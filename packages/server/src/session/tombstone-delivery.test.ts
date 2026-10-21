import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import type { OperationBatchMessage, SyncMessage } from '@korajs/sync'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { describe, expect, test, vi } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { PostgresServerStore } from '../store/postgres-server-store'
import { replayScopeSnapshots } from '../store/scope-snapshot'
import type { ServerStore } from '../store/server-store'
import { SqliteServerStore } from '../store/sqlite-server-store'
import { createServerTransportPair } from '../transport/memory-server-transport'
import type { AuthProvider } from '../types'
import { ClientSession } from './client-session'

/**
 * An operation after which the record is deleted (a delete, or a stale write that lands
 * on the tombstone) is delivered by what the session's view held of the record, read
 * from the record's live-view summary, never by the operation's own values: a delete
 * reaches every view that held a live version, and a stale write reaches no view as a
 * live record. Where the summary or the tombstone state is unknown (not built yet, or
 * left behind by an instance that does not maintain it), delivery is as before.
 */

const schema = defineSchema({
	version: 1,
	collections: { lessons: { fields: { title: t.string(), school: t.string() } } },
})

let sequence = 0
function op(
	id: string,
	type: Operation['type'],
	wallTime: number,
	data: Record<string, unknown> | null,
	nodeId = 'node-a',
): Operation {
	sequence += 1
	return {
		id,
		nodeId,
		type,
		collection: 'lessons',
		recordId: 'r',
		data,
		previousData: null,
		timestamp: { wallTime, logical: 0, nodeId },
		sequenceNumber: sequence,
		causalDeps: [],
		schemaVersion: 1,
	}
}

/**
 * r is inserted in school-0 and moved to school-1; the server deletes it (t=4000); a
 * device that was offline then uploads an older write (t=3500) moving it to school-0.
 */
function history(): Operation[] {
	return [
		op('ins', 'insert', 1000, { title: 'r', school: 'school-0' }),
		op('move', 'update', 2000, { school: 'school-1' }),
		op('del', 'delete', 4000, null),
		op('stale', 'update', 3500, { school: 'school-0' }, 'node-b'),
	]
}

/** A store, and raw SQL on its database (null for the memory store). */
interface Fixture {
	store: ServerStore
	sql: ((query: string) => Promise<unknown[]>) | null
	done: () => Promise<void>
}

const PG_URL = process.env.KORA_PG_TEST_URL
let pgSchemas = 0
const stores: Array<[string, () => Promise<Fixture>]> = [
	['memory', async () => ({ store: new MemoryServerStore('s'), sql: null, done: async () => {} })],
	[
		'sqlite',
		async () => {
			const db = new Database(':memory:')
			return {
				store: new SqliteServerStore(drizzle(db), 's'),
				sql: async (query) =>
					query.trim().startsWith('SELECT') ? db.prepare(query).all() : (db.exec(query), []),
				done: async () => {},
			}
		},
	],
]
if (PG_URL) {
	stores.push([
		'postgres',
		async () => {
			pgSchemas += 1
			const name = `kora_tombstone_${process.pid}_${pgSchemas}`
			const admin = postgres(PG_URL, { max: 1 })
			await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
			await admin.unsafe(`CREATE SCHEMA ${name}`)
			await admin.end()
			const client = postgres(PG_URL, { max: 4, connection: { search_path: name } })
			return {
				store: new PostgresServerStore(drizzlePg(client), 's'),
				sql: async (query) => [...(await client.unsafe(query))],
				done: async () => {
					await client.end()
					const drop = postgres(PG_URL, { max: 1 })
					await drop.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
					await drop.end()
				},
			}
		},
	])
}

async function seeded(
	fixture: Fixture,
	operations = history(),
	register = true,
): Promise<ServerStore> {
	const { store } = fixture
	await store.setSchema(schema)
	if (register) await store.registerLiveViewFields?.('lessons', ['school'])
	for (const operation of operations) await store.applyRemoteOperation(operation)
	await store.whenLiveViewsIdle?.()
	return store
}

async function stream(store: ServerStore, school: string, watermark = 0): Promise<string[]> {
	const auth: AuthProvider = {
		authenticate: async () => ({ userId: school, scopes: { lessons: { school } } }),
	}
	const { client, server } = createServerTransportPair()
	const messages: SyncMessage[] = []
	client.onMessage((message) => messages.push(message))
	const session = new ClientSession({ sessionId: school, transport: server, store, auth })
	session.start()
	client.send({
		type: 'handshake',
		messageId: 'hs',
		nodeId: `device-${school}`,
		versionVector: {},
		schemaVersion: 1,
		authToken: 'token',
		lastDeliverySequence: watermark,
		// The view the watermark belongs to (a different one restarts the stream at 0).
		syncScope: { lessons: { school } },
	})
	const batches = (): OperationBatchMessage[] =>
		messages.filter((m): m is OperationBatchMessage => m.type === 'operation-batch')
	await vi.waitFor(() => expect(batches().some((batch) => batch.isFinal)).toBe(true))
	client.disconnect?.()
	return batches().flatMap((batch) => batch.operations.map((sent) => sent.id))
}

