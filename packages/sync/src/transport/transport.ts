import type { SyncMessage } from '../protocol/messages'

/**
 * Options for transport connection.
 */
export interface TransportOptions {
	/** Authentication token sent during connection */
	authToken?: string
	/** Additional headers (for HTTP-based transports) */
	headers?: Record<string, string>
}

/**
 * Transport-level error handler.
 */
export type TransportErrorHandler = (error: Error) => void

/**
 * Transport-level close handler.
 */
export type TransportCloseHandler = (reason: string) => void

/**
 * Transport-level message handler.
 */
export type TransportMessageHandler = (message: SyncMessage) => void

/**
 * Abstract transport interface for sync communication.
 * Implementations can use WebSocket, HTTP, Bluetooth, or any other transport.
 */
export interface SyncTransport {
	/** Connect to the sync server at the given URL */
	connect(url: string, options?: TransportOptions): Promise<void>

	/** Disconnect from the server */
	disconnect(): Promise<void>

	/** Send a sync message */
	send(message: SyncMessage): void

	/** Register a handler for incoming messages */
	onMessage(handler: TransportMessageHandler): void

	/** Register a handler for connection close events */
	onClose(handler: TransportCloseHandler): void

	/** Register a handler for transport errors */
	onError(handler: TransportErrorHandler): void

	/** Returns true if the transport is currently connected */
	isConnected(): boolean
}
