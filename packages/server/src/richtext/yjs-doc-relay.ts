import type { SyncMessage, YjsDocUpdateMessage } from '@korajs/sync'
import type { ServerTransport } from '../transport/server-transport'

interface RelayClient {
	sessionId: string
	transport: ServerTransport
}

/**
 * Relays ephemeral Yjs doc channel updates between connected clients.
 * Not persisted — durable richtext state still flows through the operation log.
 */
export class YjsDocRelay {
	private readonly clients = new Map<string, RelayClient>()

	addClient(sessionId: string, transport: ServerTransport): void {
		this.clients.set(sessionId, { sessionId, transport })
	}

	removeClient(sessionId: string): void {
		this.clients.delete(sessionId)
	}

	handleUpdate(sourceSessionId: string, message: YjsDocUpdateMessage): void {
		if (!this.clients.has(sourceSessionId)) {
			return
		}
		this.broadcastExcept(sourceSessionId, message)
	}

	getClientCount(): number {
		return this.clients.size
	}

	clear(): void {
		this.clients.clear()
	}

	private broadcastExcept(excludeSessionId: string, message: SyncMessage): void {
		for (const [, client] of this.clients) {
			if (client.sessionId === excludeSessionId) {
				continue
			}
			if (!client.transport.isConnected()) {
				continue
			}
			client.transport.send(message)
		}
	}
}
