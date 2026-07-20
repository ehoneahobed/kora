import { MAX_LOGICAL } from '@korajs/core'
import type { Operation } from '@korajs/core'

/** Max allowed future skew for operation timestamps at server ingest (1 minute). */
export const SERVER_MAX_TIMESTAMP_FUTURE_MS = 60_000

/**
 * Returns false when an operation's HLC timestamp is structurally invalid or
 * unreasonably far in the future.
 *
 * Structural checks matter because operations are content-addressed and
 * immutable: a timestamp with a non-integer/negative field or a logical
 * counter past the 5-digit serialization cap would poison the shared log
 * forever (its serialized form no longer sorts like HybridLogicalClock.compare),
 * so it must never be accepted at ingest.
 */
export function isOperationTimestampValid(op: Operation, now: number = Date.now()): boolean {
	const { wallTime, logical } = op.timestamp
	if (!Number.isInteger(wallTime) || wallTime < 0) {
		return false
	}
	if (!Number.isInteger(logical) || logical < 0 || logical > MAX_LOGICAL) {
		return false
	}
	return wallTime <= now + SERVER_MAX_TIMESTAMP_FUTURE_MS
}
