import { SyncError } from '@korajs/core'
import type { MessageSerializer } from '@korajs/sync'
import type {
	ServerCloseHandler,
	ServerErrorHandler,
	ServerMessageHandler,
	ServerTransport,
} from './server-transport'

export interface HttpPollResponse {
	status: 200 | 204 | 304 | 410
	body?: string | Uint8Array
	headers?: Record<string, string>
}

interface QueuedMessage {
	etag: string
	contentType: string
	payload: string | Uint8Array
	/** Approximate size of `payload` in bytes. */
	bytes: number
}

/**
 * Default ceiling on bytes queued for an HTTP long-poll client that is not polling
 * (32 MiB). Past it the session is closed instead of growing server memory without
 * bound; the client resumes from its delivery watermark on its next handshake.
 */
export const DEFAULT_HTTP_MAX_QUEUED_BYTES = 32 * 1024 * 1024

/**
 * Server-side transport for HTTP long-polling clients.
 *
 * Incoming client messages are pushed via POST, while outbound server
 * messages are pulled via GET long-poll requests.
 */
export class HttpServerTransport implements ServerTransport {
	private readonly serializer: MessageSerializer

	private messageHandler: ServerMessageHandler | null = null
	private closeHandler: ServerCloseHandler | null = null
	private errorHandler: ServerErrorHandler | null = null

	private connected = true
	private nextSequence = 1
	private readonly queue: QueuedMessage[] = []
	private queuedBytes = 0
	private readonly maxQueuedBytes: number

	/**
	 * @param serializer - Message serializer
	 * @param options - `maxQueuedBytes`: close the session once this many bytes wait
	 *   unpolled (default 32 MiB; 0 disables the ceiling)
	 */
	constructor(serializer: MessageSerializer, options: { maxQueuedBytes?: number } = {}) {
		this.serializer = serializer
		this.maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_HTTP_MAX_QUEUED_BYTES
	}

	send(message: import('@korajs/sync').SyncMessage): void {
		if (!this.connected) return

		const encoded = this.serializer.encode(message)
		const isBinary = encoded instanceof Uint8Array
		// UTF-16 length is a cheap upper-bound proxy for the UTF-8 size of JSON text.
		const bytes = isBinary ? encoded.byteLength : encoded.length
		this.queue.push({
			etag: this.makeEtag(this.nextSequence++),
			contentType: isBinary ? 'application/x-protobuf' : 'application/json',
			payload: encoded,
			bytes,
		})
		this.queuedBytes += bytes
		if (this.maxQueuedBytes > 0 && this.queuedBytes > this.maxQueuedBytes) {
			// The client stopped polling: end the session rather than buffer without bound
			// (and drop what it never collected).
			this.queue.length = 0
			this.queuedBytes = 0
			this.close(1001, 'http session queue overflow')
		}
	}

	/** Bytes queued for the client and not yet polled (delivery-stream backpressure). */
	bufferedAmount(): number {
		return this.queuedBytes
	}

	onMessage(handler: ServerMessageHandler): void {
		this.messageHandler = handler
	}

	onClose(handler: ServerCloseHandler): void {
		this.closeHandler = handler
	}

	onError(handler: ServerErrorHandler): void {
		this.errorHandler = handler
	}

	isConnected(): boolean {
		return this.connected
	}

	/**
	 * Close the session. Messages already queued (typically the final error that
	 * explains the close, for example a refused handshake) stay pollable, so a
	 * long-polling client learns why, exactly as a WebSocket client receives the error
	 * frame before the close; once drained, polls answer 410.
	 */
	close(code = 1000, reason = 'transport closed'): void {
		if (!this.connected) return
		this.connected = false
		this.closeHandler?.(code, reason)
	}

	/** True while messages queued before the close are still waiting to be polled. */
	hasPending(): boolean {
		return this.queue.length > 0
	}

	receive(payload: string | Uint8Array): void {
		if (!this.connected) {
			throw new SyncError('HTTP server transport is closed')
		}

		try {
			const message = this.serializer.decode(payload)
			this.messageHandler?.(message)
		} catch (error) {
			this.errorHandler?.(error instanceof Error ? error : new Error(String(error)))
		}
	}

	poll(ifNoneMatch?: string): HttpPollResponse {
		if (!this.connected && this.queue.length === 0) {
			return { status: 410 }
		}

		const next = this.queue[0]
		if (!next) {
			return { status: 204 }
		}

		if (ifNoneMatch && ifNoneMatch === next.etag) {
			return {
				status: 304,
				headers: { etag: next.etag },
			}
		}

		this.queue.shift()
		this.queuedBytes = Math.max(0, this.queuedBytes - next.bytes)
		return {
			status: 200,
			body: next.payload,
			headers: {
				'content-type': next.contentType,
				etag: next.etag,
			},
		}
	}

	private makeEtag(sequence: number): string {
		return `W/"${sequence}"`
	}
}
