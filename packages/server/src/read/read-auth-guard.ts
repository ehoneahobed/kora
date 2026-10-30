import { createHmac, randomBytes } from 'node:crypto'
import { KoraError } from '@korajs/core'
import type { AuthContext } from '../types'

/**
 * A guard in front of the auth provider for the read endpoint.
 *
 * A read is a plain HTTP request, so every one carries a bearer token the provider must
 * check, and a provider call can be costly (a database lookup, a JWKS fetch). Charging a
 * rate limit to the caller's ADDRESS before that is a denial of service in itself (behind a
 * proxy every user has the proxy's address, and an expired tab counts as a failure), so the
 * guard bounds provider calls by the TOKEN instead:
 *
 * - a positive cache, keyed by an HMAC fingerprint of the token (the token itself is never
 *   stored), lives a few seconds and never past the credential's own expiry; a request whose
 *   fingerprint is cached never reaches the provider or the checks that depend on it;
 * - concurrent first requests with one token share ONE provider call (single flight);
 * - a negative cache answers a repeated garbage token without the provider;
 * - provider calls for tokens not seen before (cache misses) are capped globally by a small
 *   concurrency limit and a token bucket, and each call has a deadline, so a hung provider
 *   frees its slot (the late answer is ignored, never cached).
 *
 * What this does NOT promise: a user is safe from the miss cap only within `ttlMs` of their
 * last read. A user with no cache entry (a first visit, a long-idle tab) is a miss like any
 * other, and a flood of distinct garbage tokens from many addresses (or from any address
 * when the host does not trust its proxy headers) can spend the miss budget and make such a
 * cold read answer 429 `AUTH_BUSY` (retriable). Two lanes soften this: an address that
 * failed recently draws from a small share (a quarter) of the budget, so one noisy address
 * cannot spend the whole of it, but a distributed flood in which every address is still
 * clean is not stopped by it. A device that gets `AUTH_BUSY` waits for replication.
 *
 * The lanes add little (a flood of clean addresses, or any flood when the host does not trust
 * its proxy headers, still spends the clean share), and they are not an access control.
 *
 * Revocation lag: a revoked credential keeps reading until its cache entry is evicted. A
 * revocation the server hears about (`terminateSessions`, which the auth provider's feed
 * calls) evicts at once; otherwise the lag is at most `ttlMs`. An eviction also marks every
 * authentication taken before it as stale ({@link ReadAuthGuard.isStale}), so a read that
 * began before it cannot answer from the old grant.
 */
export interface ReadAuthGuardOptions {
	/** How long a successful (and a failed) authentication is remembered. 0 turns the cache off. */
	ttlMs: number
	/** Provider calls for unseen tokens in flight at once. */
	maxConcurrentMisses: number
	/** Provider calls for unseen tokens per second (token bucket). */
	missesPerSecond: number
	/** Burst of the bucket above. */
	missBurst: number
	/** Longest a provider call may take before its slot is released and the call rejected. */
	timeoutMs: number
	/** How long an abandoned call counts against the orphan cap (a promise that never settles). */
	orphanTtlMs?: number
}

/** Which share of the miss budget a call draws from. */
export type GuardLane = 'clean' | 'suspect'

/** Thrown when the auth provider did not answer within the guard's deadline. */
export class ReadAuthTimeoutError extends KoraError {
	constructor(timeoutMs: number) {
		super(`The auth provider did not answer within ${timeoutMs} ms.`, 'READ_AUTH_TIMEOUT', {
			timeoutMs,
			fix: 'Check the auth provider, or raise readThrough.authGuard.timeoutMs.',
		})
		this.name = 'ReadAuthTimeoutError'
	}
}

/**
 * How long a refused token stays refused. Kept short: a token refused and then made valid
 * (a sign-in that completes a moment later) still gets 401 until this passes.
 */
const NEGATIVE_TTL_MS = 2_000

