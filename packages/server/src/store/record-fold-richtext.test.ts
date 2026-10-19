/**
 * The cost fixes of the fold must not change a single byte (correctness outranks
 * speed): per-operation scope snapshots that materialize only the fields they keep, and
 * the incremental richtext merge cache, are compared with the reference implementations
 * (every field materialized per operation; every richtext merge from scratch) over
 * random operation sets: richtext edits (full snapshots and deltas, several devices,
 * deletes, formatting, resets), arrays, counters, record deletes and re-inserts,
 * transforms and mixed schema versions, in random arrival orders.
 */
import { fc, test as propTest } from '@fast-check/vitest'
import {
	type FoldState,
	type Operation,
	type OperationTransform,
	bytesToBase64,
	defineSchema,
	encodeBytesForOpData,
	t,
} from '@korajs/core'
import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import {
	FoldMigrationProgress,
	REFOLD_REQUIRED,
	RichtextMergeCache,
	type ServerFoldOptions,
	batchesByOperations,
	mergeIntoFoldState,
	mergeRichtextUpdatesForServer,
	projectFoldState,
	refoldRecord,
	serverFoldOptions,
} from './record-fold'
import { replayScopeSnapshots, scopeValuesOf } from './scope-snapshot'
import type { OperationScopeSnapshot } from './server-store'

const schema = defineSchema({
	version: 2,
	collections: {
		docs: {
			fields: {
				title: t.string(),
				status: t.enum(['draft', 'review', 'published']).default('draft'),
				body: t.richtext(),
				tags: t.array(t.string()).default([]),
				views: t.number().merge('counter').default(0),
				best: t.number().merge('max').optional(),
			},
		},
	},
})

/** Version-1 operations read with their titles in upper case (a fold-time transform). */
const transforms: OperationTransform[] = [
	{
		fromVersion: 1,
		toVersion: 2,
		transform: (operation) =>
			operation.data && typeof operation.data.title === 'string'
				? {
						...operation,
						schemaVersion: 2,
						data: { ...operation.data, title: operation.data.title.toUpperCase() },
					}
				: { ...operation, schemaVersion: 2 },
	},
]

/** The server's fold options without the incremental merger: the reference. */
function referenceOptions(): ServerFoldOptions {
	const options: ServerFoldOptions = { ...serverFoldOptions([], transforms) }
	options.richtextKeyed = undefined
	return options
}

/** The replay before the fix: every field of the record materialized per operation. */
function referenceReplay(
	operations: readonly Operation[],
	options: ServerFoldOptions,
): Map<string, OperationScopeSnapshot> {
	const result = new Map<string, OperationScopeSnapshot>()
	const committed: Operation[] = []
	let state: FoldState | null = null
	let pre: Record<string, unknown> | null = null
	for (const operation of operations) {
		committed.push(operation)
		const merged = mergeIntoFoldState(state, [operation], schema, options)
		state = merged === REFOLD_REQUIRED ? refoldRecord(committed, schema, options) : merged
		const row = state ? projectFoldState(state, options) : null
		const post = row ? scopeValuesOf(schema, 'docs', 'doc', { ...row.values }) : null
		result.set(operation.id, { pre, post })
		pre = row && !row.deleted ? post : null
	}
	return result
}

type Action =
	| {
			k: 'rt'
			device: number
			edit: 'insert' | 'delete' | 'format'
			at: number
			length: number
			delta: boolean
			sync: boolean
	  }
	| { k: 'title'; value: string }
	| { k: 'status'; value: 'draft' | 'review' | 'published' }
	| { k: 'tags'; value: string[] }
	| { k: 'increment'; by: number }
	| { k: 'views'; value: number }
	| { k: 'best'; value: number }
	| { k: 'reset'; value: string | null }
	| { k: 'delete' }
	| { k: 'insert' }

interface Step {
	action: Action
	device: number
	version: 1 | 2
	skew: number
}

