import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
/**
 * The reads of a server transaction (`server.kora.transaction`, and `applyConditional`,
 * which runs as one) decide on the record as the deciding instance's fold plan folds it.
 * During a rolling deploy that changes operation transforms, an instance still on the
 * previous plan may materialize a record with that plan's values; until the delivery
 * poll re-folds it, the row on disk is not the record the new plan defines, and a
 * transaction's `if` predicate, its atomic ops and its route logic must not decide on
 * it. Postgres runs with KORA_PG_TEST_URL.
 */
import type { Operation, OperationTransform } from '@korajs/core'
import { op as atomic, defineSchema, encodeBytesForOpData, t } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import { KoraSyncServer } from '../server/kora-sync-server'
import { type ProductionHttpRouteContext, createRouteContext } from '../server/route-context'
import { PostgresServerStore } from './postgres-server-store'
import type { ServerStore } from './server-store'
import { createSqliteServerStore } from './sqlite-server-store'

const schema = defineSchema({
	version: 2,
	collections: {
		items: { fields: { title: t.string(), count: t.number() } },
		// Every column kind, to check a record substituted on the slow path reads back
		// exactly as the active plan's row would.
		rich: {
			fields: {
				title: t.string(),
				tags: t.array(t.string()),
				meta: t.object({ a: t.number() }),
				extra: t.json(),
				quoted: t.json(),
				flag: t.boolean(),
				due: t.timestamp(),
				kind: t.enum(['a', 'b']),
				body: t.richtext(),
			},
		},
	},
})

const keep: OperationTransform = {
	fromVersion: 1,
	toVersion: 2,
	transform: (operation) => ({ ...operation, schemaVersion: 2 }),
}

/** The new plan: version 1 titles read in upper case and counts ten times over. */
const shout: OperationTransform = {
	fromVersion: 1,
	toVersion: 2,
	transform: (operation) => {
		if (!operation.data) return { ...operation, schemaVersion: 2 }
		const data = { ...operation.data }
		if (typeof data.title === 'string') data.title = data.title.toUpperCase()
		if (typeof data.count === 'number') data.count = data.count * 10
		return { ...operation, schemaVersion: 2, data }
	},
}

/** An old plan that makes nothing of a record titled 'hidden'. */
const dropHidden: OperationTransform = {
	fromVersion: 1,
	toVersion: 2,
	transform: (operation) =>
		operation.data?.title === 'hidden' ? null : { ...operation, schemaVersion: 2 },
}

let seq = 0
function v1(input: Partial<Operation> & Pick<Operation, 'recordId' | 'data'>): Operation {
	seq += 1
	return {
		id: `op-${seq}-${Math.random().toString(36).slice(2)}`,
		nodeId: 'device',
		type: 'insert',
		collection: 'items',
		previousData: null,
		timestamp: { wallTime: 1_000 + seq, logical: 0, nodeId: 'device' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		...input,
	}
}

const PG_URL = process.env.KORA_PG_TEST_URL
const cleanups: (() => unknown)[] = []

afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup()
})

const NO_TEMP_DATABASE = 'kora_test_notemp'

/** The database without TEMP for PUBLIC, created on first use (concurrent runs may race). */
async function noTempDatabase(url: string): Promise<string> {
	const admin = postgres(url, { max: 1, onnotice: () => {} })
	try {
		const [found] = await admin.unsafe('SELECT 1 FROM pg_database WHERE datname = $1', [
			NO_TEMP_DATABASE,
		])
		if (!found) {
			try {
				await admin.unsafe(`CREATE DATABASE ${NO_TEMP_DATABASE}`)
			} catch (error) {
				// Another run created it first: 42P04 duplicate_database, or 23505 when both
				// inserted into pg_database at once.
				const code = (error as { code?: string }).code
				if (code !== '42P04' && code !== '23505') throw error
			}
		}
	} finally {
		await admin.end()
	}
	const target = new URL(url)
	target.pathname = `/${NO_TEMP_DATABASE}`
	const owner = postgres(target.toString(), { max: 1, onnotice: () => {} })
	try {
		// TEMP is granted to PUBLIC by default: revoke it on this database only (idempotent).
		await owner.unsafe(`REVOKE TEMP ON DATABASE ${NO_TEMP_DATABASE} FROM PUBLIC`)
	} finally {
		await owner.end()
	}
	return NO_TEMP_DATABASE
}