/** How long an abandoned provider call counts against the cap if it never answers. */
const ORPHAN_TTL_MS = 60_000

/** The fraction of the miss budget that addresses with recent failures share. */
const SUSPECT_SHARE = 0.25

interface Lane {
	maxConcurrent: number
	perSecond: number
	burst: number
	inFlight: number
	tokens: number
	tokensAt: number
}

/** The most fingerprints remembered, each way; the oldest go first. */
const MAX_ENTRIES = 10_000

/** What the guard knows about a token without calling the provider. */
export type GuardLookup =
	| { kind: 'context'; context: AuthContext; stamp: number }
	| { kind: 'denied' }
	| { kind: 'unknown' }

/** What the guard decided for a token it did not know. */
export type GuardResolution =
	| { kind: 'context'; context: AuthContext | null; stamp: number }
	| { kind: 'busy'; retryAfterMs: number }
	| { kind: 'unavailable' }

interface Positive {
	context: AuthContext | null
	until: number
}

interface InFlight {
	promise: Promise<AuthContext | null>
	stamp: number
}

/** The guard. The clock is injected so tests need no real time. */
export class ReadAuthGuard {
	private readonly key = randomBytes(32)
	private readonly positive = new Map<string, Positive>()
	private readonly negative = new Map<string, number>()
	private readonly inflight = new Map<string, InFlight>()
	private readonly lanes: Record<GuardLane, Lane>
	private readonly maxOrphaned: number
	/**
	 * Calls that passed their deadline and whose provider has not answered yet, with the time
	 * each stops counting. A promise that never settles must not wedge the cap forever.
	 */
	private readonly orphans = new Map<number, number>()
	private orphanSeq = 0
	/**
	 * Eviction bookkeeping. Every eviction takes the next `clock` value; an authentication
	 * stamped with an earlier value is stale for what the eviction covered: everything
	 * (`globalEvictedAt`), or one user (`userEvictedAt`). When the per-user map is trimmed the
	 * trimmed values are folded into `evictionFloor`, which errs towards stale.
	 */
	private clock = 0
	private globalEvictedAt = 0
	private evictionFloor = 0
	private readonly userEvictedAt = new Map<string, number>()

	constructor(
		private readonly options: ReadAuthGuardOptions,
		private readonly now: () => number = Date.now,
	) {
		// The lanes split the configured budget and never exceed it: a budget too small to split
		// (a quarter of it rounds to nothing) is one shared lane.
		const suspectConcurrent = Math.floor(options.maxConcurrentMisses * SUSPECT_SHARE)
		const suspectBurst = Math.floor(options.missBurst * SUSPECT_SHARE)
		const lane = (concurrent: number, rate: number, burst: number): Lane => ({
			maxConcurrent: concurrent,
			perSecond: rate,
			burst,
			inFlight: 0,
			tokens: burst,
			tokensAt: now(),
		})
		if (suspectConcurrent < 1 || suspectBurst < 1) {
			const shared = lane(options.maxConcurrentMisses, options.missesPerSecond, options.missBurst)
			this.lanes = { suspect: shared, clean: shared }
		} else {
			const suspectRate = options.missesPerSecond * SUSPECT_SHARE
			this.lanes = {
				suspect: lane(suspectConcurrent, suspectRate, suspectBurst),
				clean: lane(
					options.maxConcurrentMisses - suspectConcurrent,
					options.missesPerSecond - suspectRate,
					options.missBurst - suspectBurst,
				),
			}
		}
		this.maxOrphaned = Math.max(1, options.maxConcurrentMisses * 2)
	}

	/** The fingerprint a token is remembered under. */
	fingerprint(token: string): string {
		return createHmac('sha256', this.key).update(token).digest('base64url').slice(0, 24)
	}

