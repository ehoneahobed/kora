import { describe, expect, test } from 'vitest'
import { defineSchema } from '../schema/define'
import { t } from '../schema/types'
import type { AtomicOp, HLCTimestamp, Operation, SchemaDefinition } from '../types'
import { FoldConfigurationError, FoldStateError } from './errors'
import {
	FOLD_RECORD_TRACE_FIELD,
	createFoldState,
	foldRecord,
	getFoldFieldVersions,
	isFoldStateLive,
	joinStates,
	materialize,
	mergeOp,
} from './fold'
import { deserializeFoldState, serializeFoldState } from './serialize'
import { toMergeTrace } from './trace'
import type { FoldState } from './types'

const schema = defineSchema({
	version: 1,
	collections: {
		tickets: {
			fields: {
				title: t.string(),
				qty: t.number(),
				tags: t.array(t.string()),
				settings: t.object({ c: t.string(), d: t.number() }).optional(),
				doc: t.json(),
				score: t.number().merge('counter'),
				best: t.number().merge('max'),
				least: t.number().merge('min'),
				history: t.array(t.string()).merge('append-only'),
				owner: t.string().merge('server-authoritative'),
				stock: t.number(),
				pin: t.secret(),
				body: t.richtext(),
			},
			resolve: {
				stock: (local, remote, base) => (local as number) + ((remote as number) - (base as number)),
			},
		},
	},
}) as unknown as SchemaDefinition

let counter = 0
function op(
	partial: Partial<Operation> & {
		type: Operation['type']
		wall: number
		node?: string
		logical?: number
	},
): Operation {
	counter += 1
	const node = partial.node ?? 'a'
	const timestamp: HLCTimestamp = {
		wallTime: partial.wall,
		logical: partial.logical ?? 0,
		nodeId: node,
	}
	return {
		id: partial.id ?? `${node}-${partial.wall}-${partial.logical ?? 0}-${counter}`,
		nodeId: node,
		type: partial.type,
		collection: 'tickets',
		recordId: 'r1',
		data: partial.data ?? null,
		previousData: partial.previousData ?? null,
		timestamp,
		sequenceNumber: counter,
		causalDeps: [],
		schemaVersion: 1,
		...(partial.atomicOps ? { atomicOps: partial.atomicOps } : {}),
		...(partial.fieldVersions ? { fieldVersions: partial.fieldVersions } : {}),
	}
}

const insert = (wall: number, data: Record<string, unknown>, node = 'a'): Operation =>
	op({ type: 'insert', wall, node, data })
const update = (
	wall: number,
	data: Record<string, unknown>,
	previousData: Record<string, unknown>,
	node = 'a',
	atomicOps?: Record<string, AtomicOp>,
): Operation => op({ type: 'update', wall, node, data, previousData, atomicOps })
const del = (wall: number, node = 'a'): Operation => op({ type: 'delete', wall, node })

function fold(ops: Operation[]): Record<string, unknown> | null {
	const state = foldRecord(ops, schema).state
	return state === null ? null : materialize(state)
}

function foldBothOrders(ops: Operation[]): Record<string, unknown> | null {
	const forward = fold(ops)
	expect(fold([...ops].reverse())).toEqual(forward)
	return forward
}

