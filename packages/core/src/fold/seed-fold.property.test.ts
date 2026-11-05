import * as fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { defineSchema } from '../schema/define'
import { t } from '../schema/types'
import type { HLCTimestamp, Operation, SchemaDefinition } from '../types'
import { foldRecord, getFoldFieldVersions, joinStates, materialize } from './fold'
import { createSnapshotState } from './snapshot'

/*
 * First-visit parity, S4b: the fold-level half of the convergence gate
 * (docs/design/first-visit-parity.md 5.6.2, 5.6.3 and 10.1).
 *
 * A seed is a row snapshot of a record as the server held it at some frontier. While a device
 * is seeded, a local write is folded on top of that snapshot. The design claims the result is
 * what the real fold of "what the server had" plus "the local writes" would show. If it is not,
 * a user would see a value that the merge later changes. This test checks the claim for every
 * fold kind a seed can carry, with the server's view being ANY subset of the record's
 * operations (a frontier cuts the log by commit order, not by timestamp).
 *
 * Rich text is left out: a pre-ready answer is not given for it and its seed is a later slice.
 */

const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				title: t.string(),
				note: t.string().optional(),
				flag: t.boolean(),
				tags: t.array(t.string()),
				meta: t.object({ a: t.string(), b: t.string() }).optional(),
				score: t.number().merge('counter'),
				hi: t.number().merge('max'),
				lo: t.number().merge('min'),
				log: t.array(t.string()).merge('append-only'),
				stock: t.number(),
			},
			resolve: {
				stock: (local, remote, base) => (local as number) + ((remote as number) - (base as number)),
			},
		},
	},
}) as unknown as SchemaDefinition

type Values = Record<string, unknown>

const WORDS = ['a', 'b', 'c']
// Elements are unique per array: duplicates are a documented residual (see the last test).
const arrayOf = fc.uniqueArray(fc.constantFrom(...WORDS), { maxLength: 3 })

/** One field's new value; the generator picks which fields an update changes. */
const fieldValue: Record<string, fc.Arbitrary<unknown>> = {
	title: fc.constantFrom('x', 'y', 'z'),
	note: fc.constantFrom('p', 'q', null),
	flag: fc.boolean(),
	tags: arrayOf,
	meta: fc.record({ a: fc.constantFrom('1', '2'), b: fc.constantFrom('1', '2') }),
	score: fc.integer({ min: -5, max: 20 }),
	hi: fc.integer({ min: 0, max: 20 }),
	lo: fc.integer({ min: 0, max: 20 }),
	log: arrayOf,
	stock: fc.integer({ min: 0, max: 20 }),
}
const FIELD_NAMES = Object.keys(fieldValue)

const INSERT: Values = {
	title: 'x',
	note: null,
	flag: false,
	tags: [],
	meta: { a: '1', b: '1' },
	score: 0,
	hi: 0,
	lo: 10,
	log: [],
	stock: 5,
}

const changes: fc.Arbitrary<Values> = fc
	.subarray(FIELD_NAMES, { minLength: 1, maxLength: 4 })
	.chain((fields) =>
		fc.tuple(...fields.map((field) => fieldValue[field] as fc.Arbitrary<unknown>)).map((values) => {
			const out: Values = {}
			fields.forEach((field, i) => {
				out[field] = values[i]
			})
			return out
		}),
	)

const stamp = (wallTime: number, nodeId: string, logical = 0): HLCTimestamp => ({
	wallTime,
	logical,
	nodeId,
})

let counter = 0
function operation(
	type: Operation['type'],
	timestamp: HLCTimestamp,
	data: Values | null,
	previousData: Values | null,
): Operation {
	counter += 1
	return {
		id: `${timestamp.nodeId}-${timestamp.wallTime}-${counter}`,
		nodeId: timestamp.nodeId,
		type,
		collection: 'items',
		recordId: 'r1',
		data,
		previousData,
		timestamp,
		sequenceNumber: counter,
		causalDeps: [],
		schemaVersion: 1,
	}
}

/** A record's remote history: an insert and updates by other devices, in any wall-clock order. */
const remoteHistory: fc.Arbitrary<Operation[]> = fc
	.array(
		fc.record({
			changed: changes,
			wall: fc.integer({ min: 2, max: 40 }),
			node: fc.constantFrom('n1', 'n2', 'n3'),
		}),
		{ minLength: 0, maxLength: 8 },
	)
	.map((updates) => {
		const ops = [operation('insert', stamp(1, 'n1'), INSERT, null)]
		// Each writer saw the history built so far, which is what its previousData records.
		let view: Values = { ...INSERT }
		// A device's clock never goes back: its stamps rise in the order it wrote (the logical
		// counter breaks a tie on the wall clock), while two devices' stamps may be in any order.
		const lastWall: Record<string, number> = { n1: 1 }
		let logical = 0
		for (const update of updates) {
			const previous: Values = {}
			for (const field of Object.keys(update.changed)) previous[field] = view[field]
			logical += 1
			const wall = Math.max(update.wall, lastWall[update.node] ?? 0)
			lastWall[update.node] = wall
			ops.push(operation('update', stamp(wall, update.node, logical), update.changed, previous))
			view = { ...view, ...update.changed }
		}
		return ops
	})

/**
 * What the server had committed when it answered: a prefix of the commit order (the insert is
 * always in it). Timestamps are not in order, so an older write may be committed after a newer
 * one, which is the case a snapshot's per-field versions must get right.
 */
const reflected = (history: Operation[]): fc.Arbitrary<Operation[]> =>
	fc.integer({ min: 1, max: history.length }).map((count) => history.slice(0, count))

const localChanges = fc.array(changes, { minLength: 1, maxLength: 3 })

