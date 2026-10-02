import { SyncError } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { JsonMessageSerializer } from '@korajs/sync'
import type { MessageSerializer } from '@korajs/sync'
import type {
	ServerCloseHandler,
	ServerErrorHandler,
	ServerMessageHandler,
	ServerTransport,
} from './server-transport'

/** WebSocket ready states (mirrors ws constants) */
const WS_OPEN = 1

/**
 * Default interval between WebSocket pings, in ms (SRV-6, LMS #12). Inside the 30-120 s
 * idle windows of carrier NATs, so an idle connection stays mapped, and long enough
 * that a ping rarely wakes a phone's radio on its own.
 */
export const DEFAULT_WS_HEARTBEAT_INTERVAL_MS = 25_000
/** Pings that may go unanswered before the connection is declared dead. */
export const DEFAULT_WS_MAX_MISSED_PONGS = 2
/**
 * Default ceiling on bytes queued for one client and not yet written to the network
 * (32 MiB). Past it the client is too slow (or gone) and the connection is closed
 * instead of growing server memory without bound. The delivery stream itself pauses
 * far below this (backpressure); the ceiling only catches what bypasses it.
 */
export const DEFAULT_WS_MAX_BUFFERED_BYTES = 32 * 1024 * 1024
/** Close code for a connection that missed its pongs or overflowed its send buffer. */
const CLOSE_CODE_GOING_AWAY = 1001

/**
 * Minimal interface for a ws.WebSocket instance.
 * Allows dependency injection for testing without importing ws directly.
 */
export interface WsWebSocket {
	readyState: number
	send(data: string | Uint8Array, callback?: (err?: Error) => void): void
	close(code?: number, reason?: string): void
	on(event: string, listener: (...args: unknown[]) => void): void
	removeAllListeners(): void
	/** Send a ping frame (ws). Without it, no liveness probing happens. */
	ping?(): void
	/** Destroy the socket at once, emitting `close` (ws). Falls back to `close()`. */
	terminate?(): void
	/** Bytes queued and not yet written to the network (ws). */
	readonly bufferedAmount?: number
}

/**
 * Options for WsServerTransport.
 */
export interface WsServerTransportOptions {
	/** Message serializer. Defaults to JsonMessageSerializer. */
	serializer?: MessageSerializer
	/**
	 * Interval between WebSocket pings, in ms (SRV-6). A connection that leaves
	 * `maxMissedPongs` pings in a row unanswered (and sends nothing else meanwhile) is
	 * terminated, which runs Kora's normal close path. Defaults to 25 seconds; 0
	 * disables probing. Keep it at 15 seconds or more on mobile networks.
	 */
	heartbeatIntervalMs?: number
	/** Unanswered pings before the connection is terminated. Defaults to 2. */
	maxMissedPongs?: number
	/**
	 * Bytes that may be queued for this client before it is disconnected as a slow
	 * consumer. Defaults to 32 MiB; 0 disables the ceiling.
	 */
	maxBufferedBytes?: number
}

/**
 * Server-side transport wrapping a ws.WebSocket connection.
 * Created for each incoming client connection.
 *
 * It probes liveness with WebSocket pings (both the standalone server and
 * `createProductionServer` create their connections through it), so a half-open
 * connection, a peer that vanished without a FIN, is detected and closed instead of
 * holding a session forever.
 */
export class WsServerTransport implements ServerTransport {
	private readonly ws: WsWebSocket
	private readonly serializer: MessageSerializer
	private messageHandler: ServerMessageHandler | null = null
	private closeHandler: ServerCloseHandler | null = null
	private errorHandler: ServerErrorHandler | null = null
	private readonly maxMissedPongs: number
	private readonly maxBufferedBytes: number
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null
	private missedPongs = 0
	private terminated = false

