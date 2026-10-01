import { hashBlob } from '@korajs/core'
import {
	type BlobChunkRequestMessage,
	type BlobChunkResponseMessage,
	decodeBlobChunkBytes,
	encodeBlobChunkBytes,
} from '@korajs/sync'
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
}

interface RelayClient {
	sessionId: string
	transport: ServerTransport
}

/** Limits that bound the relay's per-session bookkeeping. */
export interface BlobChunkRelayLimits {
	/** Most unanswered requests one session may have outstanding. Defaults to 256. */
	maxPendingPerSession?: number
	/** How long an unanswered request is remembered, in ms. Defaults to 60 seconds. */
	pendingTtlMs?: number
}

/** Default cap on outstanding forwarded requests per session. */
export const DEFAULT_MAX_PENDING_BLOB_REQUESTS_PER_SESSION = 256
/** Default lifetime of an unanswered forwarded request. */
export const DEFAULT_BLOB_REQUEST_TTL_MS = 60_000

interface PendingRequest {
	originSessionId: string
	/** The content hash requested; a response must hash to it. */
	hash: string
	/** Sessions the request was forwarded to: the only ones allowed to answer it. */
	forwardedTo: Set<string>
	createdAtMs: number
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
 *
 * Blob bytes never enter the operation log; only the `BlobRef` inside a record does.
 * Not persisted: this is an ephemeral side channel, like the Yjs doc relay.
 */
export class BlobChunkRelay {
	private readonly clients = new Map<string, RelayClient>()
	/** requestId -> the session that originated the request (to route the answer back). */
	private readonly pending = new Map<string, PendingRequest>()
	private readonly resolveBlobChunk: ResolveBlobChunk | null
	private readonly policy: BlobAccessPolicy
	private readonly maxPendingPerSession: number
	private readonly pendingTtlMs: number

	constructor(
		resolveBlobChunk: ResolveBlobChunk | undefined,
		policy: BlobAccessPolicy,
		limits: BlobChunkRelayLimits = {},
	) {
		this.resolveBlobChunk = resolveBlobChunk ?? null
		this.policy = policy
		this.maxPendingPerSession =
			limits.maxPendingPerSession ?? DEFAULT_MAX_PENDING_BLOB_REQUESTS_PER_SESSION
		this.pendingTtlMs = limits.pendingTtlMs ?? DEFAULT_BLOB_REQUEST_TTL_MS
	}

	addClient(sessionId: string, transport: ServerTransport): void {
		this.clients.set(sessionId, { sessionId, transport })
	}

	removeClient(sessionId: string): void {
		this.clients.delete(sessionId)
		// Drop any requests this session was waiting on; their answers can no
		// longer be delivered.
		for (const [requestId, entry] of this.pending) {
			if (entry.originSessionId === sessionId) {
				this.pending.delete(requestId)
			} else {
				entry.forwardedTo.delete(sessionId)
			}
		}
	}

	getClientCount(): number {
		return this.clients.size
	}

	getPendingCount(): number {
		return this.pending.size
	}

	clear(): void {
		this.clients.clear()
		this.pending.clear()
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
				this.sendResponseTo(sourceSessionId, message.requestId, encodeBlobChunkBytes(bytes))
				return
			}
		}

		if (!(await this.forwardRequestToPeers(sourceSessionId, message))) {
			this.sendResponseTo(sourceSessionId, message.requestId, null)
		}
	}

	/**
	 * Handle an inbound chunk response from a peer. Routes it back to the session
	 * that originally requested it, but only when the responder was asked and the
	 * bytes hash to the requested hash. A "not held" answer (bytes === null) is
	 * ignored so a peer without the chunk does not preempt one that has it; the
	 * requester's own per-request timeout bounds the wait.
	 */
	async handleResponse(sourceSessionId: string, message: BlobChunkResponseMessage): Promise<void> {
		if (!this.clients.has(sourceSessionId)) {
			return
		}
		if (message.bytes === null) {
			return
		}
		const entry = this.pending.get(message.requestId)
		if (!entry || !entry.forwardedTo.has(sourceSessionId)) {
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
			return
		}
		// Re-check after the await: another response may have completed the request.
		if (this.pending.get(message.requestId) !== entry) {
			return
		}
		this.pending.delete(message.requestId)
		this.policy.observeVerifiedBytes?.(entry.hash, decoded)
		this.sendResponseTo(entry.originSessionId, message.requestId, message.bytes)
	}

	private async allowed(check: () => Promise<boolean>): Promise<boolean> {
		try {
			return await check()
		} catch {
			// Fail closed: an authorization error never grants access.
			return false
		}
	}

	/** Forward to admitted peers. False when nobody may be asked (answer "not held"). */
	private async forwardRequestToPeers(
		sourceSessionId: string,
		message: BlobChunkRequestMessage,
	): Promise<boolean> {
		const now = Date.now()
		this.expirePending(now)
		const existing = this.pending.get(message.requestId)
		// A request id already pending for another session is refused, so one session
		// cannot hijack the answer routed to another by reusing its request id.
		if (existing && existing.originSessionId !== sourceSessionId) {
			return true
		}
		if (!existing && this.pendingCountFor(sourceSessionId) >= this.maxPendingPerSession) {
			// Over the per-session cap: drop the request. The requester's own timeout
			// bounds its wait; the relay's memory stays bounded per session.
			return true
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
		// The requester may have left, or a duplicate request id may have registered,
		// while the policy was consulted.
		if (!this.clients.has(sourceSessionId)) return true
		const current = this.pending.get(message.requestId)
		if (current && current.originSessionId !== sourceSessionId) return true
		if (targets.length === 0) return false
		const forwardedTo = current?.forwardedTo ?? new Set<string>()
		for (const target of targets) forwardedTo.add(target.sessionId)
		this.pending.set(message.requestId, {
			originSessionId: sourceSessionId,
			hash: message.hash,
			forwardedTo,
			createdAtMs: now,
		})
		for (const target of targets) {
			target.transport.send(message)
		}
		return true
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
		for (const [requestId, entry] of this.pending) {
			if (entry.createdAtMs <= cutoff) {
				this.pending.delete(requestId)
			}
		}
	}

	private sendResponseTo(sessionId: string, requestId: string, bytes: string | null): void {
		const client = this.clients.get(sessionId)
		if (!client || !client.transport.isConnected()) {
			return
		}
		const response: BlobChunkResponseMessage = {
			type: 'blob-chunk-response',
			messageId: generateResponseId(requestId),
			requestId,
			bytes,
		}
		client.transport.send(response)
	}
}

/**
 * Derive a deterministic wire messageId for a routed response. The correlation
 * that matters is `requestId`; `messageId` only needs to be a non-empty string,
 * so deriving it avoids a clock/random dependency in the relay.
 */
function generateResponseId(requestId: string): string {
	return `blob-resp-${requestId}`
}
