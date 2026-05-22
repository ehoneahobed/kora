import type { Operation } from '@korajs/core'

/** Max allowed future skew for operation timestamps at server ingest (1 minute). */
export const SERVER_MAX_TIMESTAMP_FUTURE_MS = 60_000

/**
 * Returns false when an operation's HLC wallTime is unreasonably far in the future.
 */
export function isOperationTimestampValid(op: Operation, now: number = Date.now()): boolean {
	return op.timestamp.wallTime <= now + SERVER_MAX_TIMESTAMP_FUTURE_MS
}
