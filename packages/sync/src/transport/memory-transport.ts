import { SyncError } from '@kora/core'
import type { SyncMessage } from '../protocol/messages'
import type {
	SyncTransport,
	TransportCloseHandler,
	TransportErrorHandler,
	TransportMessageHandler,
	TransportOptions,
} from './transport'

/**
 * In-memory transport for testing. Provides instant, synchronous message delivery
 * between a linked pair of transports (simulating client ↔ server).
 */
export class MemoryTransport implements SyncTransport {
	private connected = false
	private messageHandler: TransportMessageHandler | null = null
	private closeHandler: TransportCloseHandler | null = null
	private errorHandler: TransportErrorHandler | null = null
	private peer: MemoryTransport | null = null
	private readonly sentMessages: SyncMessage[] = []

	/** Link this transport to its peer (the other end of the connection) */
	linkPeer(peer: MemoryTransport): void {
		this.peer = peer
	}

	async connect(_url: string, _options?: TransportOptions): Promise<void> {
		if (!this.peer) {
			throw new SyncError('MemoryTransport has no linked peer', {
				reason: 'not-linked',
			})
		}
		this.connected = true
		this.peer.connected = true
	}

	async disconnect(): Promise<void> {
		if (!this.connected) return
		this.connected = false
		// Notify peer that we disconnected
		if (this.peer?.connected) {
			this.peer.connected = false
			this.peer.closeHandler?.('peer disconnected')
		}
	}

	send(message: SyncMessage): void {
		if (!this.connected) {
			throw new SyncError('Cannot send message: transport is not connected', {
				messageType: message.type,
			})
		}
		this.sentMessages.push(message)
		// Deliver to peer's message handler
		this.peer?.messageHandler?.(message)
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
		return this.connected
	}

	// --- Testing helpers ---

	/**
	 * Simulate an incoming message (as if received from peer).
	 * Useful for testing without a linked peer.
	 */
	simulateIncoming(message: SyncMessage): void {
		this.messageHandler?.(message)
	}

	/**
	 * Simulate a disconnect from the remote side.
	 */
	simulateDisconnect(reason: string): void {
		this.connected = false
		this.closeHandler?.(reason)
	}

	/**
	 * Simulate a transport error.
	 */
	simulateError(error: Error): void {
		this.errorHandler?.(error)
	}

	/**
	 * Get all messages sent through this transport.
	 */
	getSentMessages(): SyncMessage[] {
		return [...this.sentMessages]
	}

	/**
	 * Clear the sent messages history.
	 */
	clearSentMessages(): void {
		this.sentMessages.length = 0
	}
}

/**
 * Create a linked pair of memory transports for testing.
 * Messages sent on `client` arrive at `server` and vice versa.
 */
export function createMemoryTransportPair(): { client: MemoryTransport; server: MemoryTransport } {
	const client = new MemoryTransport()
	const server = new MemoryTransport()
	client.linkPeer(server)
	server.linkPeer(client)
	return { client, server }
}
