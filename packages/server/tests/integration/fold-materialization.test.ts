/**
 * W7 Stage B2: every server store materializes through the one fold.
 *
 * - Parity: memory, SQLite and Postgres fed the same operations in any order hold
 *   identical rows and byte-identical fold states, equal to `foldRecord` (random
 *   workloads over every field kind).
 * - SRV-1 server half: concurrent array / object / resolver edits materialize to the
 *   values every client folds to.
 * - Legacy duplicate pairs (Phase 2, RT-37) both fold.
 * - Re-materialization migration from a beta.12/beta.13-era database (no fold table,
 *   replay-materialized rows): idempotent, resumable, gated on the log-integrity scan.
 * - Rolling upgrade: operations appended without folding are caught up.
 *
 * Postgres cases need KORA_PG_TEST_URL.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type FoldState,
	type Operation,
	type SchemaDefinition,
	bytesToBase64,
	defineSchema,
	foldRecord,
	materialize,
	quoteIdent,
	replayOperationsForRecord,
	serializeFoldState,
	t,
} from '@korajs/core'
import { stringToRichtextUpdate } from '@korajs/merge'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, describe, expect, test } from 'vitest'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { PostgresServerStore } from '../../src/store/postgres-server-store'
import { mergeRichtextUpdatesForServer, serverFoldOptions } from '../../src/store/record-fold'
import type { MaterializedRecord, ServerStore } from '../../src/store/server-store'
import { createSqliteServerStore } from '../../src/store/sqlite-server-store'

const PG_URL = process.env.KORA_PG_TEST_URL
const pgClients: Array<ReturnType<typeof postgres>> = []
afterAll(async () => {
	for (const client of pgClients) await client.end()
})

const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				title: t.string(),
				count: t.number().merge('counter'),
				best: t.number().merge('max'),
				tags: t.array(t.string()),
				meta: t.object({ a: t.string(), b: t.number() }).optional(),
				qty: t.number(),
				done: t.boolean(),
				body: t.richtext().optional(),
			},
			resolve: {
				qty: (local, remote, base) => {
					const l = typeof local === 'number' ? local : 0
					const r = typeof remote === 'number' ? remote : 0
					const b = typeof base === 'number' ? base : 0
					return l + (r - b)
				},
			},
		},
	},
}) as SchemaDefinition

let pgCounter = 0
async function pgStore(nodeId = 'server'): Promise<{
	store: PostgresServerStore
	client: ReturnType<typeof postgres>
	schemaName: string
}> {
	pgCounter += 1
	const schemaName = `kora_fold_${process.pid}_${pgCounter}`
	const admin = postgres(PG_URL as string, { max: 1, onnotice: () => {} })
	await admin.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
	await admin.unsafe(`CREATE SCHEMA ${schemaName}`)
	await admin.end()
	const client = postgres(PG_URL as string, {
		max: 4,
		onnotice: () => {},
		connection: { search_path: schemaName },
	})
	pgClients.push(client)
	return { store: new PostgresServerStore(drizzle(client), nodeId), client, schemaName }
}

function rng(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let x = state
		x = Math.imul(x ^ (x >>> 15), x | 1)
		x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
		return ((x ^ (x >>> 14)) >>> 0) / 4294967296
	}
}

const rt = (text: string): { $koraBytes: string } => ({
	$koraBytes: bytesToBase64(stringToRichtextUpdate(text)),
})

/** A random multi-node workload over every field kind (inserts may arrive late). */
function workload(seed: number, size: number): Operation[] {
	const random = rng(seed)
	const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
	const nodes = ['n1', 'n2', 'n3']
	const sequences: Record<string, number> = {}
	const records = ['r0', 'r1', 'r2', 'r3']
	const ops: Operation[] = []
	const value = (field: string): unknown => {
		switch (field) {
			case 'title':
				return pick(['a', 'b', 'c', 'd'])
			case 'count':
			case 'qty':
				return Math.floor(random() * 20)
			case 'best':
				return Math.floor(random() * 100)
			case 'tags':
				return ['x', 'y', 'z', 'w'].filter(() => random() < 0.5)
			case 'meta':
				return random() < 0.2 ? null : { a: pick(['p', 'q']), b: Math.floor(random() * 5) }
			case 'done':
				return random() < 0.5
			case 'body':
				return rt(pick(['hello', 'world', 'kora', 'fold']))
			default:
				return null
		}
	}
	const fields = ['title', 'count', 'best', 'tags', 'meta', 'qty', 'done', 'body']
	for (let i = 0; i < size; i++) {
		const node = pick(nodes)
		sequences[node] = (sequences[node] ?? 0) + 1
		const recordId = pick(records)
		const roll = random()
		const wall = 1_000_000 + Math.floor(random() * 500)
		const base = {
			id: `w${seed}-${i}`,
			nodeId: node,
			collection: 'items',
			recordId,
			timestamp: { wallTime: wall, logical: Math.floor(random() * 3), nodeId: node },
			sequenceNumber: sequences[node] as number,
			causalDeps: [],
			schemaVersion: 1,
		}
		if (roll < 0.25) {
			const data: Record<string, unknown> = {}
			for (const field of fields) data[field] = value(field)
			ops.push({ ...base, type: 'insert', data, previousData: null })
		} else if (roll < 0.33) {
			ops.push({ ...base, type: 'delete', data: null, previousData: null })
		} else {
			const data: Record<string, unknown> = {}
			const previousData: Record<string, unknown> = {}
			for (const field of fields) {
				if (random() < 0.35) {
					data[field] = value(field)
					previousData[field] = value(field)
				}
			}
			if (random() < 0.15) {
				ops.push({
					...base,
					type: 'update',
					data: { count: 1 },
					previousData: { count: 0 },
					atomicOps: { count: { type: 'increment', value: 1 } },
				})
			} else ops.push({ ...base, type: 'update', data, previousData })
		}
	}
	return ops
}

