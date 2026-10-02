import { type Operation, quoteIdent } from '@korajs/core'
import type { OperationBatchMessage, SyncMessage } from '@korajs/sync'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import {
	type ScopeMap,
	missingScopeFields,
	operationMatchesScopes,
	recordMatchesScopes,
} from '../../src/scopes/server-scope-filter'
import { ClientSession } from '../../src/session/client-session'
import { PostgresServerStore } from '../../src/store/postgres-server-store'
import { createServerTransportPair } from '../../src/transport/memory-server-transport'
import { COLLECTIONS, bulkLoadOps, generateOps, lmsSchema, proposedBackfill } from './lms-fixture'

/**
 * LMS-11 (external report, Part D #11) on real Postgres: a fresh scoped client's first
 * delivery stream. Measures HEAD (the real ClientSession) and three alternative
 * visibility strategies over the same data with the same scope predicate functions:
 *   - proposed: preload every row of every scoped collection into a Map (+ deny-set,
 *     no retractions at 0, scan chunk batchSize*20)
 *   - batched:  per scan chunk, one `id = ANY($ids)` lookup per collection
 *   - pushdown: scope key denormalized onto the op row at write time + index, so the
 *     scan itself filters in SQL (the state-of-the-art shape)
 * Requires KORA_PG_TEST_URL. LMS_OPS sets the volume (default 50k).
 */
const PG_URL = process.env.KORA_PG_TEST_URL
const OPS = Number(process.env.LMS_OPS ?? 50_000)
const PG_SCHEMA = 'kora_lms11'
const SCHOOL = 'school-3'
const DENIED = new Set(COLLECTIONS.slice(20)) // 7 collections this role may not see

function scopesWithSentinel(): ScopeMap {
	return Object.fromEntries(
		COLLECTIONS.map((c) => [c, { schoolId: DENIED.has(c) ? '__none__' : SCHOOL }]),
	)
}
function scopesOmitting(): ScopeMap {
	return Object.fromEntries(
		COLLECTIONS.filter((c) => !DENIED.has(c)).map((c) => [c, { schoolId: SCHOOL }]),
	)
}

