import { defineSchema, t } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'
import type { StorageAdapter } from '../types'

const base = {
	version: 1,
	collections: {
		projects: { fields: { name: t.string() } },
		lessons: { fields: { title: t.string(), projectId: t.string().optional() } },
	},
} as const

function schemaWith(onDelete: 'cascade' | 'restrict') {
	return defineSchema({
		...base,
		relations: {
			lessonProject: {
				from: 'lessons',
				to: 'projects',
				type: 'many-to-one',
				field: 'projectId',
				onDelete,
			},
		},
	})
}

const stores: Store[] = []
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close()
})

async function open(
	onDelete: 'cascade' | 'restrict' = 'cascade',
	adapter: StorageAdapter = new BetterSqlite3Adapter(':memory:'),
): Promise<Store> {
	const store = new Store({
		schema: schemaWith(onDelete),
		adapter,
		nodeId: 'live-node',
		materialization: 'fold',
	})
	await store.open()
	stores.push(store)
	return store
}

describe('Store.beginStaging: when a database stages a first sync', () => {
	test('native SQLite does not stage unless asked; asked, it does', async () => {
		const store = await open()
		expect(await store.beginStaging()).toBeNull()
		const replica = await store.beginStaging({ explicit: true })
		expect(replica).not.toBeNull()
		await replica?.discard()
	})

	test('an adapter without a scratch database does not stage, asked or not', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		;(adapter as { createStagingAdapter?: unknown }).createStagingAdapter = undefined
		const store = await open('cascade', adapter)
		expect(await store.beginStaging({ explicit: true })).toBeNull()
	})

	test('a schema with a restrict relation does not stage (a delete is judged against live children)', async () => {
		const store = await open('restrict')
		expect(await store.beginStaging({ explicit: true })).toBeNull()
	})

	test('a log with quarantined records does not stage (the replica would not hold them)', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		const store = await open('cascade', adapter)
		await adapter.execute(
			'CREATE TABLE IF NOT EXISTS _kora_log_quarantine (collection TEXT NOT NULL, operation_id TEXT NOT NULL, node_id TEXT, sequence_number INTEGER, problem TEXT NOT NULL, detail TEXT NOT NULL, row_json TEXT NOT NULL, quarantined_at INTEGER NOT NULL, PRIMARY KEY (collection, operation_id))',
		)
		await adapter.execute(
			"INSERT INTO _kora_log_quarantine VALUES ('lessons', 'op-1', 'n', 1, 'p', 'd', '{\"record_id\":\"l1\"}', 1)",
		)
		expect(await store.beginStaging({ explicit: true })).toBeNull()
	})

	test('records kept outside an access narrowing do not stage', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		const store = await open('cascade', adapter)
		await adapter.execute('INSERT INTO _kora_meta (key, value) VALUES (?, ?)', [
			'access_narrowing_kept:lessons',
			JSON.stringify({ scope: null, kept: ['l1'] }),
		])
		expect(await store.beginStaging({ explicit: true })).toBeNull()
	})

	test("a replica refuses to merge once the server's authoritative node ids changed", async () => {
		const store = await open()
		const replica = await store.beginStaging({ explicit: true })
		expect(replica).not.toBeNull()
		await store.setAuthoritativeNodeIds(['server-node-2'])
		const result = await replica?.merge({ signature: '', watermark: 1 })
		expect(result).toEqual({
			kind: 'unmergeable',
			reason: "the server's authoritative node ids changed while the replica was staged",
		})
	})

	test('a closed replica merges nothing, a second merge is refused, and sizeBytes reports pages in use', async () => {
		const store = await open()
		const replica = await store.beginStaging({ explicit: true })
		if (replica === null) throw new Error('expected a replica')
		expect(await replica.sizeBytes()).toBeGreaterThan(0)
		const first = await replica.merge({ signature: '', watermark: 0 })
		expect(first.kind).toBe('merged')
		expect(replica.isClosed()).toBe(true)
		const again = await replica.merge({ signature: '', watermark: 0 })
		expect(again).toEqual({ kind: 'unmergeable', reason: 'the staging replica is closed' })
	})

	test('discard() of a replica that is merging cancels the merge, waits for it, and closes the replica once', async () => {
		const store = await open()
		const replica = await store.beginStaging({ explicit: true })
		if (replica === null) throw new Error('expected a replica')
		const merging = replica.merge({ signature: '', watermark: 5 })
		await replica.discard()
		const result = await merging
		// Cancelled before it could write its progress: nothing reports the watermark.
		expect(result.kind).toBe('unmergeable')
		expect(replica.isClosed()).toBe(true)
		expect(await store.loadDeliveryWatermark('')).toBe(0)
		await replica.discard()
	})

	test('discard() that outwaits a stuck chunk leaves the replica and its guard up until the merge ends', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		const store = await open('cascade', adapter)
		const replica = await store.beginStaging({ explicit: true, cancelWaitMs: 20 })
		if (replica === null) throw new Error('expected a replica')
		await replica.store.collection('projects').insert({ name: 'p' })
		let release: () => void = () => undefined
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let reached: () => void = () => undefined
		const hit = new Promise<void>((resolve) => {
			reached = resolve
		})
		const real = adapter.transaction.bind(adapter)
		adapter.transaction = async (fn) => {
			reached()
			await gate
			return real(fn)
		}
		const merging = replica.merge({ signature: '', watermark: 1 })
		await hit
		await replica.discard()
		// The wait ran out with a chunk still in flight: nothing was released under it.
		const internal = replica as unknown as { closed: boolean }
		expect(internal.closed).toBe(false)
		release()
		const result = await merging
		adapter.transaction = real
		expect(result.kind).toBe('unmergeable')
		expect(internal.closed).toBe(true)
		expect(await store.loadDeliveryWatermark('')).toBe(0)
	})

	test('an event the replica kept that is about no record still reaches the live listeners after the merge', async () => {
		const emitter = new SimpleEventEmitter()
		const seen: string[] = []
		emitter.on('sync:connected', () => seen.push('sync:connected'))
		const store = new Store({
			schema: schemaWith('cascade'),
			adapter: new BetterSqlite3Adapter(':memory:'),
			nodeId: 'live-node',
			materialization: 'fold',
			emitter,
		})
		await store.open()
		stores.push(store)
		const replica = await store.beginStaging({ explicit: true })
		if (replica === null) throw new Error('expected a replica')
		replica.emitter.emit({ type: 'sync:connected', nodeId: 'n' })
		expect(seen).toEqual([])
		expect((await replica.merge({ signature: '', watermark: 0 })).kind).toBe('merged')
		expect(seen).toEqual(['sync:connected'])
	})
})
