import type {
	ConnectionQuality,
	KoraEventEmitter,
	SyncDiagnosticsSnapshot,
	TimeSource,
} from '@korajs/core'
import type { SyncStatus } from '../types'
import { BandwidthEstimator } from './bandwidth-estimator'
import { SlidingWindowPercentile } from './percentile'

/**
 * Configuration for the SyncMetricsCollector.
 */
export interface MetricsCollectorConfig {
	/** Number of RTT samples to keep for percentile calculations. Defaults to 100. */
	rttWindowSize?: number
	/** Number of bandwidth samples to keep. Defaults to 20. */
	bandwidthWindowSize?: number
	/** Interval in ms between periodic diagnostics emissions. Defaults to 5000. */
	diagnosticsInterval?: number
	/** Injectable time source for deterministic testing. */
	timeSource?: TimeSource
}

/**
 * Collects and aggregates sync metrics for diagnostics and DevTools integration.
 *
 * Tracks connection timing, RTT percentiles, throughput counters, queue depth,
 * initial sync progress, errors, and connection quality. Periodically emits
 * a `sync:diagnostics` event with a full snapshot.
 */
export class SyncMetricsCollector {
	private readonly rttWindow: SlidingWindowPercentile
	private readonly inboundBandwidth: BandwidthEstimator
	private readonly outboundBandwidth: BandwidthEstimator
	private readonly timeSource: TimeSource
	private readonly diagnosticsInterval: number

	// Connection
	private connectedAt: number | null = null
	private disconnectedAt: number | null = null
	private reconnectAttempts = 0

	// Throughput
	private operationsSent = 0
	private operationsReceived = 0
	private bytesSent = 0
	private bytesReceived = 0

	// Queue
	private pendingOperations = 0
	private outboundQueueSize = 0

	// Sync progress
	private lastSyncedAt: number | null = null
	private syncStartTime: number | null = null
	private syncDuration: number | null = null
	private initialSyncComplete = false
	private initialSyncTotalBatches = 0
	private initialSyncReceivedBatches = 0

	// Errors
	private lastError: string | null = null
	private errorCount = 0

	// Status
	private currentStatus: SyncStatus = 'offline'
	private currentQuality: ConnectionQuality = 'offline'

	// Periodic emission
	private emitter: KoraEventEmitter | null = null
	private periodicTimer: ReturnType<typeof setInterval> | null = null

	constructor(config?: MetricsCollectorConfig) {
		this.rttWindow = new SlidingWindowPercentile(config?.rttWindowSize ?? 100)
		this.inboundBandwidth = new BandwidthEstimator(
			config?.bandwidthWindowSize ?? 20,
			config?.timeSource,
		)
		this.outboundBandwidth = new BandwidthEstimator(
			config?.bandwidthWindowSize ?? 20,
			config?.timeSource,
		)
		this.timeSource = config?.timeSource ?? { now: () => Date.now() }
		this.diagnosticsInterval = config?.diagnosticsInterval ?? 5000
	}

	/**
	 * Attach an event emitter for periodic diagnostics emission.
	 * Starts emitting `sync:diagnostics` events at the configured interval
	 * while connected.
	 */
	attachEmitter(emitter: KoraEventEmitter): void {
		this.emitter = emitter
	}

	/**
	 * Record that a connection has been established.
	 */
	recordConnected(): void {
		this.connectedAt = this.timeSource.now()
		this.reconnectAttempts = 0
		this.startPeriodicEmission()
	}

	/**
	 * Record that the connection has been lost.
	 */
	recordDisconnected(): void {
		this.disconnectedAt = this.timeSource.now()
		this.stopPeriodicEmission()
	}

	/**
	 * Record a reconnection attempt.
	 */
	recordReconnectAttempt(): void {
		this.reconnectAttempts++
	}

	/**
	 * Record a round-trip time measurement.
	 */
	recordRtt(ms: number): void {
		this.rttWindow.addSample(ms)
	}

