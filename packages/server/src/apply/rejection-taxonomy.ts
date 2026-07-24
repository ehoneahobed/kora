/**
 * Shared vocabulary for why the server refused an operation.
 *
 * The `retriable` flag answers one question for the caller: is it worth
 * submitting this SAME operation again later?
 *
 *  - `true`  — the rejection is transient (for example a rate limit). The
 *              identical operation may succeed once the condition clears, so a
 *              client is right to back off and retry the same bytes.
 *  - `false` — the rejection is permanent for the operation as written (a
 *              constraint violation, a referential conflict, a malformed
 *              mutation, a scope violation). Resubmitting the same bytes will
 *              always fail; the caller must change the operation or give up.
 *
 * This is deliberately defined once, in one place, so the trusted server
 * data-plane (route context / `server.kora`) and the untrusted client-ingestion
 * path speak the same language. `retriable` (this spelling) matches the wire
 * `ErrorMessage.retriable` field the sync protocol already ships, so a single
 * flag flows from the pipeline out to connected clients unchanged.
 */
export interface OperationRejection {
	/** Stable, machine-readable reason code (for example `CONSTRAINT_VIOLATION`). */
	code: string
	/** Human-readable explanation with enough context to debug without reproduction. */
	message: string
	/** Whether resubmitting the identical operation may later succeed. */
	retriable: boolean
}

/**
 * Reason codes whose underlying condition is transient, so the identical
 * operation may succeed on a later attempt.
 *
 * Everything NOT listed here is treated as permanent. Permanent is the safe
 * default: a client should never be told to keep hammering a genuinely invalid
 * operation, so a new code is non-retriable until it is deliberately added here.
 *
 * `RATE_LIMIT` is the code the session emits when a client exceeds its
 * per-minute operation budget (see `client-session.ts`).
 */
export const RETRIABLE_REJECTION_CODES: ReadonlySet<string> = new Set(['RATE_LIMIT'])

/**
 * Classify a reason code as retriable (transient) or not (permanent).
 *
 * @param code - A rejection reason code.
 * @returns `true` when resubmitting the identical operation may later succeed.
 */
export function isRetriableRejection(code: string): boolean {
	return RETRIABLE_REJECTION_CODES.has(code)
}
