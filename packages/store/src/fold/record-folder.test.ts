import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	HybridLogicalClock,
	createOperation,
	defineSchema,
	foldRecord,
	materialize,
	t,
} from '@korajs/core'
import type { KoraEvent, Operation, SchemaDefinition } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { afterAll, afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'
import { FOLD_BASE_TABLE, FOLD_STATE_TABLE, mergeYjsUpdates } from './record-folder'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				tags: t.array(t.string()).default([]),
				score: t.number().merge('counter').default(0),
			},
		},
	},
}) as unknown as SchemaDefinition

const T0 = 1_790_000_000_000
let seq = 0
async function remote(
	node: string,
	wall: number,
	type: Operation['type'],
	data: Record<string, unknown> | null,
	previousData: Record<string, unknown> | null = null,
	recordId = 'rec-1',
): Promise<Operation> {
	seq += 1
	return createOperation(
		{
			nodeId: node,
			type,
			collection: 'todos',
			recordId,
			data,
			previousData,
			sequenceNumber: seq,
			causalDeps: [],
			schemaVersion: 1,
		},
		new HybridLogicalClock(node, { now: () => wall } as never),
	)
}

function reference(ops: Operation[]): Record<string, unknown> | null {
	const state = foldRecord(ops, schema, { richtext: mergeYjsUpdates }).state
	return state ? materialize(state, { richtext: mergeYjsUpdates }) : null
}

