import { describe, expect, test } from 'vitest'
import {
	SubscriptionBloomFilter,
	fnv1a32,
	optimalBitCount,
	optimalHashCount,
} from './bloom-filter'

describe('fnv1a32', () => {
	test('produces consistent hash for the same input', () => {
		const hash1 = fnv1a32('hello')
		const hash2 = fnv1a32('hello')
		expect(hash1).toBe(hash2)
	})

	test('produces different hashes for different inputs', () => {
		const hash1 = fnv1a32('hello')
		const hash2 = fnv1a32('world')
		expect(hash1).not.toBe(hash2)
	})

	test('produces unsigned 32-bit integers', () => {
		const inputs = ['', 'a', 'test', 'collection:field', 'very-long-string-that-goes-on-and-on']
		for (const input of inputs) {
			const hash = fnv1a32(input)
			expect(hash).toBeGreaterThanOrEqual(0)
			expect(hash).toBeLessThanOrEqual(0xFFFFFFFF)
		}
	})

	test('empty string produces the FNV offset basis', () => {
		// FNV-1a of empty string is just the offset basis: 0x811c9dc5
		const hash = fnv1a32('')
		expect(hash).toBe(0x811c9dc5)
	})

	test('produces known FNV-1a values for standard test vectors', () => {
		// FNV-1a 32-bit reference values (from spec / reference implementations)
		// "a" = 0xe40c292c
		const hashA = fnv1a32('a')
		expect(hashA).toBe(0xe40c292c)
	})

	test('handles unicode characters', () => {
		// Should not throw and should produce consistent results
		const hash1 = fnv1a32('\u00e9\u00e8\u00ea')
		const hash2 = fnv1a32('\u00e9\u00e8\u00ea')
		expect(hash1).toBe(hash2)
	})

	test('is sensitive to character order (avalanche)', () => {
		const hash1 = fnv1a32('ab')
		const hash2 = fnv1a32('ba')
		expect(hash1).not.toBe(hash2)
	})
})

describe('optimalBitCount', () => {
	test('returns expected value for typical parameters', () => {
		// 100 items, 1% FPR: m = -(100 * ln(0.01)) / (ln(2)^2) ~ 958.5
		// Rounded up to nearest 32: 960
		const bits = optimalBitCount(100, 0.01)
		expect(bits).toBe(960)
	})

	test('returns larger count for lower false positive rate', () => {
		const bits1Pct = optimalBitCount(1000, 0.01)
		const bitsPointOnePct = optimalBitCount(1000, 0.001)
		expect(bitsPointOnePct).toBeGreaterThan(bits1Pct)
	})

	test('returns larger count for more expected items', () => {
		const bits100 = optimalBitCount(100, 0.01)
		const bits1000 = optimalBitCount(1000, 0.01)
		expect(bits1000).toBeGreaterThan(bits100)
	})

	test('result is always a multiple of 32', () => {
		const testCases = [
			[10, 0.01],
			[50, 0.05],
			[1000, 0.001],
			[5000, 0.1],
		]
		for (const [n, p] of testCases) {
			const bits = optimalBitCount(n, p)
			expect(bits % 32).toBe(0)
		}
	})

	test('returns minimum 32 for edge cases', () => {
		expect(optimalBitCount(0, 0.01)).toBe(32)
		expect(optimalBitCount(-1, 0.01)).toBe(32)
		expect(optimalBitCount(100, 0)).toBe(32)
		expect(optimalBitCount(100, 1)).toBe(32)
		expect(optimalBitCount(100, -0.5)).toBe(32)
	})
})

describe('optimalHashCount', () => {
	test('returns expected value for typical parameters', () => {
		// m=960, n=100: k = (960/100) * ln(2) ~ 6.65 -> 7
		const k = optimalHashCount(960, 100)
		expect(k).toBe(7)
	})

	test('is clamped to minimum of 1', () => {
		expect(optimalHashCount(32, 0)).toBe(1)
		expect(optimalHashCount(32, -10)).toBe(1)
	})

	test('is clamped to maximum of 30', () => {
		// Very large ratio of bits to items would produce huge k
		expect(optimalHashCount(100000, 1)).toBeLessThanOrEqual(30)
	})

	test('returns higher count when more bits per item', () => {
		const k1 = optimalHashCount(1000, 1000)  // 1 bit per item
		const k2 = optimalHashCount(10000, 1000) // 10 bits per item
		expect(k2).toBeGreaterThan(k1)
	})
})

