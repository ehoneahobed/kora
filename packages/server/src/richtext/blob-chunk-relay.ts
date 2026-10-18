import { hashBlob } from '@korajs/core'
import {
	type BlobChunkRequestMessage,
	type BlobChunkResponseMessage,
	decodeBlobChunkBytes,
	encodeBlobChunkBytes,
} from '@korajs/sync'
import type { Logger } from '../logging/structured-logger'
import type { ServerTransport } from '../transport/server-transport'

/**
 * Resolves a blob chunk by content hash from server-side storage. Optional: when
 * provided, the server can answer chunk requests directly from its own store
 * (central-store deployment). When absent, the server acts as a pure relay,
 * forwarding chunk requests to peer sessions and their responses back.
 */
export type ResolveBlobChunk = (hash: string) => Promise<Uint8Array | null>

/**
 * Decides who may obtain the bytes behind a content hash, and from whom (RT-1).
 *
 * The server's policy: the central store serves a session only when a live record
 * inside its download scope references the hash (as a blob, a manifest, or a chunk
 * of one). A request is forwarded to a peer only when both share the same download
 * scope (same tenant view), or when both scopes reference the hash.
 */
export interface BlobAccessPolicy {
	/** Whether the central store may serve `hash` to `requesterId`. */
	canReadFromStore(requesterId: string, hash: string): Promise<boolean>
	/** Whether `requesterId`'s request for `hash` may be forwarded to (and answered by) `targetId`. */
	canForward(requesterId: string, targetId: string, hash: string): Promise<boolean>
	/**
	 * Called with bytes the relay has verified to hash to `hash`, so the policy can
	 * learn a manifest's chunk list. Optional.
	 */
	observeVerifiedBytes?(hash: string, bytes: Uint8Array): void
	/**
	 * Checked synchronously right before bytes or a forwarded request are sent (after
	 * every await), so a session that lost the right to receive meanwhile gets nothing,
	 * not even the requested hash. Optional.
	 */
	mayReceive?(sessionId: string): boolean
}

interface RelayClient {
	sessionId: string
	transport: ServerTransport
}

/** Clock and timers the relay uses; injectable so tests need no real time. */
export interface BlobChunkRelayClock {
	now(): number
	setTimeout(callback: () => void, delayMs: number): unknown
	clearTimeout(handle: unknown): void
}

const DEFAULT_RELAY_CLOCK: BlobChunkRelayClock = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => {
		const handle = setTimeout(callback, delayMs)
		// The expiry sweep must never keep a process alive on its own.
		if (typeof handle === 'object' && handle !== null && 'unref' in handle) handle.unref()
		return handle
	},
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Limits that bound the relay's per-session bookkeeping. */
export interface BlobChunkRelayLimits {
	/** Most unanswered requests one session may have outstanding. Defaults to 256. */
	maxPendingPerSession?: number
	/** How long an unanswered request is remembered, in ms. Defaults to 60 seconds. */
	pendingTtlMs?: number
	/**
	 * The `retryAfterMs` sent with a "throttled" answer the relay gives (over the
	 * pending cap, or the requester may not receive right now). Defaults to 2 seconds.
	 */
	retryAfterMs?: number
	/** Clock and timers for request expiry (default: `Date.now` and unref'd timers). */
	clock?: BlobChunkRelayClock
}

/** Default cap on outstanding forwarded requests per session. */
export const DEFAULT_MAX_PENDING_BLOB_REQUESTS_PER_SESSION = 256
/** Default lifetime of an unanswered forwarded request. */
export const DEFAULT_BLOB_REQUEST_TTL_MS = 60_000
/** Default back-off the relay asks for in a "throttled" answer. */
export const DEFAULT_BLOB_RELAY_RETRY_AFTER_MS = 2_000

/**
 * How often the relay answered a request with something other than bytes, or could
 * not answer at all. A request is never left unanswered while its requester is
 * connected; these say why it was answered the way it was.
 */
