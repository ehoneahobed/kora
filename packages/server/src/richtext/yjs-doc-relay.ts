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

	/**
	 * Relay an update from a registered session to every other registered session
	 * that `canDeliver` admits. The caller (the sync server) has already authorized
	 * the sender's write; `canDeliver` limits delivery to sessions whose download
	 * scope contains the record, so a doc update never crosses a tenant boundary.
	 *
	 * @param sourceSessionId - The sending session (never echoed back)
	 * @param message - The doc-channel update
	 * @param canDeliver - Per-target delivery check; defaults to deliver-to-all
	 */
	handleUpdate(
		sourceSessionId: string,
		message: YjsDocUpdateMessage,
		canDeliver: (targetSessionId: string) => boolean = () => true,
	): void {
		if (!this.clients.has(sourceSessionId)) {
			return
		}
		this.broadcastExcept(sourceSessionId, message, canDeliver)
	}

	getClientCount(): number {
		return this.clients.size
	}

	clear(): void {
		this.clients.clear()
	}

	private broadcastExcept(
		excludeSessionId: string,
		message: SyncMessage,
		canDeliver: (targetSessionId: string) => boolean,
	): void {
		for (const [, client] of this.clients) {
			if (client.sessionId === excludeSessionId) {
				continue
			}
			if (!canDeliver(client.sessionId)) {
				continue
			}
			if (!client.transport.isConnected()) {
				continue
			}
			client.transport.send(message)
		}
	}
}