const actionArb: fc.Arbitrary<Action> = fc.oneof(
	{
		weight: 12,
		arbitrary: fc.record({
			k: fc.constant('rt' as const),
			device: fc.integer({ min: 0, max: 2 }),
			edit: fc.constantFrom('insert' as const, 'delete' as const, 'format' as const),
			at: fc.nat(),
			length: fc.integer({ min: 1, max: 6 }),
			delta: fc.boolean(),
			sync: fc.boolean(),
		}),
	},
	{ weight: 2, arbitrary: fc.record({ k: fc.constant('title' as const), value: fc.string() }) },
	{
		weight: 1,
		arbitrary: fc.record({
			k: fc.constant('status' as const),
			value: fc.constantFrom('draft' as const, 'review' as const, 'published' as const),
		}),
	},
	{
		weight: 1,
		arbitrary: fc.record({
			k: fc.constant('tags' as const),
			value: fc.array(fc.constantFrom('a', 'b', 'c'), { maxLength: 4 }),
		}),
	},
	{
		weight: 1,
		arbitrary: fc.record({
			k: fc.constant('increment' as const),
			by: fc.integer({ min: -3, max: 5 }),
		}),
	},
	{ weight: 1, arbitrary: fc.record({ k: fc.constant('views' as const), value: fc.nat(50) }) },
	{ weight: 1, arbitrary: fc.record({ k: fc.constant('best' as const), value: fc.nat(50) }) },
	{
		weight: 1,
		arbitrary: fc.record({
			k: fc.constant('reset' as const),
			value: fc.option(fc.string({ maxLength: 8 }), { nil: null }),
		}),
	},
	{ weight: 1, arbitrary: fc.record({ k: fc.constant('delete' as const) }) },
	{ weight: 1, arbitrary: fc.record({ k: fc.constant('insert' as const) }) },
)

const stepArb: fc.Arbitrary<Step> = fc.record({
	action: actionArb,
	device: fc.integer({ min: 0, max: 2 }),
	version: fc.constantFrom(1 as const, 2 as const),
	skew: fc.integer({ min: -3, max: 3 }),
})

/** The operations a script of steps produces, in authoring order. */
function buildOperations(steps: readonly Step[]): Operation[] {
	const docs = [0, 1, 2].map((index) => {
		const doc = new Y.Doc()
		doc.clientID = 1000 + index
		return doc
	})
	const sequence = [0, 0, 0]
	const operations: Operation[] = []
	const push = (
		step: Step,
		device: number,
		type: Operation['type'],
		data: Record<string, unknown> | null,
		atomicOps?: Operation['atomicOps'],
	): void => {
		const nodeId = `device-${device}`
		sequence[device] = (sequence[device] ?? 0) + 1
		operations.push({
			id: `op-${operations.length}`,
			nodeId,
			type,
			collection: 'docs',
			recordId: 'doc',
			data,
			previousData: null,
			timestamp: { wallTime: 10_000 + operations.length * 2 + step.skew, logical: 0, nodeId },
			sequenceNumber: sequence[device] ?? 0,
			causalDeps: [],
			schemaVersion: step.version,
			hashVersion: 2,
			...(atomicOps ? { atomicOps } : {}),
		})
	}
	push({ action: { k: 'insert' }, device: 0, version: 2, skew: 0 }, 0, 'insert', {
		title: 'Doc',
		status: 'draft',
		tags: [],
		views: 0,
	})
	for (const step of steps) {
		const action = step.action
		switch (action.k) {
			case 'rt': {
				const doc = docs[action.device] as Y.Doc
				const before = Y.encodeStateVector(doc)
				const text = doc.getText('content')
				const at = text.length === 0 ? 0 : action.at % (text.length + 1)
				if (action.edit === 'insert' || text.length === 0) {
					text.insert(at, 'xyzw'.slice(0, 1 + (action.length % 4)))
				} else if (action.edit === 'delete') {
					const from = Math.min(at, text.length - 1)
					text.delete(from, Math.min(action.length, text.length - from))
				} else {
					const from = Math.min(at, text.length - 1)
					text.format(from, Math.min(action.length, text.length - from), { bold: true })
				}
				const update = action.delta
					? Y.encodeStateAsUpdate(doc, before)
					: Y.encodeStateAsUpdate(doc)
				push(step, action.device, 'update', { body: encodeBytesForOpData(update) })
				if (action.sync) {
					const other = docs[(action.device + 1) % 3] as Y.Doc
					Y.applyUpdate(other, Y.encodeStateAsUpdate(doc))
				}
				break
			}
			case 'title':
				push(step, step.device, 'update', { title: action.value })
				break
			case 'status':
				push(step, step.device, 'update', { status: action.value })
				break
			case 'tags':
				push(step, step.device, 'update', { tags: action.value })
				break
			case 'increment':
				push(
					step,
					step.device,
					'update',
					{ views: action.by },
					{
						views: { type: 'increment', value: action.by },
					},
				)
				break
			case 'views':
				push(step, step.device, 'update', { views: action.value })
				break
			case 'best':
				push(step, step.device, 'update', { best: action.value })
				break
			case 'reset':
				push(step, step.device, 'update', { body: action.value })
				break
			case 'delete':
				push(step, step.device, 'delete', null)
				break
			case 'insert':
				push(step, step.device, 'insert', { title: 'Again', status: 'review' })
				break
		}
	}
	return operations
}