export interface BlobChunkRelayStats {
	/** Answered "not held": every peer it was forwarded to said not held, or left. */
	notHeldAfterPeers: number
	/** Answered "not held": the request expired with no peer answering. */
	expired: number
	/** Answered "throttled": the requester already had the most pending requests. */
	throttledOverPendingCap: number
	/** Answered "throttled": the requester may not receive right now (access rules). */
	throttledNotReceivable: number
	/** Answered "throttled": its request id was pending for another session. */
	refusedDuplicateRequestId: number
	/** Not answered: the requester left before the answer (nobody to answer). */
	requesterGone: number
}

interface PendingRequest {
	originSessionId: string
	/** The content hash requested; a response must hash to it. */
	hash: string
	/** Sessions the request was forwarded to: the only ones allowed to answer it. */
	forwardedTo: Set<string>
	/** Forwarded sessions that answered "not held" (or left). */
	notHeldFrom: Set<string>
	/**
	 * When the request was first taken. A re-send (same id, same session) keeps it, so
	 * client retries cannot keep a request nobody answers alive past its lifetime.
	 */
	createdAtMs: number
}

/**
 * A request id some session has in flight in {@link BlobChunkRelay.handleRequest}.
 * `answers` counts how often a request from that session under that id was answered
 * (bytes, "not held" or "throttled"; see {@link BlobChunkRelay.answer}), so an attempt can tell that another one answered it while it
 * awaited the store or the policy, and must not answer (or re-open) it again.
 */
/** What the relay tells a requester: the bytes, "not held", or "throttled" (retry later). */
type RelayReply = { bytes: string } | 'not-held' | 'throttled'

interface InFlightRequest {
	handlers: number
	answers: number
}

/** One attempt's view of {@link InFlightRequest}: its key and the answer count it began at. */
interface HandlingToken {
	key: string
	record: InFlightRequest
	answersAtStart: number
}

/**
 * Routes out-of-band blob chunk transfer between connected clients (and,
 * optionally, a server-side blob store), within tenant boundaries (RT-1).
 *
 * - The central store (when configured) answers only requesters the
 *   {@link BlobAccessPolicy} admits for that hash.
 * - Otherwise the request is forwarded only to peers the policy admits for that
 *   requester and hash, so a hash never reaches another tenant.
 * - When neither applies, the request is answered "not held" (`bytes: null`), the
 *   same answer as for an unknown hash, so nothing leaks.
 * - A response is accepted only from a session the request was forwarded to, and
 *   only when its bytes hash to the requested hash (no poisoning, by another tenant
 *   or by a same-tenant peer).
 * - Never silent while the requester is connected: once every peer asked has said
 *   "not held" (or left), or the request expires, the answer is "not held"; a
 *   request the relay cannot take now (pending cap, the requester may not receive,
 *   a request id pending for another session) is answered "throttled" with
 *   `retryAfterMs`, so the client retries under the same request id.
 *
 * Blob bytes never enter the operation log; only the `BlobRef` inside a record does.
 * Not persisted: this is an ephemeral side channel, like the Yjs doc relay.
 */
export class BlobChunkRelay {
	private readonly clients = new Map<string, RelayClient>()
	/** requestId -> the session that originated the request (to route the answer back). */
	private readonly pending = new Map<string, PendingRequest>()
	/** Request ids with an attempt in flight, keyed by session and request id. */
	private readonly inFlight = new Map<string, InFlightRequest>()
	private readonly resolveBlobChunk: ResolveBlobChunk | null
	private readonly policy: BlobAccessPolicy
	private readonly maxPendingPerSession: number
	private readonly pendingTtlMs: number
	private readonly retryAfterMs: number
	private readonly logger: Logger | null
	private readonly clock: BlobChunkRelayClock
	/** The one expiry sweep timer, armed while any request is pending. */
	private sweepTimer: unknown = null
	/** When {@link sweepTimer} fires. */
	private sweepAtMs = Number.POSITIVE_INFINITY
	private readonly stats: BlobChunkRelayStats = {
		notHeldAfterPeers: 0,
		expired: 0,
		throttledOverPendingCap: 0,
		throttledNotReceivable: 0,
		refusedDuplicateRequestId: 0,
		requesterGone: 0,
	}

