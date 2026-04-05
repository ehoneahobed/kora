import type { ConnectionQuality, TimeSource } from '@korajs/core'

/**
 * Configuration for the connection monitor.
 */
export interface ConnectionMonitorConfig {
	/** Number of latency samples to keep in the rolling window. Defaults to 20. */
	windowSize?: number
	/** Time in ms after which the connection is considered stale. Defaults to 30000. */
	staleThreshold?: number
	/** Injectable time source for deterministic testing */
	timeSource?: TimeSource
}

/**
 * Monitors connection quality based on RTT latency samples,
 * missed acknowledgments, and activity timestamps.
 */
export class ConnectionMonitor {
	private readonly windowSize: number
	private readonly staleThreshold: number
	private readonly timeSource: TimeSource

	private latencies: number[] = []
	private missedAcks = 0
	private lastActivityTime: number

	constructor(config?: ConnectionMonitorConfig) {
		this.windowSize = config?.windowSize ?? 20
		this.staleThreshold = config?.staleThreshold ?? 30000
		this.timeSource = config?.timeSource ?? { now: () => Date.now() }
		this.lastActivityTime = this.timeSource.now()
	}

	/**
	 * Record a round-trip time sample.
	 */
	recordLatency(ms: number): void {
		this.latencies.push(ms)
		if (this.latencies.length > this.windowSize) {
			this.latencies.shift()
		}
		this.lastActivityTime = this.timeSource.now()
		// Successful response resets missed acks
		this.missedAcks = 0
	}

	/**
	 * Record a missed acknowledgment (message sent but no response received).
	 */
	recordMissedAck(): void {
		this.missedAcks++
	}

	/**
	 * Record any activity (message sent or received).
	 */
	recordActivity(): void {
		this.lastActivityTime = this.timeSource.now()
	}

	/**
	 * Assess current connection quality based on collected metrics.
	 *
	 * Quality thresholds (average RTT):
	 * - excellent: < 100ms, 0 missed acks
	 * - good: < 300ms, ≤ 1 missed ack
	 * - fair: < 1000ms, ≤ 3 missed acks
	 * - poor: < 5000ms or > 3 missed acks
	 * - offline: no activity for staleThreshold ms
	 */
	getQuality(): ConnectionQuality {
		const elapsed = this.timeSource.now() - this.lastActivityTime
		if (elapsed > this.staleThreshold) return 'offline'

		if (this.latencies.length === 0) {
			// No data yet — assume good until proven otherwise
			return this.missedAcks > 3 ? 'poor' : 'good'
		}

		const avgLatency = this.latencies.reduce((sum, l) => sum + l, 0) / this.latencies.length

		if (this.missedAcks > 3) return 'poor'
		if (avgLatency < 100 && this.missedAcks === 0) return 'excellent'
		if (avgLatency < 300 && this.missedAcks <= 1) return 'good'
		if (avgLatency < 1000 && this.missedAcks <= 3) return 'fair'
		return 'poor'
	}

	/**
	 * Reset all metrics. Call on disconnect.
	 */
	reset(): void {
		this.latencies = []
		this.missedAcks = 0
		this.lastActivityTime = this.timeSource.now()
	}

	/**
	 * Get the current average latency in ms. Returns null if no samples.
	 */
	getAverageLatency(): number | null {
		if (this.latencies.length === 0) return null
		return this.latencies.reduce((sum, l) => sum + l, 0) / this.latencies.length
	}

	/**
	 * Get the number of missed acks.
	 */
	getMissedAcks(): number {
		return this.missedAcks
	}
}
