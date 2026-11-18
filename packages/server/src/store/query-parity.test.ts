/**
 * One query contract for every server store (memory, SQLite, Postgres): what route queries,
 * scoped queries and constraint lookups rely on.
 *
 * - `where { field: value }` matches the stored value; a boolean matches as a boolean and
 *   `null` matches a field that is null or absent.
 * - `orderBy` puts nulls last in both directions; strings compare by code point.
 * - `id` breaks every tie and is the order when none is given, so limit/offset pages are stable.
 */
import { defineSchema, t } from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import fc from 'fast-check'
import postgres from 'postgres'
import { afterAll, describe, expect, test } from 'vitest'
import { dropTrackedPgSchemas, trackPgSchema } from '../../tests/fixtures/pg-test-schemas'
import { MemoryServerStore } from './memory-server-store'
import { PostgresServerStore } from './postgres-server-store'
import type { CollectionQueryOptions, ServerStore } from './server-store'
import { createSqliteServerStore } from './sqlite-server-store'

afterAll(dropTrackedPgSchemas)
const PG_URL = process.env.KORA_PG_TEST_URL

const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				done: t.boolean().default(false),
				who: t.string().optional(),
				status: t.enum(['draft', 'live', 'gone']).default('draft'),
				at: t.timestamp().optional(),
				score: t.number().default(0),
			},
		},
	},
}) as unknown as SchemaDefinition

type Row = {
	id: string
	done: boolean
	who: string | null
	status: string
	at: number | null
	score: number
}
const FIELDS = ['done', 'who', 'status', 'at', 'score', 'id'] as const

let schemas = 0
/** A store for one run, and what ends it (a Postgres run also ends its own client). */
type Opened = { store: ServerStore; end: () => Promise<void> }
const closing = (store: ServerStore): Opened => ({ store, end: () => store.close() })
const makers: Array<[string, () => Promise<Opened>]> = [
	['memory', async () => closing(new MemoryServerStore())],
	['sqlite', async () => closing(createSqliteServerStore({}))],
]
if (PG_URL) {
	makers.push([
		'postgres',
		async () => {
			const name = `kora_query_parity_${process.pid}_${schemas++}`
			const admin = postgres(PG_URL, { max: 1, onnotice: () => {} })
			await admin.unsafe(`CREATE SCHEMA ${name}`)
			trackPgSchema(name)
			await admin.end()
			const client = postgres(PG_URL, {
				max: 2,
				onnotice: () => {},
				connection: { search_path: name },
			})
			const store = new PostgresServerStore(drizzle(client))
			return {
				store,
				end: async () => {
					await store.close()
					await client.end({ timeout: 5 })
				},
			}
		},
	])
}

// --- the contract, as a model ---

function compareValues(a: unknown, b: unknown): number {
	if (typeof a === 'string' && typeof b === 'string') {
		const left = [...a].map((c) => c.codePointAt(0) as number)
		const right = [...b].map((c) => c.codePointAt(0) as number)
		for (let i = 0; i < Math.min(left.length, right.length); i++) {
			if (left[i] !== right[i]) return (left[i] as number) - (right[i] as number)
		}
		return left.length - right.length
	}
	return Number(a) - Number(b)
}

function model(rows: Row[], query: CollectionQueryOptions): string[] {
	let result = rows.filter((row) =>
		Object.entries(query.where ?? {}).every(
			([key, value]) => (row[key as keyof Row] ?? null) === value,
		),
	)
	const field = query.orderBy as keyof Row | undefined
	const dir = query.orderDirection === 'desc' ? -1 : 1
	result = [...result].sort((a, b) => {
		if (field) {
			const av = a[field]
			const bv = b[field]
			if (av === null && bv !== null) return 1
			if (bv === null && av !== null) return -1
			if (av !== null && bv !== null) {
				const c = compareValues(av, bv)
				if (c !== 0) return c * dir
			}
		}
		return compareValues(a.id, b.id)
	})
	const start = query.offset ?? 0
	const end = query.limit === undefined ? undefined : start + query.limit
	return result.slice(start, end).map((row) => row.id)
}

// --- generators ---

const rowArb = fc.record({
	done: fc.boolean(),
	who: fc.constantFrom<string | null>('ann', 'Bob', 'bob', 'Émile', null),
	status: fc.constantFrom('draft', 'live', 'gone'),
	at: fc.constantFrom<number | null>(1000, 2000, 2000, null),
	score: fc.constantFrom(1, 2, 2, 3),
})
const queryArb: fc.Arbitrary<CollectionQueryOptions> = fc.record(
	{
		where: fc.record(
			{
				done: fc.boolean(),
				who: fc.constantFrom<string | null>('ann', 'bob', null),
				status: fc.constantFrom('draft', 'live'),
				at: fc.constantFrom<number | null>(2000, null),
			},
			{ requiredKeys: [] },
		),
		orderBy: fc.constantFrom(...FIELDS),
		orderDirection: fc.constantFrom<'asc' | 'desc'>('asc', 'desc'),
		limit: fc.integer({ min: 0, max: 6 }),
		offset: fc.integer({ min: 0, max: 4 }),
	},
	{ requiredKeys: [] },
)

describe.each(makers)('%s server store: queries follow the shared contract', (_kind, make) => {
	test('property: filters, null ordering and stable paging match the model', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(rowArb, { minLength: 1, maxLength: 12 }),
				fc.array(queryArb, { minLength: 1, maxLength: 8 }),
				async (generated, queries) => {
					const { store, end } = await make()
					try {
						await store.setSchema(schema)
						// Ids are inserted out of order, so insertion order is not id order.
						const rows: Row[] = generated.map((row, i) => ({
							// Mixed case: a locale collation orders these differently from code points.
							id: `${['a', 'B', 'b', 'A'][i % 4]}${String((i * 7) % 13).padStart(2, '0')}-${i}`,
							...row,
						}))
						for (const [i, row] of rows.entries()) {
							const { id, ...data } = row
							const operation: Operation = {
								id: `op-${i}`,
								nodeId: 'device-a',
								type: 'insert',
								collection: 'items',
								recordId: id,
								data: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null)),
								previousData: null,
								timestamp: { wallTime: 1_790_000_000_000 + i, logical: 0, nodeId: 'device-a' },
								sequenceNumber: i + 1,
								causalDeps: [],
								schemaVersion: 1,
							}
							expect(await store.applyRemoteOperation(operation)).toBe('applied')
						}
						for (const query of queries) {
							const got = (await store.queryCollection('items', query)).map((row) => row.id)
							expect(got, JSON.stringify(query)).toEqual(model(rows, query))
							expect(
								await store.countCollection('items', query.where),
								JSON.stringify(query.where),
							).toBe(model(rows, { where: query.where }).length)
						}
					} finally {
						await end()
					}
				},
			),
			{ numRuns: PG_URL ? 30 : 60 },
		)
	}, 300_000)
})
