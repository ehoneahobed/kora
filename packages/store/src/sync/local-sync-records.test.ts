import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'
import {
	ACCEPTED_CYCLE_META_KEY,
	LOCAL_NODES_TABLE,
	findTerminalRejections,
	listLocalNodes,
	loadAcceptedCycle,
	markLocalNodeAccepted,
	markLocalNodeRefused,
	recordTerminalRejections,
	registerLocalNode,
	seedTerminalRejectionsOnce,
} from './local-sync-records'
import { loadOwnAckedThrough, ownAckedThroughKey, saveOwnAckedThrough } from './sync-durability'
import { loadNodeToken, nodeTokenKey, saveNodeToken } from './sync-state'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

let store: Store | null = null
afterEach(async () => {
	await store?.close()
	store = null
})

async function openStore(): Promise<{ store: Store; adapter: BetterSqlite3Adapter }> {
	const adapter = new BetterSqlite3Adapter(':memory:')
	store = new Store({ schema, adapter })
	await store.open()
	return { store, adapter }
}

describe('terminal rejections (RT-36)', () => {
	test('are recorded once, found by id, and never include non-terminal codes', async () => {
		const { adapter } = await openStore()
		await recordTerminalRejections(adapter, [
			{
				operationId: 'a',
				nodeId: 'n',
				sequenceNumber: 1,
				code: 'INSUFFICIENT_FUNDS',
				rejectedAt: 1,
			},
			{
				operationId: 'b',
				nodeId: 'n',
				sequenceNumber: 2,
				code: 'SEQUENCE_CONFLICT',
				rejectedAt: 1,
			},
			{ operationId: 'c', nodeId: 'n', sequenceNumber: 3, code: 'NODE_ID_MISMATCH', rejectedAt: 1 },
		])
		await recordTerminalRejections(adapter, [
			{ operationId: 'a', nodeId: 'n', sequenceNumber: 1, code: 'OTHER', rejectedAt: 2 },
		])
		expect([...(await findTerminalRejections(adapter, ['a', 'b', 'c', 'd']))]).toEqual(['a'])
		const rows = await adapter.query<{ code: string }>('SELECT code FROM _kora_terminal_rejections')
		expect(rows).toEqual([{ code: 'INSUFFICIENT_FUNDS' }])
	})

	test('are seeded once from the app rejected list, skipping SEQUENCE_CONFLICT (RT-37 rescue) and retriable rows', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		store = new Store({ schema, adapter })
		await store.open()
		await adapter.execute("DELETE FROM _kora_meta WHERE key = 'terminal_rejections_seeded_v1'")
		const insert =
			'INSERT INTO _kora_sync_rejected (operation_id, collection, record_id, code, message, retriable, rejected_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
		await adapter.execute(insert, ['refused', 'todos', 'r1', 'FORBIDDEN', 'no', 0, 1])
		await adapter.execute(insert, ['beta13-pair', 'todos', 'r2', 'SEQUENCE_CONFLICT', 'dup', 0, 1])
		await adapter.execute(insert, ['transient', 'todos', 'r3', 'BUSY', 'later', 1, 1])
		await seedTerminalRejectionsOnce(adapter)
		expect([
			...(await findTerminalRejections(adapter, ['refused', 'beta13-pair', 'transient'])),
		]).toEqual(['refused'])
		// The marker survives the app clearing its list, and seeding runs only once.
		await adapter.execute('DELETE FROM _kora_sync_rejected')
		await adapter.execute(insert, ['later', 'todos', 'r4', 'FORBIDDEN', 'no', 0, 1])
		await seedTerminalRejectionsOnce(adapter)
		expect([...(await findTerminalRejections(adapter, ['refused', 'later']))]).toEqual(['refused'])
	})
})

describe('local node registry (RT-38, RT-40)', () => {
	test('the store registers its node on open; a fresh node is not accepted', async () => {
		const { store: s, adapter } = await openStore()
		const nodes = await listLocalNodes(adapter)
		expect(nodes.map((node) => node.nodeId)).toEqual([s.getNodeId()])
		expect(nodes[0]?.accepted).toBe(false)
		expect(nodes[0]?.held).toBe(false)
	})

	test('a node with sync history from an earlier release registers as accepted', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		await adapter.open(schema)
		await adapter.execute("INSERT INTO _kora_meta (key, value) VALUES ('node_id', 'old')")
		await adapter.execute(
			"INSERT INTO _kora_meta (key, value) VALUES ('last_acked_server_vector', '{\"old\":4}')",
		)
		await registerLocalNode(adapter, 'old')
		await registerLocalNode(adapter, 'other')
		const nodes = await listLocalNodes(adapter)
		expect(nodes.find((n) => n.nodeId === 'old')?.accepted).toBe(true)
		expect(nodes.find((n) => n.nodeId === 'other')?.accepted).toBe(false)
		await adapter.close()
	})

	test('acceptance starts a refusal cycle; refusal records the cycle and holds', async () => {
		const { adapter } = await openStore()
		expect(await loadAcceptedCycle(adapter)).toBe(0)
		await markLocalNodeAccepted(adapter, 'a')
		expect(await loadAcceptedCycle(adapter)).toBe(1)
		await markLocalNodeRefused(adapter, 'a', true)
		let a = (await listLocalNodes(adapter)).find((n) => n.nodeId === 'a')
		expect(a).toMatchObject({ accepted: true, held: true, refusedCycle: 1 })
		// A later non-holding refusal never releases a hold.
		await markLocalNodeRefused(adapter, 'a', false)
		a = (await listLocalNodes(adapter)).find((n) => n.nodeId === 'a')
		expect(a?.held).toBe(true)
		// An accepted handshake as the node releases it.
		await markLocalNodeAccepted(adapter, 'a')
		a = (await listLocalNodes(adapter)).find((n) => n.nodeId === 'a')
		expect(a).toMatchObject({ accepted: true, held: false, refusedCycle: null })
		const cycle = await adapter.query<{ value: string }>(
			'SELECT value FROM _kora_meta WHERE key = ?',
			[ACCEPTED_CYCLE_META_KEY],
		)
		expect(cycle[0]?.value).toBe('2')
		expect(LOCAL_NODES_TABLE).toBe('_kora_local_nodes')
	})
})

