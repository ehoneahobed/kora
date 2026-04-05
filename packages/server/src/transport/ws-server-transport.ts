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
 * Minimal interface for a ws.WebSocket instance.
 * Allows dependency injection for testing without importing ws directly.
 */
export interface WsWebSocket {
	readyState: number
	send(data: string | Uint8Array, callback?: (err?: Error) => void): void
	close(code?: number, reason?: string): void
	on(event: string, listener: (...args: unknown[]) => void): void
	removeAllListeners(): void
}

/**
 * Options for WsServerTransport.
 */
export interface WsServerTransportOptions {
	/** Message serializer. Defaults to JsonMessageSerializer. */
	serializer?: MessageSerializer
}

/**
 * Server-side transport wrapping a ws.WebSocket connection.
 * Created for each incoming client connection.
 */
export class WsServerTransport implements ServerTransport {
	private readonly ws: WsWebSocket
	private readonly serializer: MessageSerializer
	private messageHandler: ServerMessageHandler | null = null
	private closeHandler: ServerCloseHandler | null = null
	private errorHandler: ServerErrorHandler | null = null

	constructor(ws: WsWebSocket, options?: WsServerTransportOptions) {
		this.ws = ws
		this.serializer = options?.serializer ?? new JsonMessageSerializer()
		this.setupListeners()
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
		this.ws.close(code ?? 1000, reason ?? 'server closing')
	}

	private setupListeners(): void {
		this.ws.on('message', (data: unknown) => {
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

		this.ws.on('close', (code: unknown, reason: unknown) => {
			this.closeHandler?.(Number(code) || 1006, String(reason || 'connection closed'))
		})

		this.ws.on('error', (err: unknown) => {
			this.errorHandler?.(err instanceof Error ? err : new Error(String(err)))
		})
	}
}
