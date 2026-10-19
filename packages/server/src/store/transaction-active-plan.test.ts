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
import { op as atomic, defineSchema, t } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, describe, expect, test } from 'vitest'
import { KoraSyncServer } from '../server/kora-sync-server'
import { type ProductionHttpRouteContext, createRouteContext } from '../server/route-context'
import { PostgresServerStore } from './postgres-server-store'
import type { ServerStore } from './server-store'
import { createSqliteServerStore } from './sqlite-server-store'

const schema = defineSchema({
	version: 2,
	collections: {
		items: { fields: { title: t.string(), count: t.number() } },
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
