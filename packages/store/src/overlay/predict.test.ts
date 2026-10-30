import { fc } from '@fast-check/vitest'
import { defineSchema, t, validateRecord } from '@korajs/core'
import type { CollectionDefinition } from '@korajs/core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { runLocalWrite } from '../mutations/run-local-write'
import type { LocalMutationContext } from '../mutations/types'
import {
	prepareInsert,
	writeDeleteInTx,
	writeInsertInTx,
	writeUpdateInTx,
} from '../mutations/write-ops'
import { deserializeRecord } from '../serialization/serializer'
import { Store } from '../store/store'
import type { CollectionRecord, RawCollectionRow } from '../types'
import {
	type Prediction,
	divergentFields,
	isDeletePredictable,
	predictDelete,
	predictInsert,
	predictUpdate,
} from './predict'

/**
 * Acceptance of instant-UI stage S2: the predicted record equals the post-commit
 * `SELECT` row, modulo `createdAt` and `updatedAt`, for generated inserts, updates and
 * deletes, on better-sqlite3 in both materialization modes. The prediction is made from
 * the SAME prepared object (insert) or the same validated input (update) the write path
 * then writes, and compared with the row read back the way every read reads it.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				title: t.string(),
				note: t.string().optional(),
				count: t.number().optional(),
				qty: t.number().default(0),
				done: t.boolean().default(false),
				status: t.enum(['todo', 'doing', 'finished']).default('todo'),
				due: t.timestamp().optional(),
				tags: t.array(t.string()).default([]),
				meta: t.json().optional(),
				stamp: t.timestamp().auto(),
			},
		},
		// Update-excluded shapes, for the miss tests.
		counters: { fields: { name: t.string(), hits: t.number().merge('counter').default(0) } },
		vault: { fields: { label: t.string(), pin: t.secret().hashed().optional() } },
		docs: { fields: { title: t.string(), body: t.richtext().optional() } },
		parents: { fields: { name: t.string() } },
		children: { fields: { name: t.string(), parentId: t.string().optional() } },
		plain: { fields: { name: t.string() } },
		orders: {
			fields: { status: t.enum(['draft', 'sent', 'done']).default('draft') },
			stateMachine: {
				field: 'status',
				transitions: { draft: ['sent'], sent: ['done'], done: [] },
				onInvalidTransition: 'reject',
			},
		},
	},
	relations: {
		childParent: {
			from: 'children',
			to: 'parents',
			type: 'many-to-one',
			field: 'parentId',
			onDelete: 'cascade',
		},
	},
})

const text = fc.string({ maxLength: 12 })
// Any UTF-16 code unit, so lone surrogates and NUL occur (the stored-text codec, RT-65).
const textWithOddCodeUnits = fc.string({
	unit: fc.integer({ min: 0, max: 0xffff }).map((unit) => String.fromCharCode(unit)),
	maxLength: 8,
})
const finiteNumber = fc.double({ noNaN: true, noDefaultInfinity: true })
const smallInt = fc.integer({ min: -1_000, max: 1_000 })
const number = fc.oneof(finiteNumber, smallInt, fc.constantFrom(0, -0, 0.5, 1e21, 5e-324, -1e-7))
const timestamp = fc.integer({ min: 0, max: 2 ** 41 })

const insertData = fc.record(
	{
		title: fc.oneof(text, textWithOddCodeUnits),
		note: fc.oneof(text, textWithOddCodeUnits),
		count: number,
		qty: number,
		done: fc.boolean(),
		status: fc.constantFrom('todo', 'doing', 'finished'),
		due: timestamp,
		tags: fc.array(fc.oneof(text, fc.constantFrom('a', 'a', 'b')), { maxLength: 4 }),
		meta: fc.oneof(
			fc.constant(null),
			// `__proto__` keys are refused by schema validation (they cannot be stored unchanged).
			fc
				.jsonValue()
				.filter((value) => value !== null && !JSON.stringify(value).includes('__proto__')),
		),
	},
	{ requiredKeys: ['title'] },
)

/** A scalar update: any subset of the scalar fields, optional ones may be cleared. */
const updateData = fc
	.record(
		{
			title: fc.oneof(text, textWithOddCodeUnits),
			note: fc.oneof(text, fc.constant(undefined)),
			count: fc.oneof(number, fc.constant(undefined)),
			qty: number,
			done: fc.boolean(),
			status: fc.constantFrom('todo', 'doing', 'finished'),
			due: fc.oneof(timestamp, fc.constant(undefined)),
		},
		{ requiredKeys: [] },
	)
	.filter((data) => Object.keys(data).length > 0)

