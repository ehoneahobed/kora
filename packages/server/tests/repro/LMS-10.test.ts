import { type SchemaDefinition, defineSchema, quoteIdent, t } from '@korajs/core'
import type { OperationBatchMessage, SyncMessage } from '@korajs/sync'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { ClientSession } from '../../src/session/client-session'
import { PostgresServerStore } from '../../src/store/postgres-server-store'
import { createServerTransportPair } from '../../src/transport/memory-server-transport'
import { COLLECTIONS, bulkLoadOps, generateOps, lmsSchema, proposedBackfill } from './lms-fixture'

/**
 * LMS-10 (external report, Part D #10): Postgres materialization backfill at cold start.
 *
 * Benchmarks HEAD's sequential, row-at-a-time backfill against a faithful
 * re-implementation of the report's proposal (4 collections in parallel, 500-row
 * multi-row upserts, one transaction per collection), and pins two correctness defects
 * that neither version fixes. Requires KORA_PG_TEST_URL. Op volume: LMS_OPS (default 50k).
 */
const PG_URL = process.env.KORA_PG_TEST_URL
const OPS = Number(process.env.LMS_OPS ?? 50_000)
const PG_SCHEMA = 'kora_lms10'

function counted(): { sql: postgres.Sql; queries: () => number; reset: () => void } {
	let n = 0
	const sql = postgres(PG_URL as string, {
		max: 10,
		onnotice: () => {},
		connection: { search_path: PG_SCHEMA },
		debug: () => {
			n += 1
		},
	})
	return {
		sql,
		queries: () => n,
		reset: () => {
			n = 0
		},
	}
}

async function dropAll(admin: postgres.Sql, schema: SchemaDefinition): Promise<void> {
	const names = ['operations', 'sync_state', 'delivery_counter', ...Object.keys(schema.collections)]
	await admin.unsafe(`DROP TABLE IF EXISTS ${names.map(quoteIdent).join(', ')} CASCADE`)
}

async function snapshot(sql: postgres.Sql, schema: SchemaDefinition): Promise<string> {
	const parts: string[] = []
	for (const c of Object.keys(schema.collections)) {
		const fields = Object.keys(schema.collections[c]?.fields ?? {})
		const cols = ['id', ...fields, '_deleted'].map(quoteIdent).join(', ')
		const rows = await sql.unsafe(`SELECT ${cols} FROM ${quoteIdent(c)} ORDER BY id`)
		parts.push(`${c}:${JSON.stringify(rows)}`)
	}
	return parts.join('\n')
}

async function truncateMaterialized(sql: postgres.Sql, schema: SchemaDefinition): Promise<void> {
	await sql.unsafe(`TRUNCATE ${Object.keys(schema.collections).map(quoteIdent).join(', ')}`)
}