describe('arrays: LWW element set', () => {
	test('MERGE-1: a one-sided removal survives a concurrent add', () => {
		const base = insert(1, { tags: ['urgent'] })
		const a = update(2, { tags: [] }, { tags: ['urgent'] }, 'a')
		const b = update(3, { tags: ['urgent', 'billing'] }, { tags: ['urgent'] }, 'b')
		expect(foldBothOrders([base, a, b])?.tags).toEqual(['billing'])
	})

	test('MERGE-2 counterexample (tags seed 1): every replica agrees, in any order', () => {
		const base = insert(1, { tags: ['t1'] }, 'w0')
		const round1 = [
			update(2, { tags: [] }, { tags: ['t1'] }, 'w0'),
			update(2, { tags: ['t1', 't4'] }, { tags: ['t1'] }, 'w1'),
			update(2, { tags: ['t1', 't2'] }, { tags: ['t1'] }, 'w2'),
		]
		// w0's removal of t1 beats the others' unchanged copies; both adds survive.
		expect(foldBothOrders([base, ...round1])?.tags).toEqual(['t4', 't2'])
		// Round 2 from that state: w0 removes t4, w1 and w2 remove t2.
		const round2 = [
			update(5, { tags: ['t2'] }, { tags: ['t4', 't2'] }, 'w0'),
			update(5, { tags: ['t4'] }, { tags: ['t4', 't2'] }, 'w1'),
			update(5, { tags: ['t4'] }, { tags: ['t4', 't2'] }, 'w2'),
		]
		expect(foldBothOrders([base, ...round1, ...round2])?.tags).toEqual([])
		// The repro's writers saw the beta.12 (wrong) view ['t1','t2','t4'] in round 2.
		// Even fed those inputs, the fold converges on every replica: t1 stays removed
		// (restating it unchanged is not an add) and the round-2 removals win.
		const beta12Views = [
			update(5, { tags: ['t1', 't2'] }, { tags: ['t1', 't2', 't4'] }, 'w0'),
			update(5, { tags: ['t1', 't4'] }, { tags: ['t1', 't2', 't4'] }, 'w1'),
			update(5, { tags: ['t1', 't4'] }, { tags: ['t1', 't2', 't4'] }, 'w2'),
		]
		expect(foldBothOrders([base, ...round1, ...beta12Views])?.tags).toEqual([])
	})

	test('NEW-MERGE-1: an unchanged restated array does not undo a removal', () => {
		const base = insert(1, { title: 'x', tags: ['urgent'] })
		const a = update(2, { tags: [] }, { tags: ['urgent'] }, 'a')
		const b = update(
			3,
			{ title: 'renamed', tags: ['urgent'] },
			{ title: 'x', tags: ['urgent'] },
			'b',
		)
		expect(foldBothOrders([base, a, b])).toEqual({ title: 'renamed', tags: [] })
	})

	test('SRV-1: concurrent adds are both kept, ordered by first add', () => {
		const base = insert(1, { tags: ['base'] })
		const a = update(2, { tags: ['base', 'a'] }, { tags: ['base'] }, 'a')
		const b = update(3, { tags: ['base', 'b'] }, { tags: ['base'] }, 'b')
		expect(foldBothOrders([base, a, b])?.tags).toEqual(['base', 'a', 'b'])
	})

	test('the later of a concurrent remove and re-add of the same element wins', () => {
		const base = insert(1, { tags: ['x'] })
		const remove = update(2, { tags: [] }, { tags: ['x'] }, 'a')
		const readd = update(3, { tags: ['x'] }, { tags: [] }, 'b')
		expect(foldBothOrders([base, remove, readd])?.tags).toEqual(['x'])
		const lateRemove = update(4, { tags: [] }, { tags: ['x'] }, 'c')
		expect(foldBothOrders([base, remove, readd, lateRemove])?.tags).toEqual([])
	})

	test('arrays are multisets: duplicates are kept, objects compare by canonical JSON', () => {
		const base = insert(1, { tags: ['a', 'a', 'b'] })
		expect(fold([base])?.tags).toEqual(['a', 'a', 'b'])
		const objs = insert(1, { doc: null, tags: [{ k: 1, j: 2 }] })
		const restated = update(2, { tags: [{ j: 2, k: 1 }] }, { tags: [{ k: 1, j: 2 }] })
		expect(fold([objs, restated])?.tags).toEqual([{ j: 2, k: 1 }])
	})

	test('duplicates merge per occurrence: removing one copy keeps the other', () => {
		const base = insert(1, { tags: ['a', 'a', 'b'] })
		// a removes one copy of 'a'; b concurrently adds a third copy and a 'c'.
		const a = update(2, { tags: ['a', 'b'] }, { tags: ['a', 'a', 'b'] }, 'a')
		const b = update(3, { tags: ['a', 'a', 'b', 'a', 'c'] }, { tags: ['a', 'a', 'b'] }, 'b')
		// Occurrence #1 of 'a' is removed (newest add is the insert); #2 is new.
		expect(foldBothOrders([base, a, b])?.tags).toEqual(['a', 'b', 'a', 'c'])
		// Two writers appending the same value from the same base add the same
		// occurrence: the copies coincide (documented limit of value-identified elements).
		const c = update(4, { tags: ['a', 'a', 'b', 'x'] }, { tags: ['a', 'a', 'b'] }, 'c')
		const d = update(4, { tags: ['a', 'a', 'b', 'x'] }, { tags: ['a', 'a', 'b'] }, 'd')
		expect(foldBothOrders([base, c, d])?.tags).toEqual(['a', 'a', 'b', 'x'])
	})

	test('an atomic append of a value already present adds a copy', () => {
		const base = insert(1, { tags: ['a'] })
		const append = update(2, { tags: ['a', 'a'] }, { tags: ['a'] }, 'a', {
			tags: { type: 'append', value: 'a' },
		})
		expect(foldBothOrders([base, append])?.tags).toEqual(['a', 'a'])
		const removeAll = update(3, { tags: [] }, { tags: ['a', 'a'] }, 'b', {
			tags: { type: 'remove', value: 'a' },
		})
		expect(foldBothOrders([base, append, removeAll])?.tags).toEqual([])
	})

	test('setting the array to null clears elements added before it', () => {
		const base = insert(1, { tags: ['a'] })
		const clear = update(2, { tags: null }, { tags: ['a'] }, 'a')
		const add = update(3, { tags: ['a', 'b'] }, { tags: ['a'] }, 'b')
		expect(foldBothOrders([base, clear])?.tags).toBeNull()
		expect(foldBothOrders([base, clear, add])?.tags).toEqual(['b'])
	})

	test('atomic append/remove are element adds/removes', () => {
		const base = insert(1, { tags: ['a'] })
		const append = update(2, { tags: ['a', 'b'] }, { tags: ['a'] }, 'a', {
			tags: { type: 'append', value: 'b' },
		})
		const remove = update(3, { tags: [] }, { tags: ['a'] }, 'b', {
			tags: { type: 'remove', value: 'a' },
		})
		expect(foldBothOrders([base, append, remove])?.tags).toEqual(['b'])
	})

	test('append-only arrays ignore removals', () => {
		const base = insert(1, { history: ['created'] })
		const a = update(2, { history: [] }, { history: ['created'] }, 'a')
		const b = update(3, { history: ['created', 'paid'] }, { history: ['created'] }, 'b')
		expect(foldBothOrders([base, a, b])?.history).toEqual(['created', 'paid'])
	})
})