function shuffle<T>(items: T[], seed: number): T[] {
	const random = rng(seed)
	const out = [...items]
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1))
		const tmp = out[i] as T
		out[i] = out[j] as T
		out[j] = tmp
	}
	return out
}

function normalize(value: unknown): unknown {
	if (value instanceof Uint8Array) return { $koraBytes: bytesToBase64(value) }
	if (Array.isArray(value)) return value.map(normalize)
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalize(v)]),
		)
	}
	return value
}

/** Every row (deleted ones included), normalized across stores. */
async function rowsOf(store: ServerStore): Promise<Record<string, unknown>[]> {
	const rows = await store.queryCollection('items', { includeDeleted: true, orderBy: 'id' })
	return rows.map((row: MaterializedRecord) => {
		const out: Record<string, unknown> = {}
		for (const [key, v] of Object.entries(row)) {
			out[key] = key === '_created_at' || key === '_updated_at' ? Number(v) : normalize(v)
		}
		for (const field of Object.keys(schema.collections.items?.fields ?? {})) {
			if (out[field] === undefined) out[field] = null
		}
		return out
	})
}

async function statesOf(store: ServerStore, ids: string[]): Promise<Record<string, string | null>> {
	const out: Record<string, string | null> = {}
	for (const id of ids) {
		const state = await store.getRecordFoldState?.('items', id)
		out[id] = state ? serializeFoldState(state) : null
	}
	return out
}

const FOLD = serverFoldOptions(['server'])

