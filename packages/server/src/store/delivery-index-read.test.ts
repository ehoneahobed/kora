/**
 * Reading the delivery visibility index (C2.4), on every server store. The index only
 * narrows: its answer must equal the sources' candidates taken from the global scan, and
 * must contain every operation the scope can see (the superset invariant). Postgres runs
 * with KORA_PG_TEST_URL.
 */
import { fc } from '@fast-check/vitest'
import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { afterAll, describe, expect, test } from 'vitest'
import {
	deliveryOp,
	deliveryStoreKinds,
	removeDeliveryTempFiles,
} from '../../tests/fixtures/delivery-stores'
import { dropTrackedPgSchemas } from '../../tests/fixtures/pg-test-schemas'
import {
	type DeliverySources,
	MAX_DELIVERY_SOURCES,
	deliverySourcesForScope,
	deriveDeliveryPartitionPlan,
	partitionKey,
	partitionKeysOf,
} from './delivery-partitions'

afterAll(dropTrackedPgSchemas)
afterAll(removeDeliveryTempFiles)

const schema = defineSchema({
	version: 1,
	collections: {
		notes: { fields: { body: t.string(), schoolId: t.string() }, scope: ['schoolId'] },
		logs: { fields: { line: t.string() } },
	},
})
const plan = deriveDeliveryPartitionPlan(schema)
const SCHOOLS = ['a', 'b', 'c', 'd'] as const

interface Step {
	collection: 'notes' | 'logs'
	record: number
	school: (typeof SCHOOLS)[number]
	node: 'node-a' | 'node-b'
}
const stepArb: fc.Arbitrary<Step> = fc.record({
	collection: fc.constantFrom('notes', 'logs'),
	record: fc.integer({ min: 0, max: 3 }),
	school: fc.constantFrom(...SCHOOLS),
	node: fc.constantFrom('node-a', 'node-b'),
})

/** Plays steps as inserts, then updates that move a note between schools. */
function operationsOf(steps: Step[]): Operation[] {
	const seen = new Map<string, string>()
	return steps.map((step) => {
		const recordId = `${step.collection}-${step.record}`
		const before = seen.get(recordId)
		seen.set(recordId, step.school)
		if (step.collection === 'logs') {
			return deliveryOp({ collection: 'logs', recordId, nodeId: step.node, data: { line: 'x' } })
		}
		return before === undefined
			? deliveryOp({
					collection: 'notes',
					recordId,
					nodeId: step.node,
					data: { body: 'b', schoolId: step.school },
				})
			: deliveryOp({
					collection: 'notes',
					recordId,
					nodeId: step.node,
					type: 'update',
					data: { schoolId: step.school },
					previousData: { schoolId: before },
				})
	})
}

const scopeArb = fc.subarray([...SCHOOLS], { minLength: 1 })