/** Rewrite every snapshot as an instance that does not record `deleted` would have. */
async function stripTombstoneState(fixture: Fixture, ids?: string[]): Promise<void> {
	if (!fixture.sql) return
	const rows = (await fixture.sql(
		'SELECT id, scope_snapshot FROM operations WHERE scope_snapshot IS NOT NULL',
	)) as Array<{ id: string; scope_snapshot: string }>
	for (const row of rows) {
		if (ids && !ids.includes(row.id)) continue
		const parsed = JSON.parse(row.scope_snapshot) as Record<string, unknown>
		parsed.deleted = undefined
		const value = JSON.stringify(parsed).replaceAll("'", "''")
		await fixture.sql(`UPDATE operations SET scope_snapshot = '${value}' WHERE id = '${row.id}'`)
	}
}

describe.each(stores)('tombstone delivery (%s store)', (name, make) => {
	test('snapshots record the tombstone state, and the record keeps a current summary', async () => {
		const fixture = await make()
		const store = await seeded(fixture)
		const snapshots = await store.getOperationScopeSnapshots?.(['ins', 'move', 'del', 'stale'])
		expect(snapshots?.get('ins')?.deleted).toBe(false)
		expect(snapshots?.get('move')?.deleted).toBe(false)
		expect(snapshots?.get('del')?.deleted).toBe(true)
		// The stale write is older than the delete: the record stays deleted, although the
		// write's own values (school-0) are recorded as the post-image.
		expect(snapshots?.get('stale')).toMatchObject({ deleted: true, pre: null })
		expect(snapshots?.get('stale')?.post?.school).toBe('school-0')
		const state = (await store.getRecordLiveViews?.('lessons', ['r']))?.get('r')
		expect(state?.current).toBe(true)
		expect(state?.views.versions.map((version) => version.values)).toEqual([
			{ school: 'school-0' },
			{ school: 'school-1' },
		])
		expect(state?.views.newestDelete?.id).toBe('del')
		await store.close()
		await fixture.done()
	})

	test('a view that held the record gets the delete once, and the stale write after it', async () => {
		const fixture = await make()
		const store = await seeded(fixture)
		// school-0 held the inserted version; the delete is judged on school-1 values.
		expect(await stream(store, 'school-0')).toEqual(['ins', 'del', 'stale'])
		await store.close()
		await fixture.done()
	})

	test('the view the record was deleted in gets the delete, not the stale write', async () => {
		const fixture = await make()
		const store = await seeded(fixture)
		const sent = await stream(store, 'school-1')
		// The move into school-1 is sent (after its scope entry, RT-19).
		expect(sent).toContain('move')
		expect(sent[sent.length - 1]).toBe('del')
		expect(sent.filter((id) => id === 'del')).toHaveLength(1)
		expect(sent).not.toContain('stale')
		await store.close()
		await fixture.done()
	})

	test('a view that never held the record gets nothing', async () => {
		const fixture = await make()
		const store = await seeded(fixture)
		expect(await stream(store, 'school-2')).toEqual([])
		await store.close()
		await fixture.done()
	})

	test('a stale write after a delete this pass did not send: the delete precedes it, once', async () => {
		const fixture = await make()
		const store = await seeded(fixture, [
			op('ins2', 'insert', 1000, { title: 'r', school: 'school-1' }),
			op('del2', 'delete', 4000, null),
			op('stale-a', 'update', 3500, { school: 'school-1', title: 'a' }, 'node-b'),
			op('stale-b', 'update', 3600, { title: 'b' }, 'node-b'),
		])
		expect(await stream(store, 'school-1')).toEqual(['ins2', 'del2', 'stale-a', 'stale-b'])
		// A device that resumes after the delete (it may never have received it, from an
		// older server) gets it once, before the first stale write.
		expect(await stream(store, 'school-1', 2)).toEqual(['del2', 'stale-a', 'stale-b'])
		expect(await stream(store, 'school-0')).toEqual([])
		await store.close()
		await fixture.done()
	})

	test('a long history is decided with one summary read per chunk, the delete sent once', async () => {
		const fixture = await make()
		const operations = [op('ins3', 'insert', 1000, { title: 't', school: 'school-0' })]
		for (let i = 0; i < 150; i++)
			operations.push(op(`edit-${i}`, 'update', 1001 + i, { title: `e${i}` }))
		operations.push(op('move3', 'update', 2000, { school: 'school-1' }))
		operations.push(op('del3', 'delete', 9000, null))
		for (let i = 0; i < 150; i++) {
			operations.push(
				op(`stale-${i}`, 'update', 3000 + i, { school: 'school-0', title: `s${i}` }, 'node-b'),
			)
		}
		const store = await seeded(fixture, operations)
		const reads = vi.spyOn(store, 'getRecordLiveViews' as never)
		const sent = await stream(store, 'school-0')
		expect(sent.filter((id) => id === 'del3')).toHaveLength(1)
		expect(sent.filter((id) => id.startsWith('stale-'))).toHaveLength(150)
		expect(sent).toHaveLength(1 + 150 + 1 + 150)
		// One batched read per scan chunk at most, never one per operation.
		expect(reads.mock.calls.length).toBeLessThanOrEqual(2)
		await store.close()
		await fixture.done()
	})

	if (name !== 'memory') {
		test('snapshots without the tombstone state are judged as before, until the backfill fills them', async () => {
			const fixture = await make()
			// Written before the upgrade: no registration, no `deleted`.
			const store = await seeded(fixture, history(), false)
			await stripTombstoneState(fixture)
			const register = store.registerLiveViewFields
			const rebuild = store.requestLiveViewRebuild
			// Hold the backfill back so the "before" state is observed deterministically.
			store.registerLiveViewFields = async () => {}
			store.requestLiveViewRebuild = () => {}
			// Before: the previous behavior (main); nothing reaches a view that never held it.
			expect(await stream(store, 'school-0')).toEqual(['ins', 'stale'])
			expect(await stream(store, 'school-2')).toEqual([])
			store.registerLiveViewFields = register
			store.requestLiveViewRebuild = rebuild
			await store.registerLiveViewFields?.('lessons', ['school'])
			await store.whenLiveViewsIdle?.()
			const snapshots = await store.getOperationScopeSnapshots?.(['ins', 'del', 'stale'])
			expect(snapshots?.get('del')?.deleted).toBe(true)
			expect(snapshots?.get('stale')?.deleted).toBe(true)
			expect(await stream(store, 'school-0')).toEqual(['ins', 'del', 'stale'])
			expect(await stream(store, 'school-2')).toEqual([])
			await store.close()
			await fixture.done()
		})

		test('a write by an instance that keeps no summary makes the record unknown until rebuilt', async () => {
			const fixture = await make()
			const store = await seeded(fixture)
			const sql = fixture.sql
			if (!sql) throw new Error('raw SQL is required')
			const before = (await sql(
				"SELECT views FROM kora_record_live_views WHERE record_id = 'r'",
			)) as Array<{ views: string }>
			// An older instance applies one more stale write: its snapshot has no tombstone
			// state and the summary is left as it was.
			await store.applyRemoteOperation(
				op('stale2', 'update', 3600, { school: 'school-2' }, 'node-c'),
			)
			await store.whenLiveViewsIdle?.()
			await stripTombstoneState(fixture, ['stale2'])
			await sql(
				`UPDATE kora_record_live_views SET views = '${before[0]?.views.replaceAll("'", "''")}' WHERE record_id = 'r'`,
			)
			const rebuild = store.requestLiveViewRebuild?.bind(store)
			const requested: string[] = []
			store.requestLiveViewRebuild = (_collection, recordId) => {
				requested.push(recordId)
			}
			// Stale summary: unknown, so the previous behavior, and a rebuild is asked for.
			expect(await stream(store, 'school-0')).toEqual(['ins', 'stale'])
			expect(requested).toContain('r')
			store.requestLiveViewRebuild = rebuild
			store.requestLiveViewRebuild?.('lessons', 'r')
			await store.whenLiveViewsIdle?.()
			expect((await store.getOperationScopeSnapshots?.(['stale2']))?.get('stale2')?.deleted).toBe(
				true,
			)
			expect(await stream(store, 'school-0')).toEqual(['ins', 'del', 'stale'])
			// school-2 never held the record: the stale write moving it there is not sent.
			expect(await stream(store, 'school-2')).toEqual([])
			await store.close()
			await fixture.done()
		})
	}
})

test('a replayed snapshot records the tombstone state like the live one', () => {
	const replayed = replayScopeSnapshots(schema, 'lessons', 'r', history(), {})
	expect([...replayed.values()].map((snapshot) => snapshot.deleted)).toEqual([
		false,
		false,
		true,
		true,
	])
})
