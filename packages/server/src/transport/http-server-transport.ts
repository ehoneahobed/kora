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
}

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

	constructor(serializer: MessageSerializer) {
		this.serializer = serializer
	}

	send(message: import('@korajs/sync').SyncMessage): void {
		if (!this.connected) return

		const encoded = this.serializer.encode(message)
		const isBinary = encoded instanceof Uint8Array
		this.queue.push({
			etag: this.makeEtag(this.nextSequence++),
			contentType: isBinary ? 'application/x-protobuf' : 'application/json',
			payload: encoded,
		})
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

	close(code = 1000, reason = 'transport closed'): void {
		if (!this.connected) return
		this.connected = false
		this.queue.length = 0
		this.closeHandler?.(code, reason)
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
		if (!this.connected) {
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
