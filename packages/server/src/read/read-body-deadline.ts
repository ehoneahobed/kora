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

/**
 * The smallest ceiling for a custom route body (auth, webhooks, app APIs): what the default
 * ceiling never goes below, and what a body without a length gets when no limit applies.
 */
export const ROUTE_BODY_TIMEOUT_MS = 30_000

/** The rate the default ceiling lets the largest allowed body arrive at: about a 2G link. */
export const ROUTE_BODY_SLOW_LINK_BYTES_PER_SECOND = 16 * 1024

/**
 * The default ceiling for custom route bodies: long enough for a body of `maxRequestBodyBytes`
 * to arrive at {@link ROUTE_BODY_SLOW_LINK_BYTES_PER_SECOND} after the grace period, and never
 * below {@link ROUTE_BODY_TIMEOUT_MS}. A flat ceiling made a body near the limit need a faster
 * link than offline-first apps can count on (1 MiB in 30 s is ~35 KB/s), and a larger limit worse.
 *
 * @param maxRequestBodyBytes - The server's body limit
 * @returns Milliseconds
 */
export function routeBodyCeilingMs(maxRequestBodyBytes: number): number {
	return Math.max(
		ROUTE_BODY_TIMEOUT_MS,
		READ_BODY_GRACE_MS +
			Math.ceil(maxRequestBodyBytes / ROUTE_BODY_SLOW_LINK_BYTES_PER_SECOND) * 1000,
	)
}

/**
 * {@link readBodyDeadlineMs} for custom route bodies: the same grace and minimum rate (a body
 * declaring little that stalls is cut off in seconds), never more than `ceilingMs`. A body
 * without a valid `Content-Length` (chunked) gets the ceiling.
 *
 * @param contentLength - The parsed `Content-Length` header, if any
 * @param ceilingMs - The longest any body may take (`routeBodyTimeoutMs`, or {@link routeBodyCeilingMs})
 * @returns Milliseconds
 */
export function routeBodyDeadlineMs(
	contentLength: number,
	ceilingMs: number = ROUTE_BODY_TIMEOUT_MS,
): number {
	if (!Number.isFinite(contentLength) || contentLength < 0) return ceilingMs
	return Math.min(ceilingMs, READ_BODY_GRACE_MS + Math.ceil(contentLength / 1024) * 1000)
}
