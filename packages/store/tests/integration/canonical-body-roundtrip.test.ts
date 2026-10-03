/**
 * One canonical operation body (RT-72 family: RT-79, RT-80, RT-83), client stores.
 * Property: whatever a developer writes through the collection API (json values with
 * Dates, undefined members and elements, -0, nested objects; updates that clear fields
 * with `undefined`), the operation the store logs keeps its id: the op read back from the
 * log (serialize -> store -> load) is canonical, verifies, and survives a JSON round trip
 * (the wire); the row holds exactly the canonical values. Run on SQLite (better-sqlite3),
 * SQLite WASM (mock bridge) and IndexedDB (mock bridge + fake-indexeddb).
 */
import 'fake-indexeddb/auto'
import { fc } from '@fast-check/vitest'
import { canonicalizeOperationBody, defineSchema, t, verifyOperationId } from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { IndexedDbAdapter } from '../../src/adapters/indexeddb-adapter'
import { SqliteWasmAdapter } from '../../src/adapters/sqlite-wasm-adapter'
import { MockWorkerBridge } from '../../src/adapters/sqlite-wasm-mock-bridge'
import { Store } from '../../src/store/store'
import type { StorageAdapter } from '../../src/types'

const schema = defineSchema({
	version: 1,
	collections: {
		notes: {
			fields: {
				title: t.string(),
				assignee: t.string().optional(),
				extra: t.json().optional(),
			},
		},
	},
}) as unknown as SchemaDefinition

let idb = 0
const adapters: Array<{ name: string; make: () => StorageAdapter }> = [
	{ name: 'SQLite (better-sqlite3)', make: () => new BetterSqlite3Adapter(':memory:') },
	{
		name: 'SQLite WASM (mock bridge)',
		make: () => new SqliteWasmAdapter({ bridge: new MockWorkerBridge() }),
	},
	{
		name: 'IndexedDB (mock bridge)',
		make: () =>
			new IndexedDbAdapter({ bridge: new MockWorkerBridge(), dbName: `canon-${String(++idb)}` }),
	},
]

/** Developer-written json values, the awkward ones included (no Map/Set: refused). */
const jsonish: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
	value: fc.oneof(
		{ depthSize: 'small' },
		fc.string(),
		fc.double({ noNaN: true, noDefaultInfinity: true }),
		fc.constant(-0),
		fc.boolean(),
		fc.constant(null),
		fc.date({ noInvalidDate: true, min: new Date(0), max: new Date(4e12) }),
		fc.array(tie('value'), { maxLength: 3 }),
		// (`undefined` inside a t.json() value is refused by validation; see core tests.)
		fc.dictionary(fc.string({ minLength: 1, maxLength: 5 }), tie('value'), { maxKeys: 3 }),
	),
})).value

const bodyArb = fc.record({
	title: fc.string({ maxLength: 8 }),
	assignee: fc.option(fc.string({ maxLength: 5 }), { nil: undefined }),
	extra: jsonish,
	update: fc.record(
		{
			title: fc.string({ maxLength: 8 }),
			assignee: fc.constantFrom(undefined, 'eve'),
			extra: fc.oneof(jsonish, fc.constant(undefined)),
		},
		{ requiredKeys: [] },
	),
})

async function expectCanonical(op: Operation): Promise<void> {
	expect(canonicalizeOperationBody(op)).toEqual(op)
	expect(await verifyOperationId(op)).toBe(true)
	const wire = JSON.parse(JSON.stringify(op)) as Operation
	expect(wire.data).toEqual(op.data)
	expect(await verifyOperationId(wire)).toBe(true)
}

describe.each(adapters)('canonical body round trip through the $name client store', ({ make }) => {
	test('random insert + update bodies: logged ops verify, rows hold the canonical values', async () => {
		const store = new Store({ schema, adapter: make(), nodeId: 'device-c' })
		await store.open()
		try {
			await fc.assert(
				fc.asyncProperty(bodyArb, async (body) => {
					const notes = store.collection('notes')
					const row = await notes.insert({
						title: body.title,
						assignee: body.assignee,
						extra: body.extra,
					})
					const id = String(row.id)
					if (Object.keys(body.update).length > 0) {
						await notes.update(id, body.update as Record<string, unknown>)
					}
					const ops = await store.getOperationsForRecord('notes', id)
					expect(ops.length).toBeGreaterThan(0)
					const expected: Record<string, unknown> = {}
					for (const op of ops) {
						await expectCanonical(op)
						Object.assign(expected, op.data)
					}
					const stored = await notes.findById(id)
					for (const field of ['title', 'assignee', 'extra']) {
						expect(stored?.[field] ?? null).toEqual(expected[field] ?? null)
					}
				}),
				{ numRuns: 40 },
			)
		} finally {
			await store.close()
		}
	}, 120_000)
})
