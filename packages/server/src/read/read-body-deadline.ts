/** The longest a read request may take to deliver its body. */
export const READ_BODY_TIMEOUT_MS = 10_000

/** Time allowed before the first byte, on top of 1 KiB per second of the declared size. */
export const READ_BODY_GRACE_MS = 2_000

/**
 * How long a read body may take to arrive: a grace period plus one second per declared KiB
 * (a minimum rate of 1 KiB/s), never more than {@link READ_BODY_TIMEOUT_MS}. A sender that
 * declares a small body and stalls therefore holds its body slot for seconds, not for the
 * full deadline. An absent or invalid `Content-Length` (chunked) gets the full deadline.
 *
 * @param contentLength - The parsed `Content-Length` header, if any
 * @returns Milliseconds
 */
export function readBodyDeadlineMs(contentLength: number): number {
	if (!Number.isFinite(contentLength) || contentLength < 0) return READ_BODY_TIMEOUT_MS
	return Math.min(READ_BODY_TIMEOUT_MS, READ_BODY_GRACE_MS + Math.ceil(contentLength / 1024) * 1000)
}
