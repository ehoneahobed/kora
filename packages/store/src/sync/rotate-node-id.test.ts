import { describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'

/**
 * Node rotation (RT-21) writes the version vector under the W6 discipline: inside the
 * rotation transaction, with MAX(stored, new), and never below a sequence number the
 * node already handed out. An operation that was sent but not acknowledged may be
 * stored on the server; lowering the old node's counter would let a writer still on
 * that node id (another tab) reuse its number for different content, which the
 * server refuses (SEQUENCE_CONFLICT).
 */
async function openStore(): Promise<{ store: Store; adapter: BetterSqlite3Adapter }> {
	const adapter = new BetterSqlite3Adapter(':memory:')
	const store = new Store({ schema: minimalSchema, adapter })
	await store.open()
	return { store, adapter }
}

async function persistedSequence(adapter: BetterSqlite3Adapter, nodeId: string): Promise<number> {
	const rows = await adapter.query<{ sequence_number: number }>(
		'SELECT sequence_number FROM _kora_version_vector WHERE node_id = ?',
		[nodeId],
	)
	return rows[0]?.sequence_number ?? 0
}

describe('rotateNodeId version vector (W6 discipline)', () => {
	test('the old node keeps its counter when its tail is rotated away', async () => {
		const { store, adapter } = await openStore()
		const col = store.collection('todos')
		await col.insert({ title: 'acked' })
		await col.insert({ title: 'unsynced-1' })
		await col.insert({ title: 'unsynced-2' })
		const oldNode = store.getNodeId()
		const ops = await store.getOperationRange(oldNode, 1, 10)
		const unsynced = ops.filter((op) => op.sequenceNumber > 1).map((op) => op.id)

		const result = await store.rotateNodeId(unsynced)
		expect(await persistedSequence(adapter, oldNode)).toBe(3)
		expect(store.getVersionVector().get(oldNode)).toBe(3)
		expect(await persistedSequence(adapter, result.nodeId)).toBe(2)
		await store.close()
	})

	test('rotating every op keeps the old node entry', async () => {
		const { store, adapter } = await openStore()
		const col = store.collection('todos')
		await col.insert({ title: 'a' })
		await col.insert({ title: 'b' })
		const oldNode = store.getNodeId()
		const ops = await store.getOperationRange(oldNode, 1, 10)
		await store.rotateNodeId(ops.map((op) => op.id))
		expect(await persistedSequence(adapter, oldNode)).toBe(2)
		await store.close()
	})

	test('a counter advanced by another writer before the rotation commits is never lowered', async () => {
		const { store, adapter } = await openStore()
		const col = store.collection('todos')
		await col.insert({ title: 'a' })
		await col.insert({ title: 'b' })
		const oldNode = store.getNodeId()
		const ops = await store.getOperationRange(oldNode, 1, 10)
		// Another tab sharing the database writes under the old node id after the
		// rotation was decided: its numbers must survive the rotation.
		const transaction = adapter.transaction.bind(adapter)
		let raced = false
		adapter.transaction = async (fn) => {
			if (!raced) {
				raced = true
				await adapter.execute(
					'UPDATE _kora_version_vector SET sequence_number = 9 WHERE node_id = ?',
					[oldNode],
				)
			}
			return transaction(fn)
		}
		const result = await store.rotateNodeId(ops.slice(1).map((op) => op.id))
		expect(await persistedSequence(adapter, oldNode)).toBe(9)
		expect(await persistedSequence(adapter, result.nodeId)).toBe(1)
		// New writes continue the new node's sequence.
		await col.insert({ title: 'c' })
		expect(store.getVersionVector().get(result.nodeId)).toBe(2)
		await store.close()
	})
})