	/**
	 * What is already known about a token: a live positive entry (never past the credential's
	 * expiry), a live negative one, or nothing. A context comes with the stamp to give
	 * {@link isStale} later.
	 *
	 * @param token - The bearer token
	 */
	lookup(token: string): GuardLookup {
		const fingerprint = this.fingerprint(token)
		const now = this.now()
		const hit = this.positive.get(fingerprint)
		if (hit !== undefined) {
			if (hit.until > now && hit.context !== null) {
				return { kind: 'context', context: hit.context, stamp: this.clock }
			}
			this.positive.delete(fingerprint)
		}
		const until = this.negative.get(fingerprint)
		if (until !== undefined) {
			if (until > now) return { kind: 'denied' }
			this.negative.delete(fingerprint)
		}
		return { kind: 'unknown' }
	}

	/**
	 * Whether the authentication stamped `stamp` for `userId` was taken before an eviction that
	 * covers that user. A read checks it after building its answer: if it is stale, the answer
	 * may reflect a grant that has since been revoked or narrowed.
	 *
	 * @param stamp - The stamp {@link lookup} or {@link resolve} returned with the context
	 * @param userId - The user the context belongs to
	 */
	isStale(stamp: number, userId: string): boolean {
		if (this.globalEvictedAt > stamp || this.evictionFloor > stamp) return true
		return (this.userEvictedAt.get(userId) ?? 0) > stamp
	}

	/**
	 * Authenticate a token the guard does not know: join a call already in flight for it, or
	 * make one if the miss cap of its lane allows. A provider that throws rejects every waiter
	 * and remembers nothing; one that does not answer within `timeoutMs` frees its slot and
	 * rejects every waiter with {@link ReadAuthTimeoutError}, its signal is aborted and its
	 * late answer is dropped, not cached. Too many such abandoned calls still running answers
	 * `unavailable`, so a hung provider cannot pile up unbounded work.
	 *
	 * @param token - The bearer token
	 * @param call - Asks the auth provider; receives a signal aborted at the deadline
	 * @param lane - The share of the miss budget to draw from
	 */
	async resolve(
		token: string,
		call: (signal: AbortSignal) => Promise<AuthContext | null>,
		lane: GuardLane = 'clean',
	): Promise<GuardResolution> {
		const fingerprint = this.fingerprint(token)
		const joined = this.inflight.get(fingerprint)
		if (joined !== undefined) {
			return { kind: 'context', context: await joined.promise, stamp: joined.stamp }
		}
		if (this.orphanedCalls >= this.maxOrphaned) return { kind: 'unavailable' }
		const share = this.lanes[lane]
		const busy = this.admitMiss(share)
		if (busy !== null) return busy
		share.inFlight += 1
		const stamp = this.clock
		const controller = new AbortController()
		const entry: InFlight = { promise: Promise.resolve(null), stamp }
		entry.promise = new Promise<AuthContext | null>((resolve, reject) => {
			let settled = false
			let timedOut = false
			// Whichever of the answer and the deadline comes first settles the call; the other
			// finds it settled and does nothing, which keeps a late answer out of the cache.
			const settle = (): boolean => {
				if (settled) return false
				settled = true
				clearTimeout(timer)
				share.inFlight -= 1
				// Only this call's own entry: an eviction may have replaced it with a newer call.
				if (this.inflight.get(fingerprint) === entry) this.inflight.delete(fingerprint)
				return true
			}
			const orphanId = this.orphanSeq++
			const finishOrphan = (): void => {
				if (timedOut) this.orphans.delete(orphanId)
			}
			const timer = setTimeout(() => {
				if (!settle()) return
				timedOut = true
				this.orphans.set(orphanId, this.now() + (this.options.orphanTtlMs ?? ORPHAN_TTL_MS))
				controller.abort()
				reject(new ReadAuthTimeoutError(this.options.timeoutMs))
			}, this.options.timeoutMs)
			// A pending deadline must not keep a process alive.
			timer.unref?.()
			Promise.resolve()
				.then(() => call(controller.signal))
				.then(
					(context) => {
						finishOrphan()
						if (!settle()) return
						this.remember(fingerprint, context, stamp)
						resolve(context)
					},
					(error: unknown) => {
						finishOrphan()
						if (settle()) reject(error)
					},
				)
		})
		this.inflight.set(fingerprint, entry)
		return { kind: 'context', context: await entry.promise, stamp }
	}