	constructor(
		resolveBlobChunk: ResolveBlobChunk | undefined,
		policy: BlobAccessPolicy,
		limits: BlobChunkRelayLimits = {},
		logger?: Logger,
	) {
		this.resolveBlobChunk = resolveBlobChunk ?? null
		this.policy = policy
		this.maxPendingPerSession =
			limits.maxPendingPerSession ?? DEFAULT_MAX_PENDING_BLOB_REQUESTS_PER_SESSION
		this.pendingTtlMs = limits.pendingTtlMs ?? DEFAULT_BLOB_REQUEST_TTL_MS
		this.retryAfterMs = limits.retryAfterMs ?? DEFAULT_BLOB_RELAY_RETRY_AFTER_MS
		this.logger = logger ?? null
		this.clock = limits.clock ?? DEFAULT_RELAY_CLOCK
	}

	addClient(sessionId: string, transport: ServerTransport): void {
		this.clients.set(sessionId, { sessionId, transport })
	}

	removeClient(sessionId: string): void {
		this.clients.delete(sessionId)
		// Drop any requests this session was waiting on: their answers can no longer be
		// delivered, and the client re-sends them on its next connection. A request this
		// session was asked to answer counts it as "not held", so the requester is told
		// once nobody else it asked can still answer.
		for (const [requestId, entry] of this.pending) {
			if (entry.originSessionId === sessionId) {
				this.settle(requestId, entry, false)
			} else if (entry.forwardedTo.has(sessionId)) {
				entry.notHeldFrom.add(sessionId)
				this.answerIfNobodyLeft(requestId, entry)
			}
		}
		this.scheduleSweep()
	}

	getClientCount(): number {
		return this.clients.size
	}

	getPendingCount(): number {
		return this.pending.size
	}

	/** Counts of answers other than bytes (and of requests nobody could be told about). */
	getStats(): BlobChunkRelayStats {
		return { ...this.stats }
	}

	/** Forget every client and request, and stop the expiry timer. */
	clear(): void {
		this.clients.clear()
		this.pending.clear()
		this.inFlight.clear()
		this.scheduleSweep()
	}

	/**
	 * Handle an inbound chunk request from a session. Tries the server's own store
	 * first (if configured and the policy admits the requester), then forwards the
	 * request to admitted peers and remembers who to route the answer back to. With
	 * neither, the requester is told "not held".
	 */
	async handleRequest(sourceSessionId: string, message: BlobChunkRequestMessage): Promise<void> {
		if (!this.clients.has(sourceSessionId)) {
			return
		}
		const token = this.beginHandling(sourceSessionId, message.requestId)
		try {
			if (
				this.resolveBlobChunk &&
				(await this.allowed(() => this.policy.canReadFromStore(sourceSessionId, message.hash)))
			) {
				let bytes: Uint8Array | null = null
				try {
					bytes = await this.resolveBlobChunk(message.hash)
				} catch {
					// A store read error is treated as "not held here": fall back to peers
					// rather than crashing the connection.
					bytes = null
				}
				if (bytes !== null) {
					// A peer's bytes (or the expiry) answered this request while the store was
					// read: the requester has its answer and gets no second one.
					if (this.answeredSince(token)) return
					// An earlier attempt may still be waiting on a peer: the store's answer
					// completes it, so it stops counting against the session's allowance and
					// never expires into a "not held" for a request already answered.
					const own = this.pending.get(message.requestId)
					if (own && own.originSessionId === sourceSessionId) {
						this.settle(message.requestId, own)
					}
					this.answer(sourceSessionId, message.requestId, { bytes: encodeBlobChunkBytes(bytes) })
					return
				}
			}

			await this.forwardRequestToPeers(sourceSessionId, message, token)
		} finally {
			this.endHandling(token)
		}
	}

