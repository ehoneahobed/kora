import type { SyncMessage } from '@kora/sync'

/**
 * Handler for incoming sync messages on the server side.
 */
export type ServerMessageHandler = (message: SyncMessage) => void

/**
 * Handler for connection close events on the server side.
 */
export type ServerCloseHandler = (code: number, reason: string) => void

/**
 * Handler for transport errors on the server side.
 */
export type ServerErrorHandler = (error: Error) => void

/**
 * Server-side transport interface. Unlike SyncTransport (client-side),
 * the server does not connect outward — it receives connections.
 * Each ServerTransport represents one already-established client connection.
 */
export interface ServerTransport {
	/** Send a sync message to the connected client */
	send(message: SyncMessage): void

	/** Register a handler for incoming messages from the client */
	onMessage(handler: ServerMessageHandler): void

	/** Register a handler for connection close events */
	onClose(handler: ServerCloseHandler): void

	/** Register a handler for transport errors */
	onError(handler: ServerErrorHandler): void

	/** Returns true if the transport connection is active */
	isConnected(): boolean

	/** Close the connection to the client */
	close(code?: number, reason?: string): void
}