	/**
	 * Forget the cached authentications of a revoked user (all of them when no user is
	 * named, as a device revocation cannot be mapped to a token), and make every
	 * authentication taken before now stale for that scope. Calls in flight are dropped from
	 * the join table so a request arriving after the eviction asks the provider again.
	 *
	 * @param userId - The revoked user, or undefined to forget everything
	 */
	evict(userId?: string): void {
		this.clock += 1
		this.inflight.clear()
		if (userId === undefined) {
			this.globalEvictedAt = this.clock
			this.positive.clear()
			this.userEvictedAt.clear()
			return
		}
		for (const [fingerprint, entry] of this.positive) {
			if (entry.context?.userId === userId) this.positive.delete(fingerprint)
		}
		this.userEvictedAt.delete(userId)
		this.userEvictedAt.set(userId, this.clock)
		if (this.userEvictedAt.size > MAX_ENTRIES) {
			const oldest = this.userEvictedAt.entries().next().value
			if (oldest !== undefined) {
				this.evictionFloor = Math.max(this.evictionFloor, oldest[1])
				this.userEvictedAt.delete(oldest[0])
			}
		}
	}

	/** Entries remembered, for tests. */
	get size(): number {
		return this.positive.size + this.negative.size
	}

	/** Provider calls past their deadline that have not answered yet, for tests. */
	get orphanedCalls(): number {
		const now = this.now()
		for (const [id, until] of this.orphans) if (until <= now) this.orphans.delete(id)
		return this.orphans.size
	}

	private admitMiss(lane: Lane): GuardResolution | null {
		if (lane.inFlight >= lane.maxConcurrent) {
			return { kind: 'busy', retryAfterMs: 100 }
		}
		const now = this.now()
		lane.tokens = Math.min(
			lane.burst,
			lane.tokens + ((now - lane.tokensAt) / 1000) * lane.perSecond,
		)
		lane.tokensAt = now
		if (lane.tokens < 1) {
			return {
				kind: 'busy',
				retryAfterMs: Math.ceil(((1 - lane.tokens) / lane.perSecond) * 1000),
			}
		}
		lane.tokens -= 1
		return null
	}

	private remember(fingerprint: string, context: AuthContext | null, stamp: number): void {
		if (this.options.ttlMs <= 0) return
		// A call that began before an eviction may carry what the eviction removed: used once by
		// its waiters, never cached.
		if (this.isStaleFor(stamp, context?.userId)) return
		const now = this.now()
		if (context === null) {
			trim(this.negative)
			this.negative.set(fingerprint, now + Math.min(this.options.ttlMs, NEGATIVE_TTL_MS))
			return
		}
		// Never past the credential: an expired token must not keep reading from the cache.
		const until = Math.min(now + this.options.ttlMs, context.expiresAt ?? Number.POSITIVE_INFINITY)
		if (until <= now) return
		trim(this.positive)
		this.positive.set(fingerprint, { context, until })
	}

	private isStaleFor(stamp: number, userId: string | undefined): boolean {
		return userId === undefined
			? this.globalEvictedAt > stamp || this.evictionFloor > stamp
			: this.isStale(stamp, userId)
	}
}

/** Drop the oldest tenth when a map is full (Map keeps insertion order). */
function trim(map: Map<string, unknown>): void {
	if (map.size < MAX_ENTRIES) return
	let drop = Math.ceil(MAX_ENTRIES / 10)
	for (const key of map.keys()) {
		map.delete(key)
		drop -= 1
		if (drop <= 0) break
	}
}
