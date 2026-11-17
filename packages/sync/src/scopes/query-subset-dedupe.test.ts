import { fc, test as propTest } from '@fast-check/vitest'
import { describe, expect, test, vi } from 'vitest'
import { type SyncQuerySubset, dedupeQuerySubsets, querySubsetContains } from './query-subset'

/**
 * dedupeQuerySubsets runs on every handshake, over a list the client sends. It must stay
 * fast for large legal lists, and give exactly the result of the original (pairwise)
 * definition, which is kept here as the reference.
 */

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue)
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, entry]) => entry !== undefined)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, entry]) => [key, stableValue(entry)]),
		)
	}
	return value
}

function whereContains(broad: Record<string, unknown>, narrow: Record<string, unknown>): boolean {
	return Object.entries(broad).every(
		([field, expected]) =>
			JSON.stringify(stableValue(narrow[field])) === JSON.stringify(stableValue(expected)),
	)
}

/** The original pairwise definition (the specification the fast version must match). */
function referenceDedupe(subsets: SyncQuerySubset[]): SyncQuerySubset[] {
	const normalized = subsets.map((subset) => ({
		collection: subset.collection,
		where: stableValue(subset.where) as Record<string, unknown>,
	}))
	const result: SyncQuerySubset[] = []
	for (const candidate of normalized) {
		if (
			normalized.some(
				(other) =>
					other !== candidate &&
					other.collection === candidate.collection &&
					whereContains(other.where, candidate.where) &&
					(Object.keys(other.where).length < Object.keys(candidate.where).length ||
						JSON.stringify(other.where) === JSON.stringify(candidate.where)),
			)
		) {
			const duplicateAlreadyKept = result.some(
				(item) =>
					item.collection === candidate.collection &&
					JSON.stringify(item.where) === JSON.stringify(candidate.where),
			)
			if (
				duplicateAlreadyKept ||
				normalized.some(
					(other) =>
						other !== candidate &&
						other.collection === candidate.collection &&
						Object.keys(other.where).length < Object.keys(candidate.where).length &&
						whereContains(other.where, candidate.where),
				)
			)
				continue
		}
		if (
			!result.some(
				(item) =>
					item.collection === candidate.collection &&
					JSON.stringify(item.where) === JSON.stringify(candidate.where),
			)
		)
			result.push(candidate)
	}
	return result.sort((a, b) =>
		`${a.collection}:${JSON.stringify(a.where)}`.localeCompare(
			`${b.collection}:${JSON.stringify(b.where)}`,
		),
	)
}

/** The original pairwise containment (the specification the fast version must match). */
function referenceContains(broad: SyncQuerySubset[], narrow: SyncQuerySubset[]): boolean {
	const collections = new Set([
		...broad.map((s) => s.collection),
		...narrow.map((s) => s.collection),
	])
	for (const collection of collections) {
		const b = broad.filter((s) => s.collection === collection)
		const n = narrow.filter((s) => s.collection === collection)
		if (n.length === 0) {
			if (b.length > 0) return false
			continue
		}
		if (b.length === 0) continue
		if (!n.every((candidate) => b.some((other) => whereContains(other.where, candidate.where))))
			return false
	}
	return true
}

const valueArb = fc.oneof(
	fc.constantFrom('a', 'b', 'c'),
	fc.integer({ min: 0, max: 2 }),
	fc.constant(null),
	fc.boolean(),
	fc.array(fc.constantFrom('x', 'y'), { maxLength: 2 }),
)
const whereArb = fc.dictionary(fc.constantFrom('owner', 'project', 'status', 'kind'), valueArb, {
	maxKeys: 3,
})
const subsetArb = fc.record({ collection: fc.constantFrom('todos', 'notes'), where: whereArb })

describe('dedupeQuerySubsets', () => {
	propTest.prop([fc.array(subsetArb, { maxLength: 25 })], { numRuns: 400 })(
		'gives exactly the result of the pairwise definition',
		(subsets) => {
			expect(dedupeQuerySubsets(subsets)).toEqual(referenceDedupe(subsets))
		},
	)

	const manyFields = Array.from({ length: 14 }, (_, i) => `f${i}`)
	const wideWhereArb = fc.dictionary(fc.constantFrom(...manyFields), fc.constantFrom('a', 'b'), {
		minKeys: 9,
		maxKeys: 13,
	})
	const wideSubsetArb = fc.record({ collection: fc.constant('todos'), where: wideWhereArb })
	propTest.prop(
		[
			fc.array(fc.oneof(wideSubsetArb, subsetArb), { maxLength: 20 }),
			fc.array(wideWhereArb, { maxLength: 5 }),
		],
		{ numRuns: 200 },
	)('matches the definition for wide wheres too (the scan path)', (subsets, extra) => {
		// Narrower copies of wide wheres, so containment actually happens.
		const derived = extra.flatMap((where) => {
			const keys = Object.keys(where)
			return [
				{ collection: 'todos', where },
				{
					collection: 'todos',
					where: Object.fromEntries(keys.slice(0, 2).map((k) => [k, where[k]])),
				},
			]
		})
		const input = [...subsets, ...derived]
		expect(dedupeQuerySubsets(input)).toEqual(referenceDedupe(input))
	})

	propTest.prop([fc.array(subsetArb, { maxLength: 15 }), fc.array(subsetArb, { maxLength: 15 })], {
		numRuns: 500,
	})('querySubsetContains gives exactly the result of the pairwise definition', (broad, narrow) => {
		expect(querySubsetContains(broad, narrow)).toBe(referenceContains(broad, narrow))
		// A list always contains itself and its own deduplication.
		expect(querySubsetContains(broad, broad)).toBe(referenceContains(broad, broad))
		expect(querySubsetContains(dedupeQuerySubsets(broad), broad)).toBe(
			referenceContains(dedupeQuerySubsets(broad), broad),
		)
	})

	test('5,000-entry containment checks do linear work, not pairwise', () => {
		const narrow: SyncQuerySubset[] = Array.from({ length: 5000 }, (_, i) => ({
			collection: 'todos',
			where: { owner: `u${i % 50}`, project: `p${i}` },
		}))
		// Counted, not timed (a loaded runner makes wall-clock bounds flaky): the pairwise
		// version serializes about n² times, this one O(n log n) times (the final sort serializes in its comparator).
		const serialize = vi.spyOn(JSON, 'stringify')
		try {
			expect(querySubsetContains(narrow, narrow)).toBe(true)
			expect(serialize.mock.calls.length).toBeLessThan(narrow.length * 50)
		} finally {
			serialize.mockRestore()
		}
	})

	test('5,000 legal entries dedupe with linear work (no pairwise blow-up)', () => {
		const subsets: SyncQuerySubset[] = Array.from({ length: 5000 }, (_, i) => ({
			collection: i % 2 === 0 ? 'todos' : 'notes',
			where: { owner: `u${i % 50}`, project: `p${i}` },
		}))
		// Counted, not timed (a loaded runner makes wall-clock bounds flaky): the pairwise
		// version serializes about n² times, this one O(n log n) times (the final sort serializes in its comparator).
		const serialize = vi.spyOn(JSON, 'stringify')
		try {
			const result = dedupeQuerySubsets(subsets)
			expect(result).toHaveLength(5000)
			expect(serialize.mock.calls.length).toBeLessThan(subsets.length * 50)
		} finally {
			serialize.mockRestore()
		}
	})
})