	/**
	 * Record operations sent with their serialized byte size.
	 */
	recordSent(operationCount: number, byteSize: number, durationMs: number): void {
		this.operationsSent += operationCount
		this.bytesSent += byteSize
		if (durationMs > 0 && byteSize > 0) {
			this.outboundBandwidth.recordTransfer(byteSize, durationMs)
			this.emitBandwidthEvent('out')
		}
	}

	/**
	 * Record operations received with their serialized byte size.
	 */
	recordReceived(operationCount: number, byteSize: number, durationMs: number): void {
		this.operationsReceived += operationCount
		this.bytesReceived += byteSize
		if (durationMs > 0 && byteSize > 0) {
			this.inboundBandwidth.recordTransfer(byteSize, durationMs)
			this.emitBandwidthEvent('in')
		}
	}

	/**
	 * Update the pending operations count and estimated outbound queue size.
	 */
	updateQueue(pendingOps: number, estimatedBytes: number): void {
		this.pendingOperations = pendingOps
		this.outboundQueueSize = estimatedBytes
	}

	/**
	 * Record that sync has started (for measuring sync duration).
	 */
	recordSyncStarted(): void {
		this.syncStartTime = this.timeSource.now()
	}

	/**
	 * Record that a sync cycle has completed.
	 */
	recordSyncCompleted(): void {
		if (this.syncStartTime !== null) {
			this.syncDuration = this.timeSource.now() - this.syncStartTime
			this.syncStartTime = null
		}
		this.lastSyncedAt = this.timeSource.now()
		if (!this.initialSyncComplete) {
			this.initialSyncComplete = true
		}
	}

	/**
	 * Update initial sync progress.
	 * @param receivedBatches - Number of delta batches received so far.
	 * @param totalBatches - Estimated total batches (0 if unknown).
	 */
	updateInitialSyncProgress(receivedBatches: number, totalBatches: number): void {
		this.initialSyncReceivedBatches = receivedBatches
		this.initialSyncTotalBatches = totalBatches

		const progress =
			totalBatches > 0 ? Math.min(1, receivedBatches / totalBatches) : receivedBatches > 0 ? 0.5 : 0

		this.emitter?.emit({
			type: 'sync:initial-sync-progress',
			progress,
			totalBatches,
			receivedBatches,
		})
	}

	/**
	 * Record an error.
	 */
	recordError(message: string): void {
		this.lastError = message
		this.errorCount++
	}

	/**
	 * Update the current developer-facing status.
	 */
	updateStatus(status: SyncStatus): void {
		this.currentStatus = status
	}

	/**
	 * Update the connection quality.
	 */
	updateQuality(quality: ConnectionQuality): void {
		this.currentQuality = quality
	}

	/**
	 * Compute and return a full diagnostics snapshot.
	 */
	getSnapshot(): SyncDiagnosticsSnapshot {
		return {
			// Connection
			status: this.currentStatus,
			connectedAt: this.connectedAt,
			disconnectedAt: this.disconnectedAt,
			reconnectAttempts: this.reconnectAttempts,

			// Latency
			rttMs: this.rttWindow.latest(),
			rttP50Ms: this.rttWindow.percentile(50),
			rttP95Ms: this.rttWindow.percentile(95),
			rttP99Ms: this.rttWindow.percentile(99),

			// Throughput
			operationsSent: this.operationsSent,
			operationsReceived: this.operationsReceived,
			bytesSent: this.bytesSent,
			bytesReceived: this.bytesReceived,

			// Queue
			pendingOperations: this.pendingOperations,
			outboundQueueSize: this.outboundQueueSize,

			// Sync Progress
			lastSyncedAt: this.lastSyncedAt,
			syncDuration: this.syncDuration,
			initialSyncComplete: this.initialSyncComplete,
			initialSyncProgress: this.computeInitialSyncProgress(),

			// Errors
			lastError: this.lastError,
			errorCount: this.errorCount,

			// Connection Quality
			quality: this.currentQuality,
			effectiveBandwidth: this.computeEffectiveBandwidth(),
		}
	}