interface Pair {
	/** On the new plan (`shout`), the plan the database records. */
	a: ServerStore
	/** Still on the previous plan. */
	b: ServerStore
	kora: ProductionHttpRouteContext
}

/** Seed records through `b`, the old-plan instance: rows on disk hold its values. */
async function seedThroughOldPlan(pair: Pair): Promise<void> {
	await pair.b.applyRemoteOperation(v1({ recordId: 'r1', data: { title: 'a', count: 1 } }))
	await pair.b.applyRemoteOperation(v1({ recordId: 'r2', data: { title: 'z', count: 3 } }))
}

function suite(name: string, make: (oldPlan: OperationTransform) => Promise<Pair>): void {
	describe(name, () => {
		test('transaction reads see the record the active plan folds', async () => {
			const pair = await make(keep)
			await seedThroughOldPlan(pair)
			// A record the new-plan instance wrote itself: its row on disk is current.
			await pair.a.applyRemoteOperation(v1({ recordId: 'r3', data: { title: 'm', count: 2 } }))
			let seen: unknown = null
			const result = await pair.kora.transaction(async (tx) => {
				seen = {
					found: (await tx.findById('items', 'r1'))?.title,
					count: (await tx.findById('items', 'r1'))?.count,
					current: (await tx.findById('items', 'r3'))?.title,
					upper: (await tx.query('items', { where: { title: 'A' } })).map((r) => r.id),
					lower: (await tx.query('items', { where: { title: 'a' } })).map((r) => r.id),
					ordered: (await tx.query('items', { orderBy: 'count', orderDirection: 'desc' })).map(
						(r) => r.id,
					),
					paged: (await tx.query('items', { orderBy: 'count', limit: 1, offset: 1 })).map(
						(r) => r.id,
					),
				}
				return []
			})
			expect(result.ok).toBe(true)
			expect(seen).toEqual({
				found: 'A',
				count: 10,
				current: 'M',
				upper: ['r1'],
				lower: [],
				ordered: ['r2', 'r3', 'r1'],
				paged: ['r3'],
			})
		})

		test('a conditional set admits on the active plan and resolves atomic ops against it', async () => {
			const pair = await make(keep)
			await seedThroughOldPlan(pair)
			// Under the previous plan the title is 'a': this must be refused.
			const refused = await pair.kora.applyConditional({
				collection: 'items',
				id: 'r1',
				if: { title: { $eq: 'a' } },
				update: { count: atomic.increment(1) },
			})
			expect(refused).toMatchObject({ ok: false, code: 'CONDITION_NOT_MET' })
			const admitted = await pair.kora.applyConditional({
				collection: 'items',
				id: 'r1',
				if: { title: { $eq: 'A' }, count: { $gte: 10 } },
				update: { count: atomic.increment(1) },
			})
			expect(admitted.ok).toBe(true)
			if (!admitted.ok) return
			const written = admitted.operations[0]
			expect(written?.data).toEqual({ count: 11 })
			expect(written?.previousData).toEqual({ count: 10 })
			expect(admitted.records[0]?.count).toBe(11)
		})

		test('a transaction decides on the active plan (route logic)', async () => {
			const pair = await make(keep)
			await seedThroughOldPlan(pair)
			const result = await pair.kora.transaction(async (tx) => {
				const item = await tx.findById('items', 'r1')
				if (!item || item.count !== 10) return tx.reject('STALE', `read ${String(item?.count)}`)
				return [{ collection: 'items', type: 'update', recordId: 'r1', data: { title: 'B' } }]
			})
			expect(result).toMatchObject({ ok: true })
		})

		test('a record the previous plan makes nothing of is found', async () => {
			const pair = await make(dropHidden)
			await pair.b.applyRemoteOperation(v1({ recordId: 'h1', data: { title: 'hidden', count: 1 } }))
			let seen: unknown = null
			await pair.kora.transaction(async (tx) => {
				seen = {
					found: (await tx.findById('items', 'h1'))?.title,
					listed: (await tx.query('items')).map((r) => r.id),
				}
				return []
			})
			expect(seen).toEqual({ found: 'HIDDEN', listed: ['h1'] })
		})

		test('a record substituted on the slow path reads as the active plan row, every column kind', async () => {
			const pair = await make(keep)
			const doc = new Y.Doc()
			doc.getText('t').insert(0, 'hello')
			await pair.b.applyRemoteOperation(
				v1({
					collection: 'rich',
					recordId: 'x1',
					data: {
						title: "a \u{1F600} \\x00 'q'",
						tags: ['x', 'y'],
						meta: { a: 1 },
						extra: { nested: [1, 'two', null] },
						quoted: '123',
						flag: true,
						due: 1_700_000_000_000,
						kind: 'b',
						body: encodeBytesForOpData(Y.encodeStateAsUpdate(doc)),
					},
				}),
			)
			let seen: { listed: unknown; byId: unknown; filtered: unknown } | null = null
			await pair.kora.transaction(async (tx) => {
				seen = {
					listed: (await tx.query('rich'))[0],
					byId: await tx.findById('rich', 'x1'),
					filtered: (await tx.query('rich', { where: { kind: 'b', due: 1_700_000_000_000 } })).map(
						(r) => r.id,
					),
				}
				return []
			})
			const result = seen as { listed: unknown; byId: unknown; filtered: unknown } | null
			// A row read from the database holds bytes as a Buffer and a BIGINT as a string
			// (Postgres), the folded row by id a Uint8Array and numbers: compare the values.
			const bytes = (record: unknown): unknown => {
				const row = record as Record<string, unknown> | null | undefined
				if (!row) return row
				const body = row.body
				return {
					...row,
					...(body instanceof Uint8Array ? { body: [...body] } : {}),
					_created_at: Number(row._created_at),
					_updated_at: Number(row._updated_at),
				}
			}
			expect(bytes(result?.listed)).toEqual(bytes(result?.byId))
			expect(bytes(result?.listed)).toMatchObject({ body: [...Y.encodeStateAsUpdate(doc)] })
			expect(result?.listed).toMatchObject({ title: "A \u{1F600} \\X00 'Q'", quoted: '123' })
			expect(result?.filtered).toEqual(['x1'])
		})

		test('store views in a transaction count, list deleted rows and read by id on the active plan', async () => {
			const pair = await make(keep)
			await seedThroughOldPlan(pair)
			await pair.b.applyRemoteOperation(
				v1({ type: 'delete', recordId: 'r2', data: null, previousData: null }),
			)
			const transact = pair.a.transact
			if (!transact) throw new Error('the store has no transact')
			let seen: unknown = null
			await transact.call(pair.a, async (view) => {
				seen = {
					count: await view.countCollection('items', { title: 'A' }),
					countLower: await view.countCollection('items', { title: 'a' }),
					live: (await view.queryCollection('items')).map((r) => r.id),
					all: (
						await view.queryCollection('items', { includeDeleted: true, orderBy: 'count' })
					).map((r) => [r.id, r.count, r._deleted ?? 0]),
					deleted: await view.findRecord('items', 'r2'),
				}
				return null
			})
			expect(seen).toEqual({
				count: 1,
				countLower: 0,
				live: ['r1'],
				all: [
					['r1', 10, 0],
					['r2', 30, 1],
				],
				deleted: null,
			})
			// Nothing was written: the row on disk still holds the previous plan's value.
			expect((await pair.a.queryCollection('items', { where: { id: 'r1' } }))[0]?.title).toBe('a')
		})
	})
}

