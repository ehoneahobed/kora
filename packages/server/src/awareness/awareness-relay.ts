import { generateUUIDv7 } from '@korajs/core'
import type { AwarenessStateWire, AwarenessUpdateMessage, SyncMessage } from '@korajs/sync'
import type { ServerTransport } from '../transport/server-transport'

/**
 * Tracks a single client's awareness registration.
 */
interface AwarenessClient {
	/** Session ID for this client */
	sessionId: string
	/** Client-assigned awareness ID (numeric, unique per client) */
	clientId: number
	/** Transport for sending messages to this client */
	transport: ServerTransport
	/** Current awareness state, if any */
	state: AwarenessStateWire | null
}

/**
 * Server-side awareness relay. Broadcasts ephemeral awareness states
 * (cursor positions, user presence) between connected clients.
 *
 * Awareness data is never persisted. The relay simply forwards awareness
 * updates from one client to all other connected clients, and broadcasts
 * removal notifications when a client disconnects.
 */
export class AwarenessRelay {
	private readonly clients = new Map<string, AwarenessClient>()

	/**
	 * Register a client for awareness broadcasting.
	 *
	 * @param sessionId - Unique session identifier
	 * @param clientId - Client-assigned awareness ID
	 * @param transport - Transport for sending messages to this client
	 */
	addClient(sessionId: string, clientId: number, transport: ServerTransport): void {
		this.clients.set(sessionId, {
			sessionId,
			clientId,
			transport,
			state: null,
		})

		// Send this client all existing awareness states so it catches up
		const existingStates: Record<string, AwarenessStateWire | null> = {}
		let hasStates = false
		for (const [, client] of this.clients) {
			if (client.sessionId === sessionId) continue
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
	 * Remove a client and broadcast its removal to all remaining clients.
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

		this.broadcastExcept(sessionId, msg)
	}

	/**
	 * Handle an incoming awareness update from a client.
	 * Stores the state and relays to all other connected clients.
	 *
	 * @param sessionId - Session ID of the sending client
	 * @param message - The awareness update message
	 */
	handleUpdate(sessionId: string, message: AwarenessUpdateMessage): void {
		const sender = this.clients.get(sessionId)
		if (!sender) return

		// Update stored state for this client
		const senderState = message.states[String(message.clientId)]
		if (senderState !== undefined) {
			sender.state = senderState
		}

		// Relay to all other clients
		this.broadcastExcept(sessionId, message)
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

	private broadcastExcept(excludeSessionId: string, message: SyncMessage): void {
		for (const [, client] of this.clients) {
			if (client.sessionId === excludeSessionId) continue
			if (!client.transport.isConnected()) continue

			client.transport.send(message)
		}
	}
}
