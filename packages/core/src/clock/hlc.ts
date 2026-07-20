import { ClockDriftError, InvalidTimestampError, RemoteClockDriftError } from '../errors/errors'
import type { HLCTimestamp, TimeSource } from '../types'

/** Default time source using the system clock */
const systemTimeSource: TimeSource = { now: () => Date.now() }

/**
 * Highest logical counter value that fits the 5-digit zero-padded slot in the
 * serialized timestamp form. The serialized string must sort lexicographically
 * in exactly the same order as {@link HybridLogicalClock.compare}; a 6-digit
 * logical value would shift the padding and silently break that invariant for
 * every stored `_version` column and operation timestamp. When the counter
 * would exceed this cap, the clock carries into wallTime instead
 * (wallTime + 1, logical = 0), which preserves both monotonicity and the
 * serialized ordering.
 */
export const MAX_LOGICAL = 99_999

/** Number of distinct logical values; the modulus used when carrying into wallTime. */
const LOGICAL_MODULUS = MAX_LOGICAL + 1

/**
 * Exclusive upper bound on serializable wallTime: the serialized form
 * zero-pads wallTime to 15 digits, so a 16-digit value would break the
 * lexicographic ordering. 10^15 ms is roughly the year 33658 — unreachable by
 * honest clocks, only by hand-built timestamps.
 */
const WALL_TIME_LIMIT = 10 ** 15

/** Maximum allowed drift before warning (60 seconds) */
const DRIFT_WARN_MS = 60_000

/** Drift beyond which the error-severity callback fires (5 minutes) */
const DRIFT_ERROR_MS = 5 * 60_000