type Step = { kind: 'update'; data: Record<string, unknown> } | { kind: 'delete' }

const workload = fc.record({
	insert: insertData,
	updates: fc.array(updateData, { maxLength: 4 }),
	remove: fc.boolean(),
})

async function selectRecord(
	adapter: BetterSqlite3Adapter,
	definition: CollectionDefinition,
	id: string,
): Promise<CollectionRecord | null> {
	const rows = await adapter.query<RawCollectionRow>(
		'SELECT * FROM items WHERE id = ? AND _deleted = 0',
		[id],
	)
	const row = rows[0]
	return row ? deserializeRecord(row, definition.fields) : null
}

function expectSameModuloMetadata(predicted: CollectionRecord, actual: CollectionRecord): void {
	expect(divergentFields(predicted, actual)).toEqual([])
	const strip = ({ createdAt: _c, updatedAt: _u, ...rest }: CollectionRecord) => rest
	// `toEqual` also tells +0 from -0, which `divergentFields` (Object.is) does too.
	expect(strip(predicted)).toEqual(strip(actual))
}

for (const materialization of ['fold', 'legacy'] as const) {
	describe(`predictor equals the committed row (${materialization})`, () => {
		let store: Store
		let ctx: LocalMutationContext
		const adapter = new BetterSqlite3Adapter(':memory:')
		const definition = schema.collections.items as CollectionDefinition

		beforeAll(async () => {
			store = new Store({
				schema,
				adapter,
				nodeId: 'predict-node',
				materialization,
			})
			await store.open()
			ctx = store.createMutationContext('items')
		})

		afterAll(async () => {
			await store.close()
		})

		const expectPredicted = (prediction: Prediction): Extract<Prediction, { predicted: true }> => {
			if (!prediction.predicted) throw new Error(`not predicted: ${prediction.reason}`)
			return prediction
		}

		test('inserts, update chains and deletes', async () => {
			await fc.assert(
				fc.asyncProperty(workload, async ({ insert, updates, remove }) => {
					// INSERT: predicted from the prepared object the transaction then writes.
					const prepared = await prepareInsert(ctx, 'items', insert)
					const inserted = expectPredicted(predictInsert(ctx, prepared, Date.now()))
					await runLocalWrite(ctx, (scope) => writeInsertInTx(ctx, scope, prepared))
					const afterInsert = await selectRecord(adapter, definition, prepared.recordId)
					expect(afterInsert).not.toBeNull()
					if (!afterInsert) return
					expectSameModuloMetadata(inserted.record, afterInsert)
					expect(inserted.record.id).toBe(prepared.recordId)

					// UPDATE CHAIN: every step is predicted from the PREVIOUS PREDICTION (the
					// registry's pending chain), nothing is read; then the writes run in order
					// and each intermediate row must equal its prediction.
					const steps: Step[] = updates.map((data) => ({ kind: 'update', data }))
					let base = inserted.record
					const predictions: Array<Extract<Prediction, { predicted: true }>> = []
					for (const step of steps) {
						if (step.kind !== 'update') continue
						const validated = validateRecord('items', definition, step.data, 'update')
						const next = predictUpdate(ctx, 'items', prepared.recordId, validated, base, Date.now())
						if (!next.predicted) {
							// The only reason a plain scalar update is declined here.
							expect(next.reason).toBe('no-change')
							break
						}
						predictions.push(next)
						base = next.record
					}
					for (const [index, prediction] of predictions.entries()) {
						const step = steps[index]
						if (!step || step.kind !== 'update') continue
						const validated = validateRecord('items', definition, step.data, 'update')
						await runLocalWrite(ctx, (scope) =>
							writeUpdateInTx(ctx, scope, 'items', prepared.recordId, validated),
						)
						const actual = await selectRecord(adapter, definition, prepared.recordId)
						expect(actual).not.toBeNull()
						if (actual) expectSameModuloMetadata(prediction.record, actual)
					}

					// DELETE: the tombstone reports the record as it stood, and the row is hidden.
					if (remove) {
						const current = await selectRecord(adapter, definition, prepared.recordId)
						if (!current) return
						const tomb = expectPredicted(predictDelete(ctx, 'items', prepared.recordId, current))
						expectSameModuloMetadata(tomb.record, current)
						expect(tomb.patch).toBeNull()
						await runLocalWrite(ctx, (scope) =>
							writeDeleteInTx(ctx, scope, 'items', prepared.recordId),
						)
						expect(await selectRecord(adapter, definition, prepared.recordId)).toBeNull()
					}
				}),
				{ numRuns: 200 },
			)
		}, 120_000)

		test('an insert prediction carries every field of the row, absent optionals as null', async () => {
			const prepared = await prepareInsert(ctx, 'items', { title: 'only a title' })
			const prediction = expectPredicted(predictInsert(ctx, prepared, 1_700_000_000_000))
			expect(prediction.record).toMatchObject({
				id: prepared.recordId,
				title: 'only a title',
				note: null,
				count: null,
				qty: 0,
				done: false,
				status: 'todo',
				due: null,
				tags: [],
				meta: null,
				createdAt: 1_700_000_000_000,
				updatedAt: 1_700_000_000_000,
			})
			await runLocalWrite(ctx, (scope) => writeInsertInTx(ctx, scope, prepared))
			const row = await selectRecord(adapter, definition, prepared.recordId)
			if (row) expectSameModuloMetadata(prediction.record, row)
		})
	})
}