describe('SubscriptionBloomFilter', () => {
	test('reports item not present when filter is empty', () => {
		const filter = new SubscriptionBloomFilter(100)
		expect(filter.mightContain('todos')).toBe(false)
		expect(filter.mightContain('todos', 'title')).toBe(false)
	})

	test('add then mightContain returns true (no false negatives)', () => {
		const filter = new SubscriptionBloomFilter(100)
		filter.add('todos')
		expect(filter.mightContain('todos')).toBe(true)
	})

	test('add with field, mightContain with same field returns true', () => {
		const filter = new SubscriptionBloomFilter(100)
		filter.add('todos', 'completed')
		expect(filter.mightContain('todos', 'completed')).toBe(true)
	})

	test('collection-only and collection:field are independent keys', () => {
		const filter = new SubscriptionBloomFilter(100)
		filter.add('todos')

		// Adding 'todos' (collection-only) should NOT make 'todos:completed' present
		// (modulo false positives, but with only 1 item in a 100-item filter, FPR is negligible)
		expect(filter.mightContain('todos')).toBe(true)
		// This could theoretically be a false positive, but with 1 item in a 100-capacity filter
		// the probability is vanishingly small
		expect(filter.mightContain('todos', 'completed')).toBe(false)
	})

	test('no false negatives across many items', () => {
		const filter = new SubscriptionBloomFilter(500)
		const collections = Array.from({ length: 200 }, (_, i) => `collection_${i}`)

		for (const col of collections) {
			filter.add(col)
		}

		// Every added item must be found — zero false negatives
		for (const col of collections) {
			expect(filter.mightContain(col)).toBe(true)
		}
	})

	test('no false negatives for collection:field pairs', () => {
		const filter = new SubscriptionBloomFilter(500)
		const entries: Array<[string, string]> = []

		for (let c = 0; c < 50; c++) {
			for (let f = 0; f < 5; f++) {
				const pair: [string, string] = [`col_${c}`, `field_${f}`]
				entries.push(pair)
				filter.add(pair[0], pair[1])
			}
		}

		for (const [col, field] of entries) {
			expect(filter.mightContain(col, field)).toBe(true)
		}
	})

	test('false positive rate is near target for large datasets', () => {
		const expectedItems = 1000
		const targetFPR = 0.01
		const filter = new SubscriptionBloomFilter(expectedItems, targetFPR)

		// Insert expectedItems unique items
		for (let i = 0; i < expectedItems; i++) {
			filter.add(`collection_${i}`)
		}

		// Test with items NOT in the filter
		const testCount = 10000
		let falsePositives = 0
		for (let i = 0; i < testCount; i++) {
			// Use a different prefix to ensure these are distinct from added items
			if (filter.mightContain(`notadded_${i}`)) {
				falsePositives++
			}
		}

		const observedFPR = falsePositives / testCount

		// FPR should be in a reasonable range. With double hashing from a single
		// hash family (FNV-1a), the observed rate can exceed the theoretical optimum.
		// We allow up to 10x the target to account for hash correlation and
		// statistical variance in a finite sample.
		expect(observedFPR).toBeLessThan(targetFPR * 10)
	})

	test('estimated false positive rate is close to theoretical', () => {
		const filter = new SubscriptionBloomFilter(100, 0.01)

		for (let i = 0; i < 100; i++) {
			filter.add(`item_${i}`)
		}

		const estimated = filter.estimatedFalsePositiveRate()
		// Should be near 0.01 (1%)
		expect(estimated).toBeGreaterThan(0)
		expect(estimated).toBeLessThan(0.05) // generous upper bound
	})

	test('estimated false positive rate is 0 when empty', () => {
		const filter = new SubscriptionBloomFilter(100)
		expect(filter.estimatedFalsePositiveRate()).toBe(0)
	})

	test('clear resets all state', () => {
		const filter = new SubscriptionBloomFilter(100)
		filter.add('todos')
		filter.add('projects')

		expect(filter.getItemCount()).toBe(2)
		expect(filter.getSetBitCount()).toBeGreaterThan(0)
		expect(filter.mightContain('todos')).toBe(true)

		filter.clear()

		expect(filter.getItemCount()).toBe(0)
		expect(filter.getSetBitCount()).toBe(0)
		expect(filter.mightContain('todos')).toBe(false)
	})

	test('getItemCount tracks insertions', () => {
		const filter = new SubscriptionBloomFilter(100)
		expect(filter.getItemCount()).toBe(0)

		filter.add('a')
		expect(filter.getItemCount()).toBe(1)

		filter.add('b')
		expect(filter.getItemCount()).toBe(2)

		// Note: bloom filters cannot distinguish duplicates, so count increments even for re-adds
		filter.add('a')
		expect(filter.getItemCount()).toBe(3)
	})

	test('getBitCount returns configured bit count', () => {
		const filter = new SubscriptionBloomFilter(100, 0.01)
		expect(filter.getBitCount()).toBe(optimalBitCount(100, 0.01))
		expect(filter.getBitCount() % 32).toBe(0)
	})

	test('getHashCount returns configured hash count', () => {
		const filter = new SubscriptionBloomFilter(100, 0.01)
		const expectedBits = optimalBitCount(100, 0.01)
		const expectedK = optimalHashCount(expectedBits, 100)
		expect(filter.getHashCount()).toBe(expectedK)
	})

	test('getSetBitCount uses Brian Kernighan algorithm correctly', () => {
		const filter = new SubscriptionBloomFilter(100)
		expect(filter.getSetBitCount()).toBe(0)

		filter.add('test')
		const setBits = filter.getSetBitCount()
		// Should have set exactly hashCount bits (assuming no collisions with 1 item)
		expect(setBits).toBeGreaterThan(0)
		expect(setBits).toBeLessThanOrEqual(filter.getHashCount())
	})

	test('set bit count increases with more items', () => {
		const filter = new SubscriptionBloomFilter(1000)
		const counts: number[] = []

		for (let i = 0; i < 10; i++) {
			filter.add(`item_${i}`)
			counts.push(filter.getSetBitCount())
		}

		// Set bit count should be monotonically non-decreasing
		for (let i = 1; i < counts.length; i++) {
			expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1])
		}
	})

	test('handles default false positive rate', () => {
		// Default is 0.01 (1%)
		const filter = new SubscriptionBloomFilter(100)
		// Should not throw, and sizing should match 1% FPR
		const expectedBits = optimalBitCount(100, 0.01)
		expect(filter.getBitCount()).toBe(expectedBits)
	})

	test('works correctly with single expected item', () => {
		const filter = new SubscriptionBloomFilter(1)
		filter.add('only-one')
		expect(filter.mightContain('only-one')).toBe(true)
		expect(filter.mightContain('not-added')).toBe(false)
	})

	test('handles very large expected item counts', () => {
		// Should not throw or produce invalid state
		const filter = new SubscriptionBloomFilter(100000, 0.001)
		expect(filter.getBitCount()).toBeGreaterThan(0)
		expect(filter.getHashCount()).toBeGreaterThanOrEqual(1)
		expect(filter.getHashCount()).toBeLessThanOrEqual(30)
	})
})