describe('objects and json: per-top-level-key LWW', () => {
	test('SRV-1: concurrent edits of different keys both survive', () => {
		const base = insert(1, { doc: { color: 'red', size: 1 } })
		const a = update(
			2,
			{ doc: { color: 'blue', size: 1 } },
			{ doc: { color: 'red', size: 1 } },
			'a',
		)
		const b = update(3, { doc: { color: 'red', size: 2 } }, { doc: { color: 'red', size: 1 } }, 'b')
		expect(foldBothOrders([base, a, b])?.doc).toEqual({ color: 'blue', size: 2 })
	})

	test('MERGE-2 object counterexample: the latest write of a key wins on every replica', () => {
		const base = insert(1, { settings: { c: 'w' } }, 'w0')
		const ops = [
			base,
			update(2, { settings: { c: 'y' } }, { settings: { c: 'w' } }, 'w1'),
			update(2, { settings: { c: 'w' } }, { settings: { c: 'w' } }, 'w2'),
			update(5, { settings: { c: 'z' } }, { settings: { c: 'y' } }, 'w0'),
			update(6, { settings: { c: 'x' } }, { settings: { c: 'y' } }, 'w1'),
		]
		expect(foldBothOrders(ops)?.settings).toEqual({ c: 'x' })
	})

	test('a key removal beats an unchanged key, and a later write beats a removal', () => {
		const base = insert(1, { doc: { a: 1, b: 2 } })
		const remove = update(2, { doc: { b: 2 } }, { doc: { a: 1, b: 2 } }, 'a')
		const other = update(3, { doc: { a: 1, b: 3 } }, { doc: { a: 1, b: 2 } }, 'b')
		expect(foldBothOrders([base, remove, other])?.doc).toEqual({ b: 3 })
		const rewrite = update(4, { doc: { a: 9 } }, { doc: { b: 3 } }, 'c')
		expect(foldBothOrders([base, remove, other, rewrite])?.doc).toEqual({ a: 9 })
	})

	test('nested values are whole-value LWW per top-level key', () => {
		const base = insert(1, { doc: { n: { x: 1, y: 1 } } })
		const a = update(2, { doc: { n: { x: 2, y: 1 } } }, { doc: { n: { x: 1, y: 1 } } }, 'a')
		const b = update(3, { doc: { n: { x: 1, y: 2 } } }, { doc: { n: { x: 1, y: 1 } } }, 'b')
		expect(foldBothOrders([base, a, b])?.doc).toEqual({ n: { x: 1, y: 2 } })
	})

	test('a non-object write replaces the whole value; later keys build on a fresh object', () => {
		const base = insert(1, { doc: { a: 1 } })
		const scalar = update(2, { doc: [1, 2] }, { doc: { a: 1 } }, 'a')
		expect(foldBothOrders([base, scalar])?.doc).toEqual([1, 2])
		const objectAgain = update(3, { doc: { b: 1 } }, { doc: [1, 2] }, 'b')
		expect(foldBothOrders([base, scalar, objectAgain])?.doc).toEqual({ b: 1 })
	})
})