describe('per-node sync keys', () => {
	test('the first node keeps the legacy prefix key; another node gets its own', async () => {
		const { adapter } = await openStore()
		await saveOwnAckedThrough(adapter, 'n1', 3)
		await saveOwnAckedThrough(adapter, 'n2', 7)
		await saveOwnAckedThrough(adapter, 'n1', 4)
		expect(await loadOwnAckedThrough(adapter, 'n1')).toBe(4)
		expect(await loadOwnAckedThrough(adapter, 'n2')).toBe(7)
		expect(await loadOwnAckedThrough(adapter, 'n3')).toBeNull()
		const legacy = await adapter.query<{ value: string }>(
			"SELECT value FROM _kora_meta WHERE key = 'own_acked_through'",
		)
		expect(JSON.parse(legacy[0]?.value ?? '{}')).toEqual({ nodeId: 'n1', sequence: 4 })
		const own = await adapter.query<{ value: string }>(
			'SELECT value FROM _kora_meta WHERE key = ?',
			[ownAckedThroughKey('n2')],
		)
		expect(own[0]?.value).toBe('7')
	})

	test('node tokens are kept per node; the legacy token belongs to the database node only', async () => {
		const { store: s, adapter } = await openStore()
		await adapter.execute(
			"INSERT OR REPLACE INTO _kora_meta (key, value) VALUES ('sync_node_token', 'legacy')",
		)
		expect(await loadNodeToken(adapter, s.getNodeId())).toBe('legacy')
		expect(await loadNodeToken(adapter, 'other-tab')).toBeNull()
		await saveNodeToken(adapter, 'tab-token', 'other-tab')
		expect(await loadNodeToken(adapter, 'other-tab')).toBe('tab-token')
		await s.saveNodeToken('mine')
		expect(await s.loadNodeToken()).toBe('mine')
		const rows = await adapter.query<{ value: string }>(
			'SELECT value FROM _kora_meta WHERE key = ?',
			[nodeTokenKey(s.getNodeId())],
		)
		expect(rows[0]?.value).toBe('mine')
	})
})

describe('Store sequence recovery (RT-35)', () => {
	test('raiseSequenceFloor raises the counter (never lowers it) so the next write skips the lost numbers', async () => {
		const { store: s } = await openStore()
		const node = s.getNodeId()
		await s.collection('todos').insert({ title: 'one' })
		expect(await s.raiseSequenceFloor(node, 1)).toBe(false)
		expect(await s.raiseSequenceFloor(node, 4)).toBe(true)
		expect(s.getVersionVector().get(node)).toBe(4)
		await s.collection('todos').insert({ title: 'five' })
		const ops = await s.getOperationRange(node, 1, 10)
		expect(ops.map((op) => op.sequenceNumber)).toEqual([1, 5])
	})

	test('resequenceOperation renumbers above the floor, keeps the id and records the old identity', async () => {
		const { store: s, adapter } = await openStore()
		const node = s.getNodeId()
		await s.collection('todos').insert({ title: 'one' })
		const [op] = await s.getOperationRange(node, 1, 1)
		if (!op) throw new Error('missing op')
		const renumbered = await s.resequenceOperation(op.id, node, 6)
		expect(renumbered?.id).toBe(op.id)
		expect(renumbered?.sequenceNumber).toBe(7)
		expect((await s.getOperationRange(node, 7, 7)).map((o) => o.id)).toEqual([op.id])
		expect(await s.getOperationRange(node, 1, 1)).toEqual([])
		const conflicts = await adapter.query<{ reason: string; new_sequence_number: number }>(
			'SELECT reason, new_sequence_number FROM _kora_seq_conflicts WHERE id = ?',
			[op.id],
		)
		expect(conflicts).toEqual([{ reason: 'server-sequence-conflict', new_sequence_number: 7 }])
		expect(await s.resequenceOperation('missing', node, 1)).toBeNull()
	})

	test('switchNodeId moves back to a registered node and refuses an unknown one', async () => {
		const { store: s } = await openStore()
		const first = s.getNodeId()
		await s.collection('todos').insert({ title: 'a' })
		const rotated = await s.rotateNodeId([])
		expect(s.getNodeId()).toBe(rotated.nodeId)
		await s.switchNodeId(first)
		expect(s.getNodeId()).toBe(first)
		const op = await s.collection('todos').insert({ title: 'b' })
		expect(op).toBeTruthy()
		expect(s.getVersionVector().get(first)).toBe(2)
		await expect(s.switchNodeId('never-used')).rejects.toMatchObject({ code: 'NODE_ID_UNKNOWN' })
	})

	test('ensureDurable delegates to the adapter barrier when it has one', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		let barriers = 0
		Object.assign(adapter, {
			ensureDurable: async () => {
				barriers++
			},
		})
		store = new Store({ schema, adapter })
		await store.open()
		await store.ensureDurable()
		expect(barriers).toBe(1)
	})
})
