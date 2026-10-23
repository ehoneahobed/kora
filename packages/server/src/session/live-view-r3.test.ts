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
		await overflowedRecord(pair.a)
		await pair.a.applyRemoteOperation(op('del', 'delete', 3000, null))
		await pair.a.applyRemoteOperation(op('stale', 'update', 2500, { title: 'STALE' }))
		await pair.a.applyRemoteOperation(op('revive', 'update', 4000, { level: 'x' }))
		expect((await pair.a.getRecordLiveViews?.('lessons', ['r']))?.get('r')?.views.overflow).toBe(
			true,
		)
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
					pair.sqlSync(`UPDATE operations SET delivery_seq = delivery_seq - 1`)
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

	test('L2: a fold-plan change leaves every summary unknown', async () => {
		const pair = await open(make)
		await pair.a.applyRemoteOperation(op('ins', 'insert', 1000, { title: 'r', school: 'school-0' }))
		expect((await pair.a.getRecordLiveViews?.('lessons', ['r']))?.get('r')?.current).toBe(true)
		await pair.sql(`UPDATE kora_server_meta SET value = 'other-plan' WHERE key = $1`, [
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
})
