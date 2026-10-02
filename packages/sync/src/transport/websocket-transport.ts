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
	/** Connection timeout in ms. Defaults to 10000 (10s). */
	connectTimeout?: number
	/**
	 * Also append the auth token to the connection URL as `?token=`. Off by
	 * default: the token already travels in the handshake message, and URLs are
	 * recorded by reverse proxies, load balancers and access logs. Enable only for an
	 * intermediary that authenticates the WebSocket upgrade by query parameter.
	 */
	tokenInUrl?: boolean
	/**
	 * Detect dead connections with the server's application-level heartbeat (LMS #12).
	 * The transport advertises support in the handshake; a server that sends
	 * heartbeats states their interval, and a connection that then receives nothing
	 * for `heartbeatTimeoutFactor` intervals is closed as dead, which starts a
	 * reconnect. Browsers cannot observe WebSocket pings, so without this a half-open
	 * connection (a phone that changed networks) looks alive until TCP gives up, often
	 * minutes later. Defaults to true.
	 */
	heartbeat?: boolean
	/** Silent intervals tolerated before the connection is declared dead. Defaults to 2.5. */
	heartbeatTimeoutFactor?: number
}

// WebSocket readyState constants
const WS_OPEN = 1

/**
 * WebSocket-based sync transport implementation.
 *
 * Every socket is bound to a generation (SYNC-5): `connect()` closes and detaches the
 * previous socket first, and callbacks of a superseded socket are ignored, so a stale
 * socket closing late can never sever (or feed messages into) the live session.
 */
export class WebSocketTransport implements SyncTransport {
	private ws: WebSocketLike | null = null
	/** Incremented for every socket; callbacks check theirs is still current. */
	private generation = 0
	private messageHandler: TransportMessageHandler | null = null
	private closeHandler: TransportCloseHandler | null = null
	private errorHandler: TransportErrorHandler | null = null
	private readonly serializer: MessageSerializer
	private readonly WebSocketImpl: WebSocketConstructor
	private readonly connectTimeout: number
	private readonly tokenInUrl: boolean
	private readonly heartbeat: boolean
	private readonly heartbeatTimeoutFactor: number
	/** Silence (ms) after which the current connection is declared dead; 0 = unarmed. */
	private livenessTimeoutMs = 0
	private livenessTimer: ReturnType<typeof setTimeout> | null = null

