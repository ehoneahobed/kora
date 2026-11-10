import * as fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { defineSchema } from '../schema/define'
import { t } from '../schema/types'
import type { Operation, SchemaDefinition } from '../types'
import { createFoldState, foldRecord, joinStates, materialize, mergeOp } from './fold'
import { serializeFoldState } from './serialize'
import type { FoldState } from './types'

const schema = defineSchema({
	version: 1,
	collections: {
		tickets: {
			fields: {
				title: t.string(),
				tags: t.array(t.string()),
				score: t.number().merge('counter'),
				best: t.number().merge('max'),
				history: t.array(t.string()).merge('append-only'),
			},
		},
	},
}) as unknown as SchemaDefinition

const NUM_RUNS = Number(process.env.KORA_PROPERTY_RUNS ?? 500)
const TAG = fc.constantFrom('a', 'b', 'c')
const TAGS = fc.array(TAG, { maxLength: 3 })

/** One update's changed fields and the values its author saw. */
const change = fc.oneof(
	fc.record({
		data: fc.record({ title: fc.constantFrom('x', 'y', 'z') }),
		previousData: fc.record({ title: fc.constantFrom('x', 'y') }),
	}),
	fc.record({ data: fc.record({ tags: TAGS }), previousData: fc.record({ tags: TAGS }) }),
	fc.record({
		data: fc.record({ score: fc.integer({ min: 0, max: 20 }) }),
		previousData: fc.record({ score: fc.integer({ min: 0, max: 20 }) }),
	}),
	fc.record({
		data: fc.record({ best: fc.integer({ min: 0, max: 20 }) }),
		previousData: fc.record({ best: fc.integer({ min: 0, max: 20 }) }),
	}),
	fc.record({ data: fc.record({ history: TAGS }), previousData: fc.record({ history: TAGS }) }),
)

const step = fc.oneof(
	{ weight: 6, arbitrary: change.map((c) => ({ kind: 'update' as const, ...c })) },
	{ weight: 1, arbitrary: fc.constant({ kind: 'delete' as const }) },
)

/** An insert and concurrent writes by several nodes, each with a distinct HLC stamp. */
const operations: fc.Arbitrary<Operation[]> = fc
	.array(fc.tuple(step, fc.constantFrom('n1', 'n2', 'n3')), { maxLength: 12 })
	.map((steps) => {
		const insert = build('n1', 1000, 'insert', {
			title: 'x',
			tags: ['a'],
			score: 0,
			best: 0,
			history: [],
		})
		const rest = steps.map(([current, node], index) =>
			current.kind === 'delete'
				? build(node, 1001 + index, 'delete', null)
				: build(node, 1001 + index, 'update', current.data, current.previousData),
		)
		return [insert, ...rest]
	})

function build(
	nodeId: string,
	wallTime: number,
	type: Operation['type'],
	data: Record<string, unknown> | null,
	previousData: Record<string, unknown> | null = null,
): Operation {
	return {
		id: `${nodeId}-${wallTime}`,
		nodeId,
		type,
		collection: 'tickets',
		recordId: 'r1',
		data,
		previousData,
		timestamp: { wallTime, logical: 0, nodeId },
		sequenceNumber: wallTime,
		causalDeps: [],
		schemaVersion: 1,
	}
}

function incremental(ops: readonly Operation[]): FoldState {
	let state = createFoldState('tickets', 'r1')
	for (const op of ops) state = mergeOp(state, op, schema).state
	return state
}

function canonical(state: FoldState | null): string | null {
	return state === null ? null : serializeFoldState(state)
}

/** The same operations in an order chosen by `keys`. */
function shuffled(ops: readonly Operation[], keys: readonly number[]): Operation[] {
	return ops
		.map((op, index) => ({ op, key: keys[index % keys.length] ?? 0, index }))
		.sort((a, b) => a.key - b.key || a.index - b.index)
		.map((entry) => entry.op)
}

const orderKeys = fc.array(fc.integer(), { minLength: 1, maxLength: 16 })

describe('the record fold is a CRDT over the set of operations', () => {
	test('any arrival order gives the same state (commutative, associative)', () => {
		fc.assert(
			fc.property(operations, orderKeys, orderKeys, (ops, first, second) => {
				const a = incremental(shuffled(ops, first))
				const b = incremental(shuffled(ops, second))
				expect(canonical(a)).toBe(canonical(b))
				expect(materialize(a)).toEqual(materialize(b))
			}),
			{ numRuns: NUM_RUNS, seed: 20261110 },
		)
	})

	test('merging one by one equals folding from scratch', () => {
		fc.assert(
			fc.property(operations, orderKeys, (ops, keys) => {
				expect(materialize(incremental(shuffled(ops, keys)))).toEqual(
					materialize(foldRecord(ops, schema).state as FoldState),
				)
			}),
			{ numRuns: NUM_RUNS, seed: 20261111 },
		)
	})

	test('applying an operation again changes nothing (idempotent)', () => {
		fc.assert(
			fc.property(operations, orderKeys, (ops, keys) => {
				const once = incremental(ops)
				const repeated = incremental([...ops, ...shuffled(ops, keys)])
				expect(canonical(repeated)).toBe(canonical(once))
			}),
			{ numRuns: NUM_RUNS, seed: 20261112 },
		)
	})

	test('joining replicas gives the state of the union, whichever way they join', () => {
		fc.assert(
			fc.property(operations, fc.integer({ min: 0, max: 12 }), (ops, cut) => {
				const whole = canonical(incremental(ops))
				const left = incremental(ops.slice(0, cut))
				const middle = incremental(ops.slice(cut, cut + 2))
				const right = incremental(ops.slice(cut + 2))
				expect(canonical(joinStates(joinStates(left, middle, schema), right, schema))).toBe(whole)
				expect(canonical(joinStates(right, joinStates(middle, left, schema), schema))).toBe(whole)
			}),
			{ numRuns: NUM_RUNS, seed: 20261113 },
		)
	})
})