	/**
	 * Handle an inbound chunk response from a peer. Routes it back to the session
	 * that originally requested it, but only when the responder was asked and the
	 * bytes hash to the requested hash. A "not held" answer (bytes === null) does not
	 * preempt a slower peer that has it: the requester is told "not held" only once
	 * every peer asked has said so (or left).
	 */
	async handleResponse(sourceSessionId: string, message: BlobChunkResponseMessage): Promise<void> {
		if (!this.clients.has(sourceSessionId)) {
			return
		}
		const entry = this.pending.get(message.requestId)
		if (!entry || !entry.forwardedTo.has(sourceSessionId)) {
			return
		}
		if (message.bytes === null) {
			// A peer's "throttled" carries no bytes either: it is not an answer for the
			// requester, who re-sends if nobody else answers.
			if (message.throttled === true) return
			entry.notHeldFrom.add(sourceSessionId)
			this.answerIfNobodyLeft(message.requestId, entry)
			return
		}
		let decoded: Uint8Array
		try {
			decoded = decodeBlobChunkBytes(message.bytes)
		} catch {
			return
		}
		if ((await hashBlob(decoded)) !== entry.hash) {
			// Wrong bytes for the hash: ignore them and keep waiting for an honest peer.
			// The liar counts as "not held", so it cannot keep the request open forever.
			if (this.pending.get(message.requestId) === entry) {
				entry.notHeldFrom.add(sourceSessionId)
				this.answerIfNobodyLeft(message.requestId, entry)
			}
			return
		}
		// Re-check after the await: another response (or the central store) may have
		// completed the request.
		if (!this.settle(message.requestId, entry)) {
			return
		}
		this.policy.observeVerifiedBytes?.(entry.hash, decoded)
		this.answer(entry.originSessionId, message.requestId, { bytes: message.bytes })
	}

	private async allowed(check: () => Promise<boolean>): Promise<boolean> {
		try {
			return await check()
		} catch {
			// Fail closed: an authorization error never grants access.
			return false
		}
	}

	/**
	 * Forward to admitted peers and remember the request; or answer at once: "not held"
	 * when nobody may be asked, "throttled" when the request cannot be taken now.
	 */
	private async forwardRequestToPeers(
		sourceSessionId: string,
		message: BlobChunkRequestMessage,
		token: HandlingToken,
	): Promise<void> {
		this.expirePending(this.clock.now())
		if (this.answeredSince(token)) {
			// Answered since this attempt began (a re-send that raced its own expiry, or
			// another attempt served by the store or a peer): not taken again.
			return
		}
		const existing = this.pending.get(message.requestId)
		// A request id already pending for another session is refused, so one session
		// cannot hijack the answer routed to another by reusing its request id. The
		// answer is "throttled", not "not held": an honest client whose old session has
		// not been cleaned up yet (a reconnect race) recovers by retrying, and the
		// session that owns the id is not affected.
		if (existing && existing.originSessionId !== sourceSessionId) {
			this.stats.refusedDuplicateRequestId += 1
			this.log('warn', 'blob_relay.duplicate_request_id', sourceSessionId, {
				requestId: message.requestId,
			})
			this.answer(sourceSessionId, message.requestId, 'throttled')
			return
		}
		if (!existing && this.pendingCountFor(sourceSessionId) >= this.maxPendingPerSession) {
			// Over the per-session cap: the relay's memory stays bounded per session, and
			// the requester backs off and retries instead of waiting for silence.
			this.stats.throttledOverPendingCap += 1
			this.log('warn', 'blob_relay.pending_cap', sourceSessionId, {
				maxPendingPerSession: this.maxPendingPerSession,
			})
			this.answer(sourceSessionId, message.requestId, 'throttled')
			return
		}
		const targets: RelayClient[] = []
		for (const client of this.clients.values()) {
			if (client.sessionId === sourceSessionId) continue
			if (!client.transport.isConnected()) continue
			// Only peers that may hold the bytes themselves are asked: the hash never
			// reaches a session outside the requester's tenant.
			if (
				await this.allowed(() =>
					this.policy.canForward(sourceSessionId, client.sessionId, message.hash),
				)
			) {
				targets.push(client)
			}
		}
		// The requester may have left while the policy was consulted: nobody to answer.
		if (!this.clients.has(sourceSessionId)) {
			this.stats.requesterGone += 1
			return
		}
		// A duplicate request id may have registered meanwhile.
		const current = this.pending.get(message.requestId)
		if (current && current.originSessionId !== sourceSessionId) {
			this.stats.refusedDuplicateRequestId += 1
			this.answer(sourceSessionId, message.requestId, 'throttled')
			return
		}
		if (this.answeredSince(token)) {
			// This request was answered while the policy was consulted (by a peer, the
			// expiry, or another attempt the store served): it is not taken (or forwarded)
			// again, so it can neither be answered twice nor expire into a spurious "not held".
			return
		}
		// After every await: a peer that lost the right to receive meanwhile (its access
		// rules no longer in force) is neither sent the hash nor trusted to answer it.
		const admitted = targets.filter(
			(target) =>
				target.transport.isConnected() && this.policy.mayReceive?.(target.sessionId) !== false,
		)
		if (admitted.length === 0) {
			if (current) {
				// A re-sent request nobody is left to ask: the earlier peers' answers decide.
				this.answerIfNobodyLeft(message.requestId, current)
				return
			}
			this.answer(sourceSessionId, message.requestId, 'not-held')
			return
		}
		// A re-sent request (same id, same session) widens the set it was forwarded to,
		// in place: it keeps its first creation time (retries do not extend its lifetime)
		// and its identity (an answer being verified meanwhile still completes it). Peers
		// that already said "not held" keep that answer and are not asked again, so client
		// retries do not multiply the work on every peer.
		let entry: PendingRequest
		if (current) {
			entry = current
		} else {
			entry = {
				originSessionId: sourceSessionId,
				hash: message.hash,
				forwardedTo: new Set<string>(),
				notHeldFrom: new Set<string>(),
				createdAtMs: this.clock.now(),
			}
			this.pending.set(message.requestId, entry)
			this.scheduleSweep()
		}
		const toAsk = admitted.filter((target) => !entry.notHeldFrom.has(target.sessionId))
		for (const target of toAsk) entry.forwardedTo.add(target.sessionId)
		if (toAsk.length === 0) {
			this.answerIfNobodyLeft(message.requestId, entry)
			return
		}
		for (const target of toAsk) {
			target.transport.send(message)
		}
	}

