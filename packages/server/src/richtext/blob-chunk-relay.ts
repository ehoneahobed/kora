import {
	type BlobChunkRequestMessage,
	type BlobChunkResponseMessage,
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

interface RelayClient {
	sessionId: string
	transport: ServerTransport
}

/**
 * Routes out-of-band blob chunk transfer between connected clients (and,
 * optionally, a server-side blob store).
 *
 * The server never stores or inspects blob bytes on the relay path: a
 * `blob-chunk-request` is forwarded to peer sessions, and the first peer to
 * answer with the bytes has its `blob-chunk-response` routed back to the
 * original requester by `requestId`. Blob bytes never enter the operation log;
 * only the `BlobRef` reference inside a record does.
 *
 * Not persisted — this is an ephemeral side channel, like the Yjs doc relay.
 */
export class BlobChunkRelay {
	private readonly clients = new Map<string, RelayClient>()
	/** requestId -> the session that originated the request (to route the answer back). */
	private readonly pending = new Map<string, string>()
	private readonly resolveBlobChunk: ResolveBlobChunk | null

	constructor(resolveBlobChunk?: ResolveBlobChunk) {
		this.resolveBlobChunk = resolveBlobChunk ?? null
	}

	addClient(sessionId: string, transport: ServerTransport): void {
		this.clients.set(sessionId, { sessionId, transport })
	}

	removeClient(sessionId: string): void {
		this.clients.delete(sessionId)
		// Drop any requests this session was waiting on; their answers can no
		// longer be delivered.
		for (const [requestId, originSessionId] of this.pending) {
			if (originSessionId === sessionId) {
				this.pending.delete(requestId)
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
	 * Handle an inbound chunk request from a session. Tries the server's own
	 * store first (if configured), otherwise forwards the request to peer
	 * sessions and remembers who to route the answer back to.
	 */
	handleRequest(sourceSessionId: string, message: BlobChunkRequestMessage): void {
		if (!this.clients.has(sourceSessionId)) {
			return
		}

		if (this.resolveBlobChunk) {
			void this.resolveBlobChunk(message.hash).then(
				(bytes) => {
					if (bytes !== null) {
						this.sendResponseTo(sourceSessionId, message.requestId, encodeBlobChunkBytes(bytes))
						return
					}
					this.forwardRequestToPeers(sourceSessionId, message)
				},
				() => {
					// A store read error is treated as "not held here": fall back to peers
					// rather than crashing the connection.
					this.forwardRequestToPeers(sourceSessionId, message)
				},
			)
			return
		}

		this.forwardRequestToPeers(sourceSessionId, message)
	}

	/**
	 * Handle an inbound chunk response from a peer. Routes it back to the session
	 * that originally requested it. A "not held" answer (bytes === null) is
	 * ignored so a peer without the chunk does not preempt one that has it; the
	 * requester's own per-request timeout bounds the wait.
	 */
	handleResponse(sourceSessionId: string, message: BlobChunkResponseMessage): void {
		if (!this.clients.has(sourceSessionId)) {
			return
		}
		if (message.bytes === null) {
			return
		}
		const originSessionId = this.pending.get(message.requestId)
		if (!originSessionId) {
			return
		}
		this.pending.delete(message.requestId)
		this.sendResponseTo(originSessionId, message.requestId, message.bytes)
	}

	private forwardRequestToPeers(sourceSessionId: string, message: BlobChunkRequestMessage): void {
		this.pending.set(message.requestId, sourceSessionId)
		for (const [, client] of this.clients) {
			if (client.sessionId === sourceSessionId) {
				continue
			}
			if (!client.transport.isConnected()) {
				continue
			}
			client.transport.send(message)
		}
	}

	private sendResponseTo(sessionId: string, requestId: string, bytes: string): void {
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
