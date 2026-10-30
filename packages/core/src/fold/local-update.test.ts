import { fc } from '@fast-check/vitest'
import { describe, expect, test } from 'vitest'
import { applyAtomicOp, op as atomic } from '../operations/atomic-ops'
import { defineSchema } from '../schema/define'
import { t } from '../schema/types'
import type { AtomicOp, Operation, SchemaDefinition } from '../types'
import { createFoldState, foldRecord, materialize, mergeOp } from './fold'
import { predictLocalUpdate } from './local-update'
import type { FoldState } from './types'

/*
 * `predictLocalUpdate` against the real fold. The property: for ANY history of writes to
 * a record (several nodes, writers that had not seen each other's writes, plain and atomic
 * writes of every merge kind), the values predicted for a local update equal the values the
 * fold materializes after merging that update into the record's real state. Without the
 * fold state the prediction either equals them or declines (an array add), never differs;
 * with it, it always equals them.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				title: t.string(),
				n: t.number().optional(),
				hits: t.number().merge('counter').default(0),
				best: t.number().merge('max').optional(),
				low: t.number().merge('min').optional(),
				tags: t.array(t.string()).default([]),
				log: t.array(t.string()).merge('append-only').default([]),
			},
		},
	},
}) as unknown as SchemaDefinition

const NODES = ['a', 'b', 'c'] as const
const ID = 'rec'

type Values = Record<string, unknown>

/** One field write as the author intends it: plain value or atomic intent. */
type Intent = { field: string; plain: unknown } | { field: string; atomic: AtomicOp }

const smallInt = fc.integer({ min: -5, max: 5 })
const tagArb = fc.constantFrom('x', 'y', 'z')

const intentArb: fc.Arbitrary<Intent> = fc.oneof(
	{
		weight: 1,
		arbitrary: fc.constantFrom('t0', 't1').map((plain): Intent => ({ field: 'title', plain })),
	},
	{ weight: 2, arbitrary: smallInt.map((plain): Intent => ({ field: 'n', plain })) },
	{
		weight: 2,
		arbitrary: smallInt.map(
			(value): Intent => ({
				field: 'n',
				atomic: { type: 'increment', value },
			}),
		),
	},
	{
		weight: 1,
		arbitrary: fc
			.constantFrom('max', 'min')
			.chain((type) => smallInt.map((value): Intent => ({ field: 'n', atomic: { type, value } }))),
	},
	{ weight: 2, arbitrary: smallInt.map((plain): Intent => ({ field: 'hits', plain })) },
	{
		weight: 3,
		arbitrary: smallInt.map(
			(value): Intent => ({
				field: 'hits',
				atomic: { type: 'increment', value },
			}),
		),
	},
	{ weight: 2, arbitrary: smallInt.map((plain): Intent => ({ field: 'best', plain })) },
	{
		weight: 2,
		arbitrary: smallInt.map((value): Intent => ({ field: 'best', atomic: { type: 'max', value } })),
	},
	{ weight: 2, arbitrary: smallInt.map((plain): Intent => ({ field: 'low', plain })) },
	{
		weight: 2,
		arbitrary: smallInt.map((value): Intent => ({ field: 'low', atomic: { type: 'min', value } })),
	},
	{
		weight: 3,
		arbitrary: fc
			.array(tagArb, { maxLength: 4 })
			.map((plain): Intent => ({ field: 'tags', plain })),
	},
	{
		weight: 3,
		arbitrary: tagArb.map(
			(value): Intent => ({ field: 'tags', atomic: { type: 'append', value } }),
		),
	},
	{
		weight: 3,
		arbitrary: tagArb.map(
			(value): Intent => ({ field: 'tags', atomic: { type: 'remove', value } }),
		),
	},
	{
		weight: 2,
		arbitrary: fc.array(tagArb, { maxLength: 3 }).map((plain): Intent => ({ field: 'log', plain })),
	},
	{
		weight: 2,
		arbitrary: tagArb.map((value): Intent => ({ field: 'log', atomic: { type: 'append', value } })),
	},
	{
		weight: 1,
		arbitrary: tagArb.map((value): Intent => ({ field: 'log', atomic: { type: 'remove', value } })),
	},
)

