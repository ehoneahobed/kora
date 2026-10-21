import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import type { OperationBatchMessage, SyncMessage } from '@korajs/sync'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { PostgresServerStore } from '../store/postgres-server-store'
import { RecordHistoryReplayer, replayRecordHistory } from '../store/scope-snapshot'
import type { ServerStore } from '../store/server-store'
import { SqliteServerStore } from '../store/sqlite-server-store'
import { createServerTransportPair } from '../transport/memory-server-transport'
import type { AuthProvider } from '../types'
import { ClientSession } from './client-session'

/**
 * A live-view summary is exact or unknown, never wrong (round-2 review of #65, H1/M1).
 * Each case is one way a summary can miss a write: a write by an instance that does not
 * maintain it (an older version during a rolling deploy), a second instance whose field
 * cache is stale, a backfill racing a write, and a replace-mode restore. A later write
 * must never make such a summary read as current again.
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

/** Two stores on one database (two instances), and raw SQL on it. */
interface Pair {
	a: ServerStore
	b: ServerStore
	sql: (query: string, params?: unknown[]) => Promise<Record<string, unknown>[]>
	done: () => Promise<void>
}

const PG_URL = process.env.KORA_PG_TEST_URL
const tmp = mkdtempSync(join(tmpdir(), 'kora-lv-trust-'))
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
			return {
				a: new SqliteServerStore(drizzle(dbA), 's'),
				b: new SqliteServerStore(drizzle(dbB), 's'),
				sql: async (query, params = []) => {
					const statement = dbA.prepare(query)
					if (statement.reader) return statement.all(...params) as Record<string, unknown>[]
					statement.run(...params)
					return []
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
			const name = `kora_lv_trust_${process.pid}_${made}`
			const admin = postgres(PG_URL, { max: 1 })
			await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
			await admin.unsafe(`CREATE SCHEMA ${name}`)
			await admin.end()
			const clientA = postgres(PG_URL, { max: 4, connection: { search_path: name } })
			const clientB = postgres(PG_URL, { max: 4, connection: { search_path: name } })
			return {
				a: new PostgresServerStore(drizzlePg(clientA), 's'),
				b: new PostgresServerStore(drizzlePg(clientB), 's'),
				sql: async (query, params = []) =>
					[...(await clientA.unsafe(query, params as never[]))] as Record<string, unknown>[],
				done: async () => {
					await clientA.end()
					await clientB.end()
					const drop = postgres(PG_URL, { max: 1 })
					await drop.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
					await drop.end()
				},
			}
		},
	])
}

async function stream(store: ServerStore, school: string): Promise<string[]> {
	const auth: AuthProvider = {
		authenticate: async () => ({ userId: school, scopes: { lessons: { school } } }),
	}
	const { client, server } = createServerTransportPair()
	const messages: SyncMessage[] = []
	client.onMessage((message) => messages.push(message))
	new ClientSession({ sessionId: school, transport: server, store, auth }).start()
	client.send({
		type: 'handshake',
		messageId: 'hs',
		nodeId: `device-${school}-${Math.random()}`,
		versionVector: {},
		schemaVersion: 1,
		authToken: 'token',
		lastDeliverySequence: 0,
	})
	const batches = (): OperationBatchMessage[] =>
		messages.filter((m): m is OperationBatchMessage => m.type === 'operation-batch')
	await vi.waitFor(() => expect(batches().some((batch) => batch.isFinal)).toBe(true))
	return batches().flatMap((batch) => batch.operations.map((sent) => sent.id))
}

/**
 * Apply `operation` as an instance that knows nothing of live views would (an older
 * version during a rolling deploy): the fold-state live-view columns, the summary row
 * and the snapshot's tombstone state stay as they were before it.
 */
