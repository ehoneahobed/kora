import { DEFAULT_MAX_OPERATION_BYTES as CORE_DEFAULT_MAX_OPERATION_BYTES } from '@korajs/core'
import { measureOperationBytes as measureCoreOperationBytes } from '@korajs/core'
import type { Operation } from '@korajs/core'

/**
 * Default maximum serialized size of a single operation at server ingest (256 KiB). The
 * same value the local write path enforces by default (core value domain, RT-86).
 */
export const DEFAULT_MAX_OPERATION_BYTES = CORE_DEFAULT_MAX_OPERATION_BYTES

/** Default maximum operations accepted per client session per minute. */
export const DEFAULT_MAX_OPS_PER_MINUTE = 600

/** Default blob chunk requests accepted per client session per minute (RT-24). */
export const DEFAULT_MAX_BLOB_REQUESTS_PER_MINUTE = 6000

/**
 * Rate-limit units one uploaded batch costs for the server's stored-id lookup (RT-39).
 * Operations the lookup finds already stored are acknowledged without further charge,
 * so a device re-uploading its history pays per batch, not per operation; the unit is
 * credited against the batch's first operation that is charged, so a batch of new
 * operations costs exactly one unit per operation.
 */
export const BATCH_LOOKUP_RATE_COST = 1

/** Default largest operation batch a session accepts in one message. */
export const DEFAULT_MAX_OPS_PER_BATCH = 1000

/**
 * UTF-8 byte length of an operation's JSON, for size guards. The core definition, so the
 * local write path and the server measure an operation identically (RT-86).
 */
export function measureOperationBytes(op: Operation): number {
	return measureCoreOperationBytes(op)
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
 * Default per-principal ingest budget as a multiple of the per-node budget: a user's
 * devices share it, and one device (bounded by its node budget) never meets it.
 */
export const DEFAULT_USER_BUDGET_MULTIPLIER = 4

/** What a session charges uploaded operations to. */
export interface IngestRateLimiter {
	/** Units allowed per window (the tightest applicable budget). */
	readonly limit: number
	/** Charge `count` units; false when a budget is exceeded (the units are refused). */
	allow(count?: number): boolean
	/** Milliseconds until a refused unit may be retried. */
	retryAfterMs(): number
}

/**
 * Simple sliding-window rate limiter for per-session operation ingest.
 */
export class SessionRateLimiter implements IngestRateLimiter {
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

	/** True when `count` more units fit in the current window (charges nothing). */
	wouldAllow(count = 1): boolean {
		const now = Date.now()
		const used = now - this.windowStartMs >= this.windowMs ? 0 : this.count
		return used + count <= this.maxOpsPerMinute
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

/**
 * A device node's ingest budget combined with its principal's (one user, many nodes).
 * A refusal by the user budget spends none of the node's, and a node over its own
 * budget spends none of the user's, so one runaway node cannot drain its siblings'
 * shared budget beyond its own per-node limit (per-node fairness holds).
 */
export class CombinedRateLimiter implements IngestRateLimiter {
	constructor(
		private readonly node: SessionRateLimiter,
		private readonly user: SessionRateLimiter,
	) {}

	get limit(): number {
		return Math.min(this.node.limit, this.user.limit)
	}

	allow(count = 1): boolean {
		if (!this.user.wouldAllow(count)) {
			// Refused by the shared budget: the node keeps its units for later.
			return false
		}
		if (!this.node.allow(count)) return false
		return this.user.allow(count)
	}

	retryAfterMs(): number {
		const blockers = [this.node, this.user].filter((limiter) => !limiter.wouldAllow(1))
		if (blockers.length === 0) return 0
		return Math.max(...blockers.map((limiter) => limiter.retryAfterMs()))
	}
}