function stateOf(ops: Operation[]) {
	const state = foldRecord(ops, schema).state
	if (state === null) throw new Error('a history with an insert always folds to a state')
	return state
}

function seedOf(reflectedOps: Operation[]) {
	const state = stateOf(reflectedOps)
	const values = materialize(state)
	const versions = getFoldFieldVersions(state)
	if (values === null || versions === null) throw new Error('the seeded record is live')
	return createSnapshotState(
		{
			collection: 'items',
			recordId: 'r1',
			values,
			fieldVersions: versions.fields,
			created: versions.created,
			latest: versions.latest,
			deleted: false,
		},
		schema,
	)
}

describe('a seeded record with local writes (S4b, 5.6.3)', () => {
	test('shows what the real fold of the answer and the local writes shows', () => {
		fc.assert(
			fc.property(
				remoteHistory.chain((history) => fc.tuple(fc.constant(history), reflected(history))),
				localChanges,
				([history, seen], locals) => {
					const seed = seedOf(seen)
					const seedValues = materialize(seed) ?? {}
					const latestWall = Math.max(...seen.map((o) => o.timestamp.wallTime))
					// The seed advanced the clock to the answer's newest timestamp (5.6.1 step 1), so
					// every local write is stamped after everything the answer reflects.
					let view: Values = { ...seedValues }
					const localOps = locals.map((changed, i) => {
						const previous: Values = {}
						for (const field of Object.keys(changed)) previous[field] = view[field]
						view = { ...view, ...changed }
						return operation('update', stamp(latestWall + 1 + i, 'local'), changed, previous)
					})

					// What the device shows while seeded: the snapshot plus its own log, nothing else.
					const shown = materialize(joinStates(seed, foldLocal(localOps), schema))
					// What the real fold of the same history shows.
					const truth = materialize(stateOf([...seen, ...localOps]))
					expect(contentOf(shown)).toEqual(contentOf(truth))
				},
			),
			{ numRuns: Number(process.env.KORA_PROPERTY_RUNS ?? 2000), seed: 20260605 },
		)
	})
})

/**
 * A record with its arrays as multisets. The fold orders an array's elements by their first
 * addition over the record's WHOLE history; a snapshot does not know that a removed element
 * ever existed, so after a remove and re-add the seeded order can differ from the merged one
 * while the contents are equal. The order may therefore change once, at the merge (a documented
 * residual of 5.6.2); the contents may not.
 */
function contentOf(record: Values | null): Values | null {
	if (record === null) return null
	const out: Values = {}
	for (const [field, value] of Object.entries(record)) {
		out[field] = Array.isArray(value) ? [...value].sort() : value
	}
	return out
}

/** The local operations folded alone, as a device with an empty base holds them. */
function foldLocal(localOps: Operation[]) {
	// A local update needs a record to exist for the fold to produce a live state, so the
	// log is folded as a fragment: the join with the snapshot supplies the insert.
	const state = foldRecord(localOps, schema).state
	if (state === null) throw new Error('there is at least one local operation')
	return state
}

describe('known residual: duplicate array elements (S4b, 5.6.2)', () => {
	// A snapshot holds an array's visible elements but not which copy of a repeated value each is
	// (the fold names them `value#k`, the k-th copy ever added). A local removal on a seeded record
	// therefore can target different copies than the same removal folded against the full history.
	// The replicas still converge (the merge re-folds the operation against the union), but the
	// view differs once. Property runs over 200,000 histories found this only with duplicates,
	// never with unique elements. Slice 3 decides how a seed treats such records (see the design).
	const tagsSchema = defineSchema({
		version: 1,
		collections: { items: { fields: { tags: t.array(t.string()) } } },
	}) as unknown as SchemaDefinition
	const tagsOp = (
		id: string,
		wall: number,
		logical: number,
		node: string,
		type: Operation['type'],
		tags: string[],
		previous: string[] | null,
	): Operation => ({
		...operation(type, stamp(wall, node, logical), { tags }, previous ? { tags: previous } : null),
		id,
	})

	test('a removal made on the seed can differ from the merged result', () => {
		const seen = [
			tagsOp('i', 1, 0, 'n1', 'insert', [], null),
			tagsOp('u1', 22, 1, 'n3', 'update', ['c', 'c'], []),
			tagsOp('u2', 32, 2, 'n2', 'update', ['c', 'b', 'a', 'c'], ['c', 'c']),
			tagsOp('u3', 39, 5, 'n2', 'update', ['b', 'b', 'c', 'c'], ['c', 'b', 'a', 'c']),
			tagsOp('u4', 33, 6, 'n1', 'update', ['c', 'c'], ['b', 'b', 'c', 'c']),
		]
		const state = foldRecord(seen, tagsSchema).state
		const versions = state === null ? null : getFoldFieldVersions(state)
		const values = state === null ? null : materialize(state)
		if (state === null || versions === null || values === null) throw new Error('live record')
		const seed = createSnapshotState(
			{
				collection: 'items',
				recordId: 'r1',
				values,
				fieldVersions: versions.fields,
				created: versions.created,
				latest: versions.latest,
				deleted: false,
			},
			tagsSchema,
		)
		const visible = (materialize(seed)?.tags ?? []) as string[]
		const clearAll = tagsOp('local', 40, 9, 'local', 'update', [], visible)
		const local = foldRecord([clearAll], tagsSchema).state
		if (local === null) throw new Error('one local operation')
		const shown = materialize(joinStates(seed, local, tagsSchema))
		const truth = materialize(foldRecord([...seen, clearAll], tagsSchema).state ?? seedFail())
		expect(shown?.tags).toEqual([])
		expect(truth?.tags).toEqual(['b'])
	})
})

function seedFail(): never {
	throw new Error('a history with an insert folds to a state')
}