async function applyAsOlderInstance(
	pair: Pair,
	store: ServerStore,
	operation: Operation,
): Promise<void> {
	const p = (n: number): string => (PG_URL && pair.sql.length >= 0 && isPg(pair) ? `$${n}` : '?')
	const fold = await pair.sql(
		`SELECT lv_through, lv_fields FROM kora_fold_state WHERE collection = ${p(1)} AND record_id = ${p(2)}`,
		['lessons', operation.recordId],
	)
	const views = await pair.sql(
		`SELECT views FROM kora_record_live_views WHERE collection = ${p(1)} AND record_id = ${p(2)}`,
		['lessons', operation.recordId],
	)
	await store.applyRemoteOperation(operation)
	await pair.sql(
		`UPDATE kora_fold_state SET lv_through = ${p(1)}, lv_fields = ${p(2)} WHERE collection = ${p(3)} AND record_id = ${p(4)}`,
		[fold[0]?.lv_through ?? null, fold[0]?.lv_fields ?? null, 'lessons', operation.recordId],
	)
	if (views[0]) {
		await pair.sql(
			`UPDATE kora_record_live_views SET views = ${p(1)} WHERE collection = ${p(2)} AND record_id = ${p(3)}`,
			[views[0].views, 'lessons', operation.recordId],
		)
	} else {
		await pair.sql(
			`DELETE FROM kora_record_live_views WHERE collection = ${p(1)} AND record_id = ${p(2)}`,
			['lessons', operation.recordId],
		)
	}
	const snapshot = await pair.sql(`SELECT scope_snapshot FROM operations WHERE id = ${p(1)}`, [
		operation.id,
	])
	const parsed = JSON.parse(String(snapshot[0]?.scope_snapshot)) as Record<string, unknown>
	parsed.deleted = undefined
	await pair.sql(`UPDATE operations SET scope_snapshot = ${p(1)} WHERE id = ${p(2)}`, [
		JSON.stringify(parsed),
		operation.id,
	])
}

const pgPairs = new WeakSet<Pair>()
function isPg(pair: Pair): boolean {
	return pgPairs.has(pair)
}

async function open(kind: string, make: () => Promise<Pair>, register = true): Promise<Pair> {
	const pair = await make()
	if (kind === 'postgres') pgPairs.add(pair)
	// B starts first: its cache of registered fields is read before A registers.
	await pair.b.setSchema(schema)
	await pair.a.setSchema(schema)
	if (register) await pair.a.registerLiveViewFields?.('lessons', ['school'])
	return pair
}

async function close(pair: Pair): Promise<void> {
	await pair.a.close()
	await pair.b.close()
	await pair.done()
}

/** Every summary that reads as current equals a rebuild from the log. */
async function expectTrustworthy(store: ServerStore, recordIds: string[]): Promise<number> {
	const states = (await store.getRecordLiveViews?.('lessons', recordIds)) ?? new Map()
	const log = await store.getOperationsAfterDelivery(0, 100_000)
	let current = 0
	for (const [recordId, state] of states) {
		if (!state.current) continue
		current += 1
		const history = log.filter(
			(delivered) =>
				delivered.operation.collection === 'lessons' && delivered.operation.recordId === recordId,
		)
		const rebuilt = replayRecordHistory(
			schema,
			'lessons',
			recordId,
			history,
			{},
			state.views.fields,
		)
		expect({ record: recordId, versions: state.views.versions }).toEqual({
			record: recordId,
			versions: rebuilt.views?.versions,
		})
		expect(state.views.newestDelete?.id ?? null).toBe(rebuilt.views?.newestDelete?.id ?? null)
	}
	return current
}