suite('sqlite: transaction reads during a rolling deploy', async (oldPlan) => {
	const dir = mkdtempSync(join(tmpdir(), 'kora-txplan-'))
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
	const filename = join(dir, 'server.db')
	const a = createSqliteServerStore({ filename })
	const b = createSqliteServerStore({ filename })
	cleanups.push(async () => {
		await a.close()
		await b.close()
	})
	await a.setSchema(schema, { operationTransforms: [keep] })
	await b.setSchema(schema, { operationTransforms: [keep] })
	await b.setOperationTransforms([oldPlan])
	await a.setOperationTransforms([shout])
	return { a, b, kora: createRouteContext(new KoraSyncServer({ store: a }), a) }
})

if (PG_URL) {
	suite('postgres: transaction reads during a rolling deploy', async (oldPlan) => {
		const name = `kora_txplan_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
		const admin = postgres(PG_URL, { max: 1 })
		await admin.unsafe(`CREATE SCHEMA ${name}`)
		cleanups.push(async () => {
			await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
			await admin.end()
		})
		const make = async (instance: string): Promise<PostgresServerStore> => {
			const client = postgres(PG_URL, { max: 4, connection: { search_path: name } })
			// Ended before the schema is dropped (cleanups run in reverse).
			cleanups.push(() => client.end())
			const store = new PostgresServerStore(drizzle(client), 'server-node', undefined, {
				instanceId: instance,
			})
			await store.setSchema(schema, { operationTransforms: [keep] })
			return store
		}
		const a = await make('a')
		const b = await make('b')
		await b.setOperationTransforms([oldPlan])
		await a.setOperationTransforms([shout])
		return { a, b, kora: createRouteContext(new KoraSyncServer({ store: a }), a) }
	})
	// Least-privilege deployments often run without TEMP: the slow path must not need it.
	//
	// TEMP is a per-database privilege granted to PUBLIC, so the suite needs a database of
	// its own where PUBLIC lacks it. It reuses one fixed database across tests and runs
	// (created once, never dropped) and isolates each test, and each concurrent run, in a
	// role and schema of its own. It deliberately never runs CREATE/DROP DATABASE per
	// test: DROP DATABASE waits for a cluster-wide checkpoint, whose length depends on what
	// every other suite writes concurrently, and six of them in one afterAll overran the
	// hook timeout and leaked the databases of the hooks that did not finish.
	suite(
		'postgres without the TEMP privilege: transaction reads during a rolling deploy',
		async (oldPlan) => {
			const tag = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`
			const role = `kora_notemp_${tag}`
			const url = new URL(PG_URL)
			url.pathname = `/${await noTempDatabase(PG_URL)}`
			const owner = postgres(url.toString(), { max: 1, onnotice: () => {} })
			await owner.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'notemp'`)
			await owner.unsafe(`CREATE SCHEMA ${role} AUTHORIZATION ${role}`)
			cleanups.push(async () => {
				await owner.unsafe(`DROP SCHEMA IF EXISTS ${role} CASCADE`)
				await owner.unsafe(`DROP OWNED BY ${role}`)
				await owner.unsafe(`DROP ROLE IF EXISTS ${role}`)
				await owner.end()
			})
			url.username = role
			url.password = 'notemp'
			const probe = postgres(url.toString(), { max: 1, onnotice: () => {} })
			await expect(probe.unsafe('CREATE TEMP TABLE t (x int)')).rejects.toThrow(/permission denied/)
			await probe.end()
			const make = async (instance: string): Promise<PostgresServerStore> => {
				const client = postgres(url.toString(), {
					max: 4,
					onnotice: () => {},
					connection: { search_path: role },
				})
				// Ended before the role and schema are dropped (cleanups run in reverse).
				cleanups.push(() => client.end())
				const store = new PostgresServerStore(drizzle(client), 'server-node', undefined, {
					instanceId: instance,
				})
				await store.setSchema(schema, { operationTransforms: [keep] })
				return store
			}
			const a = await make('a')
			const b = await make('b')
			await b.setOperationTransforms([oldPlan])
			await a.setOperationTransforms([shout])
			return { a, b, kora: createRouteContext(new KoraSyncServer({ store: a }), a) }
		},
	)
} else {
	describe.skip('postgres: transaction reads during a rolling deploy (KORA_PG_TEST_URL)', () => {
		test('skipped', () => {})
	})
}

describe('sqlite: transaction reads of current-plan records', () => {
	test('stay on the plain query (nothing is staged)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'kora-txplan-'))
		const filename = join(dir, 'server.db')
		const a = createSqliteServerStore({ filename })
		const b = createSqliteServerStore({ filename })
		try {
			await a.setSchema(schema, { operationTransforms: [keep] })
			await b.setSchema(schema, { operationTransforms: [keep] })
			await a.setOperationTransforms([shout])
			await b.applyRemoteOperation(v1({ recordId: 'r1', data: { title: 'a', count: 1 } }))
			// The new-plan process re-folds it (the delivery poll): every row is current.
			expect(await a.refoldOutdatedRecords()).toBe(1)
			const db = (a as unknown as { db: { run: (query: unknown) => unknown } }).db
			const run = db.run.bind(db)
			let staged = 0
			db.run = (query: unknown) => {
				const chunks = (query as { queryChunks?: { value?: unknown }[] }).queryChunks ?? []
				if (chunks.some((chunk) => String(chunk.value ?? '').includes('CREATE TEMP TABLE'))) {
					staged += 1
				}
				return run(query)
			}
			const kora = createRouteContext(new KoraSyncServer({ store: a }), a)
			let seen: unknown = null
			await kora.transaction(async (tx) => {
				seen = (await tx.query('items', { where: { title: 'A' } })).map((r) => r.count)
				return []
			})
			expect(seen).toEqual([10])
			expect(staged).toBe(0)
		} finally {
			await a.close()
			await b.close()
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