	/**
	 * Answer "not held" once every session the request was forwarded to has said so
	 * (or left): no single "not held" preempts a slower peer that holds the chunk.
	 */
	private answerIfNobodyLeft(requestId: string, entry: PendingRequest): void {
		if (this.pending.get(requestId) !== entry) return
		for (const sessionId of entry.forwardedTo) {
			if (!entry.notHeldFrom.has(sessionId)) return
		}
		if (!this.settle(requestId, entry)) return
		this.stats.notHeldAfterPeers += 1
		this.answer(entry.originSessionId, requestId, 'not-held')
	}

	/**
	 * The one way a pending request ends: removes it (only if `entry` is still the pending
	 * one), records that its requester was answered, and re-arms the expiry sweep. Returns
	 * false when the request had already ended, in which case the caller sends nothing.
	 */
	private settle(requestId: string, entry: PendingRequest, reschedule = true): boolean {
		if (this.pending.get(requestId) !== entry) return false
		this.pending.delete(requestId)
		this.noteAnswered(entry.originSessionId, requestId)
		if (reschedule) this.scheduleSweep()
		return true
	}

	private beginHandling(sessionId: string, requestId: string): HandlingToken {
		const key = inFlightKey(sessionId, requestId)
		let record = this.inFlight.get(key)
		if (!record) {
			record = { handlers: 0, answers: 0 }
			this.inFlight.set(key, record)
		}
		record.handlers += 1
		return { key, record, answersAtStart: record.answers }
	}

	private endHandling(token: HandlingToken): void {
		token.record.handlers -= 1
		if (token.record.handlers <= 0 && this.inFlight.get(token.key) === token.record) {
			this.inFlight.delete(token.key)
		}
	}

	/** Whether the request this attempt handles was answered after the attempt began. */
	private answeredSince(token: HandlingToken): boolean {
		return token.record.answers !== token.answersAtStart
	}

	private noteAnswered(sessionId: string, requestId: string): void {
		const record = this.inFlight.get(inFlightKey(sessionId, requestId))
		if (record) record.answers += 1
	}

	private pendingCountFor(sessionId: string): number {
		let count = 0
		for (const entry of this.pending.values()) {
			if (entry.originSessionId === sessionId) count += 1
		}
		return count
	}