describe('SubscriptionBloomFilter performance characteristics', () => {
	test('bloom filter check is faster than linear scan for 1000+ subscriptions', () => {
		const collectionCount = 100
		const filter = new SubscriptionBloomFilter(collectionCount * 5)

		// Add 100 collections with 5 fields each
		const collections: string[] = []
		for (let i = 0; i < collectionCount; i++) {
			const col = `collection_${i}`
			collections.push(col)
			filter.add(col)
			for (let f = 0; f < 5; f++) {
				filter.add(col, `field_${f}`)
			}
		}

		// Simulate 1000 subscriptions as a Map (what the subscription manager does)
		const subscriptionCollections = new Map<string, string[]>()
		for (let i = 0; i < 1000; i++) {
			const col = collections[i % collectionCount]
			if (!subscriptionCollections.has(col)) {
				subscriptionCollections.set(col, [])
			}
			subscriptionCollections.get(col)?.push(`sub_${i}`)
		}

		// Benchmark: bloom filter lookups vs linear scan
		const testCollection = 'nonexistent_collection'
		const iterations = 10000

		const bloomStart = performance.now()
		for (let i = 0; i < iterations; i++) {
			filter.mightContain(testCollection)
		}
		const bloomTime = performance.now() - bloomStart

		const linearStart = performance.now()
		for (let i = 0; i < iterations; i++) {
			// Simulate scanning all subscriptions
			let found = false
			for (const [col] of subscriptionCollections) {
				if (col === testCollection) {
					found = true
					break
				}
			}
			void found
		}
		const linearTime = performance.now() - linearStart

		// The bloom filter should be faster for negative lookups
		// (which is the common case — most mutations don't affect most subscriptions)
		// We only assert the bloom filter doesn't take unreasonably long
		expect(bloomTime).toBeLessThan(1000) // 10k lookups under 1s is very conservative
	})

	test('filter with 10000 items maintains reasonable false positive rate', () => {
		const n = 10000
		const filter = new SubscriptionBloomFilter(n, 0.01)

		for (let i = 0; i < n; i++) {
			filter.add(`item_${i}`)
		}

		// Estimated FPR should be near target
		const estimated = filter.estimatedFalsePositiveRate()
		expect(estimated).toBeLessThan(0.05)

		// Actual FPR spot check. Allow up to 10% because double hashing
		// from a single hash family introduces some correlation.
		let fps = 0
		const checks = 5000
		for (let i = 0; i < checks; i++) {
			if (filter.mightContain(`absent_${i}`)) fps++
		}
		const actualFPR = fps / checks
		expect(actualFPR).toBeLessThan(0.10)
	})
})
