/**
 * Sliding window percentile calculator.
 *
 * Maintains a fixed-size circular buffer of numeric samples and
 * computes percentiles (p50, p95, p99, etc.) on demand by sorting
 * the current window. This approach is simple, correct, and fast
 * for the expected window sizes (100 samples).
 */
export class SlidingWindowPercentile {
	private readonly samples: number[]
	private readonly maxSize: number
	private writeIndex = 0
	private count = 0

	/**
	 * @param maxSize - Maximum number of samples in the sliding window.
	 *                  Older samples are overwritten when the buffer is full.
	 */
	constructor(maxSize: number) {
		if (maxSize < 1) {
			throw new Error(`SlidingWindowPercentile maxSize must be >= 1, got ${maxSize}`)
		}
		this.maxSize = maxSize
		this.samples = new Array<number>(maxSize)
	}

	/**
	 * Add a sample to the sliding window.
	 * If the window is full, the oldest sample is overwritten.
	 */
	addSample(value: number): void {
		this.samples[this.writeIndex] = value
		this.writeIndex = (this.writeIndex + 1) % this.maxSize
		if (this.count < this.maxSize) {
			this.count++
		}
	}

	/**
	 * Compute a percentile value from the current window.
	 *
	 * Uses the nearest-rank method: the percentile value is the smallest
	 * value in the dataset such that at least p% of the data is <= that value.
	 *
	 * @param p - Percentile to compute (0-100). E.g., 50 for median, 95 for p95.
	 * @returns The percentile value, or 0 if no samples have been recorded.
	 */
	percentile(p: number): number {
		if (this.count === 0) return 0

		// Extract only the valid portion of the buffer and sort
		const sorted = this.samples.slice(0, this.count).sort((a, b) => a - b)

		// Nearest-rank method: index = ceil(p/100 * n) - 1, clamped to [0, n-1]
		const rank = Math.ceil((p / 100) * sorted.length) - 1
		const index = Math.max(0, Math.min(rank, sorted.length - 1))
		return sorted[index]
	}

	/**
	 * Get the most recently added sample, or 0 if no samples exist.
	 */
	latest(): number {
		if (this.count === 0) return 0
		// writeIndex points to the next write position, so the last written is one behind
		const lastIndex = (this.writeIndex - 1 + this.maxSize) % this.maxSize
		return this.samples[lastIndex]
	}

	/**
	 * Get the number of samples currently in the window.
	 */
	size(): number {
		return this.count
	}

	/**
	 * Reset the sliding window, clearing all samples.
	 */
	reset(): void {
		this.writeIndex = 0
		this.count = 0
	}
}
