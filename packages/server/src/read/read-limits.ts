/**
 * Limits of the read-through endpoint (first-visit parity S2, design section 5.12).
 *
 * Every limit answers 413 or 429 with a retry hint, and the client falls back to waiting for
 * replication, so a limit costs speed, never data.
 */

/** Options of the read-through endpoint (`KoraSyncServerConfig.readThrough`). */
export interface ReadThroughOptions {
	/** Turn the endpoint off (it answers 404, like a server without it). Default true. */
	enabled?: boolean
	/** Rows returned per query before the answer is `partial` with a cursor. Default 500. */
	maxRows?: number
	/** Response bytes before the remaining rows are deferred to a cursor. Default 1 MiB. */
	maxBytes?: number
	/** Scoped rows read per query; past it the answer is `partial`. Default 10,000. */
	maxCandidates?: number
	/** Rows one query may page through with a cursor. Default 5,000. */
	maxQueryRows?: number
	/** Largest request body in bytes. Default 512 KiB. */
	maxRequestBytes?: number
	/**
	 * Work one request may cause, counted in store rows loaded, field-version reads and
	 * encrypted-record checks together, across all its queries and includes. Past it the
	 * remaining queries answer `unsupported` (reason `work-budget`). Default 30,000.
	 */
	maxWork?: number
	/**
	 * The guard in front of the auth provider (see `ReadAuthGuard`). `ttlMs`: how long an
	 * authentication is remembered, default 5,000 (0 turns the cache off); this is also the
	 * longest a revoked credential keeps reading when the revocation is not announced.
	 * `maxConcurrent`, `perSecond`, `burst`: the global cap on provider calls for tokens not
	 * seen before; defaults 16, 100, 100. Past it a first request is refused 429
	 * `AUTH_BUSY`. `timeoutMs` (default 8,000): the deadline of one provider call, after which
	 * the read answers 503 and the slot is freed. `orphanTtlMs` (default 60,000): how long an
	 * abandoned call that never answers counts against the cap of twice `maxConcurrent`. A user with a live cache entry is not
	 * affected by the cap; one without (a first visit) can be, under a flood of garbage tokens.
	 */
	authGuard?: {
		ttlMs?: number
		maxConcurrent?: number
		perSecond?: number
		burst?: number
		timeoutMs?: number
		orphanTtlMs?: number
	}
	/**
	 * Key that signs paging cursors, so a client cannot forge one to lift `maxQueryRows`. The
	 * default is random per process: a cursor then only continues on the instance that issued
	 * it, so set the same secret on every instance behind a load balancer.
	 */
	cursorSecret?: string
	/** Rate limits. */
	rate?: {
		/** Requests per second per principal (token bucket). Default 20. */
		perSecond?: number
		/** Bucket size: requests allowed in a burst. Default: `perSecond`. */
		burst?: number
		/** Reads in flight per principal. Default 4. */
		concurrent?: number
		/** Reads in flight on the whole server. Default 64. */
		maxConcurrent?: number
		/**
		 * Reads that carry no identity (a server without an auth provider, or an anonymous
		 * principal). They share one bucket per client address, and behind a proxy without
		 * `trustProxy` that address is the proxy's, so the bucket is sized for a whole
		 * deployment: defaults 200 per second, burst 200, 16 in flight.
		 */
		anonymous?: { perSecond?: number; burst?: number; concurrent?: number }
	}
}

/** The resolved limits. */
export interface ReadLimits {
	maxRows: number
	maxBytes: number
	maxCandidates: number
	maxQueryRows: number
	maxRequestBytes: number
	maxWork: number
	perSecond: number
	burst: number
	concurrent: number
	maxConcurrent: number
	anonymousPerSecond: number
	anonymousBurst: number
	anonymousConcurrent: number
	authTtlMs: number
	authMaxConcurrent: number
	authPerSecond: number
	authBurst: number
	authTimeoutMs: number
	authOrphanTtlMs: number
}