for (const kind of deliveryStoreKinds()) {
	describe(`delivery index reads: ${kind.name}`, () => {
		test('equals the global scan on every case and never omits a visible operation', async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(stepArb, { minLength: 1, maxLength: 14 }),
					scopeArb,
					fc.boolean(),
					fc.integer({ min: 0, max: 14 }),
					fc.integer({ min: 1, max: 6 }),
					async (steps, schools, withLogs, after, limit) => {
						const handle = await kind.make()
						try {
							const { store } = handle
							await store.setSchema(schema)
							await store.whenDeliveryIndexIdle?.()
							for (const op of operationsOf(steps)) await store.applyRemoteOperation(op)
							await store.backfillDeliveryPartitions?.()
							const all = await store.getOperationsAfterDelivery(0, 1000)
							const read = (await store.getOperationsAfterDeliveryIn?.(
								{
									...deliverySourcesForScope(plan, 'notes', { schoolId: { $in: schools } }).sources,
									collections: withLogs ? ['logs'] : [],
								},
								after,
								limit,
							)) ?? { operations: [], complete: false, coveredThrough: after }
							expect(read.complete).toBe(true)
							const keys = new Set(
								schools.map((s) => partitionKey('notes', 'schoolId', s).toString()),
							)
							keys.add(partitionKey('notes', 'schoolId', null).toString())
							const candidate = (d: (typeof all)[number]): boolean =>
								d.operation.collection === 'logs'
									? withLogs
									: partitionKeysOf(plan, d.operation.collection, d.scopeSnapshot ?? null).some(
											(k) => keys.has(k.toString()),
										)
							// Candidates by the global scan: the first `limit` after the cursor.
							const expected = all
								.filter(
									(d) =>
										d.deliverySequence > after &&
										d.deliverySequence <= read.coveredThrough &&
										candidate(d),
								)
								.slice(0, limit)
							expect(read.operations.map((d) => d.operation.id)).toEqual(
								expected.map((d) => d.operation.id),
							)
							expect(read.coveredThrough).toBe(Math.max(after, all.length))
							// Superset: whatever the scope can see up to the last returned
							// operation (or everything covered, below the limit) is in the answer.
							const horizon =
								read.operations.length >= limit
									? (read.operations[read.operations.length - 1]?.deliverySequence ?? after)
									: read.coveredThrough
							const returned = new Set(read.operations.map((d) => d.operation.id))
							for (const d of all) {
								if (d.deliverySequence <= after || d.deliverySequence > horizon) continue
								const image = d.scopeSnapshot
								const sees =
									d.operation.collection === 'logs'
										? withLogs
										: [image?.pre, image?.post].some(
												(i) =>
													i &&
													typeof i.schoolId === 'string' &&
													schools.includes(i.schoolId as never),
											)
								if (sees) expect(returned.has(d.operation.id)).toBe(true)
							}
						} finally {
							await handle.done()
						}
					},
				),
				{ numRuns: kind.name === 'memory' ? 60 : 12 },
			)
		}, 120_000)

		test('an index that cannot answer says so, and a read past the frontier is empty', async () => {
			const handle = await kind.make()
			try {
				const { store } = handle
				await store.setSchema(schema)
				await store.whenDeliveryIndexIdle?.()
				await store.applyRemoteOperation(
					deliveryOp({ collection: 'notes', recordId: 'n1', data: { body: 'b', schoolId: 'a' } }),
				)
				const some: DeliverySources = {
					partitionKeys: [partitionKey('notes', 'schoolId', 'a')],
					collections: [],
					nodeIds: [],
				}
				const hit = await store.getOperationsAfterDeliveryIn?.(some, 0, 10)
				expect(hit?.complete).toBe(true)
				expect(hit?.operations).toHaveLength(1)
				// Nothing above the cursor: complete, empty, covered through the cursor.
				const past = await store.getOperationsAfterDeliveryIn?.(some, 5, 10)
				expect(past).toEqual({ operations: [], complete: true, coveredThrough: 5 })
				// Too many sources: refused, so the caller reads through the global scan.
				const wide: DeliverySources = {
					partitionKeys: Array.from({ length: MAX_DELIVERY_SOURCES + 1 }, (_, i) =>
						partitionKey('notes', 'schoolId', `s${i}`),
					),
					collections: [],
					nodeIds: [],
				}
				expect(await store.getOperationsAfterDeliveryIn?.(wide, 0, 10)).toEqual({
					operations: [],
					complete: false,
					coveredThrough: 0,
				})
				// Another plan (a rolling deploy) is not trusted until the rebuild completes.
				if (handle.open) {
					const other = handle.open()
					await other.setSchema(schema, { deliveryPartitions: { notes: ['body'] } })
					const read = await store.getOperationsAfterDeliveryIn?.(some, 0, 10)
					expect(read?.complete).toBe(false)
				}
			} finally {
				await handle.done()
			}
		})

		test('node and collection sources are read like partition keys', async () => {
			const handle = await kind.make()
			try {
				const { store } = handle
				await store.setSchema(schema)
				await store.whenDeliveryIndexIdle?.()
				const a = deliveryOp({
					collection: 'logs',
					recordId: 'l1',
					nodeId: 'node-a',
					data: { line: '1' },
				})
				const b = deliveryOp({
					collection: 'logs',
					recordId: 'l2',
					nodeId: 'node-b',
					data: { line: '2' },
				})
				const c = deliveryOp({
					collection: 'notes',
					recordId: 'n1',
					nodeId: 'node-b',
					data: { body: 'b', schoolId: 'z' },
				})
				for (const op of [a, b, c]) await store.applyRemoteOperation(op)
				const byNode = await store.getOperationsAfterDeliveryIn?.(
					{ partitionKeys: [], collections: [], nodeIds: ['node-b'] },
					0,
					10,
				)
				expect(byNode?.operations.map((d) => d.operation.id)).toEqual([b.id, c.id])
				const byCollection = await store.getOperationsAfterDeliveryIn?.(
					{ partitionKeys: [], collections: ['logs'], nodeIds: [] },
					1,
					10,
				)
				expect(byCollection?.operations.map((d) => d.operation.id)).toEqual([b.id])
			} finally {
				await handle.done()
			}
		})

		test('a delete is filed under every partition its record was in', async () => {
			const handle = await kind.make()
			try {
				const { store } = handle
				await store.setSchema(schema)
				await store.whenDeliveryIndexIdle?.()
				const insert = deliveryOp({
					collection: 'notes',
					recordId: 'n1',
					data: { body: 'b', schoolId: 'a' },
				})
				const move = deliveryOp({
					collection: 'notes',
					recordId: 'n1',
					type: 'update',
					data: { schoolId: 'b' },
					previousData: { schoolId: 'a' },
				})
				const remove = deliveryOp({
					collection: 'notes',
					recordId: 'n1',
					type: 'delete',
					data: null,
					previousData: null,
				})
				for (const op of [insert, move, remove]) await store.applyRemoteOperation(op)
				await store.backfillDeliveryPartitions?.()
				// A session that read school "a" only: the record was in its view, so it is sent
				// the delete although the delete's own pre-image names school "b".
				const read = await store.getOperationsAfterDeliveryIn?.(
					{
						partitionKeys: [partitionKey('notes', 'schoolId', 'a')],
						collections: [],
						nodeIds: [],
					},
					0,
					10,
				)
				expect(read?.operations.map((d) => d.operation.id)).toEqual([insert.id, move.id, remove.id])
			} finally {
				await handle.done()
			}
		})

		test('a read is not trusted when a reset and a full rebuild fit inside its window', async () => {
			if (kind.name === 'memory') return
			const handle = await kind.make()
			try {
				const { store } = handle
				if (!handle.sql) throw new Error('this store kind offers raw SQL')
				await store.setSchema(schema)
				await store.whenDeliveryIndexIdle?.()
				await store.applyRemoteOperation(
					deliveryOp({ collection: 'notes', recordId: 'n1', data: { body: 'b', schoolId: 'a' } }),
				)
				const sources: DeliverySources = {
					partitionKeys: [partitionKey('notes', 'schoolId', 'a')],
					collections: [],
					nodeIds: [],
				}
				const original = store.getDeliveryPartitionState?.bind(store)
				if (!original) throw new Error('this store reports its partition state')
				let reads = 0
				store.getDeliveryPartitionState = async () => {
					const state = await original()
					reads += 1
					if (reads === 1) {
						// A restore: same plan, the index emptied and a new epoch, then the rebuild
						// reaches the old frontier before the read looks at the state again, so
						// plan and frontier alone look untouched.
						await handle.sql?.('DELETE FROM kora_delivery_partitions')
						await handle.sql?.(
							"UPDATE kora_server_meta SET value = '0' WHERE key = 'delivery_partitions_through'",
						)
						await handle.sql?.(
							"INSERT INTO kora_server_meta (key, value) VALUES ('delivery_partitions_epoch', 'restored') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
						)
						await store.backfillDeliveryPartitions?.()
						expect((await original()).through).toBe(state.through)
					}
					return state
				}
				const read = await store.getOperationsAfterDeliveryIn?.(sources, 0, 10)
				expect(read?.complete).toBe(false)
			} finally {
				await handle.done()
			}
		})

		test('an index built under an older plan version is unusable until it is rebuilt', async () => {
			if (kind.name === 'memory') return
			const handle = await kind.make()
			try {
				const { store } = handle
				if (!handle.sql || !handle.open) throw new Error('this store kind offers raw SQL')
				await store.setSchema(schema)
				await store.whenDeliveryIndexIdle?.()
				await store.applyRemoteOperation(
					deliveryOp({ collection: 'notes', recordId: 'n1', data: { body: 'b', schoolId: 'a' } }),
				)
				const before = await store.getDeliveryPartitionState?.()
				expect(before?.fingerprint?.startsWith('dp2:')).toBe(true)
				// What main's C2.1 to C2.4 code left behind: its fingerprint, rows and frontier.
				await handle.sql?.(
					"UPDATE kora_server_meta SET value = 'dp1:old' WHERE key = 'delivery_partition_fields'",
				)
				// Read under this plan's fingerprint it is not trusted, whatever its frontier says.
				expect((await store.getDeliveryPartitionState?.())?.usable).toBe(false)
				const upgraded = handle.open()
				try {
					await upgraded.setSchema(schema)
					// The first start under this plan finds a stored fingerprint that is not its own:
					// the index is reset, and read as unusable until the rebuild completes.
					await upgraded.whenDeliveryIndexIdle?.()
					const after = await upgraded.getDeliveryPartitionState?.()
					expect(after?.fingerprint).toBe(before?.fingerprint)
					expect(after?.usable).toBe(true)
					expect(after?.epoch).not.toBe(before?.epoch)
				} finally {
					await upgraded.close()
				}
			} finally {
				await handle.done()
			}
		})

		test('a read that raced an index reset is not trusted', async () => {
			if (!kind.name || kind.name === 'memory') return
			const handle = await kind.make()
			try {
				const { store } = handle
				if (!handle.sql) throw new Error('this store kind offers raw SQL')
				await store.setSchema(schema)
				await store.whenDeliveryIndexIdle?.()
				await store.applyRemoteOperation(
					deliveryOp({ collection: 'notes', recordId: 'n1', data: { body: 'b', schoolId: 'a' } }),
				)
				const sources: DeliverySources = {
					partitionKeys: [partitionKey('notes', 'schoolId', 'a')],
					collections: [],
					nodeIds: [],
				}
				const original = store.getDeliveryPartitionState?.bind(store)
				if (!original) throw new Error('this store reports its partition state')
				let reads = 0
				store.getDeliveryPartitionState = async () => {
					const state = await original()
					reads += 1
					// Another instance resets the index right after the first state read.
					if (reads === 1) {
						await handle.sql?.(
							"UPDATE kora_server_meta SET value = '0' WHERE key = 'delivery_partitions_through'",
						)
					}
					return state
				}
				const read = await store.getOperationsAfterDeliveryIn?.(sources, 0, 10)
				expect(read?.complete).toBe(false)
			} finally {
				await handle.done()
			}
		})
	})
}
