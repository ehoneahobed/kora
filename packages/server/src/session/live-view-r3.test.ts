import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, foldRecord, materialize, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import type { OperationBatchMessage, SyncMessage } from '@korajs/sync'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { PostgresServerStore } from '../store/postgres-server-store'
import { FOLD_PLAN_FINGERPRINT_KEY } from '../store/record-fold'
import { RecordHistoryReplayer, replayRecordHistory } from '../store/scope-snapshot'
import type { ServerStore } from '../store/server-store'
import { SqliteServerStore } from '../store/sqlite-server-store'
import { createServerTransportPair } from '../transport/memory-server-transport'
import type { AuthProvider } from '../types'
import { ClientSession } from './client-session'

/**
 * Round-3 review of #65: a device never diverges from the server while a summary is
 * unknown (H1); a client's handshake narrowing never chooses tracked fields (M1) nor
 * triggers rebuilds (M2); a rebuild racing a restore never stores a replay of the
 * replaced log (L1); a fold-plan change leaves summaries unknown (L2); a record created
 * while an instance's field cache lags is tracked (L3).
 */

const schema = defineSchema({
	version: 1,
	collections: {
		lessons: { fields: { title: t.string(), school: t.string(), level: t.string().optional() } },
	},
})

let sequence = 0
function op(
	id: string,
	type: Operation['type'],
	wallTime: number,
	data: Record<string, unknown> | null,
	recordId = 'r',
	nodeId = 'node-a',
): Operation {
	sequence += 1
	return {
		id,
		nodeId,
		type,
		collection: 'lessons',
		recordId,
		data,
		previousData: null,
		timestamp: { wallTime, logical: 0, nodeId },
		sequenceNumber: sequence,
		causalDeps: [],
		schemaVersion: 1,
	}
}

interface Pair {
	kind: 'sqlite' | 'postgres'
	a: ServerStore
	b: ServerStore
	/** A third store on the same database, opened on demand (a restart). */
	reopen: () => ServerStore
	/** Raw SQL with `$n` placeholders (rewritten to `?` on SQLite). */
	sql: (query: string, params?: unknown[]) => Promise<Record<string, unknown>[]>
	/** Synchronous raw SQL (SQLite only). */
	sqlSync: ((query: string, params?: unknown[]) => void) | null
	/** A further connection to the same database (Postgres only). */
	connect: (() => ReturnType<typeof postgres>) | null
	done: () => Promise<void>
}

