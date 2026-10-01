import { generateUUIDv7 } from '@korajs/core'
import type { AwarenessStateWire, AwarenessUpdateMessage, SyncMessage } from '@korajs/sync'
import type { ServerTransport } from '../transport/server-transport'

/**
 * Tracks a single client's awareness registration.
 */
interface AwarenessClient {
	/** Session ID for this client */
	sessionId: string
	/** Client-assigned awareness ID, bound to the session on its first update */
	clientId: number
	/** Transport for sending messages to this client */
	transport: ServerTransport
	/** Current awareness state, if any */
	state: AwarenessStateWire | null
	/**
	 * Presence partition. Updates are only relayed between clients with the same
	 * partition (the sync server uses the session's canonical download scope), so
	 * presence never crosses a tenant boundary.
	 */
	partition: string
}

/** Partition used when the caller does not supply one (single-tenant setups). */
const DEFAULT_PARTITION = '*'

/**
 * Server-side awareness relay. Broadcasts ephemeral awareness states
 * (cursor positions, user presence) between connected clients.
 *
 * Awareness data is never persisted. Each session's awareness `clientId` is bound on
 * registration: a session may only publish (or clear) its own state, never another
 * client's, and its updates reach only clients in the same partition.
 */
export class AwarenessRelay {
	private readonly clients = new Map<string, AwarenessClient>()

	/**
	 * Register a client for awareness broadcasting. A session registers once; later
	 * calls for an already-registered session are ignored, so a client cannot rebind
	 * itself to another client's id.
	 *
	 * @param sessionId - Unique session identifier
	 * @param clientId - Client-assigned awareness ID
	 * @param transport - Transport for sending messages to this client
	 * @param partition - Presence partition (clients only see their own partition)
	 */
	addClient(
		sessionId: string,
		clientId: number,
		transport: ServerTransport,
		partition: string = DEFAULT_PARTITION,
	): void {
		if (this.clients.has(sessionId)) return
		this.clients.set(sessionId, {
			sessionId,
			clientId,
			transport,
			state: null,
			partition,
		})

		// Send this client all existing awareness states in its partition so it catches up
		const existingStates: Record<string, AwarenessStateWire | null> = {}
		let hasStates = false
		for (const [, client] of this.clients) {
			if (client.sessionId === sessionId) continue
			if (client.partition !== partition) continue
			if (client.state) {
				existingStates[String(client.clientId)] = client.state
				hasStates = true
			}
		}

		if (hasStates) {
			const catchUpMsg: SyncMessage = {
				type: 'awareness-update',
				messageId: generateUUIDv7(),
				clientId: 0, // Server-sourced
				states: existingStates,
			}
			transport.send(catchUpMsg)
		}
	}

	/**
	 * True when the session is registered with the relay.
	 *
	 * @param sessionId - Session to check
	 */
	hasClient(sessionId: string): boolean {
		return this.clients.has(sessionId)
	}

	/**
	 * Remove a client and broadcast its removal to the remaining clients in its partition.
	 *
	 * @param sessionId - Session ID of the disconnecting client
	 */
	removeClient(sessionId: string): void {
		const client = this.clients.get(sessionId)
		if (!client) return

		this.clients.delete(sessionId)

		// Only broadcast removal if the client had an awareness state
		if (client.state === null) return

		const removalStates: Record<string, AwarenessStateWire | null> = {
			[String(client.clientId)]: null,
		}

		const msg: SyncMessage = {
			type: 'awareness-update',
			messageId: generateUUIDv7(),
			clientId: client.clientId,
			states: removalStates,
		}

		this.broadcastExcept(sessionId, client.partition, msg)
	}

	/**
	 * Handle an incoming awareness update from a registered client.
	 *
	 * Only the sender's own entry is accepted: the message must be stamped with the
	 * sender's bound `clientId`, and only `states[clientId]` is stored and relayed.
	 * Entries for other clients are dropped, so a sender cannot overwrite or remove
	 * anyone else's presence. The sanitized update reaches only the sender's partition.
	 *
	 * @param sessionId - Session ID of the sending client
	 * @param message - The awareness update message
	 */
	handleUpdate(sessionId: string, message: AwarenessUpdateMessage): void {
		const sender = this.clients.get(sessionId)
		if (!sender) return
		if (message.clientId !== sender.clientId) return

		const key = String(sender.clientId)
		if (!(key in message.states)) return
		const senderState = message.states[key] ?? null
		sender.state = senderState

		const sanitized: SyncMessage = {
			type: 'awareness-update',
			messageId: message.messageId,
			clientId: sender.clientId,
			states: { [key]: senderState },
		}
		this.broadcastExcept(sessionId, sender.partition, sanitized)
	}

	/**
	 * Get the number of registered awareness clients.
	 */
	getClientCount(): number {
		return this.clients.size
	}

	/**
	 * Remove all clients and clear all state.
	 */
	clear(): void {
		this.clients.clear()
	}

	// --- Private ---

	private broadcastExcept(excludeSessionId: string, partition: string, message: SyncMessage): void {
		for (const [, client] of this.clients) {
			if (client.sessionId === excludeSessionId) continue
			if (client.partition !== partition) continue
			if (!client.transport.isConnected()) continue

			client.transport.send(message)
		}
	}
}
