import { describe, expect, test } from 'vitest'
import { defineSchema } from '../schema/define'
import { t } from '../schema/types'
import type { HLCTimestamp, Operation, SchemaDefinition } from '../types'
import {
	createFoldState,
	foldRecord,
	getFoldFieldVersions,
	joinStates,
	materialize,
	mergeOp,
} from './fold'
import { serializeFoldState } from './serialize'
import { createSnapshotState } from './snapshot'

const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				title: t.string(),
				tags: t.array(t.string()),
				meta: t.object({ a: t.string(), b: t.string() }).optional(),
				score: t.number().merge('counter'),
				stock: t.number(),
				body: t.richtext(),
			},
			resolve: {
				stock: (local, remote, base) => (local as number) + ((remote as number) - (base as number)),
			},
		},
	},
}) as unknown as SchemaDefinition

const ts = (wallTime: number, nodeId = 'a'): HLCTimestamp => ({ wallTime, logical: 0, nodeId })
let n = 0
function op(
	type: Operation['type'],
	wall: number,
	data: Record<string, unknown> | null,
	previousData: Record<string, unknown> | null = null,
	node = 'a',
): Operation {
	n += 1
	return {
		id: `${node}-${wall}-${n}`,
		nodeId: node,
		type,
		collection: 'items',
		recordId: 'r1',
		data,
		previousData,
		timestamp: ts(wall, node),
		sequenceNumber: n,
		causalDeps: [],
		schemaVersion: 1,
	}
}

function snapshotOf(ops: Operation[]) {
	const state = foldRecord(ops, schema).state
	if (state === null) throw new Error('no state')
	const values = materialize(state) ?? {}
	const versions = getFoldFieldVersions(state)
	if (versions === null) throw new Error('not live')
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

describe('createSnapshotState', () => {
	const history = [
		op('insert', 1, { title: 'x', tags: ['a', 'b'], meta: { a: '1' }, score: 1, stock: 10 }),
		op('update', 2, { tags: ['b'], score: 3 }, { tags: ['a', 'b'], score: 1 }),
		op('update', 3, { stock: 15, meta: { a: '1', b: '2' } }, { stock: 10, meta: { a: '1' } }, 'b'),
	]

	test('materializes the row it was built from', () => {
		const expected = materialize(
			foldRecord(history, schema).state ?? createFoldState('items', 'r1'),
		)
		expect(materialize(snapshotOf(history))).toEqual(expected)
	})

	test('re-merging the operations it reflects changes nothing', () => {
		let state = snapshotOf(history)
		const before = materialize(state)
		for (const reflected of [...history].reverse()) {
			state = mergeOp(state, reflected, schema).state
		}
		expect(materialize(state)).toEqual(before)
		// The counter did not double-count its deltas, the resolver did not re-resolve.
		expect(materialize(state)?.score).toBe(3)
		expect(materialize(state)?.stock).toBe(15)
	})

	test('a stale add of an element the row no longer shows is not resurrected', () => {
		let state = snapshotOf(history)
		// An older concurrent write re-adding 'a' (compacted removal already won).
		state = mergeOp(
			state,
			op('update', 1, { tags: ['a', 'b', 'z'] }, { tags: ['b'] }, 'c'),
			schema,
		).state
		expect(materialize(state)?.tags).toEqual(['b'])
	})

	test('later operations merge on top per kind', () => {
		let state = snapshotOf(history)
		state = mergeOp(
			state,
			op('update', 5, { tags: ['b', 'c'] }, { tags: ['b'] }, 'c'),
			schema,
		).state
		state = mergeOp(state, op('update', 6, { score: 10 }, { score: 3 }, 'c'), schema).state
		state = mergeOp(state, op('update', 6, { stock: 13 }, { stock: 15 }, 'd'), schema).state
		const result = materialize(state)
		expect(result?.tags).toEqual(['b', 'c'])
		expect(result?.score).toBe(10)
		// Resolver: local = snapshot value 15, remote 13 on base 15 => 13.
		expect(result?.stock).toBe(13)
	})

	test('a resolver entry older than the snapshot is pruned, also through a join', () => {
		const snapshot = snapshotOf(history)
		const late = foldRecord([op('update', 2, { stock: 99 }, { stock: 10 }, 'e')], schema).state
		if (late === null) throw new Error('no state')
		expect(materialize(joinStates(snapshot, late, schema))?.stock).toBe(15)
		expect(serializeFoldState(joinStates(snapshot, late, schema))).toBe(
			serializeFoldState(joinStates(late, snapshot, schema)),
		)
	})

	test('a deleted row stays deleted until a later write', () => {
		const state = createSnapshotState(
			{
				collection: 'items',
				recordId: 'r1',
				values: { title: 'x' },
				fieldVersions: { title: ts(1) },
				created: ts(1),
				latest: ts(4),
				deleted: true,
			},
			schema,
		)
		expect(materialize(state)).toBeNull()
		const stale = mergeOp(state, op('update', 3, { title: 'y' }, { title: 'x' }), schema).state
		expect(materialize(stale)).toBeNull()
		const revived = mergeOp(state, op('update', 5, { title: 'z' }, { title: 'x' }), schema).state
		expect(materialize(revived)?.title).toBe('z')
	})
})

describe('scope-entry operations carrying a fold state', () => {
	test('join the carried state, so every kind enters with its merge state', () => {
		const serverOps = [
			op('insert', 1, { title: 'x', score: 1 }, null, 'srv'),
			op('update', 2, { score: 4 }, { score: 1 }, 'b'),
		]
		const serverState = foldRecord(serverOps, schema).state
		if (serverState === null) throw new Error('no state')
		const entry: Operation = {
			...op('insert', 1, { title: 'x', score: 4 }, null, 'srv'),
			foldState: serializeFoldState(serverState),
		}
		// The device concurrently incremented the counter by 2 from 1.
		const local = op('update', 3, { score: 3 }, { score: 1 }, 'dev')
		let state = mergeOp(createFoldState('items', 'r1'), local, schema).state
		state = mergeOp(state, entry, schema).state
		state = mergeOp(state, serverOps[0] as Operation, schema).state
		// A counter, not LWW: 1 + 3 + 2.
		expect(materialize(state)?.score).toBe(6)
		const reference = foldRecord([...serverOps, local], schema).state
		expect(materialize(state)).toEqual(materialize(reference ?? createFoldState('items', 'r1')))
	})

	test('an unreadable carried state falls back to the operation data', () => {
		const entry: Operation = {
			...op('insert', 1, { title: 'x' }, null, 'srv'),
			foldState: '{"v":99}',
		}
		const state = mergeOp(createFoldState('items', 'r1'), entry, schema).state
		expect(materialize(state)?.title).toBe('x')
	})
})