describe('server stores materialize through the fold', () => {
	test.each([1, 2, 3, 4, 5, 6])(
		'parity seed %i: memory / SQLite (/ Postgres) in different orders hold identical rows and states',
		async (seed) => {
			const ops = workload(seed, 70)
			const stores: Array<[string, ServerStore]> = [
				['memory', new MemoryServerStore('server')],
				['sqlite', createSqliteServerStore({ nodeId: 'server' })],
			]
			if (PG_URL) stores.push(['postgres', (await pgStore()).store])
			const results: Array<{ rows: unknown; states: unknown }> = []
			for (const [index, [, store]] of stores.entries()) {
				await store.setSchema(schema)
				for (const o of shuffle(ops, seed * 31 + index)) {
					expect(await store.applyRemoteOperation(o)).toBe('applied')
				}
				results.push({
					rows: await rowsOf(store),
					states: await statesOf(store, ['r0', 'r1', 'r2', 'r3']),
				})
			}
			for (const result of results.slice(1)) {
				expect(result.states).toEqual(results[0]?.states)
				expect(result.rows).toEqual(results[0]?.rows)
			}
			// The reference: a from-scratch fold of each record's operations.
			for (const id of ['r0', 'r1', 'r2', 'r3']) {
				const reference = foldRecord(
					ops.filter((o) => o.recordId === id),
					schema,
					FOLD,
				).state
				expect((results[0]?.states as Record<string, string | null>)[id]).toBe(
					reference ? serializeFoldState(reference) : null,
				)
			}
			for (const [, store] of stores) await store.close()
		},
		60_000,
	)

	test('SRV-1 server half: concurrent array / object / resolver edits fold like the clients', async () => {
		for (const store of [new MemoryServerStore('server'), createSqliteServerStore({})]) {
			await store.setSchema(schema)
			const insert: Operation = {
				id: 'srv1-insert',
				nodeId: 'a',
				type: 'insert',
				collection: 'items',
				recordId: 'r',
				data: {
					title: 't',
					tags: ['base'],
					meta: { a: 'red', b: 1 },
					qty: 10,
					count: 0,
					best: 0,
					done: false,
				},
				previousData: null,
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'a' },
				sequenceNumber: 1,
				causalDeps: [],
				schemaVersion: 1,
			}
			const editA: Operation = {
				...insert,
				id: 'srv1-a',
				type: 'update',
				data: { tags: ['base', 'a'], meta: { a: 'blue', b: 1 }, qty: 15 },
				previousData: { tags: ['base'], meta: { a: 'red', b: 1 }, qty: 10 },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'a' },
				sequenceNumber: 2,
			}
			const editB: Operation = {
				...insert,
				id: 'srv1-b',
				nodeId: 'b',
				type: 'update',
				data: { tags: ['base', 'b'], meta: { a: 'red', b: 2 }, qty: 13 },
				previousData: { tags: ['base'], meta: { a: 'red', b: 1 }, qty: 10 },
				timestamp: { wallTime: 2001, logical: 0, nodeId: 'b' },
				sequenceNumber: 1,
			}
			for (const o of [insert, editB, editA]) await store.applyRemoteOperation(o)
			const row = await store.findRecord('items', 'r')
			expect([...((row?.tags as string[]) ?? [])].sort()).toEqual(['a', 'b', 'base'])
			expect(row?.meta).toEqual({ a: 'blue', b: 2 })
			expect(row?.qty).toBe(18)
			const client = materialize(foldRecord([editA, insert, editB], schema).state as FoldState, {
				richtext: mergeRichtextUpdatesForServer,
			})
			expect(row?.tags).toEqual(client?.tags)
			expect(row?.meta).toEqual(client?.meta)
			expect(row?.qty).toBe(client?.qty)
			await store.close()
		}
	})

	test('legacy duplicate pairs (RT-37): both operations fold', async () => {
		for (const store of [new MemoryServerStore('server'), createSqliteServerStore({})]) {
			await store.setSchema(schema)
			const insert: Operation = {
				id: 'pair-insert',
				nodeId: 'legacy',
				type: 'insert',
				collection: 'items',
				recordId: 'r',
				data: { title: 't', tags: [] },
				previousData: null,
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'legacy' },
				sequenceNumber: 1,
				causalDeps: [],
				schemaVersion: 1,
			}
			const first: Operation = {
				...insert,
				id: 'pair-1',
				type: 'update',
				data: { title: 'first' },
				previousData: { title: 't' },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'legacy' },
				sequenceNumber: 2,
			}
			const second: Operation = {
				...first,
				id: 'pair-2',
				data: { tags: ['second'] },
				previousData: { tags: [] },
				timestamp: { wallTime: 2000, logical: 1, nodeId: 'legacy' },
			}
			await store.applyRemoteOperation(insert)
			await store.applyRemoteOperation(first)
			expect(await store.applyRemoteOperation(second, { legacySequenceWriter: true })).toBe(
				'applied',
			)
			const row = await store.findRecord('items', 'r')
			expect(row?.title).toBe('first')
			expect(row?.tags).toEqual(['second'])
			await store.close()
		}
	})
})