	/**
	 * Assess connection quality from current metrics.
	 *
	 * Quality is derived from RTT percentiles, error rate, and bandwidth:
	 * - excellent: p95 < 100ms, no errors
	 * - good: p95 < 300ms, errorCount <= 1
	 * - fair: p95 < 1000ms, errorCount <= 3
	 * - poor: p95 >= 1000ms or errorCount > 3
	 * - offline: no connection
	 */
	assessQuality(): ConnectionQuality {
		if (this.currentStatus === 'offline') return 'offline'

		const p95 = this.rttWindow.percentile(95)
		const hasSamples = this.rttWindow.size() > 0

		if (!hasSamples) {
			// No RTT data yet, fall back to error-based assessment
			if (this.errorCount > 3) return 'poor'
			if (this.errorCount > 0) return 'fair'
			return 'good'
		}

		if (this.errorCount > 3) return 'poor'
		if (p95 < 100 && this.errorCount === 0) return 'excellent'
		if (p95 < 300 && this.errorCount <= 1) return 'good'
		if (p95 < 1000 && this.errorCount <= 3) return 'fair'
		return 'poor'
	}

	/**
	 * Reset all collected metrics. Call when starting a new session.
	 */
	reset(): void {
		this.rttWindow.reset()
		this.inboundBandwidth.reset()
		this.outboundBandwidth.reset()

		this.connectedAt = null
		this.disconnectedAt = null
		this.reconnectAttempts = 0

		this.operationsSent = 0
		this.operationsReceived = 0
		this.bytesSent = 0
		this.bytesReceived = 0

		this.pendingOperations = 0
		this.outboundQueueSize = 0

		this.lastSyncedAt = null
		this.syncStartTime = null
		this.syncDuration = null
		this.initialSyncComplete = false
		this.initialSyncTotalBatches = 0
		this.initialSyncReceivedBatches = 0

		this.lastError = null
		this.errorCount = 0

		this.currentStatus = 'offline'
		this.currentQuality = 'offline'

		this.stopPeriodicEmission()
	}

	/**
	 * Stop periodic emission and clean up resources.
	 */
	dispose(): void {
		this.stopPeriodicEmission()
		this.emitter = null
	}

	// --- Private helpers ---

	private computeInitialSyncProgress(): number {
		if (this.initialSyncComplete) return 1
		if (this.initialSyncTotalBatches > 0) {
			return Math.min(1, this.initialSyncReceivedBatches / this.initialSyncTotalBatches)
		}
		// Unknown total: if we have received some batches, report 0.5 as indeterminate progress
		return this.initialSyncReceivedBatches > 0 ? 0.5 : 0
	}

	private computeEffectiveBandwidth(): number | null {
		// Use the lower of inbound and outbound as effective bandwidth,
		// since the bottleneck determines the effective rate.
		const inbound = this.inboundBandwidth.estimate()
		const outbound = this.outboundBandwidth.estimate()

		if (inbound === null && outbound === null) return null
		if (inbound === null) return outbound
		if (outbound === null) return inbound
		return Math.min(inbound, outbound)
	}

	private startPeriodicEmission(): void {
		if (this.periodicTimer !== null) return
		if (!this.emitter) return

		this.periodicTimer = setInterval(() => {
			this.emitDiagnostics()
		}, this.diagnosticsInterval)
	}

	private stopPeriodicEmission(): void {
		if (this.periodicTimer !== null) {
			clearInterval(this.periodicTimer)
			this.periodicTimer = null
		}
	}

	private emitDiagnostics(): void {
		this.emitter?.emit({
			type: 'sync:diagnostics',
			diagnostics: this.getSnapshot(),
		})
	}

	private emitBandwidthEvent(direction: 'in' | 'out'): void {
		const estimator = direction === 'in' ? this.inboundBandwidth : this.outboundBandwidth
		const bps = estimator.estimate()
		if (bps !== null) {
			this.emitter?.emit({
				type: 'sync:bandwidth',
				bytesPerSecond: bps,
				direction,
			})
		}
	}
}
