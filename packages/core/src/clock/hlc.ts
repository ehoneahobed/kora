import { ClockDriftError } from '../errors/errors'
import type { HLCTimestamp, TimeSource } from '../types'

/** Default time source using the system clock */
const systemTimeSource: TimeSource = { now: () => Date.now() }

/** Maximum allowed drift before warning (60 seconds) */
const DRIFT_WARN_MS = 60_000

/** Maximum allowed drift before refusing to generate timestamps (5 minutes) */
const DRIFT_ERROR_MS = 5 * 60_000

/**
 * Hybrid Logical Clock implementation based on Kulkarni et al.
 *
 * Provides a total order that respects causality without requiring synchronized clocks.
 * Each call to now() returns a timestamp strictly greater than the previous one.
 *
 * @example
 * ```typescript
 * const clock = new HybridLogicalClock('node-1')
 * const ts1 = clock.now()
 * const ts2 = clock.now()
 * // HybridLogicalClock.compare(ts1, ts2) < 0 (ts1 is earlier)
 * ```
 */
export class HybridLogicalClock {
	private wallTime = 0
	private logical = 0

	constructor(
		private readonly nodeId: string,
		private readonly timeSource: TimeSource = systemTimeSource,
		private readonly onDriftWarning?: (driftMs: number) => void,
	) {}

	/**
	 * Generate a new timestamp for a local event.
	 * Guarantees monotonicity: each call returns a timestamp strictly greater than the previous.
	 *
	 * @throws {ClockDriftError} If physical time is more than 5 minutes behind the HLC wallTime
	 */
	now(): HLCTimestamp {
		const physicalTime = this.timeSource.now()
		this.checkDrift(physicalTime)

		if (physicalTime > this.wallTime) {
			this.wallTime = physicalTime
			this.logical = 0
		} else {
			this.logical++
		}

		return { wallTime: this.wallTime, logical: this.logical, nodeId: this.nodeId }
	}

	/**
	 * Update clock on receiving a remote timestamp.
	 * Merges the remote clock state with the local state to maintain causal ordering.
	 *
	 * @throws {ClockDriftError} If physical time is more than 5 minutes behind the resulting wallTime
	 */
	receive(remote: HLCTimestamp): HLCTimestamp {
		const physicalTime = this.timeSource.now()

		if (physicalTime > this.wallTime && physicalTime > remote.wallTime) {
			this.wallTime = physicalTime
			this.logical = 0
		} else if (remote.wallTime > this.wallTime) {
			this.wallTime = remote.wallTime
			this.logical = remote.logical + 1
		} else if (this.wallTime === remote.wallTime) {
			this.logical = Math.max(this.logical, remote.logical) + 1
		} else {
			// this.wallTime > remote.wallTime && this.wallTime >= physicalTime
			this.logical++
		}

		this.checkDrift(physicalTime)

		return { wallTime: this.wallTime, logical: this.logical, nodeId: this.nodeId }
	}

	/**
	 * Compare two timestamps. Returns negative if a < b, positive if a > b, zero if equal.
	 * Total order: wallTime first, then logical, then nodeId (lexicographic).
	 */
	static compare(a: HLCTimestamp, b: HLCTimestamp): number {
		if (a.wallTime !== b.wallTime) return a.wallTime - b.wallTime
		if (a.logical !== b.logical) return a.logical - b.logical
		if (a.nodeId < b.nodeId) return -1
		if (a.nodeId > b.nodeId) return 1
		return 0
	}

	/**
	 * Serialize an HLC timestamp to a string that sorts lexicographically.
	 * Format: zero-padded wallTime:logical:nodeId
	 */
	static serialize(ts: HLCTimestamp): string {
		const wall = ts.wallTime.toString().padStart(15, '0')
		const log = ts.logical.toString().padStart(5, '0')
		return `${wall}:${log}:${ts.nodeId}`
	}

	/**
	 * Deserialize an HLC timestamp from its serialized string form.
	 */
	static deserialize(s: string): HLCTimestamp {
		const parts = s.split(':')
		if (parts.length < 3) {
			throw new Error(`Invalid HLC timestamp string: "${s}"`)
		}
		return {
			wallTime: Number.parseInt(parts[0] ?? '0', 10),
			logical: Number.parseInt(parts[1] ?? '0', 10),
			// nodeId may contain colons, so rejoin remaining parts
			nodeId: parts.slice(2).join(':'),
		}
	}

	private checkDrift(physicalTime: number): void {
		const drift = this.wallTime - physicalTime
		if (drift > DRIFT_ERROR_MS) {
			throw new ClockDriftError(this.wallTime, physicalTime)
		}
		if (drift > DRIFT_WARN_MS) {
			this.onDriftWarning?.(drift)
		}
	}
}
