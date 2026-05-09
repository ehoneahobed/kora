import { describe, expect, it } from 'vitest'
import { BandwidthEstimator } from './bandwidth-estimator'

function createMockTimeSource(start = 1000): { now: () => number; advance: (ms: number) => void } {
	let current = start
	return {
		now: () => current,
		advance: (ms: number) => {
			current += ms
		},
	}
}

describe('BandwidthEstimator', () => {
	it('returns null when no samples have been recorded', () => {
		const estimator = new BandwidthEstimator()
		expect(estimator.estimate()).toBeNull()
		expect(estimator.sampleCount()).toBe(0)
	})

	it('returns null with only one sample (needs at least 2)', () => {
		const time = createMockTimeSource()
		const estimator = new BandwidthEstimator(20, time)

		estimator.recordTransfer(1000, 100)
		expect(estimator.estimate()).toBeNull()
		expect(estimator.sampleCount()).toBe(1)
	})

	it('computes correct bandwidth for uniform samples', () => {
		const time = createMockTimeSource()
		const estimator = new BandwidthEstimator(20, time)

		// 1000 bytes in 100ms = 10,000 bytes/sec
		estimator.recordTransfer(1000, 100)
		time.advance(200)
		estimator.recordTransfer(1000, 100)

		const bps = estimator.estimate()
		expect(bps).not.toBeNull()
		// Both samples are 10,000 B/s, so weighted average should also be 10,000
		expect(bps).toBe(10000)
	})

	it('gives more weight to recent samples', () => {
		const time = createMockTimeSource()
		const estimator = new BandwidthEstimator(20, time)

		// Old sample: 100 bytes in 100ms = 1000 B/s
		estimator.recordTransfer(100, 100)
		time.advance(1000)

		// Recent sample: 10000 bytes in 100ms = 100,000 B/s
		estimator.recordTransfer(10000, 100)

		const bps = estimator.estimate()
		expect(bps).not.toBeNull()

		// Weighted average should be closer to 100,000 than to 1,000
		// because the recent sample has weight 1.0 and the older has weight 0.9
		// weighted = (100000 * 1.0 + 1000 * 0.9) / (1.0 + 0.9) = 100900 / 1.9 ~ 53,105
		expect(bps).toBeGreaterThan(50000)
		expect(bps).toBeLessThan(60000)
	})

	it('ignores samples with zero duration', () => {
		const time = createMockTimeSource()
		const estimator = new BandwidthEstimator(20, time)

		estimator.recordTransfer(1000, 0)
		expect(estimator.sampleCount()).toBe(0)
	})

	it('ignores samples with negative duration', () => {
		const time = createMockTimeSource()
		const estimator = new BandwidthEstimator(20, time)

		estimator.recordTransfer(1000, -50)
		expect(estimator.sampleCount()).toBe(0)
	})

	it('ignores samples with zero bytes', () => {
		const time = createMockTimeSource()
		const estimator = new BandwidthEstimator(20, time)

		estimator.recordTransfer(0, 100)
		expect(estimator.sampleCount()).toBe(0)
	})

	it('ignores samples with negative bytes', () => {
		const time = createMockTimeSource()
		const estimator = new BandwidthEstimator(20, time)

		estimator.recordTransfer(-100, 100)
		expect(estimator.sampleCount()).toBe(0)
	})

	it('evicts old samples beyond maxSamples', () => {
		const time = createMockTimeSource()
		const estimator = new BandwidthEstimator(3, time)

		estimator.recordTransfer(100, 100)
		time.advance(100)
		estimator.recordTransfer(200, 100)
		time.advance(100)
		estimator.recordTransfer(300, 100)
		time.advance(100)

		expect(estimator.sampleCount()).toBe(3)

		estimator.recordTransfer(400, 100)
		expect(estimator.sampleCount()).toBe(3)
	})

	it('reset clears all samples', () => {
		const time = createMockTimeSource()
		const estimator = new BandwidthEstimator(20, time)

		estimator.recordTransfer(1000, 100)
		time.advance(100)
		estimator.recordTransfer(1000, 100)
		expect(estimator.sampleCount()).toBe(2)

		estimator.reset()
		expect(estimator.sampleCount()).toBe(0)
		expect(estimator.estimate()).toBeNull()
	})

	it('handles high throughput (large payloads)', () => {
		const time = createMockTimeSource()
		const estimator = new BandwidthEstimator(20, time)

		// 1 MB in 100ms = 10 MB/s
		estimator.recordTransfer(1_000_000, 100)
		time.advance(200)
		estimator.recordTransfer(1_000_000, 100)

		const bps = estimator.estimate()
		expect(bps).toBe(10_000_000)
	})

	it('handles very slow connections', () => {
		const time = createMockTimeSource()
		const estimator = new BandwidthEstimator(20, time)

		// 100 bytes in 5000ms = 20 B/s (simulated 2G)
		estimator.recordTransfer(100, 5000)
		time.advance(6000)
		estimator.recordTransfer(100, 5000)

		const bps = estimator.estimate()
		expect(bps).not.toBeNull()
		expect(bps).toBe(20)
	})

	it('bandwidth adapts to changing conditions', () => {
		const time = createMockTimeSource()
		const estimator = new BandwidthEstimator(5, time)

		// Start with fast connection: 10,000 B/s
		for (let i = 0; i < 3; i++) {
			estimator.recordTransfer(1000, 100)
			time.advance(200)
		}

		const fast = estimator.estimate()
		expect(fast).not.toBeNull()

		// Connection degrades: 100 B/s
		for (let i = 0; i < 5; i++) {
			estimator.recordTransfer(100, 1000)
			time.advance(1500)
		}

		const slow = estimator.estimate()
		expect(slow).not.toBeNull()
		// After 5 slow samples filling the window, estimate should be close to 100 B/s
		expect(slow).toBeLessThan(200)
	})
})
