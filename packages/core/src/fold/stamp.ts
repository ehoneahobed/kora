import { HybridLogicalClock } from '../clock/hlc'
import type { HLCTimestamp } from '../types'
import type { Stamp } from './types'

/**
 * Total order on stamps: serialized HLC (which sorts exactly like
 * `HybridLogicalClock.compare`), then operation id.
 *
 * @returns Negative if a < b, positive if a > b, 0 if equal
 */
export function compareStamps(a: Stamp, b: Stamp): number {
	if (a.t !== b.t) return a.t < b.t ? -1 : 1
	if (a.o !== b.o) return a.o < b.o ? -1 : 1
	return 0
}

/** The later of two stamps (null counts as "never"). */
export function maxStamp(a: Stamp | null, b: Stamp | null): Stamp | null {
	if (a === null) return b
	if (b === null) return a
	return compareStamps(a, b) >= 0 ? a : b
}

/** The earlier of two stamps (null counts as "never"). */
export function minStamp(a: Stamp | null, b: Stamp | null): Stamp | null {
	if (a === null) return b
	if (b === null) return a
	return compareStamps(a, b) <= 0 ? a : b
}

/** True when `a` is strictly later than `b` (anything is later than null). */
export function isAfter(a: Stamp | null, b: Stamp | null): boolean {
	if (a === null) return false
	if (b === null) return true
	return compareStamps(a, b) > 0
}

/**
 * Build a stamp from an HLC timestamp and an operation id. Throws
 * `InvalidTimestampError` for a timestamp that cannot be serialized (for example
 * a null wallTime left by a beta.12 backup restore): such an op must be repaired
 * by the log-integrity scan (W8) before it is folded, never folded with a guess.
 */
export function stampOf(timestamp: HLCTimestamp, opId: string): Stamp {
	return { t: HybridLogicalClock.serialize(timestamp), o: opId }
}

/** The HLC timestamp a stamp was built from. */
export function stampTimestamp(stamp: Stamp): HLCTimestamp {
	return HybridLogicalClock.deserialize(stamp.t)
}
