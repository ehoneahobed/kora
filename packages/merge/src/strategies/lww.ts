import { HybridLogicalClock } from '@kora/core'
import type { HLCTimestamp } from '@kora/core'

/**
 * Result of a Last-Write-Wins comparison.
 */
export interface LWWResult {
	/** The winning value */
	value: unknown
	/** Which side won */
	winner: 'local' | 'remote'
}

/**
 * Last-Write-Wins merge strategy using HLC timestamps.
 *
 * Compares two values by their HLC timestamps and returns the value with the
 * later timestamp. The HLC total order guarantees a deterministic winner even
 * when wall-clock times and logical counters are identical (nodeId tiebreaker).
 *
 * @param localValue - The local field value
 * @param remoteValue - The remote field value
 * @param localTimestamp - HLC timestamp of the local operation
 * @param remoteTimestamp - HLC timestamp of the remote operation
 * @returns The winning value and which side won
 */
export function lastWriteWins(
	localValue: unknown,
	remoteValue: unknown,
	localTimestamp: HLCTimestamp,
	remoteTimestamp: HLCTimestamp,
): LWWResult {
	const comparison = HybridLogicalClock.compare(localTimestamp, remoteTimestamp)
	// HLC total order guarantees comparison is never 0 for different nodeIds.
	// If comparison >= 0, local wins (local is later or same node).
	if (comparison >= 0) {
		return { value: localValue, winner: 'local' }
	}
	return { value: remoteValue, winner: 'remote' }
}