describe('scalars and atomic ops', () => {
	test('last write wins by HLC, then node id', () => {
		const base = insert(1, { title: 'base' })
		const a = update(5, { title: 'a' }, { title: 'base' }, 'a')
		const b = update(5, { title: 'b' }, { title: 'base' }, 'b')
		expect(foldBothOrders([base, a, b])?.title).toBe('b')
	})

	test('an unchanged restated scalar does not override a concurrent change', () => {
		const base = insert(1, { title: 'x' })
		const change = update(2, { title: 'y' }, { title: 'x' }, 'a')
		const restate = update(3, { title: 'x' }, { title: 'x' }, 'b')
		expect(foldBothOrders([base, change, restate])?.title).toBe('y')
	})

	test('a forged duplicate HLC still resolves deterministically by op id', () => {
		const base = insert(1, { title: 'base' })
		const x = op({
			type: 'update',
			wall: 5,
			node: 'a',
			id: 'id-x',
			data: { title: 'x' },
			previousData: { title: 'base' },
		})
		const y = op({
			type: 'update',
			wall: 5,
			node: 'a',
			id: 'id-y',
			data: { title: 'y' },
			previousData: { title: 'base' },
		})
		expect(foldBothOrders([base, x, y])?.title).toBe('y')
	})

	test('concurrent increments compose; a later plain set resets the chain', () => {
		const base = insert(1, { qty: 10 })
		const inc = (wall: number, node: string, n: number, seen: number): Operation =>
			update(wall, { qty: seen + n }, { qty: seen }, node, { qty: { type: 'increment', value: n } })
		const a = inc(2, 'a', 5, 10)
		const b = inc(3, 'b', 3, 10)
		expect(foldBothOrders([base, a, b])?.qty).toBe(18)
		const set = update(4, { qty: 100 }, { qty: 18 }, 'c')
		const c = inc(5, 'd', 1, 100)
		expect(foldBothOrders([base, a, b, set, c])?.qty).toBe(101)
	})

	test('a very late increment older than the newest plain set is ignored', () => {
		const base = insert(10, { qty: 1 })
		const set = update(20, { qty: 50 }, { qty: 1 }, 'b')
		const late = update(15, { qty: 2 }, { qty: 1 }, 'a', { qty: { type: 'increment', value: 1 } })
		expect(foldBothOrders([base, set, late])?.qty).toBe(50)
	})

	test('counter strategy: base plus every delta', () => {
		const base = insert(1, { score: 10 })
		const a = update(2, { score: 15 }, { score: 10 }, 'a')
		const b = update(3, { score: 12 }, { score: 10 }, 'b')
		const c = update(4, { score: 13 }, { score: 12 }, 'c', {
			score: { type: 'increment', value: 1 },
		})
		expect(foldBothOrders([base, a, b, c])?.score).toBe(18)
	})

	test('max / min strategies keep the extremum of every write', () => {
		const base = insert(1, { best: 5, least: 5 })
		const a = update(2, { best: 9, least: 1 }, { best: 5, least: 5 }, 'a')
		const b = update(3, { best: 7, least: 3 }, { best: 5, least: 5 }, 'b')
		const result = foldBothOrders([base, a, b])
		expect(result?.best).toBe(9)
		expect(result?.least).toBe(1)
	})

	test('server-authoritative without authoritative nodes resolves by last write wins', () => {
		const base = insert(1, { owner: 'client' })
		const server = update(3, { owner: 'server' }, { owner: 'client' }, 'srv')
		const client = update(2, { owner: 'mine' }, { owner: 'client' }, 'a')
		expect(foldBothOrders([base, server, client])?.owner).toBe('server')
	})

	test('server-authoritative: an authoritative write beats a later client write', () => {
		const authoritativeNodeIds = new Set(['srv'])
		const foldAuth = (ops: Operation[]) => {
			const state = foldRecord(ops, schema, { authoritativeNodeIds }).state
			return state === null ? null : materialize(state)
		}
		const base = insert(1, { owner: 'client', title: 't' })
		const server = update(2, { owner: 'server' }, { owner: 'client' }, 'srv')
		const client = update(9, { owner: 'mine', title: 'later' }, { owner: 'client', title: 't' })
		for (const order of [
			[base, server, client],
			[client, server, base],
			[server, base, client],
		]) {
			const result = foldAuth(order)
			// The class decides the server-authoritative field only; other fields stay LWW.
			expect(result?.owner).toBe('server')
			expect(result?.title).toBe('later')
		}
		// Within the authoritative class, the later write wins.
		const server2 = update(3, { owner: 'server-2' }, { owner: 'server' }, 'srv')
		expect(foldAuth([base, client, server2, server])?.owner).toBe('server-2')
		// Incremental merges agree with the from-scratch fold, in any order.
		let state = createFoldState('tickets', 'r1')
		for (const next of [server2, client, base, server]) {
			state = mergeOp(state, next, schema, { authoritativeNodeIds }).state
		}
		expect(materialize(state)?.owner).toBe('server-2')
	})
})