describe.each(kinds)('live-view summaries stay exact or unknown (%s)', (kind, make) => {
	test('a write by an older instance leaves the summary unknown; a later write does not make it current', async () => {
		const pair = await open(kind, make)
		await pair.a.applyRemoteOperation(op('ins', 'insert', 1000, { title: 'r', school: 'school-1' }))
		await applyAsOlderInstance(pair, pair.a, op('movein', 'update', 2000, { school: 'school-0' }))
		await pair.a.applyRemoteOperation(op('moveout', 'update', 3000, { school: 'school-1' }))
		await pair.a.applyRemoteOperation(op('del', 'delete', 4000, null))
		const state = (await pair.a.getRecordLiveViews?.('lessons', ['r']))?.get('r')
		expect(state?.current).toBe(false)
		// Unknown: the delete is judged on its own values (school-1), and a rebuild is asked for.
		expect(await stream(pair.a, 'school-0')).toEqual(['movein'])
		await pair.a.whenLiveViewsIdle?.()
		expect(await expectTrustworthy(pair.a, ['r'])).toBe(1)
		// Rebuilt from the log: school-0 held it, so the delete reaches a school-0 device.
		expect(await stream(pair.a, 'school-0')).toEqual(['movein', 'del'])
		await close(pair)
	})

	test('a second instance with a stale field cache still maintains the summary', async () => {
		const pair = await open(kind, make)
		await pair.a.applyRemoteOperation(op('ins', 'insert', 1000, { title: 'r', school: 'school-1' }))
		// B has not seen the registration yet: it maintains the summary anyway.
		await pair.b.applyRemoteOperation(op('movein', 'update', 2000, { school: 'school-0' }))
		await pair.a.applyRemoteOperation(op('moveout', 'update', 3000, { school: 'school-1' }))
		await pair.a.applyRemoteOperation(op('del', 'delete', 4000, null))
		expect((await pair.a.getRecordLiveViews?.('lessons', ['r']))?.get('r')?.current).toBe(true)
		expect(await expectTrustworthy(pair.a, ['r'])).toBe(1)
		expect(await stream(pair.a, 'school-0')).toEqual(['movein', 'del'])
		await close(pair)
	})

	test('a backfill racing writes never leaves a current summary that misses one', async () => {
		const pair = await open(kind, make, false)
		const ids = Array.from({ length: 12 }, (_, i) => `rec-${i}`)
		for (const [i, id] of ids.entries()) {
			await pair.a.applyRemoteOperation(
				op(`${id}-ins`, 'insert', 1000 + i, { title: id, school: 'school-0' }, id),
			)
		}
		// Each record's rebuild reads the log, then a write lands before its guarded write.
		const raced: Promise<unknown>[] = []
		const original = RecordHistoryReplayer.prototype.push
		const spy = vi.spyOn(RecordHistoryReplayer.prototype, 'push').mockImplementation(function (
			this: RecordHistoryReplayer,
			delivered,
		) {
			original.call(this, delivered)
			const recordId = delivered[0]?.operation.recordId
			if (recordId && raced.length < ids.length) {
				raced.push(
					pair.b.applyRemoteOperation(
						op(
							`${recordId}-move-${raced.length}`,
							'update',
							5000 + raced.length,
							{ school: 'school-1' },
							recordId,
						),
					),
				)
			}
		})
		await pair.a.registerLiveViewFields?.('lessons', ['school'])
		await pair.a.whenLiveViewsIdle?.()
		await Promise.all(raced)
		spy.mockRestore()
		await expectTrustworthy(pair.a, ids)
		// Requested again, every record is rebuilt to an exact, current summary.
		for (const id of ids) pair.a.requestLiveViewRebuild?.('lessons', id)
		await pair.a.whenLiveViewsIdle?.()
		expect(await expectTrustworthy(pair.a, ids)).toBe(ids.length)
		await close(pair)
	})

	test('a replace-mode restore leaves no summary of the replaced log', async () => {
		const pair = await open(kind, make)
		await pair.a.applyRemoteOperation(op('ins', 'insert', 1000, { title: 'r', school: 'school-0' }))
		const backup = await pair.a.exportBackup()
		// Written after the backup and not re-uploaded: r2's sequences differ after the restore.
		await pair.a.applyRemoteOperation(
			op('r3-ins', 'insert', 1500, { title: 'r3', school: 'school-0' }, 'r3'),
		)
		const created = [
			op('r2-ins', 'insert', 2000, { title: 'r2', school: 'school-1' }, 'r2'),
			op('r2-move', 'update', 3000, { school: 'school-2' }, 'r2'),
		]
		for (const operation of created) await pair.a.applyRemoteOperation(operation)
		await pair.a.importBackup(backup)
		const rows = await pair.a.getRecordLiveViews?.('lessons', ['r', 'r2'])
		expect([...(rows?.values() ?? [])].filter((state) => state.current)).toEqual([])
		// The device re-uploads r2, then one more write lands.
		for (const operation of created) await pair.a.applyRemoteOperation(operation)
		await pair.a.applyRemoteOperation(op('r2-more', 'update', 4000, { title: 'again' }, 'r2'))
		await pair.a.applyRemoteOperation(op('r2-last', 'update', 4100, { school: 'school-0' }, 'r2'))
		await expectTrustworthy(pair.a, ['r', 'r2'])
		await pair.a.whenLiveViewsIdle?.()
		await expectTrustworthy(pair.a, ['r', 'r2'])
		await close(pair)
	})
})