/** `operations` in the order `keys` sorts them (a random arrival order). */
function arrival(operations: readonly Operation[], keys: readonly number[]): Operation[] {
	return operations
		.map((operation, index) => ({ operation, key: keys[index % Math.max(1, keys.length)] ?? 0 }))
		.sort((a, b) => a.key - b.key)
		.map((entry) => entry.operation)
}

function stableSnapshots(map: Map<string, OperationScopeSnapshot>): string {
	return JSON.stringify([...map.entries()])
}

/** Every intermediate projection of folding `operations` one by one. */
function projections(operations: readonly Operation[], options: ServerFoldOptions): string[] {
	const out: string[] = []
	const committed: Operation[] = []
	let state: FoldState | null = null
	for (const operation of operations) {
		committed.push(operation)
		const merged = mergeIntoFoldState(state, [operation], schema, options)
		state = merged === REFOLD_REQUIRED ? refoldRecord(committed, schema, options) : merged
		// Twice: the second materialization of an unchanged state is a cache hit.
		const first = state ? projectFoldState(state, options) : null
		const again = state ? projectFoldState(state, options) : null
		out.push(JSON.stringify(first), JSON.stringify(again))
	}
	return out
}

describe('fold cost fixes are byte-identical to the reference implementations', () => {
	propTest.prop(
		[fc.array(stepArb, { minLength: 4, maxLength: 40 }), fc.array(fc.nat(1000), { maxLength: 60 })],
		{
			numRuns: 120,
		},
	)('scope snapshots keep the same values without materializing other fields', (steps, keys) => {
		const operations = arrival(buildOperations(steps), keys)
		expect(
			stableSnapshots(
				replayScopeSnapshots(schema, 'docs', 'doc', operations, serverFoldOptions([], transforms)),
			),
		).toBe(stableSnapshots(referenceReplay(operations, referenceOptions())))
	})

	propTest.prop(
		[
			fc.array(stepArb, { minLength: 4, maxLength: 40 }),
			fc.array(fc.nat(1000), { maxLength: 60 }),
			fc.array(fc.nat(1000), { maxLength: 60 }),
		],
		{ numRuns: 120 },
	)(
		'incremental richtext materialization equals the from-scratch merge, write by write',
		(steps, keys, otherKeys) => {
			const operations = buildOperations(steps)
			const reference = referenceOptions()
			// One cache across two arrival orders: hits, partial hits and misses all occur.
			const cached = serverFoldOptions([], transforms)
			for (const order of [keys, otherKeys]) {
				const delivered = arrival(operations, order)
				expect(projections(delivered, cached)).toEqual(projections(delivered, reference))
			}
			const final = refoldRecord(operations, schema, cached)
			expect(JSON.stringify(final && projectFoldState(final, cached))).toBe(
				JSON.stringify(final && projectFoldState(final, reference)),
			)
		},
	)
})

describe('pending Yjs content', () => {
	test('a delta that arrives before its base is merged from scratch, never incrementally', () => {
		// Found by the property above (fast-check counterexample): Yjs encodes the same
		// document with differently split structs when pending content (deltas of device-0
		// and device-1 whose base, op-1 and op-2, arrives later) is integrated in another
		// grouping, so an incremental merge over pending content is not byte-identical.
		const rt = (device: number, delta: boolean, sync: boolean, length = 1): Step => ({
			action: {
				k: 'rt',
				device,
				edit: 'insert',
				at: device === 1 ? 886489616 : 0,
				length,
				delta,
				sync,
			},
			device: 0,
			version: 1,
			skew: 0,
		})
		const plain = (action: Action): Step => ({ action, device: 0, version: 1, skew: 0 })
		const operations = buildOperations([
			rt(0, false, false),
			rt(0, false, true, 3),
			rt(1, true, false),
			plain({ k: 'delete' }),
			rt(0, true, false),
			plain({ k: 'insert' }),
			rt(0, false, false),
		])
		const cached = serverFoldOptions([], transforms)
		for (const order of [[], [0, 1, 1, 0, 0]]) {
			const delivered = arrival(operations, order)
			expect(projections(delivered, cached)).toEqual(projections(delivered, referenceOptions()))
		}
	})
})

