import { fc, test as propTest } from '@fast-check/vitest'
import type { HLCTimestamp } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { mergeObject } from './object-merge'

const tsA: HLCTimestamp = { wallTime: 2000, logical: 0, nodeId: 'node-a' }
const tsB: HLCTimestamp = { wallTime: 1000, logical: 0, nodeId: 'node-b' }

// Arbitrary JSON-ish object value: nested objects, arrays, and scalars.
const scalarArb = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null))
const jsonObjectArb = fc.dictionary(
	fc.string({ minLength: 1, maxLength: 4 }),
	fc.oneof(scalarArb, fc.array(scalarArb, { maxLength: 4 })),
	{ maxKeys: 5 },
)

describe('mergeObject — concrete behavior', () => {
	test('concurrent edits to different keys both survive', () => {
		const base = { theme: 'light', fontSize: 12 }
		const local = { theme: 'dark', fontSize: 12 } // A changed theme
		const remote = { theme: 'light', fontSize: 16 } // B changed fontSize
		const merged = mergeObject(local, remote, base, tsA, tsB)
		expect(merged).toEqual({ theme: 'dark', fontSize: 16 })
	})

	test('same-key conflict resolves by HLC (A later wins)', () => {
		const base = { theme: 'light' }
		const local = { theme: 'dark' }
		const remote = { theme: 'blue' }
		// tsA.wallTime (2000) > tsB.wallTime (1000) → local wins
		expect(mergeObject(local, remote, base, tsA, tsB).theme).toBe('dark')
		// swap timestamps → remote wins
		expect(mergeObject(local, remote, base, tsB, tsA).theme).toBe('blue')
	})

	test('add-wins: a concurrent add survives a concurrent delete of a different key', () => {
		const base = { a: 1, b: 2 }
		const local = { a: 1 } // A removed b
		const remote = { a: 1, b: 2, c: 3 } // B added c
		const merged = mergeObject(local, remote, base, tsA, tsB)
		expect(merged).toEqual({ a: 1, c: 3 })
	})

	test('add-wins: writing a key that the other side deleted keeps the write', () => {
		const base = { a: 1 }
		const local = {} // A removed a
		const remote = { a: 5 } // B changed a
		expect(mergeObject(local, remote, base, tsA, tsB)).toEqual({ a: 5 })
	})

	test('both delete the same key → key is gone', () => {
		const base = { a: 1, b: 2 }
		const local = { b: 2 }
		const remote = { b: 2 }
		expect(mergeObject(local, remote, base, tsA, tsB)).toEqual({ b: 2 })
	})

	test('nested objects merge recursively, not wholesale', () => {
		const base = { user: { name: 'A', prefs: { theme: 'light' } } }
		const local = { user: { name: 'A', prefs: { theme: 'dark' } } }
		const remote = { user: { name: 'B', prefs: { theme: 'light' } } }
		const merged = mergeObject(local, remote, base, tsA, tsB)
		expect(merged).toEqual({ user: { name: 'B', prefs: { theme: 'dark' } } })
	})

	test('nested arrays merge add-wins', () => {
		const base = { tags: ['x'] }
		const local = { tags: ['x', 'y'] }
		const remote = { tags: ['x', 'z'] }
		const merged = mergeObject(local, remote, base, tsA, tsB) as { tags: unknown[] }
		expect([...merged.tags].sort()).toEqual(['x', 'y', 'z'])
	})

	test('a scalar replacing the whole object falls back to LWW', () => {
		const base = { a: 1 }
		// remote replaced the object with a scalar; local kept an object
		const merged = mergeObject({ a: 2 }, 'scalar' as unknown, base, tsB, tsA)
		// tsA (remote) later → scalar wins, coerced to empty object (not a map)
		expect(merged).toEqual({})
	})
})

describe('mergeObject — CRDT laws (property-based)', () => {
	propTest.prop([jsonObjectArb, jsonObjectArb, jsonObjectArb])(
		'commutative: merge(a,b) deep-equals merge(b,a) with swapped clocks',
		(base, local, remote) => {
			const ab = mergeObject(local, remote, base, tsA, tsB)
			const ba = mergeObject(remote, local, base, tsB, tsA)
			expect(ab).toEqual(ba)
		},
	)

	propTest.prop([jsonObjectArb])(
		'idempotent: a no-op merge (base === both sides) returns the value unchanged',
		(value) => {
			// The CRDT idempotency law: merging a state with itself and its own base
			// applies no change and yields that state. (Arrays are add-wins sets, so
			// a value carrying duplicate array elements canonicalizes; the no-op law
			// is the model-correct statement of idempotency.)
			const merged = mergeObject(value, value, value, tsA, tsB)
			expect(merged).toEqual(value)
		},
	)

	propTest.prop([jsonObjectArb, jsonObjectArb, jsonObjectArb])(
		'deterministic: same inputs always produce the same output',
		(base, local, remote) => {
			const first = mergeObject(local, remote, base, tsA, tsB)
			const second = mergeObject(local, remote, base, tsA, tsB)
			expect(first).toEqual(second)
		},
	)

	propTest.prop([jsonObjectArb, jsonObjectArb])(
		'no data loss: a key only one side added (vs a shared base) is always present',
		(base, additions) => {
			// local = base + additions (only-adds, no deletes), remote = base unchanged
			const local = { ...base, ...additions }
			const merged = mergeObject(local, base, base, tsA, tsB)
			for (const key of Object.keys(additions)) {
				expect(key in merged).toBe(true)
			}
		},
	)
})