describe('RecordFolder through the Store', () => {
	const stores: Store[] = []
	const dir = mkdtempSync(join(tmpdir(), 'kora-record-folder-'))
	afterEach(async () => {
		for (const store of stores.splice(0)) await store.close()
	})
	afterAll(() => rmSync(dir, { recursive: true, force: true }))

	async function open(
		path: string,
		materialization: 'fold' | 'legacy' = 'fold',
		events?: KoraEvent[],
	): Promise<Store> {
		const emitter = new SimpleEventEmitter()
		if (events) emitter.on('store:rematerialized', (event) => events.push(event))
		const store = new Store({
			schema,
			adapter: new BetterSqlite3Adapter(path),
			emitter,
			nodeId: 'local',
			materialization,
		})
		stores.push(store)
		await store.open()
		return store
	}

	test('remote ops in any order materialize the reference fold; the state is persisted', async () => {
		const insert = await remote('a', T0, 'insert', { title: 'x', tags: ['t1'], score: 1 })
		const u1 = await remote('b', T0 + 1, 'update', { tags: [] }, { tags: ['t1'] })
		const u2 = await remote(
			'c',
			T0 + 2,
			'update',
			{ tags: ['t1', 't2'], score: 4 },
			{ tags: ['t1'], score: 1 },
		)
		const expected = reference([insert, u1, u2])
		for (const order of [
			[insert, u1, u2],
			[u2, u1, insert],
			[u1, insert, u2, u1],
		]) {
			const store = await open(':memory:')
			for (const op of order) await store.applyRemoteOperation(op)
			const row = await store.collection('todos').findById('rec-1')
			expect({ title: row?.title, tags: row?.tags, score: row?.score }).toEqual(expected)
			const state = await store.getFoldState('todos', 'rec-1')
			expect(state && materialize(state)).toEqual(expected)
		}
		expect(expected).toEqual({ score: 4, tags: ['t2'], title: 'x' })
	})

	test('a terminal rejection re-folds the record without the refused op (W7 step 2)', async () => {
		const store = await open(':memory:')
		const insert = await remote('a', T0, 'insert', { title: 'x', tags: [], score: 0 })
		await store.applyRemoteOperation(insert)
		const local = await store
			.collection('todos')
			.update('rec-1', { title: 'mine', tags: ['local'] })
		expect(local.title).toBe('mine')
		const ownOps = (await store.getAllOperations()).filter((op) => op.nodeId === 'local')
		const refused = ownOps[0] as Operation
		// A concurrent remote edit the server did store.
		const other = await remote(
			'b',
			refused.timestamp.wallTime - 1,
			'update',
			{ score: 5 },
			{ score: 0 },
		)
		await store.applyRemoteOperation(other)

		await store.recordTerminalRejections([
			{
				operationId: refused.id,
				nodeId: 'local',
				sequenceNumber: refused.sequenceNumber,
				code: 'PERMISSION_DENIED',
				rejectedAt: T0,
			},
		])
		const row = await store.collection('todos').findById('rec-1')
		// Exactly what the server holds: the insert and the other device's edit.
		expect({ title: row?.title, tags: row?.tags, score: row?.score }).toEqual(
			reference([insert, other]),
		)
	})

	test('a refused insert hides the record', async () => {
		const store = await open(':memory:')
		const created = await store.collection('todos').insert({ title: 'never stored' })
		const [insertOp] = await store.getAllOperations()
		await store.recordTerminalRejections([
			{
				operationId: (insertOp as Operation).id,
				nodeId: 'local',
				sequenceNumber: 1,
				code: 'SCOPE_VIOLATION',
				rejectedAt: T0,
			},
		])
		expect(await store.collection('todos').findById(created.id)).toBeNull()
	})

	test('compaction keeps the state, records a base, dedups compacted ids (STORE-14)', async () => {
		const store = await open(':memory:')
		const created = await store.collection('todos').insert({ title: 'a', tags: ['x'] })
		await store.collection('todos').update(created.id, { score: 3 })
		await store.collection('todos').update(created.id, { title: 'b' })
		const before = await store.getFoldState('todos', created.id)
		const own = (await store.getAllOperations()).filter((op) => op.nodeId === 'local')
		const result = await store.compact({ mode: 'after-ack', serverVector: new Map([['local', 3]]) })
		expect(result.deletedCount).toBe(3)
		expect(await store.getAllOperations()).toEqual([])
		expect(await store.getFoldState('todos', created.id)).toEqual(before)
		const bases = await (store as unknown as { adapter: BetterSqlite3Adapter }).adapter.query<{
			record_id: string
		}>(`SELECT record_id FROM ${FOLD_BASE_TABLE}`)
		expect(bases.map((row) => row.record_id)).toEqual([created.id])

		// A compacted id delivered again (a full resync) is a duplicate.
		expect(await store.applyRemoteOperation(own[1] as Operation)).toBe('duplicate')
		// A concurrent op of another device still merges onto the base.
		const late = await remote(
			'z',
			Date.now() + 1_000,
			'update',
			{ score: 10 },
			{ score: 0 },
			created.id,
		)
		expect(await store.applyRemoteOperation(late)).toBe('applied')
		const row = await store.collection('todos').findById(created.id)
		// Counter: 0 + 3 (local) + 10 (late), in HLC order.
		expect(row?.score).toBe(13)
		expect(row?.title).toBe('b')
	})

	test('compaction keeps delete operations and never folds a refused op into a base', async () => {
		const store = await open(':memory:')
		const created = await store.collection('todos').insert({ title: 'a' })
		await store.collection('todos').delete(created.id)
		await store.compact({ mode: 'after-ack', serverVector: new Map([['local', 2]]) })
		const left = await store.getAllOperations()
		expect(left.map((op) => op.type)).toEqual(['delete'])
		const stale = await remote('r', T0, 'update', { title: 'zombie' }, { title: 'a' }, created.id)
		await store.applyRemoteOperation(stale)
		expect(await store.collection('todos').findById(created.id)).toBeNull()
	})

	test('compaction only declares a contiguous prefix compacted', async () => {
		const store = await open(':memory:')
		const a1 = await remote('peer', T0, 'insert', { title: 'p1' }, null, 'p-1')
		const a3 = {
			...(await remote('peer', T0 + 2, 'insert', { title: 'p3' }, null, 'p-3')),
			sequenceNumber: 3,
		}
		const a1s = { ...a1, sequenceNumber: 1 }
		await store.applyRemoteOperation(a1s)
		await store.applyRemoteOperation(a3)
		const result = await store.compact({ mode: 'after-ack', serverVector: new Map([['peer', 3]]) })
		// peer:2 was never received (out of this device's scope): only 1 is compacted.
		expect(result.watermark.get('peer')).toBe(1)
		const a2 = {
			...(await remote('peer', T0 + 1, 'insert', { title: 'p2' }, null, 'p-2')),
			sequenceNumber: 2,
		}
		expect(await store.applyRemoteOperation(a2)).toBe('applied')
		expect((await store.collection('todos').findById('p-2'))?.title).toBe('p2')
	})

	test('re-materialization repairs a beta.13 (legacy) database on first open', async () => {
		const path = join(dir, 'legacy.db')
		const legacy = await open(path, 'legacy')
		const insert = await remote('a', T0, 'insert', { title: 'x', tags: ['urgent'], score: 0 })
		const remove = await remote('a', T0 + 1, 'update', { tags: [] }, { tags: ['urgent'] })
		const add = await remote(
			'b',
			T0 + 2,
			'update',
			{ tags: ['urgent', 'billing'] },
			{ tags: ['urgent'] },
		)
		for (const op of [insert, remove, add]) await legacy.applyRemoteOperation(op)
		// The legacy store resolves the array by whole-value LWW (MERGE-1's divergence).
		expect((await legacy.collection('todos').findById('rec-1'))?.tags).toEqual([
			'urgent',
			'billing',
		])
		await legacy.close()
		stores.splice(stores.indexOf(legacy), 1)

		const events: KoraEvent[] = []
		const store = await open(path, 'fold', events)
		expect((await store.collection('todos').findById('rec-1'))?.tags).toEqual(['billing'])
		expect(events).toEqual([
			expect.objectContaining({
				type: 'store:rematerialized',
				mode: 'log',
				records: 1,
				changedRows: 1,
			}),
		])
		// Once per database.
		await store.close()
		stores.splice(stores.indexOf(store), 1)
		const again: KoraEvent[] = []
		await open(path, 'fold', again)
		expect(again).toEqual([])
	})

	test('a beta.12 database (JSON timestamps from a restore) is repaired by W8, then rebuilt', async () => {
		const path = join(dir, 'beta12.db')
		const legacy = await open(path, 'legacy')
		const insert = await remote('a', T0, 'insert', { title: 'x', tags: ['t1'], score: 1 })
		const edit = await remote(
			'b',
			T0 + 5,
			'update',
			{ title: 'y', score: 2 },
			{ title: 'x', score: 1 },
		)
		for (const op of [insert, edit]) await legacy.applyRemoteOperation(op)
		const adapter = (legacy as unknown as { adapter: BetterSqlite3Adapter }).adapter
		// What beta.12's backup restore wrote into the timestamp column.
		await adapter.execute('UPDATE _kora_ops_todos SET timestamp = ? WHERE id = ?', [
			JSON.stringify(edit.timestamp),
			edit.id,
		])
		await legacy.close()
		stores.splice(stores.indexOf(legacy), 1)

		const events: KoraEvent[] = []
		const store = await open(path, 'fold', events)
		expect(events[0]).toMatchObject({ mode: 'log' })
		const row = await store.collection('todos').findById('rec-1')
		expect({ title: row?.title, tags: row?.tags, score: row?.score }).toEqual(
			reference([insert, edit]),
		)
	})

	test('a compacted legacy database keeps its rows as base snapshots (snapshot+log)', async () => {
		const path = join(dir, 'compacted.db')
		const legacy = await open(path, 'legacy')
		const created = await legacy.collection('todos').insert({ title: 'a', tags: ['x'] })
		await legacy.collection('todos').update(created.id, { tags: ['x', 'y'], score: 2 })
		await legacy.compact({ mode: 'after-ack', serverVector: new Map([['local', 2]]) })
		await legacy.close()
		stores.splice(stores.indexOf(legacy), 1)

		const events: KoraEvent[] = []
		const store = await open(path, 'fold', events)
		expect(events[0]).toMatchObject({ mode: 'snapshot+log' })
		const row = await store.collection('todos').findById(created.id)
		expect(row).toMatchObject({ title: 'a', tags: ['x', 'y'], score: 2 })
		// A stale concurrent op the snapshot already reflects changes nothing; a newer one merges.
		const stale = await remote(
			's',
			T0,
			'update',
			{ tags: ['x', 'y', 'old'] },
			{ tags: ['x', 'y'] },
			created.id,
		)
		await store.applyRemoteOperation(stale)
		expect((await store.collection('todos').findById(created.id))?.tags).toEqual(['x', 'y'])
		await store.collection('todos').update(created.id, { score: 5 })
		expect((await store.collection('todos').findById(created.id))?.score).toBe(5)
	})

	test('a quarantined log is never rebuilt from: rows are kept (kept)', async () => {
		const path = join(dir, 'quarantined.db')
		const legacy = await open(path, 'legacy')
		const insert = await remote('a', T0, 'insert', { title: 'x', tags: ['urgent'], score: 0 })
		const remove = await remote('a', T0 + 1, 'update', { tags: [] }, { tags: ['urgent'] })
		const add = await remote(
			'b',
			T0 + 2,
			'update',
			{ tags: ['urgent', 'billing'] },
			{ tags: ['urgent'] },
		)
		for (const op of [insert, remove, add]) await legacy.applyRemoteOperation(op)
		const adapter = (legacy as unknown as { adapter: BetterSqlite3Adapter }).adapter
		// An unrecoverable row (W8 quarantines it on the next open).
		await adapter.execute(`UPDATE _kora_ops_todos SET causal_deps = '{' WHERE id = ?`, [remove.id])
		await legacy.close()
		stores.splice(stores.indexOf(legacy), 1)

		const events: KoraEvent[] = []
		const store = await open(path, 'fold', events)
		expect(events[0]).toMatchObject({ mode: 'kept' })
		// The legacy row is kept as it was.
		expect((await store.collection('todos').findById('rec-1'))?.tags).toEqual(['urgent', 'billing'])
		const states = await (store as unknown as { adapter: BetterSqlite3Adapter }).adapter.query<{
			record_id: string
		}>(`SELECT record_id FROM ${FOLD_STATE_TABLE}`)
		expect(states).toHaveLength(1)
	})

	test('switching from fold to legacy and back re-materializes', async () => {
		const path = join(dir, 'switch.db')
		const store = await open(path)
		const created = await store.collection('todos').insert({ title: 'a' })
		await store.close()
		stores.splice(stores.indexOf(store), 1)
		const legacy = await open(path, 'legacy')
		expect(legacy.isFoldMaterialized()).toBe(false)
		await legacy.collection('todos').update(created.id, { title: 'b' })
		await legacy.close()
		stores.splice(stores.indexOf(legacy), 1)
		const events: KoraEvent[] = []
		const back = await open(path, 'fold', events)
		expect(back.isFoldMaterialized()).toBe(true)
		expect(events).toHaveLength(1)
		expect((await back.collection('todos').findById(created.id))?.title).toBe('b')
		expect((await back.getFoldState('todos', created.id))?.f.title).toBeDefined()
	})
})