const PG_URL = process.env.KORA_PG_TEST_URL
const tmp = mkdtempSync(join(tmpdir(), 'kora-lv-r3-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
let made = 0
const kinds: Array<[string, () => Promise<Pair>]> = [
	[
		'sqlite',
		async () => {
			made += 1
			const file = join(tmp, `db-${made}.sqlite`)
			const dbA = new Database(file)
			const dbB = new Database(file)
			const toSqlite = (query: string): string => query.replace(/\$\d+/g, '?')
			return {
				kind: 'sqlite',
				a: new SqliteServerStore(drizzle(dbA), 's'),
				b: new SqliteServerStore(drizzle(dbB), 's'),
				reopen: () => new SqliteServerStore(drizzle(new Database(file)), 's'),
				sql: async (query, params = []) => {
					const statement = dbA.prepare(toSqlite(query))
					if (statement.reader) return statement.all(...params) as Record<string, unknown>[]
					statement.run(...params)
					return []
				},
				sqlSync: (query, params = []) => {
					dbA.prepare(toSqlite(query)).run(...params)
				},
				connect: null,
				done: async () => {},
			}
		},
	],
]
if (PG_URL) {
	kinds.push([
		'postgres',
		async () => {
			made += 1
			// Our own schema (prefixed): never anyone else's.
			const name = `kora_lv_r3_${process.pid}_${made}`
			const admin = postgres(PG_URL, { max: 1, onnotice: () => {} })
			await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
			await admin.unsafe(`CREATE SCHEMA ${name}`)
			await admin.end()
			const clients: Array<ReturnType<typeof postgres>> = []
			const client = (): ReturnType<typeof postgres> => {
				const c = postgres(PG_URL, {
					max: 4,
					connection: { search_path: name },
					onnotice: () => {},
				})
				clients.push(c)
				return c
			}
			const raw = client()
			return {
				kind: 'postgres',
				a: new PostgresServerStore(drizzlePg(client()), 's'),
				b: new PostgresServerStore(drizzlePg(client()), 's'),
				reopen: () => new PostgresServerStore(drizzlePg(client()), 's'),
				sql: async (query, params = []) =>
					[...(await raw.unsafe(query, params as never[]))] as Record<string, unknown>[],
				sqlSync: null,
				connect: client,
				done: async () => {
					for (const c of clients) await c.end()
					const drop = postgres(PG_URL, { max: 1, onnotice: () => {} })
					await drop.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
					await drop.end()
				},
			}
		},
	])
}

async function open(make: () => Promise<Pair>, register = true): Promise<Pair> {
	const pair = await make()
	await pair.b.setSchema(schema)
	await pair.a.setSchema(schema)
	if (register) await pair.a.registerLiveViewFields?.('lessons', ['school'])
	return pair
}

async function close(pair: Pair, ...extra: ServerStore[]): Promise<void> {
	for (const store of [pair.a, pair.b, ...extra]) await store.close()
	await pair.done()
}

async function stream(
	store: ServerStore,
	options: {
		school?: string
		syncScope?: Record<string, unknown>
		from?: number
		node?: string
	} = {},
): Promise<Operation[]> {
	const school = options.school ?? 'school-0'
	const auth: AuthProvider = {
		authenticate: async () => ({ userId: school, scopes: { lessons: { school } } }),
	}
	const { client, server } = createServerTransportPair()
	const messages: SyncMessage[] = []
	client.onMessage((message) => messages.push(message))
	new ClientSession({ sessionId: `s-${Math.random()}`, transport: server, store, auth }).start()
	client.send({
		type: 'handshake',
		messageId: 'hs',
		nodeId: options.node ?? `device-${Math.random()}`,
		versionVector: {},
		schemaVersion: 1,
		authToken: 'token',
		lastDeliverySequence: options.from ?? 0,
		...(options.syncScope ? { syncScope: options.syncScope } : {}),
	} as never)
	const batches = (): OperationBatchMessage[] =>
		messages.filter((m): m is OperationBatchMessage => m.type === 'operation-batch')
	await vi.waitFor(() => expect(batches().some((batch) => batch.isFinal)).toBe(true))
	return batches().flatMap((batch) => batch.operations)
}

/** The record as a device that applied `ops` folds it. */
function onDevice(ops: Operation[], recordId = 'r'): Record<string, unknown> | null {
	const { state } = foldRecord(
		ops.filter((o) => o.recordId === recordId),
		schema,
	)
	return state ? materialize(state) : null
}

async function onServer(
	store: ServerStore,
	recordId = 'r',
): Promise<Record<string, unknown> | null> {
	const state = await store.getRecordFoldState?.('lessons', recordId)
	return state ? materialize(state) : null
}

/** Every summary that reads as current equals a rebuild from the log. */
async function expectTrustworthy(store: ServerStore, recordIds: string[]): Promise<void> {
	const states = (await store.getRecordLiveViews?.('lessons', recordIds)) ?? new Map()
	const log = await store.getOperationsAfterDelivery(0, 100_000)
	for (const [recordId, state] of states) {
		if (!state.current) continue
		const history = log.filter((d) => d.operation.recordId === recordId)
		const rebuilt = replayRecordHistory(
			schema,
			'lessons',
			recordId,
			history,
			{},
			state.views.fields,
		)
		expect({ recordId, versions: state.views.versions }).toEqual({
			recordId,
			versions: rebuilt.views?.versions,
		})
	}
}

/**
 * Apply `operation` as an instance that knows nothing of live views would (an older
 * version during a rolling deploy): the fold-state live-view columns and the snapshot's
 * tombstone state stay as they were before it.
 */
async function applyAsOlderInstance(pair: Pair, operation: Operation): Promise<void> {
	const fold = await pair.sql(
		'SELECT lv_through, lv_fields FROM kora_fold_state WHERE collection = $1 AND record_id = $2',
		['lessons', operation.recordId],
	)
	await pair.a.applyRemoteOperation(operation)
	await pair.sql(
		'UPDATE kora_fold_state SET lv_through = $1, lv_fields = $2 WHERE collection = $3 AND record_id = $4',
		[fold[0]?.lv_through ?? null, fold[0]?.lv_fields ?? null, 'lessons', operation.recordId],
	)
	const snapshot = await pair.sql('SELECT scope_snapshot FROM operations WHERE id = $1', [
		operation.id,
	])
	const parsed = JSON.parse(String(snapshot[0]?.scope_snapshot)) as Record<string, unknown>
	parsed.deleted = undefined
	await pair.sql('UPDATE operations SET scope_snapshot = $1 WHERE id = $2', [
		JSON.stringify(parsed),
		operation.id,
	])
}

/** r is moved through more schools than a summary keeps: its summary overflows (unknown). */
async function overflowedRecord(store: ServerStore): Promise<void> {
	await store.applyRemoteOperation(op('ins', 'insert', 1000, { title: 'orig', school: 'school-0' }))
	for (let i = 0; i < 70; i++) {
		await store.applyRemoteOperation(op(`mv${i}`, 'update', 1100 + i, { school: `s-${i}` }))
	}
	await store.applyRemoteOperation(op('back', 'update', 1900, { school: 'school-0' }))
}

describe.each(kinds)('round-3 live-view fixes (%s)', (_name, make) => {
	test('H1: an unknown summary still delivers the stale write; a later revival converges', async () => {
		const pair = await open(make)
		await pair.a.applyRemoteOperation(
			op('ins', 'insert', 1000, { title: 'orig', school: 'school-0' }),
		)
		// An older instance deletes r: r's summary is unknown from then on.
		await applyAsOlderInstance(pair, op('del', 'delete', 3000, null))
		expect((await pair.a.getRecordLiveViews?.('lessons', ['r']))?.get('r')?.current).toBe(false)
		pair.a.requestLiveViewRebuild = () => {}
		await pair.a.applyRemoteOperation(op('stale', 'update', 2500, { title: 'STALE' }))
		await pair.a.applyRemoteOperation(op('revive', 'update', 4000, { level: 'x' }))
		const received = await stream(pair.a)
		expect(onDevice(received)?.title).toBe((await onServer(pair.a))?.title)
		expect(onDevice(received)?.title).toBe('STALE')
		await close(pair)
	})

	test('H1: a resumed device with an unknown summary converges after a revival', async () => {
		const pair = await open(make)
		await overflowedRecord(pair.a)
		const node = `device-${Math.random()}`
		const syncScope = { lessons: { school: 'school-0' } }
		const first = await stream(pair.a, { node, syncScope })
		const watermark = (await pair.a.getOperationsAfterDelivery(0, 10_000)).length
		await pair.a.applyRemoteOperation(op('del', 'delete', 3000, null))
		await pair.a.applyRemoteOperation(op('stale', 'update', 2500, { title: 'STALE' }))
		// Before the revival the device shows the record deleted, as the server does.
		const middle = await stream(pair.a, { node, syncScope, from: watermark })
		expect(onDevice([...first, ...middle])).toBeNull()
		await pair.a.applyRemoteOperation(op('revive', 'update', 4000, { level: 'x' }))
		const second = await stream(pair.a, { node, syncScope, from: watermark })
		expect(onDevice([...first, ...second])?.title).toBe((await onServer(pair.a))?.title)
		await close(pair)
	})

	test('H1: a known summary converges too', async () => {
		const pair = await open(make)
		await pair.a.applyRemoteOperation(
			op('ins', 'insert', 1000, { title: 'orig', school: 'school-0' }),
		)
		await pair.a.applyRemoteOperation(op('del', 'delete', 3000, null))
		await pair.a.applyRemoteOperation(op('stale', 'update', 2500, { title: 'STALE' }))
		await pair.a.applyRemoteOperation(op('revive', 'update', 4000, { level: 'x' }))
		const received = await stream(pair.a)
		expect(onDevice(received)?.title).toBe((await onServer(pair.a))?.title)
		await close(pair)
	})

	test('M1: a handshake narrowing never registers a client-chosen field', async () => {
		const pair = await open(make, false)
		await pair.a.applyRemoteOperation(
			op('ins', 'insert', 1000, { title: 'orig', school: 'school-0' }),
		)
		await stream(pair.a, { syncScope: { lessons: { school: 'school-0', title: 'orig' } } })
		await vi.waitFor(async () => {
			const rows = await pair.sql('SELECT value FROM kora_server_meta WHERE key = $1', [
				'live_view_fields:lessons',
			])
			expect(rows.map((row) => row.value)).toEqual(['["school"]'])
		})
		await close(pair)
	})

	test('M2: a narrowed view on an untracked field does not trigger rebuilds', async () => {
		const pair = await open(make)
		await pair.a.applyRemoteOperation(
			op('ins', 'insert', 1000, { title: 'orig', school: 'school-0' }),
		)
		await pair.a.applyRemoteOperation(op('del', 'delete', 3000, null))
		await pair.a.applyRemoteOperation(op('stale', 'update', 2500, { title: 'STALE' }))
		expect((await pair.a.getRecordLiveViews?.('lessons', ['r']))?.get('r')?.current).toBe(true)
		const requested: string[] = []
		pair.a.requestLiveViewRebuild = (_collection, recordId) => {
			requested.push(recordId)
		}
		for (let i = 0; i < 2; i++) {
			await stream(pair.a, { syncScope: { lessons: { school: 'school-0', title: 'orig' } } })
		}
		expect(requested).toEqual([])
		await close(pair)
	})

	test('L1: a rebuild racing a replace-mode restore never stores the replaced log', async () => {
		const pair = await open(make, false)
		// The backup holds only r: restored, r's operations take other delivery sequences.
		const source = pair.reopen()
		await source.setSchema(schema)
		const rOps = [
			op('r-ins', 'insert', 1000, { title: 'r', school: 'school-0' }),
			op('r-move', 'update', 2000, { school: 'school-1' }),
			op('r-back', 'update', 3000, { school: 'school-0' }),
		]
		await pair.a.applyRemoteOperation(
			op('x-ins', 'insert', 900, { title: 'x', school: 'school-0' }, 'x'),
		)
		for (const operation of rOps) await pair.a.applyRemoteOperation(operation)
		const isolated = await (async () => {
			const solo = await make()
			await solo.a.setSchema(schema)
			for (const operation of rOps) await solo.a.applyRemoteOperation(operation)
			const bytes = await solo.a.exportBackup()
			await close(solo)
			return bytes
		})()
		await source.close()
		// The restore lands after the rebuild read r's log and before it writes the summary.
		let restore: Promise<unknown> | null = null
		const original = RecordHistoryReplayer.prototype.push
		const spy = vi.spyOn(RecordHistoryReplayer.prototype, 'push').mockImplementation(function (
			this: RecordHistoryReplayer,
			delivered,
		) {
			original.call(this, delivered)
			if (restore === null && delivered[0]?.operation.recordId === 'r') {
				// Another instance restores (the rebuild runs on A).
				restore = pair.b.importBackup(isolated)
			}
		})
		const internals = pair.a as unknown as {
			db: { transaction: (...args: unknown[]) => unknown }
		}
		const transaction = internals.db.transaction.bind(internals.db)
		internals.db.transaction = (...args: unknown[]) => {
			if (restore === null || pair.kind === 'sqlite') return transaction(...args)
			// Postgres: the guarded write waits for the restore to commit.
			return (restore as Promise<unknown>).then(() => transaction(...args))
		}
		if (pair.kind === 'sqlite') {
			// SQLite is synchronous: emulate the restore's effect at the same point (the epoch
			// bump and the renumbered log), as an older or another process would commit it.
			spy.mockImplementation(function (this: RecordHistoryReplayer, delivered) {
				original.call(this, delivered)
				if (restore === null && delivered[0]?.operation.recordId === 'r' && pair.sqlSync) {
					restore = Promise.resolve()
					pair.sqlSync(`DELETE FROM operations WHERE record_id = 'x'`)
					pair.sqlSync('UPDATE operations SET delivery_seq = delivery_seq - 1')
					pair.sqlSync(
						`INSERT INTO kora_server_meta (key, value) VALUES ('live_view_epoch', '9') ON CONFLICT (key) DO UPDATE SET value = '9'`,
					)
				}
			})
		}
		await pair.a.registerLiveViewFields?.('lessons', ['school'])
		await pair.a.whenLiveViewsIdle?.()
		await restore
		spy.mockRestore()
		internals.db.transaction = transaction
		await expectTrustworthy(pair.a, ['r'])
		await close(pair)
	})

	test('L2: a fold state invalidated in place leaves the summary unknown', async () => {
		const pair = await open(make)
		await pair.a.applyRemoteOperation(op('ins', 'insert', 1000, { title: 'r', school: 'school-0' }))
		expect((await pair.a.getRecordLiveViews?.('lessons', ['r']))?.get('r')?.current).toBe(true)
		// What a fold-plan change or a legacy-body migration does (any version, before the
		// record is re-folded): the fold state no longer vouches for what it covers.
		await pair.sql('UPDATE kora_fold_state SET covered_seq = -1')
		expect((await pair.a.getRecordLiveViews?.('lessons', ['r']))?.get('r')?.current).toBe(false)
		// And a fold-plan change on restart.
		await pair.sql('UPDATE kora_fold_state SET covered_seq = 1')
		await pair.sql('UPDATE kora_server_meta SET value = $1 WHERE key = $2', [
			'other-plan',
			FOLD_PLAN_FINGERPRINT_KEY,
		])
		const restarted = pair.reopen()
		await restarted.setSchema(schema)
		expect((await restarted.getRecordLiveViews?.('lessons', ['r']))?.get('r')?.current).not.toBe(
			true,
		)
		await close(pair, restarted)
	})

	test('L3: a record created while an instance cache lags the registration is tracked', async () => {
		const pair = await open(make)
		// B read its cache before A registered: it still tracks a new record.
		await pair.b.applyRemoteOperation(
			op('ins', 'insert', 1000, { title: 'r', school: 'school-0' }, 'new'),
		)
		const state = (await pair.a.getRecordLiveViews?.('lessons', ['new']))?.get('new')
		expect(state?.current).toBe(true)
		expect(state?.views.fields).toEqual(['school'])
		await close(pair)
	})

	test('L1b: snapshot fills of a rebuild racing a restore are void too', async () => {
		const pair = await open(make, false)
		const ops = [
			op('f-ins', 'insert', 1000, { title: 'r', school: 'school-0' }, 'f'),
			op('f-del', 'delete', 3000, null, 'f'),
			op('f-stale', 'update', 2500, { title: 'STALE' }, 'f'),
		]
		for (const operation of ops) await pair.a.applyRemoteOperation(operation)
		// Written before the upgrade: no tombstone state on any snapshot.
		const rows = await pair.sql('SELECT id, scope_snapshot FROM operations')
		for (const row of rows) {
			const parsed = JSON.parse(String(row.scope_snapshot)) as Record<string, unknown>
			parsed.deleted = undefined
			await pair.sql('UPDATE operations SET scope_snapshot = $1 WHERE id = $2', [
				JSON.stringify(parsed),
				row.id,
			])
		}
		// A restore replaces the log after the rebuild read it: in the restored log f was
		// never deleted, so f-stale does not leave it deleted.
		const restoreSql = [
			"DELETE FROM operations WHERE id = 'f-del'",
			"UPDATE kora_server_meta SET value = '7' WHERE key = 'live_view_epoch'",
			"INSERT INTO kora_server_meta (key, value) SELECT 'live_view_epoch', '7' WHERE NOT EXISTS (SELECT 1 FROM kora_server_meta WHERE key = 'live_view_epoch')",
		]
		let restored: Promise<void> | null = null
		const original = RecordHistoryReplayer.prototype.push
		const spy = vi.spyOn(RecordHistoryReplayer.prototype, 'push').mockImplementation(function (
			this: RecordHistoryReplayer,
			delivered,
		) {
			original.call(this, delivered)
			if (restored !== null || delivered[0]?.operation.recordId !== 'f') return
			if (pair.sqlSync) {
				for (const query of restoreSql) pair.sqlSync(query)
				restored = Promise.resolve()
			} else {
				restored = (async () => {
					for (const query of restoreSql) await pair.sql(query)
				})()
			}
		})
		// Either instance may run the rebuild (b picks the registration up from the meta).
		const unwrap: Array<() => void> = []
		for (const store of [pair.a, pair.b]) {
			const internals = store as unknown as {
				db: { transaction: (...args: unknown[]) => unknown }
			}
			const transaction = internals.db.transaction.bind(internals.db)
			internals.db.transaction = (...args: unknown[]) =>
				restored === null ? transaction(...args) : restored.then(() => transaction(...args))
			unwrap.push(() => {
				internals.db.transaction = transaction
			})
		}
		await pair.a.registerLiveViewFields?.('lessons', ['school'])
		await pair.a.whenLiveViewsIdle?.()
		await pair.b.whenLiveViewsIdle?.()
		spy.mockRestore()
		for (const restore of unwrap) restore()
		const stale = await pair.a.getOperationScopeSnapshots?.(['f-stale'])
		expect(stale?.get('f-stale')?.deleted).not.toBe(true)
		await close(pair)
	})

	test('a rebuild that throws does not drop the rest of the requested batch', async () => {
		const pair = await open(make)
		for (const id of ['r1', 'r2', 'r3']) {
			await pair.a.applyRemoteOperation(
				op(`ins-${id}`, 'insert', 1000, { title: id, school: 'school-0' }, id),
			)
		}
		await pair.a.whenLiveViewsIdle?.()
		const internals = pair.a as unknown as {
			rebuildRecordLiveViews: (
				collection: string,
				recordId: string,
				...rest: unknown[]
			) => Promise<void>
			liveViewRebuilds: Set<string>
		}
		const original = internals.rebuildRecordLiveViews.bind(internals)
		const rebuilt: string[] = []
		let failNext = true
		const spy = vi
			.spyOn(internals, 'rebuildRecordLiveViews')
			.mockImplementation(async (collection, recordId, ...rest) => {
				if (failNext) {
					failNext = false
					throw new Error('rebuild exploded')
				}
				rebuilt.push(recordId)
				await original(collection, recordId, ...rest)
			})
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		for (const id of ['r1', 'r2', 'r3']) pair.a.requestLiveViewRebuild?.('lessons', id)
		await pair.a.whenLiveViewsIdle?.()
		// The failure was reported, and the two records behind it are still requested.
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('rebuild exploded'))
		expect(internals.liveViewRebuilds.size).toBe(2)
		// The next kick rebuilds them.
		pair.a.requestLiveViewRebuild?.('lessons', 'r3')
		await pair.a.whenLiveViewsIdle?.()
		expect(rebuilt.sort()).toEqual(['r2', 'r3'])
		expect(internals.liveViewRebuilds.size).toBe(0)
		spy.mockRestore()
		warn.mockRestore()
		await close(pair)
	})

	// Every operation that clears or invalidates the summaries, snapshots or epoch of a store
	// whose backfill had finished: the summaries must be rebuilt, and a device that missed a
	// delete made while the record was outside its view must receive it.
	const invalidations: Array<{
		name: string
		run: (pair: Pair) => Promise<ServerStore>
	}> = [
		{
			name: 'a schema change that adds a captured field (snapshot wipe)',
			run: async (pair) => {
				const changed = defineSchema({
					version: 1,
					collections: {
						lessons: {
							fields: {
								title: t.string(),
								school: t.string(),
								level: t.string().optional(),
								extra: t.string().optional(),
							},
						},
					},
				})
				await pair.a.setSchema(changed)
				return pair.a
			},
		},
		{
			name: 'a replace-mode restore',
			run: async (pair) => {
				await pair.a.importBackup(await pair.a.exportBackup(), false)
				return pair.a
			},
		},
		{
			name: 'a fold-plan change (full re-fold)',
			run: async (pair) => {
				await pair.sql('UPDATE kora_server_meta SET value = $1 WHERE key = $2', [
					'other-plan',
					FOLD_PLAN_FINGERPRINT_KEY,
				])
				const restarted = pair.reopen()
				await restarted.setSchema(schema)
				return restarted
			},
		},
	]
	for (const invalidation of invalidations) {
		test(`after ${invalidation.name} the summaries are rebuilt and a missed out-of-view delete is delivered`, async () => {
			const pair = await open(make)
			await pair.a.applyRemoteOperation(
				op('tb-ins', 'insert', 1000, { title: 'r', school: 'school-0' }),
			)
			await pair.a.applyRemoteOperation(op('tb-move', 'update', 2000, { school: 'school-1' }))
			await pair.a.applyRemoteOperation(op('tb-del', 'delete', 3000, null))
			// The backfill of the collection has finished.
			await pair.a.whenLiveViewsIdle?.()
			expect((await pair.a.getRecordLiveViews?.('lessons', ['r']))?.get('r')?.current).toBe(true)
			const log = await pair.a.getOperationsAfterDelivery(0, 100)
			const moveSeq = log.find((d) => d.operation.id === 'tb-move')?.deliverySequence ?? 0
			const store = await invalidation.run(pair)
			await store.whenLiveViewsIdle?.()
			expect((await store.getRecordLiveViews?.('lessons', ['r']))?.get('r')?.current).toBe(true)
			// A school-0 device that saw the insert and the move (it keeps or hides the record)
			// reconnects after the move: the delete is outside its view but it held the record.
			const received = await stream(store, { school: 'school-0', from: moveSeq })
			expect(received.map((o) => o.id)).toContain('tb-del')
			await close(pair, ...(store === pair.a ? [] : [store]))
		})
	}

	// The collection pass yields between records; an invalidation landing there must not be
	// undone by the pass's cursor write.
	const interleaved: Array<{ name: string; run: (pair: Pair) => Promise<void> }> = [
		{
			name: 'a replace-mode restore',
			run: async (pair) => {
				await pair.a.importBackup(await pair.a.exportBackup(), false)
			},
		},
		{
			name: 'a schema change that adds a captured field',
			run: async (pair) => {
				await pair.a.setSchema(
					defineSchema({
						version: 1,
						collections: {
							lessons: {
								fields: {
									title: t.string(),
									school: t.string(),
									level: t.string().optional(),
									extra: t.string().optional(),
								},
							},
						},
					}),
				)
			},
		},
	]
	for (const invalidation of interleaved) {
		test(`${invalidation.name} landing between two records of the backfill pass is not undone by its cursor write`, async () => {
			const pair = await open(make)
			// The second store on this database runs its own backfill passes; only one pass
			// may interleave with the invalidation under test.
			await pair.b.close()
			await pair.a.applyRemoteOperation(
				op('bi-ins', 'insert', 1000, { title: 'r', school: 'school-0' }),
			)
			await pair.a.applyRemoteOperation(op('bi-move', 'update', 2000, { school: 'school-1' }))
			await pair.a.applyRemoteOperation(op('bi-del', 'delete', 3000, null))
			await pair.a.whenLiveViewsIdle?.()
			const log = await pair.a.getOperationsAfterDelivery(0, 100)
			const moveSeq = log.find((d) => d.operation.id === 'bi-move')?.deliverySequence ?? 0
			// A fresh pass over the collection: the finished cursor is gone.
			await pair.sql('DELETE FROM kora_server_meta WHERE key LIKE $1', ['live_view_cursor:%'])
			const internals = pair.a as unknown as {
				kickLiveViewBackfill: () => void
				rebuildRecordLiveViews: (
					collection: string,
					recordId: string,
					force: boolean,
				) => Promise<void>
			}
			const original = internals.rebuildRecordLiveViews.bind(internals)
			let interleavedOnce = false
			const spy = vi
				.spyOn(internals, 'rebuildRecordLiveViews')
				.mockImplementation(async (collection, recordId, force) => {
					await original(collection, recordId, force)
					// The pass's own rebuild of a record (not a requested one) has just finished.
					if (!force && !interleavedOnce) {
						interleavedOnce = true
						await invalidation.run(pair)
					}
				})

			internals.kickLiveViewBackfill()
			await pair.a.whenLiveViewsIdle?.()
			spy.mockRestore()
			expect(interleavedOnce).toBe(true)
			expect((await pair.a.getRecordLiveViews?.('lessons', ['r']))?.get('r')?.current).toBe(true)
			const received = await stream(pair.a, { school: 'school-0', from: moveSeq })
			expect(received.map((o) => o.id)).toContain('bi-del')
			await close(pair)
		})
	}

	test('a replace-mode restore rebuilds the summaries of the restored log in the background', async () => {
		const pair = await open(make)
		await pair.a.applyRemoteOperation(op('ins', 'insert', 1000, { title: 'r', school: 'school-0' }))
		await pair.a.applyRemoteOperation(op('del', 'delete', 2000, null))
		await pair.a.whenLiveViewsIdle?.()
		expect((await pair.a.getRecordLiveViews?.('lessons', ['r']))?.get('r')?.current).toBe(true)
		const backup = await pair.a.exportBackup()
		await pair.a.importBackup(backup, false)
		await pair.a.whenLiveViewsIdle?.()
		// No delivery pass asked for it: the restore itself schedules the rebuild.
		expect((await pair.a.getRecordLiveViews?.('lessons', ['r']))?.get('r')?.current).toBe(true)
		await close(pair)
	})

	test('a version-vector delta carries a replayed delete once', async () => {
		const pair = await open(make)
		const ins = op('v-ins', 'insert', 1000, { title: 'r', school: 'school-0' }, 'r', 'node-a')
		const stale = op('v-stale', 'update', 1500, { title: 'stale' }, 'r', 'node-a')
		const del = {
			...op('v-del', 'delete', 2000, null, 'r', 'node-b'),
			causalDeps: [ins.id],
		}
		for (const o of [ins, del, stale]) await pair.a.applyRemoteOperation(o)
		await pair.a.whenLiveViewsIdle?.()
		const auth: AuthProvider = {
			authenticate: async () => ({ userId: 'u', scopes: { lessons: { school: 'school-0' } } }),
		}
		const { client, server } = createServerTransportPair()
		const messages: SyncMessage[] = []
		client.onMessage((message) => messages.push(message))
		new ClientSession({
			sessionId: `s-${Math.random()}`,
			transport: server,
			store: pair.a,
			auth,
		}).start()
		// No delivery watermark: the version-vector path.
		client.send({
			type: 'handshake',
			messageId: 'hs',
			nodeId: 'device-vv',
			versionVector: {},
			schemaVersion: 1,
			authToken: 'token',
		} as never)
		await vi.waitFor(() =>
			expect(messages.some((m) => m.type === 'operation-batch' || m.type === 'error')).toBe(true),
		)
		expect(messages.filter((m) => m.type === 'error')).toEqual([])
		const ids = messages
			.filter((m): m is OperationBatchMessage => m.type === 'operation-batch')
			.flatMap((batch) => batch.operations.map((o) => o.id))
		expect(ids.filter((id) => id === del.id)).toHaveLength(1)
		expect(ids).toContain(stale.id)
		await close(pair)
	})

	test('a delete that carries the record reaches a view that held only an earlier version elsewhere, without the record', async () => {
		const pair = await open(make)
		await pair.a.applyRemoteOperation(
			op('m-ins', 'insert', 1000, { title: 't', school: 'school-0' }),
		)
		await pair.a.applyRemoteOperation(op('m-move', 'update', 2000, { school: 'school-1' }))
		await pair.a.applyRemoteOperation(op('m-priv', 'update', 3000, { title: 'PRIVATE-B' }))
		// What a delete made through a server route carries: the record it removed.
		await pair.a.applyRemoteOperation({
			...op('m-del', 'delete', 4000, null),
			previousData: { id: 'r', title: 'PRIVATE-B', school: 'school-1' },
		})
		await pair.a.whenLiveViewsIdle?.()
		const seen = await stream(pair.a, { school: 'school-0' })
		expect(JSON.stringify(seen)).not.toContain('PRIVATE-B')
		// The view still learns that the record is gone.
		const deletion = seen.find((o) => o.id === 'm-del')
		expect(deletion?.type).toBe('delete')
		expect(deletion?.previousData).toBeNull()
		await close(pair)
	})

	test('a snapshot wipe takes the epoch lock before the operation rows (no deadlock with a rebuild)', async () => {
		const pair = await open(make)
		const connect = pair.connect
		if (!connect) {
			// SQLite takes no such locks.
			await close(pair)
			return
		}
		for (const id of ['d1', 'd2']) {
			await pair.a.applyRemoteOperation(
				op(`w-${id}`, 'insert', 1000, { title: id, school: 'school-0' }, id),
			)
		}
		await pair.a.whenLiveViewsIdle?.()
		await pair.b.whenLiveViewsIdle?.()
		await pair.sql(
			"INSERT INTO kora_server_meta (key, value) VALUES ('live_view_epoch', '0') ON CONFLICT (key) DO NOTHING",
		)
		// A rebuild holds the epoch row (shared) before it writes snapshots.
		const holder = await connect().reserve()
		await holder.unsafe('BEGIN')
		await holder.unsafe(
			"SELECT value FROM kora_server_meta WHERE key = 'live_view_epoch' FOR SHARE",
		)
		const changed = defineSchema({
			version: 1,
			collections: {
				lessons: {
					fields: {
						title: t.string(),
						school: t.string(),
						level: t.string().optional(),
						extra: t.string().optional(),
					},
				},
			},
		})
		// A schema that changes the captured fields wipes every snapshot.
		const wipe = pair.b.setSchema(changed)
		await vi.waitFor(async () => {
			const waiting = await pair.sql(
				`SELECT count(*)::int AS n FROM pg_stat_activity
				 WHERE wait_event_type = 'Lock' AND datname = current_database()
				   AND query ILIKE 'INSERT INTO kora_server_meta%'`,
			)
			expect(Number(waiting[0]?.n)).toBeGreaterThan(0)
		})
		// Waiting for the epoch, the wipe holds no operation row (else a rebuild that locks
		// the epoch first and then a row would deadlock with it).
		await expect(pair.sql('SELECT id FROM operations FOR UPDATE NOWAIT', [])).resolves.toBeDefined()
		await holder.unsafe('COMMIT')
		holder.release()
		await wipe
		await close(pair)
	})
})

test('the memory store rebuilds the summaries of a replace-mode restore at once', async () => {
	const store = new MemoryServerStore()
	await store.setSchema(schema)
	await store.registerLiveViewFields?.('lessons', ['school'])
	await store.applyRemoteOperation(
		op('mem-ins', 'insert', 1000, { title: 'r', school: 'school-0' }),
	)
	await store.applyRemoteOperation(op('mem-del', 'delete', 2000, null))
	const backup = await store.exportBackup()
	await store.importBackup(backup, false)
	expect((await store.getRecordLiveViews?.('lessons', ['r']))?.get('r')?.current).toBe(true)
	await store.close()
})

describe('the memory store after an operation that clears its summaries', () => {
	const changed = defineSchema({
		version: 1,
		collections: {
			lessons: {
				fields: {
					title: t.string(),
					school: t.string(),
					level: t.string().optional(),
					extra: t.string().optional(),
				},
			},
		},
	})
	const cases: Array<[string, (store: MemoryServerStore) => Promise<void>]> = [
		['a schema change that adds a captured field', (store) => store.setSchema(changed)],
		[
			'a replace-mode restore',
			async (store) => {
				await store.importBackup(await store.exportBackup(), false)
			},
		],
	]
	for (const [name, run] of cases) {
		test(`after ${name} the summaries are rebuilt and a missed out-of-view delete is delivered`, async () => {
			const store = new MemoryServerStore()
			await store.setSchema(schema)
			await store.registerLiveViewFields?.('lessons', ['school'])
			await store.applyRemoteOperation(
				op('mm-ins', 'insert', 1000, { title: 'r', school: 'school-0' }),
			)
			await store.applyRemoteOperation(op('mm-move', 'update', 2000, { school: 'school-1' }))
			await store.applyRemoteOperation(op('mm-del', 'delete', 3000, null))
			const log = await store.getOperationsAfterDelivery(0, 100)
			const moveSeq = log.find((d) => d.operation.id === 'mm-move')?.deliverySequence ?? 0
			await run(store)
			expect((await store.getRecordLiveViews?.('lessons', ['r']))?.get('r')?.current).toBe(true)
			const received = await stream(store, { school: 'school-0', from: moveSeq })
			expect(received.map((o) => o.id)).toContain('mm-del')
			await store.close()
		})
	}
})