/** Maximum future skew accepted from a remote timestamp before it is rejected (5 minutes) */
const MAX_REMOTE_FUTURE_MS = 5 * 60_000

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
	private referenceOffsetMs: number | null = null

	constructor(
		private readonly nodeId: string,
		private readonly timeSource: TimeSource = systemTimeSource,
		private readonly onDriftWarning?: (driftMs: number) => void,
		private readonly onDriftError?: (driftMs: number) => void,
	) {}

	/**
	 * Records the known offset between an external time reference (usually the
	 * sync server, learned at handshake) and this device's physical clock:
	 * `referenceTime - localPhysicalTime`. Once set, drift evaluation and remote
	 * timestamp validation are performed against reference-corrected time, so a
	 * device with a wrong local clock still validates remote timestamps correctly.
	 */
	setReferenceOffset(offsetMs: number): void {
		this.referenceOffsetMs = offsetMs
	}

	getReferenceOffset(): number | null {
		return this.referenceOffsetMs
	}

	/** Physical time corrected by the known reference offset, when available. */
	private effectiveTime(physicalTime: number): number {
		return physicalTime + (this.referenceOffsetMs ?? 0)
	}

	/**
	 * Generate a new timestamp for a local event.
	 * Guarantees monotonicity: each call returns a timestamp strictly greater than the previous.
	 *
	 * Never throws and never blocks a local write: if the physical clock has
	 * fallen behind the HLC (e.g. the user corrected a fast clock), the HLC
	 * freezes wallTime and advances the logical counter, and drift is reported
	 * through the onDriftWarning / onDriftError callbacks instead.
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
		this.carryLogicalOverflow()

		return { wallTime: this.wallTime, logical: this.logical, nodeId: this.nodeId }
	}

	/**
	 * Update clock on receiving a remote timestamp.
	 * Merges the remote clock state with the local state to maintain causal ordering.
	 *
	 * @throws {InvalidTimestampError} If the remote timestamp has non-integer or
	 * negative wallTime/logical, or logical beyond {@link MAX_LOGICAL}. Checked
	 * BEFORE any state change, so malformed input cannot corrupt this clock.
	 * @throws {RemoteClockDriftError} If the remote timestamp is more than 5 minutes
	 * ahead of reference-corrected local time. Validation happens BEFORE any state
	 * is adopted, so a rejected timestamp cannot poison this clock. When no
	 * reference offset is known and this clock is uninitialized (cold start with
	 * a possibly-wrong local clock), validation is skipped, matching the previous
	 * cold-start behavior but now without a corrupting failure mode afterward.
	 */
	receive(remote: HLCTimestamp): HLCTimestamp {
		const physicalTime = this.timeSource.now()
		const wasColdStart = this.wallTime === 0

		// Validate before adopting anything. Malformed fields would corrupt the
		// clock's arithmetic (NaN/fractional wallTime) or overflow the serialized
		// form's 5-digit logical slot, so they are rejected outright.
		if (
			!Number.isInteger(remote.wallTime) ||
			remote.wallTime < 0 ||
			!Number.isInteger(remote.logical) ||
			remote.logical < 0 ||
			remote.logical > MAX_LOGICAL
		) {
			throw new InvalidTimestampError(
				`Rejected remote HLC timestamp with invalid fields (wallTime=${remote.wallTime}, logical=${remote.logical}). wallTime and logical must be non-negative integers and logical must not exceed ${MAX_LOGICAL}.`,
				remote.wallTime,
				remote.logical,
			)
		}

		// A far-future remote timestamp must never become this clock's state.
		const canValidate = this.referenceOffsetMs !== null || !wasColdStart
		if (canValidate) {
			const reference = this.effectiveTime(physicalTime)
			if (remote.wallTime > reference + MAX_REMOTE_FUTURE_MS) {
				throw new RemoteClockDriftError(remote.wallTime, reference)
			}
		}

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
		this.carryLogicalOverflow()

		// Report (never throw) drift after merging. Cold start is exempt from
		// reporting to avoid false positives when the local clock is simply wrong.
		if (!wasColdStart) {
			this.checkDrift(physicalTime)
		}

		return { wallTime: this.wallTime, logical: this.logical, nodeId: this.nodeId }
	}

	/**
	 * Advance this clock to at least the given timestamp.
	 *
	 * Used after a timestamp rebase rewrites unsynced operations: future `now()`
	 * timestamps must sort after every rebased operation, otherwise a write issued
	 * immediately after the rebase could interleave with (or precede) rebased ops
	 * and break the log's total order. Never moves the clock backward — a
	 * timestamp at or before the current state is a no-op, preserving the
	 * monotonicity guarantee of `now()`.
	 *
	 * Inputs with logical > MAX_LOGICAL are normalized deterministically by
	 * carrying the excess into wallTime, so the adopted state always leaves room
	 * for the next increment inside the serializable range.
	 */
	advanceTo(ts: HLCTimestamp): void {
		// Deterministic normalization: adopting given values verbatim could plant
		// an unserializable logical counter inside the clock.
		const normalized: HLCTimestamp = {
			wallTime: ts.wallTime + Math.floor(ts.logical / LOGICAL_MODULUS),
			logical: ts.logical % LOGICAL_MODULUS,
			nodeId: ts.nodeId,
		}
		const current: HLCTimestamp = {
			wallTime: this.wallTime,
			logical: this.logical,
			nodeId: this.nodeId,
		}
		if (HybridLogicalClock.compare(normalized, current) > 0) {
			this.wallTime = normalized.wallTime
			this.logical = normalized.logical
		}
	}

	/**
	 * Carry the logical counter into wallTime when an increment pushed it past
	 * MAX_LOGICAL. Bumping wallTime by 1ms keeps the timestamp strictly greater
	 * than everything issued before (monotonicity) while keeping the logical
	 * counter inside the 5-digit slot the serialized form depends on.
	 */
	private carryLogicalOverflow(): void {
		if (this.logical > MAX_LOGICAL) {
			this.wallTime += 1
			this.logical = 0
		}
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
	 *
	 * @throws {InvalidTimestampError} If wallTime does not fit 15 digits or
	 * logical does not fit 5 digits (or either is negative/non-integer). Such a
	 * value would overflow its zero-padded slot and the serialized string would
	 * no longer sort in the same order as {@link HybridLogicalClock.compare} —
	 * silently corrupting every LWW comparison on stored `_version` columns.
	 * Internal clocks can no longer produce such values (the logical counter
	 * carries into wallTime); this guards against hand-built timestamps.
	 */
	static serialize(ts: HLCTimestamp): string {
		if (
			!Number.isInteger(ts.wallTime) ||
			ts.wallTime < 0 ||
			ts.wallTime >= WALL_TIME_LIMIT ||
			!Number.isInteger(ts.logical) ||
			ts.logical < 0 ||
			ts.logical > MAX_LOGICAL
		) {
			throw new InvalidTimestampError(
				`Cannot serialize HLC timestamp (wallTime=${ts.wallTime}, logical=${ts.logical}): wallTime must be an integer in [0, 10^15) and logical an integer in [0, ${MAX_LOGICAL}]. Values outside these ranges overflow the zero-padded serialized form, which must sort lexicographically identically to HybridLogicalClock.compare.`,
				ts.wallTime,
				ts.logical,
			)
		}
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

	/**
	 * Reports drift between the HLC and (reference-corrected) physical time.
	 * Reporting only: local timestamp generation is never blocked, because the
	 * user's data always outranks the quality of its timestamps.
	 */
	private checkDrift(physicalTime: number): void {
		const drift = this.wallTime - this.effectiveTime(physicalTime)
		if (drift > DRIFT_ERROR_MS) {
			this.onDriftError?.(drift)
			return
		}
		if (drift > DRIFT_WARN_MS) {
			this.onDriftWarning?.(drift)
		}
	}
}