describe('custom resolvers', () => {
	test('SRV-1: the additive resolver folds in HLC order with local = merged state', () => {
		const base = insert(1, { stock: 10 })
		const a = update(2, { stock: 15 }, { stock: 10 }, 'a')
		const b = update(3, { stock: 13 }, { stock: 10 }, 'b')
		expect(foldBothOrders([base, a, b])?.stock).toBe(18)
	})

	test('a throwing resolver falls back to the incoming value and reports the error', () => {
		const throwing = defineSchema({
			version: 1,
			collections: {
				tickets: {
					fields: { title: t.string() },
					resolve: {
						title: () => {
							throw new Error('nope')
						},
					},
				},
			},
		}) as unknown as SchemaDefinition
		const base = insert(1, { title: 'a' })
		const state = foldRecord([base], throwing).state as FoldState
		const result = mergeOp(state, update(2, { title: 'b' }, { title: 'a' }), throwing)
		expect(materialize(result.state)?.title).toBe('b')
		expect(result.traces[0]?.error).toBe('nope')
		expect(result.state.f.title).toMatchObject({ k: 'res', err: 'nope' })
	})
})

describe('richtext', () => {
	const update1 = { $koraBytes: 'AQI=' }
	const update2 = { $koraBytes: 'AwQ=' }
	const merger = (updates: Uint8Array[]): Uint8Array =>
		new Uint8Array(updates.flatMap((u) => [...u]))

	test('one update materializes as itself; several need the merger', () => {
		const base = insert(1, { body: update1 })
		expect(fold([base])?.body).toEqual(update1)
		const other = update(2, { body: update2 }, { body: update1 }, 'b')
		const state = foldRecord([base, other], schema).state as FoldState
		expect(() => materialize(state)).toThrow(FoldConfigurationError)
		expect(materialize(state, { richtext: merger })?.body).toEqual({ $koraBytes: 'AQIDBA==' })
	})

	test('a plain string write resets the field and hides earlier updates', () => {
		const base = insert(1, { body: update1 })
		const reset = update(2, { body: 'plain' }, { body: update1 }, 'a')
		expect(foldBothOrders([base, reset])?.body).toBe('plain')
		const edit = update(3, { body: update2 }, { body: 'plain' }, 'b')
		expect(foldBothOrders([base, reset, edit])?.body).toEqual(update2)
	})

	test('binary values normalize to the tagged form', () => {
		const base = insert(1, { body: new Uint8Array([1, 2]) })
		expect(fold([base])?.body).toEqual(update1)
	})

	test('richtextSubsumes prunes contained updates without changing any materialization', () => {
		// Model: an update is a set of bytes; content = union; a ⊆ b by bytes.
		const setMerger = (updates: Uint8Array[]): Uint8Array =>
			new Uint8Array([...new Set(updates.flatMap((u) => [...u]))].sort((x, y) => x - y))
		const subsumes = (a: Uint8Array, b: Uint8Array): boolean => [...a].every((x) => b.includes(x))
		const enc = (...bytes: number[]) => ({
			$koraBytes: Buffer.from(new Uint8Array(bytes)).toString('base64'),
		})
		let rng = 7
		const next = () => {
			rng = (rng * 1103515245 + 12345) % 2147483648
			return rng / 2147483648
		}
		for (let round = 0; round < 60; round++) {
			const ops: Operation[] = [insert(1, { body: enc(1) })]
			let local = [1]
			for (let i = 0; i < 6; i++) {
				const r = next()
				if (r < 0.1) {
					ops.push(update(2 + i, { body: 'plain' }, { body: enc(...local) }, `n${i}`))
					continue
				}
				// Snapshots grow (a device's edits), sometimes from an older view (concurrent).
				local = r < 0.6 ? [...local, 10 + i] : [1, 20 + i]
				ops.push(update(2 + i, { body: enc(...local) }, { body: enc(1) }, `n${i}`))
			}
			// Content, not encoding: a single live update materializes as its own bytes.
			const content = (body: unknown): unknown =>
				body !== null && typeof body === 'object' && '$koraBytes' in body
					? [
							...setMerger([
								new Uint8Array(
									Buffer.from(String((body as { $koraBytes: string }).$koraBytes), 'base64'),
								),
							]),
						]
					: body
			const plain = foldRecord(ops, schema).state as FoldState
			const expected = content(materialize(plain, { richtext: setMerger })?.body)
			const states = [ops, [...ops].reverse(), [...ops].sort(() => next() - 0.5)].map((order) => {
				let state = createFoldState('tickets', 'r1')
				for (const op of order)
					state = mergeOp(state, op, schema, { richtextSubsumes: subsumes }).state
				return state
			})
			for (const state of states) {
				expect(content(materialize(state, { richtext: setMerger })?.body)).toEqual(expected)
				expect(serializeFoldState(state)).toBe(serializeFoldState(states[0] as FoldState))
				const kept = state.f.body?.k === 'rt' ? Object.keys(state.f.body.u).length : 0
				const all = plain.f.body?.k === 'rt' ? Object.keys(plain.f.body.u).length : 0
				expect(kept).toBeLessThanOrEqual(all)
			}
		}
	})
})