const stepArb = fc.record({
	node: fc.constantFrom(...NODES),
	intents: fc.array(intentArb, { minLength: 1, maxLength: 3 }),
	/** How many of the earlier writes this author had seen (0 = all of them). */
	staleness: fc.nat(3),
})

/** Build the update operation an author makes from the values it sees, as the write path does. */
function buildUpdate(
	seen: Values,
	intents: readonly Intent[],
	node: string,
	index: number,
): Operation | null {
	const data: Record<string, unknown> = {}
	const previousData: Record<string, unknown> = {}
	const atomicOps: Record<string, AtomicOp> = {}
	for (const intent of intents) {
		const { field } = intent
		if (field in data) continue // one value per field per operation
		previousData[field] = seen[field] ?? null
		if ('atomic' in intent) {
			data[field] = applyAtomicOp(seen[field], intent.atomic)
			atomicOps[field] = intent.atomic
		} else {
			data[field] = intent.plain
		}
	}
	if (Object.keys(data).length === 0) return null
	return {
		id: `op-${index}`,
		nodeId: node,
		type: 'update',
		collection: 'items',
		recordId: ID,
		data,
		previousData,
		timestamp: { wallTime: 1_000 + index, logical: 0, nodeId: node },
		sequenceNumber: index,
		causalDeps: [],
		schemaVersion: 1,
		...(Object.keys(atomicOps).length > 0 ? { atomicOps } : {}),
	}
}

const insertOp: Operation = {
	id: 'op-insert',
	nodeId: 'a',
	type: 'insert',
	collection: 'items',
	recordId: ID,
	data: { title: 't0', n: 0, hits: 0, tags: [], log: [] },
	previousData: null,
	timestamp: { wallTime: 500, logical: 0, nodeId: 'a' },
	sequenceNumber: 0,
	causalDeps: [],
	schemaVersion: 1,
}

/** The record's values after merging `ops` (any order). */
function valuesOf(ops: readonly Operation[]): Values {
	const folded = foldRecord(ops, schema)
	return folded.state ? (materialize(folded.state) ?? {}) : {}
}

interface History {
	ops: Operation[]
	state: FoldState
	current: Values
}

function buildHistory(
	steps: ReadonlyArray<{ node: string; intents: Intent[]; staleness: number }>,
): History {
	const ops: Operation[] = [insertOp]
	steps.forEach((step, i) => {
		// A writer that had not seen the latest `staleness` writes derives its update from
		// the values before them: concurrent writes, as between two devices.
		const seen = valuesOf(ops.slice(0, Math.max(1, ops.length - step.staleness)))
		const built = buildUpdate(seen, step.intents, step.node, i + 1)
		if (built) ops.push(built)
	})
	const folded = foldRecord(ops, schema)
	if (!folded.state) throw new Error('history has no state')
	return { ops, state: folded.state, current: materialize(folded.state) ?? {} }
}

/** The local update, stamped after everything else. */
function localUpdate(history: History, intents: readonly Intent[]): Operation | null {
	const built = buildUpdate(history.current, intents, 'L', 10_000)
	return built
}

function fieldsOf(values: Values, fields: readonly string[]): Values {
	const out: Values = {}
	for (const field of fields) out[field] = values[field] ?? null
	return out
}

