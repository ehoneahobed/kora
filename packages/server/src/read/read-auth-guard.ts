import { createHmac, randomBytes } from 'node:crypto'
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
 *   concurrency limit and a token bucket, so a flood of distinct garbage tokens can delay a
 *   cold sign-in (retriable) but can never refuse a signed-in user, who hits the cache.
 *
 * Revocation lag: a revoked credential keeps reading until its cache entry is evicted. A
 * revocation the server hears about (`terminateSessions`, which the auth provider's feed
 * calls) evicts at once; otherwise the lag is at most `ttlMs`.
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
}

/** The most fingerprints remembered, each way; the oldest go first. */
const MAX_ENTRIES = 10_000

/** What the guard knows about a token without calling the provider. */
export type GuardLookup =
	| { kind: 'context'; context: AuthContext }
	| { kind: 'denied' }
	| { kind: 'unknown' }

/** What the guard decided for a token it did not know. */
export type GuardResolution =
	| { kind: 'context'; context: AuthContext | null }
	| { kind: 'busy'; retryAfterMs: number }

interface Positive {
	context: AuthContext | null
	until: number
}

/** The guard. The clock is injected so tests need no real time. */
export class ReadAuthGuard {
	private readonly key = randomBytes(32)
	private readonly positive = new Map<string, Positive>()
	private readonly negative = new Map<string, number>()
	private readonly inflight = new Map<string, Promise<AuthContext | null>>()
	private missesInFlight = 0
	private tokens: number
	private tokensAt: number

	constructor(
		private readonly options: ReadAuthGuardOptions,
		private readonly now: () => number = Date.now,
	) {
		this.tokens = options.missBurst
		this.tokensAt = now()
	}

	/** The fingerprint a token is remembered under. */
	fingerprint(token: string): string {
		return createHmac('sha256', this.key).update(token).digest('base64url').slice(0, 24)
	}

	/**
	 * What is already known about a token: a live positive entry (never past the credential's
	 * expiry), a live negative one, or nothing.
	 *
	 * @param token - The bearer token
	 */
	lookup(token: string): GuardLookup {
		const fingerprint = this.fingerprint(token)
		const now = this.now()
		const hit = this.positive.get(fingerprint)
		if (hit !== undefined) {
			if (hit.until > now && hit.context !== null) return { kind: 'context', context: hit.context }
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
	 * Authenticate a token the guard does not know: join a call already in flight for it, or
	 * make one if the global miss cap allows. A provider that throws rejects every waiter and
	 * remembers nothing.
	 *
	 * @param token - The bearer token
	 * @param call - Asks the auth provider
	 */
	async resolve(token: string, call: () => Promise<AuthContext | null>): Promise<GuardResolution> {
		const fingerprint = this.fingerprint(token)
		const joined = this.inflight.get(fingerprint)
		if (joined !== undefined) return { kind: 'context', context: await joined }
		const busy = this.admitMiss()
		if (busy !== null) return busy
		this.missesInFlight += 1
		const promise = (async () => {
			try {
				const context = await call()
				this.remember(fingerprint, context)
				return context
			} finally {
				this.missesInFlight -= 1
				this.inflight.delete(fingerprint)
			}
		})()
		this.inflight.set(fingerprint, promise)
		return { kind: 'context', context: await promise }
	}

	/**
	 * Forget the cached authentications of a revoked user (all of them when no user is
	 * named, as a device revocation cannot be mapped to a token).
	 *
	 * @param userId - The revoked user, or undefined to forget everything
	 */
	evict(userId?: string): void {
		if (userId === undefined) {
			this.positive.clear()
			return
		}
		for (const [fingerprint, entry] of this.positive) {
			if (entry.context?.userId === userId) this.positive.delete(fingerprint)
		}
	}

	/** Entries remembered, for tests. */
	get size(): number {
		return this.positive.size + this.negative.size
	}

	private admitMiss(): GuardResolution | null {
		if (this.missesInFlight >= this.options.maxConcurrentMisses) {
			return { kind: 'busy', retryAfterMs: 100 }
		}
		const now = this.now()
		this.tokens = Math.min(
			this.options.missBurst,
			this.tokens + ((now - this.tokensAt) / 1000) * this.options.missesPerSecond,
		)
		this.tokensAt = now
		if (this.tokens < 1) {
			return {
				kind: 'busy',
				retryAfterMs: Math.ceil(((1 - this.tokens) / this.options.missesPerSecond) * 1000),
			}
		}
		this.tokens -= 1
		return null
	}

	private remember(fingerprint: string, context: AuthContext | null): void {
		if (this.options.ttlMs <= 0) return
		const now = this.now()
		if (context === null) {
			trim(this.negative)
			this.negative.set(fingerprint, now + this.options.ttlMs)
			return
		}
		// Never past the credential: an expired token must not keep reading from the cache.
		const until = Math.min(now + this.options.ttlMs, context.expiresAt ?? Number.POSITIVE_INFINITY)
		if (until <= now) return
		trim(this.positive)
		this.positive.set(fingerprint, { context, until })
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