describe('delete vs write', () => {
	test('a delete later than every write hides the record', () => {
		const base = insert(1, { title: 'x' })
		expect(foldBothOrders([base, del(2)])).toBeNull()
	})

	test('an update later than the delete revives the record with every field', () => {
		const base = insert(1, { title: 'x', qty: 1 })
		const revive = update(3, { qty: 2 }, { qty: 1 }, 'b')
		expect(foldBothOrders([base, del(2), revive])).toEqual({ title: 'x', qty: 2 })
	})

	test('a write older than the delete stays hidden', () => {
		const base = insert(1, { title: 'x' })
		const older = update(2, { title: 'y' }, { title: 'x' }, 'b')
		expect(foldBothOrders([base, older, del(3)])).toBeNull()
		const state = foldRecord([base, del(3)], schema).state as FoldState
		const result = mergeOp(state, older, schema)
		expect(result.traces.some((tr) => tr.field === FOLD_RECORD_TRACE_FIELD)).toBe(true)
	})

	test('an insert after a delete merges per field (not a reset)', () => {
		const base = insert(1, { title: 'x', qty: 1 })
		const reinsert = insert(3, { title: 'again' }, 'b')
		expect(foldBothOrders([base, del(2), reinsert])).toEqual({ title: 'again', qty: 1 })
	})

	test('updates without an insert do not materialize a record', () => {
		expect(fold([update(1, { title: 'x' }, { title: 'w' })])).toBeNull()
	})
})