/** Queries one request may carry. */
export const MAX_READ_QUERIES = 8
/** `known` ids one query may carry. */
export const MAX_READ_KNOWN = 1_000
/** Relations one query may include. */
export const MAX_READ_INCLUDES = 3
/** `orderBy` keys one query may carry. */
export const MAX_READ_ORDER_KEYS = 4
/** `where` fields one query may carry. */
export const MAX_READ_WHERE_FIELDS = 16
/**
 * Store queries one read-through query may fan out into (a scope with a long `$in` list reads
 * one equality query per value). Past it the query is `unsupported`: replication answers it.
 */
export const MAX_READ_PUSHDOWN_QUERIES = 256

const DEFAULTS: ReadLimits = {
	maxRows: 500,
	maxBytes: 1024 * 1024,
	maxCandidates: 10_000,
	maxQueryRows: 5_000,
	maxRequestBytes: 512 * 1024,
	maxWork: 30_000,
	perSecond: 20,
	burst: 20,
	concurrent: 4,
	maxConcurrent: 64,
	anonymousPerSecond: 200,
	anonymousBurst: 200,
	anonymousConcurrent: 16,
	authTtlMs: 5_000,
	authMaxConcurrent: 16,
	authPerSecond: 100,
	authBurst: 100,
	authTimeoutMs: 8_000,
	authOrphanTtlMs: 60_000,
}

/**
 * Resolve the options to limits, refusing nonsense (a limit that is not a positive integer).
 *
 * @throws {RangeError} On a limit that is not a positive safe integer
 */
export function resolveReadLimits(options: ReadThroughOptions | undefined): ReadLimits {
	const rate = options?.rate
	const perSecond = rate?.perSecond ?? DEFAULTS.perSecond
	const limits: ReadLimits = {
		maxRows: options?.maxRows ?? DEFAULTS.maxRows,
		maxBytes: options?.maxBytes ?? DEFAULTS.maxBytes,
		maxCandidates: options?.maxCandidates ?? DEFAULTS.maxCandidates,
		maxQueryRows: options?.maxQueryRows ?? DEFAULTS.maxQueryRows,
		maxRequestBytes: options?.maxRequestBytes ?? DEFAULTS.maxRequestBytes,
		maxWork: options?.maxWork ?? DEFAULTS.maxWork,
		perSecond,
		burst: rate?.burst ?? perSecond,
		concurrent: rate?.concurrent ?? DEFAULTS.concurrent,
		maxConcurrent: rate?.maxConcurrent ?? DEFAULTS.maxConcurrent,
		anonymousPerSecond: rate?.anonymous?.perSecond ?? DEFAULTS.anonymousPerSecond,
		anonymousBurst: rate?.anonymous?.burst ?? rate?.anonymous?.perSecond ?? DEFAULTS.anonymousBurst,
		anonymousConcurrent: rate?.anonymous?.concurrent ?? DEFAULTS.anonymousConcurrent,
		authTtlMs: options?.authGuard?.ttlMs ?? DEFAULTS.authTtlMs,
		authMaxConcurrent: options?.authGuard?.maxConcurrent ?? DEFAULTS.authMaxConcurrent,
		authPerSecond: options?.authGuard?.perSecond ?? DEFAULTS.authPerSecond,
		authBurst: options?.authGuard?.burst ?? options?.authGuard?.perSecond ?? DEFAULTS.authBurst,
		authTimeoutMs: options?.authGuard?.timeoutMs ?? DEFAULTS.authTimeoutMs,
		authOrphanTtlMs: options?.authGuard?.orphanTtlMs ?? DEFAULTS.authOrphanTtlMs,
	}
	for (const [name, value] of Object.entries(limits)) {
		// The auth cache may be switched off with a zero lifetime.
		if (name === 'authTtlMs' && value === 0) continue
		if (!Number.isSafeInteger(value) || value < 1) {
			throw new RangeError(
				`readThrough limit "${name}" must be a positive integer, got ${String(value)}.`,
			)
		}
	}
	return limits
}

/** What the limiter decided. */
export type ReadAdmission =
	| { admitted: true; release: () => void }
	| { admitted: false; reason: 'rate' | 'concurrent' | 'busy'; retryAfterMs: number }

interface Bucket {
	tokens: number
	updatedAtMs: number
	inFlight: number
	lastUsedAtMs: number
}

/** The most principals tracked at once; the least recently used are dropped past it. */
const MAX_TRACKED_PRINCIPALS = 10_000

