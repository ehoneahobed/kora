import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import type { VersionVector } from '../../src/types'
import { dominates, mergeVectors, vectorsEqual } from '../../src/version-vector/version-vector'

const versionVectorArb: fc.Arbitrary<VersionVector> = fc
	.array(fc.tuple(fc.stringMatching(/^[a-z]{1,4}$/), fc.nat({ max: 100 })), { maxLength: 5 })
	.map((entries) => new Map(entries))

describe('Version vector property-based tests', () => {
	test('mergeVectors is commutative', () => {
		fc.assert(
			fc.property(versionVectorArb, versionVectorArb, (a, b) => {
				const ab = mergeVectors(a, b)
				const ba = mergeVectors(b, a)
				expect(vectorsEqual(ab, ba)).toBe(true)
			}),
		)
	})

	test('mergeVectors is associative', () => {
		fc.assert(
			fc.property(versionVectorArb, versionVectorArb, versionVectorArb, (a, b, c) => {
				const ab_c = mergeVectors(mergeVectors(a, b), c)
				const a_bc = mergeVectors(a, mergeVectors(b, c))
				expect(vectorsEqual(ab_c, a_bc)).toBe(true)
			}),
		)
	})

	test('mergeVectors is idempotent', () => {
		fc.assert(
			fc.property(versionVectorArb, (a) => {
				const merged = mergeVectors(a, a)
				expect(vectorsEqual(merged, a)).toBe(true)
			}),
		)
	})

	test('merged vector dominates both inputs', () => {
		fc.assert(
			fc.property(versionVectorArb, versionVectorArb, (a, b) => {
				const merged = mergeVectors(a, b)
				expect(dominates(merged, a)).toBe(true)
				expect(dominates(merged, b)).toBe(true)
			}),
		)
	})
})
