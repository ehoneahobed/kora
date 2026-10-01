import { HybridLogicalClock, createOperation, defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { Store } from '../../src/store/store'

// STORE-10: two tabs share one DB (leader/follower). When tab A applies a remote
// op, tab B's later apply of the same op returns 'duplicate'; tab B's live
// queries must still reflect the row.
const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})
const ticks = async () => {
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('STORE-10 multi-tab duplicate apply', () => {
	const closers: Array<() => Promise<void>> = []
	afterEach(async () => {
		for (const c of closers.splice(0)) await c()
	})

	test('tab B subscription sees a remote op that tab A applied first', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		const tabA = new Store({ schema, adapter, nodeId: 'shared-node' })
		const tabB = new Store({ schema, adapter, nodeId: 'shared-node' })
		await tabA.open()
		await tabB.open()
		closers.push(async () => {
			await tabA.close().catch(() => {})
		})

		let latest: unknown[] = []
		tabB
			.collection('todos')
			.where({})
			.subscribe((rows) => {
				latest = rows
			})
		await ticks()

		const op = await createOperation(
			{
				nodeId: 'server-peer',
				type: 'insert',
				collection: 'todos',
				recordId: 'r1',
				data: { title: 'from server' },
				previousData: null,
				sequenceNumber: 1,
				causalDeps: [],
				schemaVersion: 1,
			},
			new HybridLogicalClock('server-peer'),
		)
		expect(await tabA.applyRemoteOperation(op)).toBe('applied')
		expect(await tabB.applyRemoteOperation(op)).toBe('duplicate')
		await ticks()
		expect(latest).toHaveLength(1)
		// and tab B's in-memory vector must know about the op
		expect(tabB.getVersionVector().get('server-peer')).toBe(1)
	})
})
