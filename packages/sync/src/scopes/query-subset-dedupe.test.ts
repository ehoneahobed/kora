import { fc, test as propTest } from '@fast-check/vitest'
import { describe, expect, test } from 'vitest'
import { type SyncQuerySubset, dedupeQuerySubsets } from './query-subset'

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

	test('5,000 legal entries dedupe quickly (no pairwise blow-up)', () => {
		const subsets: SyncQuerySubset[] = Array.from({ length: 5000 }, (_, i) => ({
			collection: i % 2 === 0 ? 'todos' : 'notes',
			where: { owner: `u${i % 50}`, project: `p${i}` },
		}))
		const started = performance.now()
		const result = dedupeQuerySubsets(subsets)
		const elapsed = performance.now() - started
		expect(result).toHaveLength(5000)
		// Generous for slow CI runners; the pairwise version takes seconds here.
		expect(elapsed).toBeLessThan(250)
	})
})