	private expirePending(now: number): void {
		const cutoff = now - this.pendingTtlMs
		const expired: Array<[string, PendingRequest]> = []
		for (const [requestId, entry] of this.pending) {
			if (entry.createdAtMs <= cutoff) expired.push([requestId, entry])
		}
		for (const [requestId, entry] of expired) {
			if (!this.settle(requestId, entry, false)) continue
			// No peer answered in time: tell the requester (if still here) instead of
			// leaving it to its own timeout.
			this.stats.expired += 1
			this.answer(entry.originSessionId, requestId, 'not-held')
		}
		this.scheduleSweep()
	}

	/**
	 * Keep one timer armed for the earliest expiry while requests are pending, and none
	 * otherwise, so a request expires on time whether or not other messages arrive and
	 * nothing keeps running once the relay is idle or cleared.
	 */
	private scheduleSweep(): void {
		let earliest = Number.POSITIVE_INFINITY
		for (const entry of this.pending.values()) {
			earliest = Math.min(earliest, entry.createdAtMs + this.pendingTtlMs)
		}
		if (earliest === this.sweepAtMs && this.sweepTimer !== null) return
		if (this.sweepTimer !== null) {
			this.clock.clearTimeout(this.sweepTimer)
			this.sweepTimer = null
		}
		this.sweepAtMs = earliest
		if (earliest === Number.POSITIVE_INFINITY) return
		this.sweepTimer = this.clock.setTimeout(
			() => {
				this.sweepTimer = null
				this.sweepAtMs = Number.POSITIVE_INFINITY
				this.expirePending(this.clock.now())
			},
			Math.max(0, earliest - this.clock.now()),
		)
	}

	/**
	 * The one way a requester is answered. Every reply (bytes, "not held", "throttled")
	 * is recorded against the request before it is sent, so an attempt for the same
	 * request id that began earlier and is still awaiting the store or the policy sees
	 * it ({@link answeredSince}) and neither answers again nor forwards or registers it.
	 *
	 * "throttled" counts too, although it is not terminal for the client: the client
	 * backs off and re-sends under the same id, and that re-send is a new attempt that
	 * decides afresh. An older attempt that went on after a throttle would register an
	 * entry the requester was just told was not taken (possibly over the pending cap it
	 * was throttled for), forward a hash at a time the relay refused to, and answer a
	 * second time. Recording happens even when the requester is gone, for the same reason.
	 */
	private answer(sessionId: string, requestId: string, reply: RelayReply): void {
		this.noteAnswered(sessionId, requestId)
		const client = this.clients.get(sessionId)
		if (!client || !client.transport.isConnected()) {
			this.stats.requesterGone += 1
			return
		}
		let response: BlobChunkResponseMessage
		if (
			reply === 'throttled' ||
			(reply !== 'not-held' && this.policy.mayReceive?.(sessionId) === false)
		) {
			if (reply !== 'throttled') {
				// The requester may not receive bytes right now (its access rules are not in
				// force): no bytes, but a retriable answer instead of silence.
				this.stats.throttledNotReceivable += 1
			}
			// A retriable refusal: no bytes and no claim about who holds the hash, so it is
			// safe to send to any session. Clients since 1.0.0-beta.13 back off and re-send
			// under the same request id (RT-24).
			response = {
				type: 'blob-chunk-response',
				messageId: generateResponseId(requestId),
				requestId,
				bytes: null,
				throttled: true,
				retryAfterMs: this.retryAfterMs,
			}
		} else {
			response = {
				type: 'blob-chunk-response',
				messageId: generateResponseId(requestId),
				requestId,
				bytes: reply === 'not-held' ? null : reply.bytes,
			}
		}
		client.transport.send(response)
	}

	private log(
		level: 'info' | 'warn',
		event: string,
		sessionId: string,
		details: Record<string, unknown>,
	): void {
		this.logger?.log({ timestamp: this.clock.now(), level, event, sessionId, details })
	}
}

/**
 * Derive a deterministic wire messageId for a routed response. The correlation
 * that matters is `requestId`; `messageId` only needs to be a non-empty string,
 * so deriving it avoids a clock/random dependency in the relay.
 */
function inFlightKey(sessionId: string, requestId: string): string {
	return JSON.stringify([sessionId, requestId])
}

function generateResponseId(requestId: string): string {
	return `blob-resp-${requestId}`
}