/** Recreate the beta.12/13 materialized state: replay rows, no fold table or plan fingerprint. */
function legacyRow(ops: Operation[]): Record<string, unknown> | null {
	const ordered = [...ops].sort(
		(a, b) =>
			a.timestamp.wallTime - b.timestamp.wallTime ||
			a.timestamp.logical - b.timestamp.logical ||
			(a.timestamp.nodeId < b.timestamp.nodeId
				? -1
				: a.timestamp.nodeId > b.timestamp.nodeId
					? 1
					: 0),
	)
	return replayOperationsForRecord(
		ordered.map((o) => ({
			type: o.type,
			data: o.data,
			atomicOps: o.atomicOps ?? null,
			previousData: o.previousData,
		})),
	)
}

const migrationSchema = defineSchema({
	version: 1,
	collections: { lists: { fields: { name: t.string(), tags: t.array(t.string()) } } },
}) as SchemaDefinition

function migrationOps(count = 1200): Operation[] {
	const ops: Operation[] = []
	for (let r = 0; r < count; r++) {
		const insert: Operation = {
			id: `m-${r}-i`,
			nodeId: 'a',
			type: 'insert',
			collection: 'lists',
			recordId: `l-${String(r).padStart(4, '0')}`,
			data: { name: `n${r}`, tags: ['base'] },
			previousData: null,
			timestamp: { wallTime: 1000 + r, logical: 0, nodeId: 'a' },
			sequenceNumber: 3 * r + 1,
			causalDeps: [],
			schemaVersion: 1,
		}
		// beta.12/13 merged these concurrent array edits pairwise; the fold keeps both adds.
		const a: Operation = {
			...insert,
			id: `m-${r}-a`,
			type: 'update',
			data: { tags: ['base', 'x'] },
			previousData: { tags: ['base'] },
			timestamp: { wallTime: 5000 + r, logical: 0, nodeId: 'a' },
			sequenceNumber: 3 * r + 2,
		}
		const b: Operation = {
			...insert,
			id: `m-${r}-b`,
			nodeId: 'b',
			type: 'update',
			data: { tags: ['y'] },
			previousData: { tags: ['base'] },
			timestamp: { wallTime: 4000 + r, logical: 0, nodeId: 'b' },
			sequenceNumber: r + 1,
		}
		ops.push(insert, a, b)
	}
	return ops
}

function foldedTags(ops: Operation[], recordId: string): unknown {
	const state = foldRecord(
		ops.filter((o) => o.recordId === recordId),
		migrationSchema,
	).state
	return state ? materialize(state)?.tags : null
}

