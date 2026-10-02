import type { Operation } from '@korajs/core'

/** Default maximum serialized size of a single operation at server ingest (256 KiB). */
export const DEFAULT_MAX_OPERATION_BYTES = 256 * 1024

/** Default maximum operations accepted per client session per minute. */
export const DEFAULT_MAX_OPS_PER_MINUTE = 600

/** Default blob chunk requests accepted per client session per minute (RT-24). */
export const DEFAULT_MAX_BLOB_REQUESTS_PER_MINUTE = 6000

/** Default largest operation batch a session accepts in one message. */
export const DEFAULT_MAX_OPS_PER_BATCH = 1000

/**
 * Approximate UTF-8 byte length of an operation payload for rate/size guards.
 */
export function measureOperationBytes(op: Operation): number {
	return Buffer.byteLength(JSON.stringify(op), 'utf8')
}

export interface OperationSizeValidation {
	valid: boolean
	bytes: number
	message?: string
}

/**
 * Returns false when an operation exceeds the configured byte limit.
 */
export function validateOperationSize(
	op: Operation,
	maxBytes: number = DEFAULT_MAX_OPERATION_BYTES,
): OperationSizeValidation {
	const bytes = measureOperationBytes(op)
	if (bytes <= maxBytes) {
		return { valid: true, bytes }
	}
	return {
		valid: false,
		bytes,
		message: `Operation "${op.id}" exceeds max size (${String(bytes)} > ${String(maxBytes)} bytes)`,
	}
}

/**
 * Simple sliding-window rate limiter for per-session operation ingest.
 */
export class SessionRateLimiter {
	private windowStartMs = Date.now()
	private count = 0

	/**
	 * @param maxOpsPerMinute - Units allowed per window
	 * @param windowMs - Window length (one minute; shorter only in tests)
	 */
	constructor(
		private readonly maxOpsPerMinute: number = DEFAULT_MAX_OPS_PER_MINUTE,
		private readonly windowMs: number = 60_000,
	) {}

	get limit(): number {
		return this.maxOpsPerMinute
	}

	/** Record N operations and return false when the limit is exceeded. */
	allow(count = 1): boolean {
		const now = Date.now()
		if (now - this.windowStartMs >= this.windowMs) {
			this.windowStartMs = now
			this.count = 0
		}
		this.count += count
		return this.count <= this.maxOpsPerMinute
	}

	/** Milliseconds until the current window resets (when a refused unit may retry). */
	retryAfterMs(): number {
		return Math.max(0, this.windowStartMs + this.windowMs - Date.now())
	}

	reset(): void {
		this.windowStartMs = Date.now()
		this.count = 0
	}
}