	constructor(options?: WebSocketTransportOptions) {
		this.serializer = options?.serializer ?? new JsonMessageSerializer()
		this.connectTimeout = options?.connectTimeout ?? 10000
		this.tokenInUrl = options?.tokenInUrl ?? false
		this.heartbeat = options?.heartbeat ?? true
		this.heartbeatTimeoutFactor = Math.max(1.5, options?.heartbeatTimeoutFactor ?? 2.5)

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

		// Never let two sockets feed one engine: close and detach any previous socket
		// before opening the next (SYNC-5).
		this.releaseSocket('Client reconnecting')
		const generation = ++this.generation
		const isCurrent = (): boolean => generation === this.generation

		return new Promise<void>((resolve, reject) => {
			let settled = false

			const settle = (fn: () => void): void => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				fn()
			}

			// Connection timeout — prevents hanging for 30+ seconds on mobile when offline
			const timer = setTimeout(() => {
				settle(() => {
					const err = new SyncError('WebSocket connection timed out', {
						url,
						timeout: this.connectTimeout,
					})
					if (isCurrent()) {
						this.releaseSocket('Connection timed out')
						this.errorHandler?.(err)
					}
					reject(err)
				})
			}, this.connectTimeout)

			try {
				// The token is NOT put in the URL by default (it is sent in the handshake);
				// see WebSocketTransportOptions.tokenInUrl for the explicit opt-in.
				const connectUrl =
					this.tokenInUrl && options?.authToken
						? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(options.authToken)}`
						: url

				const ws = new this.WebSocketImpl(connectUrl)
				this.ws = ws

				ws.onopen = () => {
					if (!isCurrent()) return
					settle(() => resolve())
				}

				ws.onmessage = (event: { data: unknown }) => {
					if (!isCurrent()) return
					// Any inbound frame proves the connection alive.
					this.touchLiveness()
					try {
						if (
							typeof event.data !== 'string' &&
							!(event.data instanceof Uint8Array) &&
							!(event.data instanceof ArrayBuffer)
						) {
							return
						}

						const message = this.serializer.decode(event.data)
						if (message.type === 'heartbeat') return
						if (
							message.type === 'handshake-response' &&
							typeof message.heartbeatIntervalMs === 'number' &&
							message.heartbeatIntervalMs > 0
						) {
							this.armLiveness(message.heartbeatIntervalMs)
						}
						this.messageHandler?.(message)
					} catch {
						this.errorHandler?.(new SyncError('Failed to decode incoming message'))
					}
				}

				ws.onclose = (event: { reason: string; code: number }) => {
					// A superseded socket closing late must not touch the live one (SYNC-5).
					if (!isCurrent()) return
					this.ws = null
					this.clearLiveness()
					this.livenessTimeoutMs = 0
					this.closeHandler?.(event.reason || `WebSocket closed with code ${event.code}`)
				}

				ws.onerror = (_event: unknown) => {
					if (!isCurrent()) return
					const err = new SyncError('WebSocket error', {
						url,
					})
					this.errorHandler?.(err)
					// If we haven't connected yet, reject the connect promise
					if (!this.isConnected()) {
						this.ws = null
						settle(() => reject(err))
					}
				}
			} catch (err) {
				settle(() =>
					reject(
						err instanceof SyncError
							? err
							: new SyncError('Failed to create WebSocket', {
									url,
									error: String(err),
								}),
					),
				)
			}
		})
	}

	async disconnect(): Promise<void> {
		// Invalidate the current socket's callbacks: an intentional disconnect fires no
		// close handler.
		this.generation++
		this.releaseSocket('Client disconnecting')
	}

	send(message: SyncMessage): void {
		if (!this.ws || this.ws.readyState !== WS_OPEN) {
			throw new SyncError('Cannot send message: WebSocket is not connected', {
				messageType: message.type,
			})
		}
		// The heartbeat is a transport capability, so the transport advertises it.
		const outgoing: SyncMessage =
			this.heartbeat && message.type === 'handshake'
				? { ...message, supportsHeartbeat: true }
				: message
		const encoded = this.serializer.encode(outgoing)
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

	/** Close and detach the current socket, if any, without firing the close handler. */
	private releaseSocket(reason: string): void {
		this.clearLiveness()
		this.livenessTimeoutMs = 0
		const ws = this.ws
		this.ws = null
		if (!ws) return
		ws.onopen = null
		ws.onmessage = null
		ws.onclose = null
		ws.onerror = null
		try {
			ws.close(1000, reason)
		} catch {
			// Closing an already-failed socket can throw; it is detached either way.
		}
	}

	/** Start watching for silence once the server stated its heartbeat interval. */
	private armLiveness(heartbeatIntervalMs: number): void {
		if (!this.heartbeat) return
		this.livenessTimeoutMs = Math.round(heartbeatIntervalMs * this.heartbeatTimeoutFactor)
		this.touchLiveness()
	}

	private touchLiveness(): void {
		if (this.livenessTimeoutMs <= 0) return
		this.clearLiveness()
		const generation = this.generation
		this.livenessTimer = setTimeout(() => {
			this.livenessTimer = null
			if (generation !== this.generation || this.ws === null) return
			// Nothing arrived for several heartbeat intervals: the connection is dead even
			// though the browser still reports it open. Drop it and report the close so
			// the engine reconnects.
			const silenceMs = this.livenessTimeoutMs
			this.generation++
			this.releaseSocket('Heartbeat timeout')
			this.closeHandler?.(`Heartbeat timeout: no message from the server for ${silenceMs} ms`)
		}, this.livenessTimeoutMs)
	}

	private clearLiveness(): void {
		if (this.livenessTimer !== null) {
			clearTimeout(this.livenessTimer)
			this.livenessTimer = null
		}
	}
}