describe.skipIf(!PG_URL)('LMS-11: first delivery stream on Postgres', () => {
	let admin: postgres.Sql
	let sql: postgres.Sql
	let store: PostgresServerStore
	let queries = 0

	beforeAll(async () => {
		admin = postgres(PG_URL as string, {
			max: 4,
			onnotice: () => {},
			connection: { search_path: PG_SCHEMA },
		})
		await admin.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`)
		await admin.unsafe(`CREATE SCHEMA ${PG_SCHEMA}`)
		sql = postgres(PG_URL as string, {
			max: 10,
			onnotice: () => {},
			connection: { search_path: PG_SCHEMA },
			debug: () => {
				queries += 1
			},
		})
		const boot = new PostgresServerStore(drizzle(sql), 'boot')
		await boot.setSchema(lmsSchema)
		await admin.unsafe('ALTER TABLE operations ADD COLUMN scope_key TEXT')
		await bulkLoadOps(admin, generateOps(OPS), true)
		await proposedBackfill(admin, lmsSchema, { concurrency: 2, batch: 500 }) // = HEAD state (LMS-10)
		await admin.unsafe('CREATE INDEX ops_scope_seq ON operations (scope_key, delivery_seq)')
		await admin.unsafe('ANALYZE')
		store = new PostgresServerStore(drizzle(sql), 'srv')
		await store.setSchema(lmsSchema) // HEAD re-backfills on every start (see LMS-10)
	}, 900_000)

	afterAll(async () => {
		await sql?.end()
		await admin?.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`)
		await admin?.end()
	})

	async function runHead(
		scopes: ScopeMap,
		policy: 'retain' | 'retract',
	): Promise<{
		ms: number
		firstBatchMs: number
		queries: number
		ops: number
		retractions: number
		bytes: number
	}> {
		const { client, server } = createServerTransportPair()
		const messages: SyncMessage[] = []
		let firstBatchAt = 0
		const t0 = performance.now()
		client.onMessage((m) => {
			if (m.type === 'operation-batch' && firstBatchAt === 0) firstBatchAt = performance.now()
			messages.push(m)
		})
		const session = new ClientSession({
			sessionId: `s-${policy}`,
			transport: server,
			store,
			auth: { authenticate: async () => ({ userId: 'student', scopes }) },
		})
		queries = 0
		session.start()
		client.send({
			type: 'handshake',
			messageId: 'hs',
			nodeId: 'fresh-phone',
			versionVector: {},
			schemaVersion: 1,
			authToken: 'ok',
			lastDeliverySequence: 0,
			scopeExitPolicy: policy,
		} as SyncMessage)
		const isBatch = (m: SyncMessage): m is OperationBatchMessage => m.type === 'operation-batch'
		await vi.waitFor(() => expect(messages.filter(isBatch).some((b) => b.isFinal)).toBe(true), {
			timeout: 600_000,
			interval: 20,
		})
		const ms = performance.now() - t0
		const b = messages.filter(isBatch)
		session.close('done')
		return {
			ms,
			firstBatchMs: firstBatchAt - t0,
			queries,
			ops: b.reduce((n, x) => n + x.operations.length, 0),
			retractions: b.reduce((n, x) => n + (x.retractions?.length ?? 0), 0),
			bytes: b.reduce((n, x) => n + JSON.stringify(x).length, 0),
		}
	}

	test(`benchmark: fresh scoped client, ${OPS} ops, 27 collections, sees ~5%`, async () => {
		const sentinelRetain = await runHead(scopesWithSentinel(), 'retain')
		const sentinelRetract = await runHead(scopesWithSentinel(), 'retract')
		const omitRetain = await runHead(scopesOmitting(), 'retain')

		// --- proposed (#11.1-11.4), re-implemented over the same store -------------
		const scopes = scopesWithSentinel()
		queries = 0
		const heap0 = process.memoryUsage().heapUsed
		let t0 = performance.now()
		const preload = new Map<string, Map<string, Record<string, unknown>>>()
		let preloadedRows = 0
		for (const c of COLLECTIONS) {
			if ((scopes[c] as Record<string, unknown>).schoolId === '__none__') continue
			const rows = await store.queryCollection(c, { includeDeleted: true })
			preloadedRows += rows.length
			preload.set(c, new Map(rows.map((r) => [r.id, r])))
		}
		const preloadHeap = process.memoryUsage().heapUsed - heap0
		let cursor = 0
		let proposedSent = 0
		for (;;) {
			const chunk = await store.getOperationsAfterDelivery(cursor, 100 * 20)
			const last = chunk[chunk.length - 1]
			if (!last) break
			cursor = last.deliverySequence
			for (const { operation } of chunk) {
				if (
					(scopes[operation.collection] as Record<string, unknown> | undefined)?.schoolId ===
					'__none__'
				)
					continue
				const full = preload.get(operation.collection)?.get(operation.recordId)
				if (operationMatchesScopes(operation, scopes, full)) proposedSent++
			}
			if (chunk.length < 2000) break
		}
		const proposedMs = performance.now() - t0
		const proposedQueries = queries

		// --- batched IN() lookups per scan chunk (bounded memory, fresh data) -----------
		queries = 0
		t0 = performance.now()
		cursor = 0
		let batchedSent = 0
		for (;;) {
			const chunk = await store.getOperationsAfterDelivery(cursor, 500)
			const last = chunk[chunk.length - 1]
			if (!last) break
			cursor = last.deliverySequence
			const need = new Map<string, Set<string>>()
			for (const { operation } of chunk) {
				if (missingScopeFields(operation, scopes).length > 0) {
					const s = need.get(operation.collection) ?? new Set<string>()
					s.add(operation.recordId)
					need.set(operation.collection, s)
				}
			}
			const found = new Map<string, Record<string, unknown>>()
			for (const [c, ids] of need) {
				const rows = await sql.unsafe(`SELECT * FROM ${quoteIdent(c)} WHERE id = ANY($1)`, [
					[...ids],
				] as never[])
				for (const r of rows) found.set(`${c}/${r.id}`, r)
			}
			for (const { operation } of chunk) {
				const full = found.get(`${operation.collection}/${operation.recordId}`)
				if (operationMatchesScopes(operation, scopes, full)) batchedSent++
			}
			if (chunk.length < 500) break
		}
		const batchedMs = performance.now() - t0
		const batchedQueries = queries

		// --- SQL push-down on a write-time denormalized scope key -----------------------
		const allowed = COLLECTIONS.filter((c) => !DENIED.has(c))
		queries = 0
		t0 = performance.now()
		let pushdownSent = 0
		let pc = 0
		for (;;) {
			const rows = await sql`
				SELECT id, delivery_seq FROM operations
				WHERE scope_key = ${SCHOOL} AND collection = ANY(${allowed}) AND delivery_seq > ${pc}
				ORDER BY delivery_seq LIMIT 500`
			if (rows.length === 0) break
			pushdownSent += rows.length
			pc = Number(rows[rows.length - 1]?.delivery_seq)
			if (rows.length < 500) break
		}
		const pushdownMs = performance.now() - t0
		const pushdownQueries = queries
		const plan = await admin.unsafe(
			`EXPLAIN SELECT id FROM operations WHERE scope_key = '${SCHOOL}' AND delivery_seq > 0 ORDER BY delivery_seq LIMIT 500`,
		)

		const fmt = (r: Awaited<ReturnType<typeof runHead>>): string =>
			`${r.ms.toFixed(0)} ms total, first batch at ${r.firstBatchMs.toFixed(0)} ms, ${r.queries} SQL, ${r.ops} ops + ${r.retractions} retractions sent, ${(r.bytes / 1024).toFixed(0)} KiB`
		console.log(
			[
				`[LMS-11] ops=${OPS}, user school=${SCHOOL}, 20 scoped + 7 denied collections, local PG over loopback`,
				`  HEAD  '__none__' sentinel, retain : ${fmt(sentinelRetain)}`,
				`  HEAD  '__none__' sentinel, retract: ${fmt(sentinelRetract)}`,
				`  HEAD  denied collections omitted  : ${fmt(omitRetain)}`,
				`  proposed preload+deny+chunk*20    : ${proposedMs.toFixed(0)} ms, ${proposedQueries} SQL, preloaded ${preloadedRows} rows (all tenants), heap +${(preloadHeap / 1e6).toFixed(1)} MB, ${proposedSent} visible`,
				`  batched ANY($ids) per 500-op chunk: ${batchedMs.toFixed(0)} ms, ${batchedQueries} SQL, ${batchedSent} visible`,
				`  write-time scope key + index      : ${pushdownMs.toFixed(0)} ms, ${pushdownQueries} SQL, ${pushdownSent} ops`,
				`  pushdown plan: ${plan.map((p) => p['QUERY PLAN']).join(' | ')}`,
			].join('\n'),
		)
		// Since RT-14 HEAD judges each operation on the scope values the record had when the
		// operation was applied (its stored scope snapshot), not on the current row: updates
		// written while a record was in scope are delivered even if it left the scope
		// later, and nothing written before it entered the scope is. The two cheaper
		// strategies above emulate the previous current-row rule, so they agree with each
		// other, and HEAD agrees with a reference count over the stored snapshots.
		let cursorRef = 0
		let snapshotVisible = 0
		for (;;) {
			const chunk = await store.getOperationsAfterDelivery(cursorRef, 2000)
			const last = chunk[chunk.length - 1]
			if (!last) break
			cursorRef = last.deliverySequence
			for (const { operation, scopeSnapshot } of chunk) {
				const post = scopeSnapshot?.post
				if (
					post &&
					recordMatchesScopes(operation.collection, { ...post, id: operation.recordId }, scopes)
				)
					snapshotVisible++
			}
			if (chunk.length < 2000) break
		}
		expect(sentinelRetain.ops).toBe(snapshotVisible)
		expect(batchedSent).toBe(proposedSent)
	}, 1_800_000)
})