describe('insert onto an existing row', () => {
	test('merges per field: newer fields win, older inserts never reset', () => {
		const a = insert(1, { title: 'a', qty: 1 }, 'a')
		const edit = update(2, { qty: 5 }, { qty: 1 }, 'a')
		const b = insert(3, { title: 'b' }, 'b')
		expect(foldBothOrders([a, edit, b])).toEqual({ title: 'b', qty: 5 })
	})

	test('a scope-entry insert stamps each field at its own version (RT-27)', () => {
		const base = insert(1, { title: 'old', qty: 1 }, 'a')
		const localNewer = update(5, { qty: 7 }, { qty: 1 }, 'b')
		const entry = op({
			type: 'insert',
			wall: 1,
			node: 'srv',
			data: { title: 'new', qty: 3 },
			fieldVersions: {
				title: { wallTime: 4, logical: 0, nodeId: 'c' },
				qty: { wallTime: 3, logical: 0, nodeId: 'c' },
			},
		})
		expect(foldBothOrders([base, localNewer, entry])).toEqual({ title: 'new', qty: 7 })
	})
})

describe('exclusion', () => {
	test('excluded ops (set or predicate) are left out', () => {
		const base = insert(1, { title: 'x' })
		const rejected = update(2, { title: 'forbidden' }, { title: 'x' }, 'b')
		const bySet = foldRecord([base, rejected], schema, { exclude: new Set([rejected.id]) }).state
		expect(materialize(bySet as FoldState)?.title).toBe('x')
		const byPredicate = foldRecord([base, rejected], schema, {
			exclude: (o) => o.nodeId === 'b',
		}).state
		expect(materialize(byPredicate as FoldState)?.title).toBe('x')
		const state = foldRecord([base], schema).state as FoldState
		const merged = mergeOp(state, rejected, schema, { exclude: new Set([rejected.id]) })
		expect(merged.changed).toBe(false)
		expect(merged.state).toBe(state)
	})

	test('folding nothing returns a null state', () => {
		expect(foldRecord([], schema).state).toBeNull()
	})
})

describe('mergeOp contract', () => {
	test('a duplicate op changes nothing', () => {
		const base = insert(1, { title: 'x', tags: ['a'], qty: 1 })
		const s1 = mergeOp(createFoldState('tickets', 'r1'), base, schema).state
		const s2 = mergeOp(s1, base, schema)
		expect(s2.changed).toBe(false)
		expect(serializeFoldState(s2.state)).toBe(serializeFoldState(s1))
	})

	test('mergeOp never mutates the input state', () => {
		const state = foldRecord([insert(1, { title: 'x', tags: ['a'] })], schema).state as FoldState
		const before = serializeFoldState(state)
		mergeOp(state, update(2, { title: 'y', tags: [] }, { title: 'x', tags: ['a'] }), schema)
		expect(serializeFoldState(state)).toBe(before)
	})

	test('rejects an op for another record', () => {
		const other = { ...insert(1, { title: 'x' }), recordId: 'r2' }
		expect(() => mergeOp(createFoldState('tickets', 'r1'), other, schema)).toThrow(FoldStateError)
	})

	test('rejects a stored field whose kind the schema changed', () => {
		const state = foldRecord([insert(1, { title: 'x' })], schema).state as FoldState
		const changed = defineSchema({
			version: 2,
			collections: { tickets: { fields: { title: t.array(t.string()) } } },
		}) as unknown as SchemaDefinition
		expect(() => mergeOp(state, update(2, { title: ['y'] }, { title: 'x' }), changed)).toThrow(
			FoldStateError,
		)
	})

	test('fields and collections the schema does not know fold as LWW registers', () => {
		const unknown = { ...insert(1, { extra: [1] }), collection: 'ghost' }
		const state = mergeOp(createFoldState('ghost', 'r1'), unknown, schema).state
		expect(state.f.extra?.k).toBe('reg')
		expect(materialize(state)).toEqual({ extra: [1] })
	})
})

