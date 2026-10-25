import { fc } from '@fast-check/vitest'
import {
	defineSchema,
	foldRecord,
	materialize,
	mergeOp,
	operationSchemaView,
	t,
} from '@korajs/core'
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { cutPreviousData, readsBase, readsBaseOrUnknown, sameValue } from './payload-gate'

const schema = defineSchema({
	version: 1,
	collections: {
		c: {
			fields: {
				s: t.string().optional(),
				tags: t.array(t.string()).default([]),
				n: t.number().merge('counter').default(0),
				m: t.object({}).optional(),
				q: t.number().default(0),
			},
			resolve: {
				// Additive: applies the writer's delta to the value merged so far.
				q: (local: unknown, remote: unknown, base: unknown) =>
					Number(local) + (Number(remote) - Number(base)),
			},
		},
	},
})
const collection = schema.collections.c

let counter = 0
function op(
	id: string,
	node: string,
	type: 'insert' | 'update',
	wall: number,
	data: Record<string, unknown>,
	previousData: Record<string, unknown> | null,
): Operation {
	counter += 1
	return {
		id,
		nodeId: node,
		type,
		collection: 'c',
		recordId: 'r',
		data,
		previousData,
		timestamp: { wallTime: wall, logical: 0, nodeId: node },
		sequenceNumber: counter,
		causalDeps: [],
		schemaVersion: 1,
		hashVersion: 2,
	}
}

describe('readsBase', () => {
	test("is true for exactly the kinds whose fold reads the writer's base", () => {
		expect(readsBase(collection, 's')).toBe(false)
		expect(readsBase(collection, 'tags')).toBe(true)
		expect(readsBase(collection, 'n')).toBe(true)
		expect(readsBase(collection, 'm')).toBe(true)
		expect(readsBase(collection, 'q')).toBe(true)
		// A field the schema does not know folds as a register.
		expect(readsBase(collection, 'gone')).toBe(false)
	})
})

describe('base dependence through a schema transform (PR #79 review)', () => {
	test('a field the schema does not know fails closed', () => {
		expect(readsBaseOrUnknown(collection, 'gone')).toBe(true)
		expect(readsBaseOrUnknown(undefined, 's')).toBe(true)
		expect(readsBaseOrUnknown(collection, 's')).toBe(false)
		expect(readsBaseOrUnknown(collection, 'tags')).toBe(true)
		const renamed = op('u', 'n1', 'update', 10, { votes: 5 }, { votes: 3 })
		expect(cutPreviousData(renamed, collection).lostBase).toBe(true)
	})

	test("the transformed view's fields decide, not only the stored names", () => {
		// v1 wrote a register-looking field `s`; the transform folds it into the counter `n`.
		const stored: Operation = {
			...op('u', 'n1', 'update', 10, { s: 5 }, { s: 3 }),
			schemaVersion: 1,
		}
		const view = operationSchemaView(stored, 2, [
			{
				fromVersion: 1,
				toVersion: 2,
				transform: (o) => ({
					...o,
					data: { n: (o.data as Record<string, number>).s },
					previousData: { n: (o.previousData as Record<string, number>).s },
					schemaVersion: 2,
				}),
			},
		])
		expect(cutPreviousData(stored, collection).lostBase).toBe(false)
		expect(cutPreviousData(stored, collection, view).lostBase).toBe(true)
		// A transform that cannot be read fails closed too.
		expect(cutPreviousData(stored, collection, 'unreadable').lostBase).toBe(true)
		// The wire representation of the copy is the stored one.
		expect(cutPreviousData(stored, collection, view).operation.data).toEqual({ s: 5 })
	})
})