describe.skipIf(!PG_URL)('LMS-10: Postgres cold-start backfill', () => {
	let admin: postgres.Sql
	const clients: postgres.Sql[] = []

	beforeAll(async () => {
		admin = postgres(PG_URL as string, {
			max: 2,
			onnotice: () => {},
			connection: { search_path: PG_SCHEMA },
		})
		await admin.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}`)
	})
	afterAll(async () => {
		for (const c of clients) await c.end()
		await admin.end()
	})
	beforeEach(async () => {
		await dropAll(admin, lmsSchema)
		await admin.unsafe('DROP TABLE IF EXISTS lessons_wide, lessons CASCADE')
	})

	test(`benchmark: 27 collections, ${OPS} ops — HEAD vs proposed vs no-op (marker)`, async () => {
		// Create tables with an empty log, then bulk-load the op log directly.
		const boot = counted()
		clients.push(boot.sql)
		const bootStore = new PostgresServerStore(drizzle(boot.sql), 'boot')
		await bootStore.setSchema(lmsSchema)
		const rows = generateOps(OPS)
		await bulkLoadOps(admin, rows)

		// (a) HEAD cold start: a fresh store instance calling setSchema (DDL + backfill).
		const head = counted()
		clients.push(head.sql)
		const store = new PostgresServerStore(drizzle(head.sql), 'srv-1')
		await store.getOperationCount() // await ensureTables
		head.reset()
		const heap0 = process.memoryUsage().heapUsed
		let t0 = performance.now()
		await store.setSchema(lmsSchema)
		const headMs = performance.now() - t0
		const headQueries = head.queries()
		const heapPeak = process.memoryUsage().heapUsed - heap0
		const headSnap = await snapshot(admin, lmsSchema)

		// (a') HEAD warm restart: identical data already materialized; the backfill
		// still re-reads the entire log and rewrites every row.
		const warm = counted()
		clients.push(warm.sql)
		const store2 = new PostgresServerStore(drizzle(warm.sql), 'srv-2')
		await store2.getOperationCount()
		warm.reset()
		t0 = performance.now()
		await store2.setSchema(lmsSchema)
		const warmMs = performance.now() - t0
		const warmQueries = warm.queries()

		// (b) proposed fix (re-implementation), on emptied materialized tables.
		await truncateMaterialized(admin, lmsSchema)
		const prop = counted()
		clients.push(prop.sql)
		t0 = performance.now()
		await proposedBackfill(prop.sql, lmsSchema, { concurrency: 4, batch: 500 })
		const propMs = performance.now() - t0
		const propQueries = prop.queries()
		const propSnap = await snapshot(admin, lmsSchema)

		// (c) same batching, NO parallelism — isolates what concurrency actually buys.
		await truncateMaterialized(admin, lmsSchema)
		const seqc = counted()
		clients.push(seqc.sql)
		t0 = performance.now()
		await proposedBackfill(seqc.sql, lmsSchema, { concurrency: 1, batch: 500 })
		const seqMs = performance.now() - t0

		// (d) persisted-marker design: a cold start whose schema hash matches does one read.
		t0 = performance.now()
		await admin`SELECT 1`
		const markerMs = performance.now() - t0

		const records = rows.filter((r) => r.type === 'insert').length
		console.log(
			[
				`[LMS-10] ops=${OPS} records=${records} collections=${COLLECTIONS.length}`,
				`  HEAD cold  : ${headMs.toFixed(0)} ms, ${headQueries} SQL statements, heap +${(heapPeak / 1e6).toFixed(1)} MB (approx)`,
				`  HEAD warm  : ${warmMs.toFixed(0)} ms, ${warmQueries} SQL statements (data already materialized)`,
				`  proposed   : ${propMs.toFixed(0)} ms, ${propQueries} SQL statements (conc 4, batch 500, tx/collection)`,
				`  batch only : ${seqMs.toFixed(0)} ms (conc 1, batch 500)`,
				`  marker hit : ${markerMs.toFixed(1)} ms (1 statement)`,
				`  speedup proposed vs HEAD: ${(headMs / propMs).toFixed(1)}x; parallelism adds ${(seqMs / propMs).toFixed(2)}x`,
			].join('\n'),
		)
		// W7 Stage B2 inverted this check. HEAD materializes through the per-record fold
		// and keeps a fold state per record, so (NEW-SRV-4) a warm restart re-materializes
		// nothing: one aggregate read per collection page instead of a replay of the log.
		// The proposal re-implemented above is a replay of the pre-fold rules, so its rows
		// legitimately differ from HEAD's wherever the fold changed semantics (for example
		// a partial update restating a field unchanged is no longer a write); it stays
		// only as a timing reference.
		void propSnap
		expect(store2.getFoldMigrationReport().records).toBe(0)
		expect(warmQueries).toBeLessThan(records / 10)
		expect(await snapshot(admin, lmsSchema)).not.toBe('')
		void headSnap
	}, 900_000)

	test('proposed fix defect: a fixed 500-row batch exceeds the Postgres 65535 bind-parameter limit on wide collections', async () => {
		const fields: Record<string, ReturnType<typeof t.string>> = {}
		for (let i = 0; i < 140; i++) fields[`f${i}`] = t.string()
		const wide = defineSchema({
			version: 1,
			collections: { lessons_wide: { fields } },
		}) as SchemaDefinition
		const c = counted()
		clients.push(c.sql)
		const s = new PostgresServerStore(drizzle(c.sql), 'w')
		await s.setSchema(wide)
		const rows = Array.from({ length: 600 }, (_, i) => ({
			id: `w-${i}`,
			node_id: 'n',
			type: 'insert',
			collection: 'lessons_wide',
			record_id: `r-${i}`,
			data: JSON.stringify(Object.fromEntries(Object.keys(fields).map((f) => [f, 'v']))),
			previous_data: null,
			atomic_ops: null,
			wall_time: 1_000 + i,
			logical: 0,
			timestamp_node_id: 'n',
			sequence_number: i + 1,
			causal_deps: '[]',
			schema_version: 1,
			received_at: 1_000 + i,
			delivery_seq: i + 1,
		}))
		await admin`INSERT INTO operations ${admin(rows)}`
		// 500 rows x 144 columns = 72,000 parameters > 65,535.
		await expect(proposedBackfill(c.sql, wide, { concurrency: 1, batch: 500 })).rejects.toThrow()
		// HEAD's row-at-a-time path is immune (and is the behaviour any batch fix must keep):
		const s2 = new PostgresServerStore(drizzle(c.sql), 'w2')
		await expect(s2.setSchema(wide)).resolves.toBeUndefined()
	}, 120_000)

	test('backfill must not overwrite a concurrent live write with a stale replay (rolling deploy)', async () => {
		// Instance A is serving; instance B cold-starts against the same database and
		// backfills. B reads the log once, then upserts row-by-row for seconds. A live
		// update committed by A in that window is later overwritten by B's stale replay.
		const schema = defineSchema({
			version: 1,
			collections: { lessons: { fields: { schoolId: t.string(), title: t.string() } } },
		}) as SchemaDefinition
		const a = counted()
		clients.push(a.sql)
		const storeA = new PostgresServerStore(drizzle(a.sql), 'A')
		await storeA.setSchema(schema)
		const N = 15_000
		const rows = Array.from({ length: N }, (_, i) => ({
			id: `L-op-${i}`,
			node_id: 'n',
			type: 'insert',
			collection: 'lessons',
			record_id: `L-${i}`,
			data: JSON.stringify({ schoolId: 's1', title: 'original' }),
			previous_data: null,
			atomic_ops: null,
			wall_time: 1_000 + i,
			logical: 0,
			timestamp_node_id: 'n',
			sequence_number: i + 1,
			causal_deps: '[]',
			schema_version: 1,
			received_at: 1_000 + i,
			delivery_seq: i + 1,
		}))
		for (let i = 0; i < rows.length; i += 2000) {
			await admin`INSERT INTO operations ${admin(rows.slice(i, i + 2000))}`
		}
		await admin`UPDATE delivery_counter SET value = ${N} WHERE id = 1`
		await admin`INSERT INTO lessons (id, "schoolId", title, _created_at, _updated_at, _deleted)
			SELECT record_id, 's1', 'original', wall_time, wall_time, 0 FROM operations`

		const b = counted()
		clients.push(b.sql)
		const storeB = new PostgresServerStore(drizzle(b.sql), 'B')
		await storeB.getOperationCount()
		const backfill = storeB.setSchema(schema)
		await new Promise((r) => setTimeout(r, 400)) // B has read the log, is now upserting
		const last = `L-${N - 1}`
		await storeA.applyRemoteOperation({
			id: 'live-update',
			nodeId: 'teacher',
			type: 'update',
			collection: 'lessons',
			recordId: last,
			data: { title: 'edited-live' },
			previousData: { title: 'original' },
			timestamp: { wallTime: 10_000_000, logical: 0, nodeId: 'teacher' },
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		})
		const [{ title: afterLive }] =
			(await admin`SELECT title FROM lessons WHERE id = ${last}`) as unknown as [{ title: string }]
		await backfill
		const [{ title }] = (await admin`SELECT title FROM lessons WHERE id = ${last}`) as unknown as [
			{ title: string },
		]
		console.log(`[LMS-10 race] after live write: ${afterLive}; after B's backfill: ${title}`)
		expect(afterLive).toBe('edited-live')
		expect(title).toBe('edited-live')
	}, 120_000)

	test('backfill of a deleted record must keep its scope fields, or scoped clients never receive the delete', async () => {
		// Restore-to-new-database / first setSchema on an existing log: the record was
		// inserted then deleted before ever being materialized. HEAD's backfill writes a
		// tombstone with only (id, _deleted), so schoolId is NULL; the delete op carries no
		// data, so the delivery stream's scope lookup judges it out of scope. A fresh scoped
		// client receives the insert but never the delete: the deleted record resurrects.
		const schema = defineSchema({
			version: 1,
			collections: { lessons: { fields: { schoolId: t.string(), title: t.string() } } },
		}) as SchemaDefinition
		const c = counted()
		clients.push(c.sql)
		const s0 = new PostgresServerStore(drizzle(c.sql), 'boot')
		await s0.setSchema(schema)
		const base = {
			node_id: 'n',
			collection: 'lessons',
			record_id: 'L-gone',
			previous_data: null,
			atomic_ops: null,
			logical: 0,
			timestamp_node_id: 'n',
			causal_deps: '[]',
			schema_version: 1,
		}
		await admin`INSERT INTO operations ${admin([
			{
				...base,
				id: 'ins',
				type: 'insert',
				data: JSON.stringify({ schoolId: 's1', title: 'x' }),
				wall_time: 1,
				sequence_number: 1,
				received_at: 1,
				delivery_seq: 1,
			},
			{
				...base,
				id: 'del',
				type: 'delete',
				data: null,
				wall_time: 2,
				sequence_number: 2,
				received_at: 2,
				delivery_seq: 2,
			},
		])}`
		await admin`UPDATE delivery_counter SET value = 2 WHERE id = 1`
		const s1 = new PostgresServerStore(drizzle(c.sql), 'srv')
		await s1.setSchema(schema)

		const { client, server } = createServerTransportPair()
		const messages: SyncMessage[] = []
		client.onMessage((m) => messages.push(m))
		const session = new ClientSession({
			sessionId: 's',
			transport: server,
			store: s1,
			auth: {
				authenticate: async () => ({ userId: 'u', scopes: { lessons: { schoolId: 's1' } } }),
			},
		})
		session.start()
		client.send({
			type: 'handshake',
			messageId: 'hs',
			nodeId: 'phone',
			versionVector: {},
			schemaVersion: 1,
			authToken: 'ok',
			lastDeliverySequence: 0,
		} as SyncMessage)
		const isBatch = (m: SyncMessage): m is OperationBatchMessage => m.type === 'operation-batch'
		await vi.waitFor(() => expect(messages.filter(isBatch).some((m) => m.isFinal)).toBe(true))
		const ids = messages.filter(isBatch).flatMap((m) => m.operations.map((o) => o.id))
		console.log(`[LMS-10 tombstone] delivered: ${JSON.stringify(ids)}`)
		// Correct: either both (insert then delete) or neither.
		expect(ids.includes('ins')).toBe(ids.includes('del'))
	}, 60_000)
})