describe('predictLocalUpdate', () => {
	test('a counter increments the current value', () => {
		const update: Operation = {
			...insertOp,
			id: 'u',
			type: 'update',
			data: { hits: 5 },
			previousData: { hits: 4 },
			atomicOps: { hits: { type: 'increment', value: 1 } },
			timestamp: { wallTime: 2_000, logical: 0, nodeId: 'L' },
		}
		const prediction = predictLocalUpdate({
			schema,
			op: update,
			current: { hits: 4 },
			options: {},
		})
		expect(prediction).toEqual({ values: { hits: 5 }, state: null })
	})

	test('a max field keeps the larger value, a min field the smaller', () => {
		const update: Operation = {
			...insertOp,
			id: 'u',
			type: 'update',
			data: { best: 3, low: 9 },
			previousData: { best: 7, low: 2 },
			timestamp: { wallTime: 2_000, logical: 0, nodeId: 'L' },
		}
		expect(
			predictLocalUpdate({ schema, op: update, current: { best: 7, low: 2 }, options: {} }),
		).toEqual({ values: { best: 7, low: 2 }, state: null })
	})

	test('an array add is declined without the fold state and exact with it', () => {
		const state = [{ tags: ['a', 'b'] }].reduce<FoldState>(
			(acc) => mergeOp(acc, { ...insertOp, data: { tags: ['a', 'b'] } }, schema, {}).state,
			createFoldState('items', ID),
		)
		const update: Operation = {
			...insertOp,
			id: 'u',
			type: 'update',
			data: { tags: ['a', 'b', 'c'] },
			previousData: { tags: ['a', 'b'] },
			atomicOps: { tags: { type: 'append', value: 'c' } },
			timestamp: { wallTime: 2_000, logical: 0, nodeId: 'L' },
		}
		const current = { tags: ['a', 'b'] }
		expect(predictLocalUpdate({ schema, op: update, current, options: {} })).toEqual({
			declined: 'array-needs-state',
		})
		const exact = predictLocalUpdate({ schema, op: update, current, baseState: state, options: {} })
		expect(exact).toMatchObject({ values: { tags: ['a', 'b', 'c'] } })
	})

	test('a re-added element returns to its original position (why adds need the state)', () => {
		// a, b, c added; a removed; then a added again: it is first again, not last.
		const ops: Operation[] = [
			{ ...insertOp, data: { tags: ['a', 'b', 'c'] } },
			{
				...insertOp,
				id: 'rm',
				type: 'update',
				data: { tags: ['b', 'c'] },
				previousData: { tags: ['a', 'b', 'c'] },
				atomicOps: { tags: { type: 'remove', value: 'a' } },
				timestamp: { wallTime: 600, logical: 0, nodeId: 'a' },
			},
		]
		const state = foldRecord(ops, schema).state as FoldState
		const current = materialize(state) ?? {}
		expect(current.tags).toEqual(['b', 'c'])
		const add: Operation = {
			...insertOp,
			id: 'add',
			type: 'update',
			data: { tags: ['b', 'c', 'a'] },
			previousData: { tags: ['b', 'c'] },
			atomicOps: { tags: { type: 'append', value: 'a' } },
			timestamp: { wallTime: 2_000, logical: 0, nodeId: 'L' },
		}
		const committed = materialize(mergeOp(state, add, schema, {}).state)
		expect(committed?.tags).toEqual(['a', 'b', 'c'])
		const exact = predictLocalUpdate({
			schema,
			op: add,
			current: { tags: ['b', 'c'] },
			baseState: state,
			options: {},
		})
		expect(exact).toMatchObject({ values: { tags: ['a', 'b', 'c'] } })
	})

	test('a state that does not describe the current values is refused', () => {
		const state = foldRecord([insertOp], schema).state as FoldState
		const update: Operation = {
			...insertOp,
			id: 'u',
			type: 'update',
			data: { hits: 9 },
			previousData: { hits: 8 },
			atomicOps: { hits: { type: 'increment', value: 1 } },
			timestamp: { wallTime: 2_000, logical: 0, nodeId: 'L' },
		}
		expect(
			predictLocalUpdate({
				schema,
				op: update,
				current: { hits: 8 },
				baseState: state,
				options: {},
			}),
		).toEqual({ declined: 'state-mismatch' })
	})

	test('a field that folds as a resolver, key map or richtext is declined', () => {
		const withMap = defineSchema({
			version: 1,
			collections: { items: { fields: { meta: t.json().optional() } } },
		}) as unknown as SchemaDefinition
		const update: Operation = {
			...insertOp,
			id: 'u',
			type: 'update',
			data: { meta: { a: 1 } },
			previousData: { meta: null },
			timestamp: { wallTime: 2_000, logical: 0, nodeId: 'L' },
		}
		expect(
			predictLocalUpdate({ schema: withMap, op: update, current: { meta: null }, options: {} }),
		).toEqual({ declined: 'unsupported-plan' })
	})

	test('the sentinel helpers resolve like the fold applies them', () => {
		// The write path resolves `op.increment(2)` against the row, the fold re-applies the intent.
		expect(applyAtomicOp(3, { type: 'increment', value: 2 })).toBe(5)
		expect(atomic.increment(2).value).toBe(2)
	})

	test('property: the prediction equals the real fold of the update, over random histories', () => {
		fc.assert(
			fc.property(
				fc.array(stepArb, { maxLength: 8 }),
				fc.array(intentArb, { minLength: 1, maxLength: 3 }),
				(steps, intents) => {
					const hist = buildHistory(steps)
					const update = localUpdate(hist, intents)
					if (!update) return
					const written = Object.keys(update.data ?? {})
					const truth = fieldsOf(
						materialize(mergeOp(hist.state, update, schema, {}).state) ?? {},
						written,
					)
					// Without the state: equal, or declined because the update adds an array element.
					const synthetic = predictLocalUpdate({
						schema,
						op: update,
						current: hist.current,
						options: {},
					})
					if ('declined' in synthetic) {
						expect(synthetic.declined).toBe('array-needs-state')
					} else {
						expect(synthetic.values).toEqual(truth)
					}
					// With the real state: always equal, and the state is the merged one.
					const exact = predictLocalUpdate({
						schema,
						op: update,
						current: hist.current,
						baseState: hist.state,
						options: {},
					})
					if ('declined' in exact) throw new Error(`declined: ${exact.declined}`)
					expect(exact.values).toEqual(truth)
					expect(exact.state && materialize(exact.state)).toEqual(
						materialize(mergeOp(hist.state, update, schema, {}).state),
					)
				},
			),
			{ numRuns: 3_000 },
		)
	}, 120_000)

	test('property: every array write is declined without the state (identity is not in the values)', () => {
		fc.assert(
			fc.property(fc.array(stepArb, { maxLength: 8 }), tagArb, (steps, value) => {
				const hist = buildHistory(steps)
				const update = localUpdate(hist, [{ field: 'tags', atomic: { type: 'remove', value } }])
				if (!update) return
				expect(
					predictLocalUpdate({ schema, op: update, current: hist.current, options: {} }),
				).toEqual({ declined: 'array-needs-state' })
			}),
			{ numRuns: 300 },
		)
	}, 60_000)

	test('removing a value whose visible copy is not the first one ever added', () => {
		// Two devices saw [y]. One removes it (y#0), the other adds a second y (y#1): the record
		// shows [y], but that copy is y#1. A local removal of "y" removes y#0 and changes
		// nothing visible. The prediction made from the fold state says so too; one made from
		// the values alone would have removed the visible copy, so it is not attempted.
		const ops: Operation[] = [
			{ ...insertOp, data: { tags: ['y'] } },
			{
				...insertOp,
				id: 'drop',
				type: 'update',
				nodeId: 'a',
				data: { tags: [] },
				previousData: { tags: ['y'] },
				timestamp: { wallTime: 600, logical: 0, nodeId: 'a' },
			},
			{
				...insertOp,
				id: 'dup',
				type: 'update',
				nodeId: 'b',
				data: { tags: ['y', 'y'] },
				previousData: { tags: ['y'] },
				timestamp: { wallTime: 601, logical: 0, nodeId: 'b' },
			},
		]
		const state = foldRecord(ops, schema).state as FoldState
		expect(materialize(state)?.tags).toEqual(['y'])
		const remove: Operation = {
			...insertOp,
			id: 'rm',
			type: 'update',
			nodeId: 'L',
			data: { tags: [] },
			previousData: { tags: ['y'] },
			atomicOps: { tags: { type: 'remove', value: 'y' } },
			timestamp: { wallTime: 2_000, logical: 0, nodeId: 'L' },
		}
		const committed = materialize(mergeOp(state, remove, schema, {}).state)?.tags
		const predicted = predictLocalUpdate({
			schema,
			op: remove,
			current: { tags: ['y'] },
			baseState: state,
			options: {},
		})
		expect(predicted).toMatchObject({ values: { tags: committed } })
		// Recorded as found: the visible copy survives the removal (see the S6b result in
		// docs/design/instant-ui-updates.md).
		expect(committed).toEqual(['y'])
	})
})
