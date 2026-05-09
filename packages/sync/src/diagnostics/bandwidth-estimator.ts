import type { TimeSource } from '@korajs/core'

/**
 * A single bandwidth measurement sample: bytes transferred over a known duration.
 */
interface BandwidthSample {
	bytes: number
	durationMs: number
	timestamp: number
}

/**
 * Estimates effective bandwidth by tracking byte transfers over time.
 *
 * Maintains a sliding window of transfer samples and computes a
 * weighted average bandwidth, giving more weight to recent samples.
 * This provides a smooth estimate that adapts to changing network conditions.
 */
export class BandwidthEstimator {
	private readonly maxSamples: number
	private readonly timeSource: TimeSource
	private readonly samples: BandwidthSample[] = []

	/**
	 * @param maxSamples - Maximum number of samples to retain. Defaults to 20.
	 * @param timeSource - Injectable time source for deterministic testing.
	 */
	constructor(maxSamples = 20, timeSource?: TimeSource) {
		this.maxSamples = maxSamples
		this.timeSource = timeSource ?? { now: () => Date.now() }
	}

	/**
	 * Record a transfer of `bytes` that took `durationMs` to complete.
	 * Samples with zero or negative duration are ignored to avoid division errors.
	 */
	recordTransfer(bytes: number, durationMs: number): void {
		if (durationMs <= 0 || bytes <= 0) return

		this.samples.push({
			bytes,
			durationMs,
			timestamp: this.timeSource.now(),
		})

		// Evict oldest samples beyond the window
		while (this.samples.length > this.maxSamples) {
			this.samples.shift()
		}
	}

	/**
	 * Estimate current effective bandwidth in bytes per second.
	 *
	 * Uses exponential weighting so recent samples have more influence.
	 * Returns null if fewer than 2 samples exist (not enough data).
	 */
	estimate(): number | null {
		if (this.samples.length < 2) return null

		let weightedSum = 0
		let totalWeight = 0

		// Exponential decay: most recent sample gets weight 1.0,
		// each older sample is multiplied by 0.9
		const decayFactor = 0.9
		for (let i = this.samples.length - 1; i >= 0; i--) {
			const sample = this.samples[i]
			const bytesPerSec = (sample.bytes / sample.durationMs) * 1000
			const age = this.samples.length - 1 - i
			const weight = decayFactor ** age

			weightedSum += bytesPerSec * weight
			totalWeight += weight
		}

		if (totalWeight === 0) return null
		return Math.round(weightedSum / totalWeight)
	}

	/**
	 * Reset all recorded samples.
	 */
	reset(): void {
		this.samples.length = 0
	}

	/**
	 * Get the number of samples currently stored.
	 */
	sampleCount(): number {
		return this.samples.length
	}
}
