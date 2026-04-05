import { SyncError } from '@korajs/core'
import type { SyncMessage } from '../protocol/messages'
import { JsonMessageSerializer } from '../protocol/serializer'
import type { MessageSerializer } from '../protocol/serializer'
import type {
	SyncTransport,
	TransportCloseHandler,
	TransportErrorHandler,
	TransportMessageHandler,
	TransportOptions,
} from './transport'

/**
 * WebSocket event interface for dependency injection.
 * Matches the subset of the browser WebSocket API that we need.
 */
export interface WebSocketLike {
	readonly readyState: number
	send(data: string | Uint8Array): void
	close(code?: number, reason?: string): void
	onopen: ((event: unknown) => void) | null
	onmessage: ((event: { data: unknown }) => void) | null
	onclose: ((event: { reason: string; code: number }) => void) | null
	onerror: ((event: unknown) => void) | null
}

/**
 * Constructor for WebSocket-like objects. Allows injection of mock WebSocket for testing.
 */
export type WebSocketConstructor = new (url: string, protocols?: string | string[]) => WebSocketLike

/**
 * Options for the WebSocket transport.
 */
export interface WebSocketTransportOptions {
	/** Custom serializer. Defaults to JSON. */
	serializer?: MessageSerializer
	/** Injectable WebSocket constructor for testing. Defaults to globalThis.WebSocket. */
	WebSocketImpl?: WebSocketConstructor
}

// WebSocket readyState constants
const WS_OPEN = 1

/**
 * WebSocket-based sync transport implementation.
 */
export class WebSocketTransport implements SyncTransport {
	private ws: WebSocketLike | null = null
	private messageHandler: TransportMessageHandler | null = null
	private closeHandler: TransportCloseHandler | null = null
	private errorHandler: TransportErrorHandler | null = null
	private readonly serializer: MessageSerializer
	private readonly WebSocketImpl: WebSocketConstructor

	constructor(options?: WebSocketTransportOptions) {
		this.serializer = options?.serializer ?? new JsonMessageSerializer()

		if (options?.WebSocketImpl) {
			this.WebSocketImpl = options.WebSocketImpl
		} else if (typeof globalThis.WebSocket !== 'undefined') {
			this.WebSocketImpl = globalThis.WebSocket as unknown as WebSocketConstructor
		} else {
			// Deferred — will throw on connect() if no implementation available
			this.WebSocketImpl = null as unknown as WebSocketConstructor
		}
	}

	async connect(url: string, options?: TransportOptions): Promise<void> {
		if (!this.WebSocketImpl) {
			throw new SyncError('WebSocket is not available in this environment', {
				hint: 'Provide a WebSocketImpl option or use a polyfill',
			})
		}

		return new Promise<void>((resolve, reject) => {
			try {
				// Append auth token as query param if provided
				const connectUrl = options?.authToken
					? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(options.authToken)}`
					: url

				const ws = new this.WebSocketImpl(connectUrl)
				this.ws = ws

				ws.onopen = () => {
					resolve()
				}

				ws.onmessage = (event: { data: unknown }) => {
					try {
						if (
							typeof event.data !== 'string' &&
							!(event.data instanceof Uint8Array) &&
							!(event.data instanceof ArrayBuffer)
						) {
							return
						}

						const message = this.serializer.decode(event.data)
						this.messageHandler?.(message)
					} catch {
						this.errorHandler?.(new SyncError('Failed to decode incoming message'))
					}
				}

				ws.onclose = (event: { reason: string; code: number }) => {
					this.ws = null
					this.closeHandler?.(event.reason || `WebSocket closed with code ${event.code}`)
				}

				ws.onerror = (event: unknown) => {
					const err = new SyncError('WebSocket error', {
						url,
					})
					this.errorHandler?.(err)
					// If we haven't connected yet, reject the connect promise
					if (!this.isConnected()) {
						this.ws = null
						reject(err)
					}
				}
			} catch (err) {
				reject(
					err instanceof SyncError
						? err
						: new SyncError('Failed to create WebSocket', {
								url,
								error: String(err),
							}),
				)
			}
		})
	}

	async disconnect(): Promise<void> {
		if (this.ws) {
			this.ws.onclose = null // Prevent close handler firing for intentional disconnect
			this.ws.close(1000, 'Client disconnecting')
			this.ws = null
		}
	}

	send(message: SyncMessage): void {
		if (!this.ws || this.ws.readyState !== WS_OPEN) {
			throw new SyncError('Cannot send message: WebSocket is not connected', {
				messageType: message.type,
			})
		}
		const encoded = this.serializer.encode(message)
		this.ws.send(encoded)
	}

	onMessage(handler: TransportMessageHandler): void {
		this.messageHandler = handler
	}

	onClose(handler: TransportCloseHandler): void {
		this.closeHandler = handler
	}

	onError(handler: TransportErrorHandler): void {
		this.errorHandler = handler
	}

	isConnected(): boolean {
		return this.ws !== null && this.ws.readyState === WS_OPEN
	}
}