	constructor(ws: WsWebSocket, options?: WsServerTransportOptions) {
		this.ws = ws
		this.serializer = options?.serializer ?? new JsonMessageSerializer()
		this.maxMissedPongs = Math.max(1, options?.maxMissedPongs ?? DEFAULT_WS_MAX_MISSED_PONGS)
		this.maxBufferedBytes = options?.maxBufferedBytes ?? DEFAULT_WS_MAX_BUFFERED_BYTES
		this.setupListeners()
		this.startHeartbeat(options?.heartbeatIntervalMs ?? DEFAULT_WS_HEARTBEAT_INTERVAL_MS)
	}

	send(message: SyncMessage): void {
		if (this.ws.readyState !== WS_OPEN) {
			throw new SyncError('Cannot send message: WebSocket is not open', {
				readyState: this.ws.readyState,
				messageType: message.type,
			})
		}

		const encoded = this.serializer.encode(message)
		this.ws.send(encoded)
		if (this.maxBufferedBytes > 0 && this.bufferedAmount() > this.maxBufferedBytes) {
			// The client is not reading (or reads far slower than the server writes).
			// Disconnect it rather than buffer without bound; it resumes from its
			// delivery watermark on reconnect, so nothing is lost.
			this.terminate('slow consumer: send buffer exceeded')
		}
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
		return this.ws.readyState === WS_OPEN
	}

	close(code?: number, reason?: string): void {
		this.stopHeartbeat()
		this.ws.close(code ?? 1000, reason ?? 'server closing')
	}

	bufferedAmount(): number {
		const amount = this.ws.bufferedAmount
		return typeof amount === 'number' && Number.isFinite(amount) ? amount : 0
	}

	/**
	 * Ping every `intervalMs`; terminate once `maxMissedPongs` pings in a row went
	 * unanswered. A pong or any inbound message proves the peer alive.
	 */
	private startHeartbeat(intervalMs: number): void {
		if (intervalMs <= 0 || typeof this.ws.ping !== 'function') return
		this.heartbeatTimer = setInterval(() => {
			if (this.ws.readyState !== WS_OPEN) {
				this.stopHeartbeat()
				return
			}
			if (this.missedPongs >= this.maxMissedPongs) {
				this.terminate('heartbeat timeout: no pong')
				return
			}
			this.missedPongs += 1
			try {
				this.ws.ping?.()
			} catch {
				// A ping on a dying socket throws; the next tick (or its close) settles it.
			}
		}, intervalMs)
		// A heartbeat must never keep a Node process alive on its own.
		;(this.heartbeatTimer as { unref?: () => void }).unref?.()
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer !== null) {
			clearInterval(this.heartbeatTimer)
			this.heartbeatTimer = null
		}
	}

	/**
	 * Drop the connection at once. ws emits `close` from `terminate()`, which runs
	 * Kora's normal close path (session, relays and side channels are released).
	 */
	private terminate(reason: string): void {
		if (this.terminated) return
		this.terminated = true
		this.stopHeartbeat()
		if (typeof this.ws.terminate === 'function') {
			this.ws.terminate()
		} else {
			this.ws.close(CLOSE_CODE_GOING_AWAY, reason)
		}
	}

	private setupListeners(): void {
		this.ws.on('message', (data: unknown) => {
			this.missedPongs = 0
			try {
				if (
					typeof data !== 'string' &&
					!(data instanceof Uint8Array) &&
					!(data instanceof ArrayBuffer)
				) {
					throw new SyncError('Unsupported WebSocket payload type', {
						payloadType: typeof data,
					})
				}

				const decoded = this.serializer.decode(data)
				this.messageHandler?.(decoded)
			} catch (err) {
				this.errorHandler?.(err instanceof Error ? err : new Error(String(err)))
			}
		})

		this.ws.on('pong', () => {
			this.missedPongs = 0
		})

		this.ws.on('close', (code: unknown, reason: unknown) => {
			this.stopHeartbeat()
			this.closeHandler?.(Number(code) || 1006, String(reason || 'connection closed'))
		})

		this.ws.on('error', (err: unknown) => {
			this.errorHandler?.(err instanceof Error ? err : new Error(String(err)))
		})
	}
}
