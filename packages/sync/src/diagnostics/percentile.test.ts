import { describe, expect, it } from 'vitest'
import { SlidingWindowPercentile } from './percentile'

describe('SlidingWindowPercentile', () => {
	it('returns 0 for all percentiles when empty', () => {
		const sw = new SlidingWindowPercentile(10)
		expect(sw.percentile(50)).toBe(0)
		expect(sw.percentile(95)).toBe(0)
		expect(sw.percentile(99)).toBe(0)
		expect(sw.latest()).toBe(0)
		expect(sw.size()).toBe(0)
	})

	it('throws if maxSize is less than 1', () => {
		expect(() => new SlidingWindowPercentile(0)).toThrow('maxSize must be >= 1')
		expect(() => new SlidingWindowPercentile(-5)).toThrow('maxSize must be >= 1')
	})

	it('computes correct median for a single sample', () => {
		const sw = new SlidingWindowPercentile(10)
		sw.addSample(42)
		expect(sw.percentile(50)).toBe(42)
		expect(sw.latest()).toBe(42)
		expect(sw.size()).toBe(1)
	})

	it('computes correct percentiles for a sorted dataset', () => {
		const sw = new SlidingWindowPercentile(100)

		// Add values 1 through 100
		for (let i = 1; i <= 100; i++) {
			sw.addSample(i)
		}

		expect(sw.size()).toBe(100)
		expect(sw.percentile(50)).toBe(50) // median
		expect(sw.percentile(95)).toBe(95)
		expect(sw.percentile(99)).toBe(99)
		expect(sw.percentile(100)).toBe(100)
		expect(sw.percentile(0)).toBe(1) // floor to first element
		expect(sw.percentile(1)).toBe(1)
	})

	it('computes correct percentiles for an unsorted dataset', () => {
		const sw = new SlidingWindowPercentile(100)

		// Add values in reverse order
		for (let i = 100; i >= 1; i--) {
			sw.addSample(i)
		}

		// Percentile calculation should sort internally
		expect(sw.percentile(50)).toBe(50)
		expect(sw.percentile(95)).toBe(95)
		expect(sw.percentile(99)).toBe(99)
	})

	it('evicts old samples when window is full', () => {
		const sw = new SlidingWindowPercentile(5)

		// Fill the window
		sw.addSample(10)
		sw.addSample(20)
		sw.addSample(30)
		sw.addSample(40)
		sw.addSample(50)
		expect(sw.size()).toBe(5)

		// Add one more, which should evict 10
		sw.addSample(60)
		expect(sw.size()).toBe(5) // still 5

		// The window now contains [20, 30, 40, 50, 60]
		// p0 should be 20 (smallest), p100 should be 60
		expect(sw.percentile(0)).toBe(20)
		expect(sw.percentile(100)).toBe(60)
		expect(sw.latest()).toBe(60)
	})

	it('handles window of size 1 correctly', () => {
		const sw = new SlidingWindowPercentile(1)

		sw.addSample(100)
		expect(sw.percentile(50)).toBe(100)
		expect(sw.percentile(99)).toBe(100)
		expect(sw.size()).toBe(1)

		// Overwrite
		sw.addSample(200)
		expect(sw.percentile(50)).toBe(200)
		expect(sw.size()).toBe(1)
		expect(sw.latest()).toBe(200)
	})

	it('reset clears all samples', () => {
		const sw = new SlidingWindowPercentile(10)

		sw.addSample(1)
		sw.addSample(2)
		sw.addSample(3)
		expect(sw.size()).toBe(3)

		sw.reset()
		expect(sw.size()).toBe(0)
		expect(sw.percentile(50)).toBe(0)
		expect(sw.latest()).toBe(0)
	})

	it('correctly wraps around the circular buffer', () => {
		const sw = new SlidingWindowPercentile(3)

		// Fill
		sw.addSample(1)
		sw.addSample(2)
		sw.addSample(3)

		// Overwrite in circular fashion multiple times
		sw.addSample(4) // evicts 1
		sw.addSample(5) // evicts 2
		sw.addSample(6) // evicts 3
		sw.addSample(7) // evicts 4

		// Window should now contain [5, 6, 7]
		expect(sw.size()).toBe(3)
		expect(sw.percentile(0)).toBe(5)
		expect(sw.percentile(100)).toBe(7)
		expect(sw.latest()).toBe(7)
	})

	it('latest() returns the most recently added value', () => {
		const sw = new SlidingWindowPercentile(5)

		sw.addSample(100)
		expect(sw.latest()).toBe(100)

		sw.addSample(200)
		expect(sw.latest()).toBe(200)

		sw.addSample(50)
		expect(sw.latest()).toBe(50)
	})

	it('handles duplicate values correctly', () => {
		const sw = new SlidingWindowPercentile(10)

		for (let i = 0; i < 10; i++) {
			sw.addSample(42)
		}

		expect(sw.percentile(0)).toBe(42)
		expect(sw.percentile(50)).toBe(42)
		expect(sw.percentile(100)).toBe(42)
	})

	it('computes p50 correctly for even-length datasets', () => {
		const sw = new SlidingWindowPercentile(10)

		sw.addSample(10)
		sw.addSample(20)
		sw.addSample(30)
		sw.addSample(40)

		// Sorted: [10, 20, 30, 40]
		// p50 nearest rank: ceil(0.5 * 4) - 1 = 1 -> value 20
		expect(sw.percentile(50)).toBe(20)
	})

	it('handles floating point values', () => {
		const sw = new SlidingWindowPercentile(10)

		sw.addSample(1.5)
		sw.addSample(2.7)
		sw.addSample(3.3)

		expect(sw.percentile(50)).toBe(2.7)
		expect(sw.percentile(100)).toBe(3.3)
		expect(sw.percentile(0)).toBe(1.5)
	})
})
