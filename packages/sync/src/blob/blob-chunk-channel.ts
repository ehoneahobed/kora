import { generateUUIDv7 } from '@korajs/core'
import type {
	BlobChunkPushMessage,
	BlobChunkRequestMessage,
	BlobChunkResponseMessage,
} from '../protocol/messages'

/**
 * A blob-chunk message in decoded form (chunk bytes as a `Uint8Array` rather
 * than the base64 wire string). This is the shape callers of the channel work
 * with; the channel handles base64 encode/decode at the wire boundary.
 *
 * The shape mirrors `@korajs/store`'s `ChunkMessage` so an app-layer adapter can
 * bridge the two with no field translation.
 */
export type BlobChunkChannelMessage =
	| { type: 'blob-chunk-request'; requestId: string; hash: string }
	| {
			type: 'blob-chunk-response'
			requestId: string
			bytes: Uint8Array | null
			/** The server refused the request for rate; retry after `retryAfterMs` (RT-24). */
			throttled?: boolean
			retryAfterMs?: number
	  }
	| { type: 'blob-chunk-push'; hash: string; bytes: Uint8Array }

/** Encode chunk bytes to a base64 string for the JSON wire. */
export function encodeBlobChunkBytes(bytes: Uint8Array): string {
	let binary = ''
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i] as number)
	}
	return btoa(binary)
}

/** Decode base64 chunk bytes from the wire back to a `Uint8Array`. */
export function decodeBlobChunkBytes(encoded: string): Uint8Array {
	const binary = atob(encoded)
	const out = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) {
		out[i] = binary.charCodeAt(i)
	}
	return out
}

export interface BlobChunkChannelOptions {
	/**
	 * Called when a local blob-chunk message should go out on the wire. The
	 * caller (the sync engine) decides whether the connection is ready to send,
	 * and returns `false` when it did not send the message (no accepted handshake);
	 * any other return (including none) counts as sent.
	 */
	onSend?: BlobChunkSendHandler
}

/**
 * Sends one blob-chunk message on the wire; `false` means it was not sent.
 */
export type BlobChunkSendHandler = (
	message: BlobChunkRequestMessage | BlobChunkResponseMessage | BlobChunkPushMessage,
	// biome-ignore lint/suspicious/noConfusingVoidType: handlers written against the earlier void-returning signature must still type-check; only an explicit false means "not sent".
) => boolean | void

/**
 * Ephemeral side channel for out-of-band blob chunk transfer over the sync
 * connection. Symmetric: a peer can both request chunks it needs and answer
 * requests for chunks it holds. Never persisted in the operation log — durable
 * state is the `BlobRef` inside a record's fields; this channel only moves the
 * referenced bytes.
 *
 * The channel owns the base64 wire encoding so callers work purely in
 * `Uint8Array`, and its {@link BlobChunkChannelMessage} shape mirrors
 * `@korajs/store`'s `ChunkMessage` so the app layer can expose it as a
 * `ChunkMessagePort` without translating fields.
 */
export class BlobChunkChannel {
	private readonly onSend: BlobChunkSendHandler | null
	private readonly handlers = new Set<(message: BlobChunkChannelMessage) => void>()
	private readonly readyHandlers = new Set<() => void>()

	constructor(options?: BlobChunkChannelOptions) {
		this.onSend = options?.onSend ?? null
	}

	/**
	 * Send a blob-chunk message to the peer. Response bytes are base64-encoded
	 * onto the wire here; callers pass a `Uint8Array`.
	 *
	 * @returns `true` when the message went out on the wire, `false` when it was not
	 * sent (no connection with an accepted handshake). A request that was not sent is
	 * the caller's to re-send: {@link onReady} says when the connection can carry it.
	 */
	send(message: BlobChunkChannelMessage): boolean {
		if (!this.onSend) {
			return false
		}
		if (message.type === 'blob-chunk-request') {
			return (
				this.onSend({
					type: 'blob-chunk-request',
					messageId: generateUUIDv7(),
					requestId: message.requestId,
					hash: message.hash,
				}) !== false
			)
		}
		if (message.type === 'blob-chunk-push') {
			return (
				this.onSend({
					type: 'blob-chunk-push',
					messageId: generateUUIDv7(),
					hash: message.hash,
					bytes: encodeBlobChunkBytes(message.bytes),
				}) !== false
			)
		}
		const sent = this.onSend({
			type: 'blob-chunk-response',
			messageId: generateUUIDv7(),
			requestId: message.requestId,
			bytes: message.bytes === null ? null : encodeBlobChunkBytes(message.bytes),
			...(message.throttled ? { throttled: true } : {}),
			...(message.retryAfterMs !== undefined ? { retryAfterMs: message.retryAfterMs } : {}),
		})
		return sent !== false
	}

	/**
	 * Register a handler called each time the connection becomes able to carry blob
	 * messages (a handshake was accepted, after a connect or a reconnect). Requests
	 * still awaiting an answer may have been lost with the previous connection, or
	 * never sent, so a requester re-sends them here.
	 *
	 * @returns A function that removes the handler
	 */
	onReady(handler: () => void): () => void {
		this.readyHandlers.add(handler)
		return () => {
			this.readyHandlers.delete(handler)
		}
	}

	/** Tell {@link onReady} handlers the connection can carry blob messages again. */
	notifyReady(): void {
		for (const handler of [...this.readyHandlers]) {
			try {
				handler()
			} catch {
				// A ready handler must never break the connection's state change.
			}
		}
	}

	/**
	 * Register a handler for inbound blob-chunk messages. Multiple handlers are
	 * allowed; each receives every delivered message.
	 */
	onMessage(handler: (message: BlobChunkChannelMessage) => void): () => void {
		this.handlers.add(handler)
		return () => {
			this.handlers.delete(handler)
		}
	}

	/**
	 * Deliver an inbound wire message to registered handlers, decoding response
	 * bytes from base64 back to a `Uint8Array` first.
	 */
	deliver(
		message: BlobChunkRequestMessage | BlobChunkResponseMessage | BlobChunkPushMessage,
	): void {
		if (this.handlers.size === 0) {
			return
		}
		const decoded: BlobChunkChannelMessage =
			message.type === 'blob-chunk-request'
				? { type: 'blob-chunk-request', requestId: message.requestId, hash: message.hash }
				: message.type === 'blob-chunk-push'
					? {
							type: 'blob-chunk-push',
							hash: message.hash,
							bytes: decodeBlobChunkBytes(message.bytes),
						}
					: {
							type: 'blob-chunk-response',
							requestId: message.requestId,
							bytes: message.bytes === null ? null : decodeBlobChunkBytes(message.bytes),
							...(message.throttled ? { throttled: true } : {}),
							...(message.retryAfterMs !== undefined ? { retryAfterMs: message.retryAfterMs } : {}),
						}
		for (const handler of this.handlers) {
			handler(decoded)
		}
	}
}