describe('what the predictor declines (allowlist, I7)', () => {
	const env = {
		schema,
		nodeId: 'miss-node',
	}
	const base = (extra: Record<string, unknown>): CollectionRecord => ({
		id: 'r1',
		createdAt: 1,
		updatedAt: 1,
		...extra,
	})

	test('collections with a secret field are never predicted', async () => {
		const insert = predictInsert(
			env,
			{ collection: 'vault', recordId: 'v1', data: { label: 'x' } },
			1,
		)
		expect(insert).toEqual({ predicted: false, reason: 'secret-field' })
		const update = predictUpdate(env, 'vault', 'v1', { label: 'y' }, base({ label: 'x' }), 2)
		expect(update).toEqual({ predicted: false, reason: 'secret-field' })
	})

	test('an insert that writes a richtext field is not predicted', () => {
		const result = predictInsert(
			env,
			{ collection: 'docs', recordId: 'd1', data: { title: 'a', body: 'text' } },
			1,
		)
		expect(result).toEqual({ predicted: false, reason: 'richtext-field' })
		// The same collection is predicted when the richtext field is not written.
		expect(
			predictInsert(env, { collection: 'docs', recordId: 'd2', data: { title: 'a' } }, 1).predicted,
		).toBe(true)
	})

	test('updates of array, json and richtext fields are not predicted', () => {
		const record = base({ title: 'a', tags: [], meta: null })
		expect(predictUpdate(env, 'items', 'r1', { tags: ['x'] }, record, 2)).toEqual({
			predicted: false,
			reason: 'unsupported-field-kind',
		})
		expect(predictUpdate(env, 'items', 'r1', { meta: { a: 1 } }, record, 2)).toEqual({
			predicted: false,
			reason: 'unsupported-field-kind',
		})
	})

	test('atomic ops and non-default merge strategies are not predicted', async () => {
		const { op } = await import('@korajs/core')
		const record = base({ qty: 1 })
		expect(predictUpdate(env, 'items', 'r1', { qty: op.increment(1) }, record, 2)).toEqual({
			predicted: false,
			reason: 'atomic-op',
		})
		expect(
			predictUpdate(env, 'counters', 'r1', { hits: 5 }, base({ name: 'n', hits: 1 }), 2),
		).toEqual({ predicted: false, reason: 'merge-strategy' })
	})

	test('a state machine rejection is a miss, an allowed transition is predicted', () => {
		const draft = base({ status: 'draft' })
		expect(predictUpdate(env, 'orders', 'r1', { status: 'done' }, draft, 2)).toEqual({
			predicted: false,
			reason: 'state-machine',
		})
		const allowed = predictUpdate(env, 'orders', 'r1', { status: 'sent' }, draft, 2)
		expect(allowed.predicted && allowed.record.status).toBe('sent')
	})

	test('an update that writes nothing is a miss', () => {
		expect(predictUpdate(env, 'items', 'r1', {}, base({ title: 'a' }), 2)).toEqual({
			predicted: false,
			reason: 'no-change',
		})
	})

	test('a delete of a record other records cascade from is not predicted', () => {
		expect(isDeletePredictable(schema, 'parents')).toBe(false)
		expect(predictDelete(env, 'parents', 'p1', base({ name: 'p' }))).toEqual({
			predicted: false,
			reason: 'cascade-target',
		})
		// A referencing collection (the "from" side) and an unrelated one are predictable.
		expect(isDeletePredictable(schema, 'children')).toBe(true)
		expect(predictDelete(env, 'plain', 'x1', base({ name: 'x' })).predicted).toBe(true)
	})

	test('the predictor never throws on a record it cannot read', () => {
		const result = predictInsert(env, { collection: 'nope', recordId: 'n1', data: {} }, 1)
		expect(result).toEqual({ predicted: false, reason: 'unsupported-write' })
	})
})