describe('traces', () => {
	test('a concurrent write emits a trace naming the prior writer', () => {
		const base = insert(1, { title: 'base' })
		const a = update(3, { title: 'a' }, { title: 'base' }, 'a')
		const b = update(2, { title: 'b' }, { title: 'base' }, 'b')
		const state = foldRecord([base, a], schema).state as FoldState
		const { traces } = mergeOp(state, b, schema)
		expect(traces).toHaveLength(1)
		expect(traces[0]).toMatchObject({
			field: 'title',
			strategy: 'lww',
			inputA: 'a',
			inputB: 'b',
			base: 'base',
			output: 'a',
			tier: 1,
			priorOperationId: a.id,
			conflict: true,
		})
		const mergeTrace = toMergeTrace(traces[0] as NonNullable<(typeof traces)[0]>, a)
		expect(mergeTrace.operationA).toBe(a)
		expect(mergeTrace.operationB).toBe(b)
	})

	test('a sequential write emits no trace in conflicts mode, one in all mode', () => {
		const base = insert(1, { title: 'base' })
		const state = foldRecord([base], schema).state as FoldState
		const next = update(2, { title: 'next' }, { title: 'base' })
		expect(mergeOp(state, next, schema).traces).toHaveLength(0)
		expect(mergeOp(state, next, schema, { traces: 'all' }).traces).toHaveLength(1)
		expect(mergeOp(state, next, schema, { traces: 'none' }).traces).toHaveLength(0)
	})

	test('secret values are redacted from traces', () => {
		const base = insert(1, { pin: 'hash-1' })
		const a = update(3, { pin: 'hash-a' }, { pin: 'hash-1' }, 'a')
		const b = update(2, { pin: 'hash-b' }, { pin: 'hash-1' }, 'b')
		const state = foldRecord([base, a], schema).state as FoldState
		const [trace] = mergeOp(state, b, schema).traces
		expect(JSON.stringify(trace)).not.toContain('hash-')
	})

	test('custom resolver traces are tier 3', () => {
		const base = insert(1, { stock: 10 })
		const a = update(2, { stock: 15 }, { stock: 10 }, 'a')
		const state = foldRecord([base, a], schema).state as FoldState
		const [trace] = mergeOp(state, update(3, { stock: 13 }, { stock: 10 }, 'b'), schema).traces
		expect(trace).toMatchObject({ strategy: 'custom', tier: 3, output: 18 })
	})
})

describe('state, serialization and versions', () => {
	const ops = [
		insert(1, { title: 'x', tags: ['a'], doc: { k: 1 }, score: 1, stock: 1, body: 'hi' }),
		update(2, { tags: ['a', 'b'], score: 3 }, { tags: ['a'], score: 1 }, 'b'),
		del(3, 'c'),
		update(4, { title: 'y' }, { title: 'x' }, 'd'),
	]

	test('serialize/deserialize round-trips to an identical state', () => {
		const state = foldRecord(ops, schema).state as FoldState
		const json = serializeFoldState(state)
		const restored = deserializeFoldState(json)
		expect(serializeFoldState(restored)).toBe(json)
		expect(materialize(restored)).toEqual(materialize(state))
	})

	test('rejects an unknown format version and malformed input', () => {
		expect(() => deserializeFoldState('{"v":99,"c":"x","r":"y","f":{}}')).toThrow(FoldStateError)
		expect(() => deserializeFoldState('not json')).toThrow(FoldStateError)
		expect(() => deserializeFoldState('{"v":1,"c":"x","r":"y","f":{"a":{"k":"?"}}}')).toThrow(
			FoldStateError,
		)
	})

	test('joinStates equals folding the union and rejects other records', () => {
		const a = foldRecord(ops.slice(0, 2), schema).state as FoldState
		const b = foldRecord(ops.slice(2), schema).state as FoldState
		const all = foldRecord(ops, schema).state as FoldState
		expect(serializeFoldState(joinStates(a, b, schema))).toBe(serializeFoldState(all))
		expect(serializeFoldState(joinStates(b, a, schema))).toBe(serializeFoldState(all))
		expect(serializeFoldState(joinStates(all, all, schema))).toBe(serializeFoldState(all))
		expect(() => joinStates(a, { ...b, r: 'other' }, schema)).toThrow(FoldStateError)
	})

	test('field versions report each field’s newest write', () => {
		const state = foldRecord(ops, schema).state as FoldState
		expect(isFoldStateLive(state)).toBe(true)
		const versions = getFoldFieldVersions(state)
		expect(versions?.created.wallTime).toBe(1)
		expect(versions?.latest.wallTime).toBe(4)
		expect(versions?.fields.title?.wallTime).toBe(4)
		expect(versions?.fields.tags?.wallTime).toBe(2)
		expect(versions?.fields.body?.wallTime).toBe(1)
		const deleted = foldRecord(ops.slice(0, 3), schema).state as FoldState
		expect(getFoldFieldVersions(deleted)).toBeNull()
	})
})