describe('RichtextMergeCache', () => {
	function snapshots(count: number): string[] {
		const doc = new Y.Doc()
		doc.clientID = 7
		const out: string[] = []
		for (let i = 0; i < count; i++) {
			doc.getText('content').insert(0, `e${i} `)
			out.push(bytesToBase64(Y.encodeStateAsUpdate(doc)))
		}
		return out
	}

	const scope = { collection: 'docs', recordId: 'doc', field: 'body' }
	const fromScratch = (updates: readonly string[]): Uint8Array =>
		mergeRichtextUpdatesForServer(
			[...updates].sort().map((update) => Uint8Array.from(Buffer.from(update, 'base64'))),
		)

	test('a superset merges only what was added; any other set merges from scratch', () => {
		const cache = new RichtextMergeCache()
		const all = snapshots(6)
		const first = all.slice(0, 4).sort()
		expect(cache.merge(first, scope)).toEqual(fromScratch(first))
		const grown = all.slice(0, 5).sort()
		expect(cache.merge(grown, scope)).toEqual(fromScratch(grown))
		// A set the cached one is not part of (a reset hid updates): from scratch.
		const shrunk = [all[1] ?? '', all[5] ?? ''].sort()
		expect(cache.merge(shrunk, scope)).toEqual(fromScratch(shrunk))
		expect(cache.merge(grown, scope)).toEqual(fromScratch(grown))
	})

	test('fields are told apart by collection, record and field', () => {
		const cache = new RichtextMergeCache()
		const a = snapshots(3).sort()
		const b = snapshots(5).slice(3).sort()
		expect(cache.merge(a, scope)).toEqual(fromScratch(a))
		expect(cache.merge(b, { ...scope, recordId: 'other' })).toEqual(fromScratch(b))
		expect(cache.merge(b, { ...scope, field: 'notes' })).toEqual(fromScratch(b))
		expect(cache.size).toBe(3)
	})

	test('is bounded by entries and by bytes, least recently used first', () => {
		const updates = snapshots(3).sort()
		const byEntries = new RichtextMergeCache(Number.POSITIVE_INFINITY, 2)
		for (const recordId of ['r1', 'r2', 'r3']) byEntries.merge(updates, { ...scope, recordId })
		expect(byEntries.size).toBe(2)

		const tiny = new RichtextMergeCache(10, 100)
		expect(tiny.merge(updates, scope)).toEqual(fromScratch(updates))
		expect(tiny.size).toBe(0)
	})
})

describe('batchesByOperations', () => {
	test('bounds operations per batch, never splitting or skipping a record', () => {
		const records = [
			{ id: 'a', ops: 900 },
			{ id: 'b', ops: 900 },
			{ id: 'c', ops: 5_000 },
			{ id: 'd', ops: 1 },
			{ id: 'e', ops: 0 },
		]
		const batches = batchesByOperations(records, (record) => record.ops, 2_000)
		expect(batches.map((batch) => batch.map((record) => record.id))).toEqual([
			['a', 'b'],
			['c'],
			['d', 'e'],
		])
	})

	test('at most FOLD_MIGRATION_BATCH records per batch', () => {
		const records = Array.from({ length: 1_200 }, (_, index) => index)
		const batches = batchesByOperations(records, () => 1, Number.POSITIVE_INFINITY)
		expect(batches.map((batch) => batch.length)).toEqual([500, 500, 200])
	})
})

describe('FoldMigrationProgress', () => {
	test('silent for a short migration', () => {
		const lines: string[] = []
		let now = 0
		const progress = new FoldMigrationProgress(
			'Task',
			(line) => lines.push(line),
			() => now,
			5_000,
		)
		progress.advance(10, 10)
		now = 4_999
		expect(progress.due()).toBe(false)
		progress.finish()
		expect(lines).toEqual([])
	})

	test('a line per interval with the total, then a final line', () => {
		const lines: string[] = []
		let now = 0
		const progress = new FoldMigrationProgress(
			'Task',
			(line) => lines.push(line),
			() => now,
			5_000,
		)
		progress.advance(3, 2)
		now = 5_000
		expect(progress.due()).toBe(true)
		expect(progress.needsTotal()).toBe(true)
		progress.setTotal(25)
		progress.report()
		expect(progress.due()).toBe(false)
		progress.advance(22, 20)
		now = 12_000
		progress.finish()
		expect(lines).toHaveLength(3)
		expect(lines[1]).toBe('[kora] Task: 3 / 25 records done, 2 rewritten (5 s).')
		expect(lines[2]).toBe('[kora] Task done: 25 records, 22 rewritten, in 12 s.')
	})
})