/**
 * Admits reads: a token bucket per principal (requests per second, with a burst), a cap on
 * reads in flight per principal, and one on the whole server. The clock is injected so the
 * tests need no real time.
 */
export class ReadLimiter {
	private readonly buckets = new Map<string, Bucket>()
	private inFlightTotal = 0

	constructor(
		private readonly limits: Pick<
			ReadLimits,
			'perSecond' | 'burst' | 'concurrent' | 'maxConcurrent'
		>,
		private readonly now: () => number = Date.now,
	) {}

	/**
	 * Admit one read for a principal, or say when to try again. An admitted read must be
	 * released when it ends (success or failure).
	 *
	 * @param key - The principal (or, for an anonymous one, its address)
	 */
	admit(key: string): ReadAdmission {
		const now = this.now()
		if (this.inFlightTotal >= this.limits.maxConcurrent) {
			return { admitted: false, reason: 'busy', retryAfterMs: 250 }
		}
		const bucket = this.bucketFor(key, now)
		if (bucket.inFlight >= this.limits.concurrent) {
			return { admitted: false, reason: 'concurrent', retryAfterMs: 100 }
		}
		if (bucket.tokens < 1) {
			const missing = 1 - bucket.tokens
			return {
				admitted: false,
				reason: 'rate',
				retryAfterMs: Math.ceil((missing / this.limits.perSecond) * 1000),
			}
		}
		bucket.tokens -= 1
		bucket.inFlight += 1
		this.inFlightTotal += 1
		let released = false
		return {
			admitted: true,
			release: () => {
				if (released) return
				released = true
				bucket.inFlight = Math.max(0, bucket.inFlight - 1)
				this.inFlightTotal = Math.max(0, this.inFlightTotal - 1)
			},
		}
	}

	/**
	 * True when `key` has a token left, without taking it. Lets a caller refuse work for a
	 * key that is already over its rate before doing the work.
	 *
	 * @param key - The principal (or address)
	 */
	peek(key: string): boolean {
		const bucket = this.buckets.get(key)
		if (bucket === undefined) return true
		const elapsed = Math.max(0, this.now() - bucket.updatedAtMs)
		return (
			Math.min(this.limits.burst, bucket.tokens + (elapsed / 1000) * this.limits.perSecond) >= 1
		)
	}

	/**
	 * True when `key` has spent tokens recently (its bucket is below full). The auth guard
	 * uses it to tell an address that has been failing from one that has not.
	 *
	 * @param key - The principal (or address)
	 */
	hasSpent(key: string): boolean {
		const bucket = this.buckets.get(key)
		if (bucket === undefined) return false
		const elapsed = Math.max(0, this.now() - bucket.updatedAtMs)
		return (
			Math.min(this.limits.burst, bucket.tokens + (elapsed / 1000) * this.limits.perSecond) <
			this.limits.burst
		)
	}

	/** Principals tracked now (for tests and diagnostics). */
	get size(): number {
		return this.buckets.size
	}

	private bucketFor(key: string, now: number): Bucket {
		let bucket = this.buckets.get(key)
		if (bucket === undefined) {
			if (this.buckets.size >= MAX_TRACKED_PRINCIPALS) this.evict()
			bucket = { tokens: this.limits.burst, updatedAtMs: now, inFlight: 0, lastUsedAtMs: now }
			this.buckets.set(key, bucket)
		} else {
			const elapsed = Math.max(0, now - bucket.updatedAtMs)
			bucket.tokens = Math.min(
				this.limits.burst,
				bucket.tokens + (elapsed / 1000) * this.limits.perSecond,
			)
			bucket.updatedAtMs = now
			bucket.lastUsedAtMs = now
			// Insertion order doubles as LRU order.
			this.buckets.delete(key)
			this.buckets.set(key, bucket)
		}
		return bucket
	}

	/** Drop the least recently used principals that have nothing in flight. */
	private evict(): void {
		let dropped = 0
		for (const [key, bucket] of this.buckets) {
			if (bucket.inFlight === 0) {
				this.buckets.delete(key)
				dropped += 1
			}
			if (dropped >= MAX_TRACKED_PRINCIPALS / 10) break
		}
	}
}