describe('cutPreviousData', () => {
	test('keeps what equals the new value, cuts the rest, drops the hash version, keeps the id', () => {
		const update = op('u', 'n1', 'update', 10, { s: 'new', tags: ['a'] }, { s: 'old', tags: ['a'] })
		const cut = cutPreviousData(update, collection)
		expect(cut.changed).toBe(true)
		expect(cut.lostBase).toBe(false)
		expect(cut.operation.previousData).toEqual({ tags: ['a'] })
		expect(cut.operation.id).toBe('u')
		expect(cut.operation.hashVersion).toBeUndefined()
		// The input is never mutated.
		expect(update.previousData).toEqual({ s: 'old', tags: ['a'] })
	})

	test('says when a cut entry belongs to a field whose fold reads its base', () => {
		const cut = cutPreviousData(op('u', 'n1', 'update', 10, { n: 5 }, { n: 3 }), collection)
		expect(cut.lostBase).toBe(true)
	})

	test('returns the same operation when nothing differs, and for inserts and deletes', () => {
		const same = op('u', 'n1', 'update', 10, { s: 'x' }, { s: 'x' })
		expect(cutPreviousData(same, collection)).toMatchObject({ operation: same, changed: false })
		const insert = op('i', 'n1', 'insert', 10, { s: 'x' }, null)
		expect(cutPreviousData(insert, collection).operation).toBe(insert)
	})

	test('sameValue compares structure, not identity', () => {
		expect(sameValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
		expect(sameValue([1, 2], [2, 1])).toBe(false)
		expect(sameValue(new Uint8Array([1]), new Uint8Array([1]))).toBe(true)
		expect(sameValue(null, undefined)).toBe(false)
	})
})

/**
 * Convergence of a recipient that gets a record whole (a scope entry: the folded state
 * as of the moving update) and then the moving update with its base cut, or not at all.
 */
describe('what the fold tolerates of a cut base', () => {
	interface Write {
		node: string
		tags: string[]
		s: string
		dn: number
		m: Record<string, string>
		dq: number
	}
	const writeArb: fc.Arbitrary<Write> = fc.record({
		node: fc.constantFrom('n1', 'n2', 'n3'),
		tags: fc.array(fc.constantFrom('a', 'b', 'c', 'd'), { maxLength: 4 }),
		s: fc.constantFrom('x', 'y', 'z'),
		dn: fc.integer({ min: -3, max: 3 }),
		m: fc.dictionary(fc.constantFrom('k1', 'k2', 'k3'), fc.constantFrom('u', 'v'), { maxKeys: 3 }),
		dq: fc.integer({ min: -2, max: 2 }),
	})

	function scenario(writes: Write[], moveAt: number, stamps: number[]) {
		counter = 0
		const base = op(
			'i',
			'n1',
			'insert',
			1000,
			{ s: 'x', tags: ['a', 'b'], n: 0, m: {}, q: 0 },
			null,
		)
		const ops: Operation[] = [base]
		let current: Record<string, unknown> = { s: 'x', tags: ['a', 'b'], n: 0, m: {}, q: 0 }
		writes.forEach((w, i) => {
			const data = {
				s: w.s,
				tags: w.tags,
				n: (current.n as number) + w.dn,
				m: w.m,
				q: (current.q as number) + w.dq,
			}
			ops.push(op(`u${i}`, w.node, 'update', 2000 + (stamps[i] ?? 0), data, { ...current }))
			current = data
		})
		const moving = ops[1 + (moveAt % writes.length)] as Operation
		const upTo = ops.slice(0, ops.indexOf(moving) + 1)
		const entry = foldRecord(upTo, schema).state
		const rest = ops.slice(ops.indexOf(moving) + 1)
		const truth = materialize(foldRecord(ops, schema).state as never)
		const replay = (first: Operation | null): unknown => {
			let state = entry as NonNullable<typeof entry>
			if (first) state = mergeOp(state, first, schema).state
			for (const later of rest) state = mergeOp(state, later, schema).state
			return materialize(state)
		}
		return { moving, truth, replay }
	}

	const args = [
		fc.array(writeArb, { minLength: 2, maxLength: 6 }),
		fc.nat(5),
		fc.array(fc.nat(100), { minLength: 6, maxLength: 6 }),
	] as const

	test('a recipient holding the entry state converges when the moving update is withheld', () => {
		fc.assert(
			fc.property(...args, (writes, moveAt, stamps) => {
				const { truth, replay } = scenario(writes, moveAt, stamps)
				expect(replay(null)).toEqual(truth)
			}),
			{ numRuns: 200, seed: 78 },
		)
	})

	test('it converges when only a base-independent cut is applied to the moving update', () => {
		fc.assert(
			fc.property(...args, (writes, moveAt, stamps) => {
				const { moving, truth, replay } = scenario(writes, moveAt, stamps)
				const cut = cutPreviousData(moving, collection)
				// Only the fields whose fold ignores the base can be cut without a copy being
				// withheld; the others are the reason a moved-in update is withheld instead.
				if (cut.lostBase) return
				expect(replay(cut.operation)).toEqual(truth)
			}),
			{ numRuns: 200, seed: 78 },
		)
	})

	test('cutting the base of an array, counter, object or resolver field would diverge (why such an update is withheld)', () => {
		let diverged = 0
		fc.assert(
			fc.property(...args, (writes, moveAt, stamps) => {
				const { moving, truth, replay } = scenario(writes, moveAt, stamps)
				const cut = cutPreviousData(moving, collection)
				if (cut.lostBase && JSON.stringify(replay(cut.operation)) !== JSON.stringify(truth)) {
					diverged += 1
				}
			}),
			{ numRuns: 200, seed: 78 },
		)
		expect(diverged).toBeGreaterThan(0)
	})
})
