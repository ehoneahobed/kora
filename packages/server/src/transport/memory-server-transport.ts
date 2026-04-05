import type { SyncMessage } from '@korajs/sync'
import type {
	ServerCloseHandler,
	ServerErrorHandler,
	ServerMessageHandler,
	ServerTransport,
} from './server-transport'

/**
 * In-memory server transport for testing. Wraps the server side of a
 * MemoryTransport pair, adapting it to the ServerTransport interface.
 *
 * Messages sent through this transport arrive at the linked client MemoryTransport.
 */
export class MemoryServerTransport implements ServerTransport {
	private connected = true
	private messageHandler: ServerMessageHandler | null = null
	private closeHandler: ServerCloseHandler | null = null
	private errorHandler: ServerErrorHandler | null = null
	private readonly sentMessages: SyncMessage[] = []
	private sendToClient: ((message: SyncMessage) => void) | null = null
	private clientDisconnect: (() => void) | null = null

	/**
	 * Wire up the send-to-client function and client disconnect notifier.
	 * Called by createServerTransportPair.
	 */
	_link(sendToClient: (message: SyncMessage) => void, clientDisconnect: () => void): void {
		this.sendToClient = sendToClient
		this.clientDisconnect = clientDisconnect
	}

	/**
	 * Deliver a message from the client side into this transport.
	 * Called by the linked client transport.
	 */
	_receiveFromClient(message: SyncMessage): void {
		this.messageHandler?.(message)
	}

	/**
	 * Notify this transport that the client disconnected.
	 */
	_notifyClientDisconnected(): void {
		if (!this.connected) return
		this.connected = false
		this.closeHandler?.(1000, 'client disconnected')
	}

	send(message: SyncMessage): void {
		if (!this.connected) {
			throw new Error('Cannot send message: server transport is not connected')
		}
		this.sentMessages.push(message)
		this.sendToClient?.(message)
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

	close(code?: number, reason?: string): void {
		if (!this.connected) return
		this.connected = false
		this.clientDisconnect?.()
	}

	// --- Testing helpers ---

	/** Get all messages sent through this transport. */
	getSentMessages(): SyncMessage[] {
		return [...this.sentMessages]
	}

	/** Simulate a disconnect from the client side. */
	simulateDisconnect(): void {
		this._notifyClientDisconnected()
	}
}

/**
 * Minimal client-side transport that pairs with MemoryServerTransport.
 * Implements the same interface shape as @korajs/sync MemoryTransport but
 * specifically designed for server testing without importing internal modules.
 */
class MemoryClientTransport {
	private connected = true
	private messageHandler: ((message: SyncMessage) => void) | null = null
	private closeHandler: ((reason: string) => void) | null = null
	private errorHandler: ((error: Error) => void) | null = null
	private readonly sentMessages: SyncMessage[] = []
	private sendToServer: ((message: SyncMessage) => void) | null = null
	private serverNotifyDisconnect: (() => void) | null = null

	_link(sendToServer: (message: SyncMessage) => void, serverNotifyDisconnect: () => void): void {
		this.sendToServer = sendToServer
		this.serverNotifyDisconnect = serverNotifyDisconnect
	}

	_receiveFromServer(message: SyncMessage): void {
		this.messageHandler?.(message)
	}

	_notifyServerDisconnected(): void {
		if (!this.connected) return
		this.connected = false
		this.closeHandler?.('server disconnected')
	}

	async connect(_url: string): Promise<void> {
		this.connected = true
	}

	async disconnect(): Promise<void> {
		if (!this.connected) return
		this.connected = false
		this.serverNotifyDisconnect?.()
	}

	send(message: SyncMessage): void {
		if (!this.connected) {
			throw new Error('Cannot send message: client transport is not connected')
		}
		this.sentMessages.push(message)
		this.sendToServer?.(message)
	}

	onMessage(handler: (message: SyncMessage) => void): void {
		this.messageHandler = handler
	}

	onClose(handler: (reason: string) => void): void {
		this.closeHandler = handler
	}

	onError(handler: (error: Error) => void): void {
		this.errorHandler = handler
	}

	isConnected(): boolean {
		return this.connected
	}

	getSentMessages(): SyncMessage[] {
		return [...this.sentMessages]
	}

	simulateIncoming(message: SyncMessage): void {
		this.messageHandler?.(message)
	}

	simulateDisconnect(reason: string): void {
		this.connected = false
		this.closeHandler?.(reason)
	}

	simulateError(error: Error): void {
		this.errorHandler?.(error)
	}

	clearSentMessages(): void {
		this.sentMessages.length = 0
	}
}

/**
 * Create a linked pair of memory transports for server testing.
 * Messages sent on `client` arrive at `server` and vice versa.
 * The client transport implements SyncTransport-compatible interface.
 */
export function createServerTransportPair(): {
	client: MemoryClientTransport
	server: MemoryServerTransport
} {
	const client = new MemoryClientTransport()
	const server = new MemoryServerTransport()

	// Wire: client.send → server._receiveFromClient
	// Wire: server.send → client._receiveFromServer
	client._link(
		(msg) => server._receiveFromClient(msg),
		() => server._notifyClientDisconnected(),
	)
	server._link(
		(msg) => client._receiveFromServer(msg),
		() => client._notifyServerDisconnected(),
	)

	return { client, server }
}