describe('re-materialization migration (W7 step 7)', () => {
	test('SQLite: a beta-era database is re-materialized once, then restarts are a no-op', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'kora-fold-mig-'))
		const filename = join(dir, 'server.db')
		try {
			const ops = migrationOps()
			const seed = createSqliteServerStore({ filename, nodeId: 'server' })
			await seed.setSchema(migrationSchema)
			for (const o of ops) await seed.applyRemoteOperation(o)
			await seed.close()
			// Turn it into a beta-era database.
			const raw = new Database(filename)
			raw.exec(
				"DROP TABLE kora_fold_state; DELETE FROM kora_server_meta WHERE key = 'fold_plan_fingerprint'",
			)
			const update = raw.prepare('UPDATE lists SET tags = ? WHERE id = ?')
			for (let r = 0; r < 1200; r++) {
				const id = `l-${String(r).padStart(4, '0')}`
				const legacy = legacyRow(ops.filter((o) => o.recordId === id))
				update.run(JSON.stringify(legacy?.tags), id)
			}
			const sample = raw.prepare('SELECT tags FROM lists WHERE id = ?').get('l-0007') as {
				tags: string
			}
			raw.close()
			expect(JSON.parse(sample.tags)).not.toEqual(foldedTags(ops, 'l-0007'))

			const store = createSqliteServerStore({ filename, nodeId: 'server' })
			await store.setSchema(migrationSchema)
			expect(store.getFoldMigrationReport()).toMatchObject({ records: 1200, skippedUnclean: 0 })
			for (const id of ['l-0000', 'l-0007', 'l-1199']) {
				expect((await store.findRecord('lists', id))?.tags).toEqual(foldedTags(ops, id))
			}
			await store.close()

			// Restart: nothing to do. Then a crash mid-way (some states stale) resumes.
			const again = createSqliteServerStore({ filename, nodeId: 'server' })
			await again.setSchema(migrationSchema)
			expect(again.getFoldMigrationReport().records).toBe(0)
			await again.close()
			const crash = new Database(filename)
			crash.exec("UPDATE kora_fold_state SET covered_seq = -1 WHERE record_id >= 'l-0900'")
			crash.close()
			const resumed = createSqliteServerStore({ filename, nodeId: 'server' })
			await resumed.setSchema(migrationSchema)
			expect(resumed.getFoldMigrationReport().records).toBe(300)
			await resumed.close()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	}, 60_000)

	test('SQLite: with quarantined log rows the pre-fold rows are kept and the skip is reported', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'kora-fold-q-'))
		const filename = join(dir, 'server.db')
		try {
			const ops = migrationOps().slice(0, 30)
			const seed = createSqliteServerStore({ filename, nodeId: 'server' })
			await seed.setSchema(migrationSchema)
			for (const o of ops) await seed.applyRemoteOperation(o)
			await seed.close()
			const raw = new Database(filename)
			raw.exec(
				"DROP TABLE kora_fold_state; DELETE FROM kora_server_meta WHERE key IN ('fold_plan_fingerprint', 'log_integrity_scan_v1')",
			)
			raw.prepare('UPDATE lists SET tags = ? WHERE id = ?').run('["legacy"]', 'l-0001')
			// A row the beta.12 restore damaged: it cannot be read back into an operation.
			raw.exec(
				"INSERT INTO operations (id, node_id, type, collection, record_id, data, wall_time, logical, timestamp_node_id, sequence_number, causal_deps, schema_version, received_at, delivery_seq) VALUES ('bad', 'z', 'bogus', 'lists', 'l-0001', '{}', 1, 0, 'z', 1, '[]', 1, 1, 9999)",
			)
			raw.close()
			const errors: string[] = []
			const original = console.error
			console.error = (...args: unknown[]) => errors.push(args.join(' '))
			try {
				const store = createSqliteServerStore({ filename, nodeId: 'server' })
				expect(store.getLogIntegrityReport().totalQuarantined).toBe(1)
				await store.setSchema(migrationSchema)
				expect(store.getFoldMigrationReport().skippedUnclean).toBe(10)
				expect((await store.findRecord('lists', 'l-0001'))?.tags).toEqual(['legacy'])
				// The next write folds the record from its remaining log.
				await store.applyRemoteOperation({
					...(ops[0] as Operation),
					id: 'after',
					type: 'update',
					recordId: 'l-0001',
					data: { name: 'renamed' },
					previousData: { name: 'n1' },
					timestamp: { wallTime: 9000, logical: 0, nodeId: 'a' },
					sequenceNumber: 10_000,
				})
				const row = await store.findRecord('lists', 'l-0001')
				expect(row?.name).toBe('renamed')
				expect(row?.tags).toEqual(foldedTags(ops, 'l-0001'))
				await store.close()
			} finally {
				console.error = original
			}
			expect(errors.some((line) => line.includes('quarantined'))).toBe(true)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	}, 60_000)

	test('rolling upgrade: operations an older instance appended without folding are caught up', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'kora-fold-roll-'))
		const filename = join(dir, 'server.db')
		try {
			const ops = migrationOps().slice(0, 3)
			const store = createSqliteServerStore({ filename, nodeId: 'server' })
			await store.setSchema(migrationSchema)
			await store.applyRemoteOperation(ops[0] as Operation)
			// An older release appends op[1] (its own row write is irrelevant here).
			const raw = new Database(filename)
			const o = ops[1] as Operation
			raw
				.prepare(
					'INSERT INTO operations (id, node_id, type, collection, record_id, data, previous_data, wall_time, logical, timestamp_node_id, sequence_number, causal_deps, schema_version, received_at, delivery_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
				)
				.run(
					o.id,
					o.nodeId,
					o.type,
					o.collection,
					o.recordId,
					JSON.stringify(o.data),
					JSON.stringify(o.previousData),
					o.timestamp.wallTime,
					o.timestamp.logical,
					o.timestamp.nodeId,
					o.sequenceNumber,
					'[]',
					1,
					1,
					2,
				)
			raw.prepare('UPDATE delivery_counter SET value = 2 WHERE id = 1').run()
			raw.close()
			await store.applyRemoteOperation(ops[2] as Operation)
			expect((await store.findRecord('lists', 'l-0000'))?.tags).toEqual(foldedTags(ops, 'l-0000'))
			await store.close()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test.skipIf(!PG_URL)(
		'Postgres: a beta-era database is re-materialized in batches; a live write during it is kept',
		async () => {
			const { store: seed, client, schemaName } = await pgStore()
			const ops = migrationOps(700)
			await seed.setSchema(migrationSchema)
			for (const o of ops) await seed.applyRemoteOperation(o)
			await client.unsafe(
				"DROP TABLE kora_fold_state; DELETE FROM kora_server_meta WHERE key = 'fold_plan_fingerprint'",
			)
			for (let r = 0; r < 700; r++) {
				const id = `l-${String(r).padStart(4, '0')}`
				const legacy = legacyRow(ops.filter((o) => o.recordId === id))
				await client`UPDATE lists SET tags = ${JSON.stringify(legacy?.tags)}::jsonb WHERE id = ${id}`
			}
			const second = postgres(PG_URL as string, {
				max: 4,
				onnotice: () => {},
				connection: { search_path: schemaName },
			})
			pgClients.push(second)
			const store = new PostgresServerStore(drizzle(second), 'server-2')
			// The new release's startup DDL (it recreates the fold table), then its migration.
			await store.getOperationCount()
			const migrating = store.setSchema(migrationSchema)
			// A live write on the first instance while the second migrates.
			const live: Operation = {
				...(ops[3 * 699] as Operation),
				id: 'live-write',
				type: 'update',
				data: { name: 'edited-live' },
				previousData: { name: 'n699' },
				timestamp: { wallTime: 99_999, logical: 0, nodeId: 'teacher' },
				nodeId: 'teacher',
				sequenceNumber: 1,
			}
			await seed.applyRemoteOperation(live)
			await migrating
			expect(store.getFoldMigrationReport().records).toBeGreaterThan(600)
			const last = await store.findRecord('lists', 'l-0699')
			expect(last?.name).toBe('edited-live')
			expect(last?.tags).toEqual(foldedTags(ops, 'l-0699'))
			expect((await store.findRecord('lists', 'l-0007'))?.tags).toEqual(foldedTags(ops, 'l-0007'))
			// Restarted with the same configuration: the authority set (the persisted legacy
			// ids plus the configured 'server-2') is unchanged, so nothing is re-folded. (A
			// new configured id would be a new legacy authority, and re-fold every record.)
			const restart = new PostgresServerStore(drizzle(second), 'server-2')
			await restart.setSchema(migrationSchema)
			expect(restart.getFoldMigrationReport().records).toBe(0)
			const rows = (await client.unsafe(
				`SELECT COUNT(*)::int AS n FROM ${quoteIdent('kora_fold_state')}`,
			)) as unknown as Array<{ n: number }>
			expect(rows[0]?.n).toBe(700)
		},
		120_000,
	)
})
