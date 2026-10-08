import { generateUUIDv7 } from '@korajs/core'
import type { AwarenessStateWire, AwarenessUpdateMessage, SyncMessage } from '@korajs/sync'
import type { ServerTransport } from '../transport/server-transport'

/**
 * Decides whether one client's current awareness state may reach another session.
 * Called with the receiving session's id; returning false keeps the state from it.
 * The sync server builds one per update from the record named in the state's cursor.
 */
export type AwarenessAudience = (targetSessionId: string) => boolean

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
	 * Presence partition, used when an update carries no audience: the state then
	 * reaches only clients with the same partition, so presence never crosses a
	 * tenant boundary.
	 */
	partition: string
	/** Who may see `state` (from its latest update); null means "same partition". */
	audience: AwarenessAudience | null
	/**
	 * Sessions that were sent a non-null state of this client and have not been sent
	 * a removal since. When the state becomes invisible to one of them (the cursor
	 * moved to a record it cannot read, or the client left), it gets a removal, so no
	 * stale presence lingers there.
	 */
	deliveredTo: Set<string>
}

/** Partition used when the caller does not supply one (single-tenant setups). */
const DEFAULT_PARTITION = '*'

/**
 * Server-side awareness relay. Broadcasts ephemeral awareness states
 * (cursor positions, user presence) between connected clients.
 *
 * Awareness data is never persisted. Each session's awareness `clientId` is bound on
 * registration: a session may only publish (or clear) its own state, never another
 * client's. A state reaches exactly the sessions its audience admits (the sync server
 * admits sessions whose download scope contains the record named in the cursor), or,
 * for an update without an audience, the clients of the same partition.
 */
export class AwarenessRelay {
	private readonly clients = new Map<string, AwarenessClient>()

	/**
	 * Register a client for awareness broadcasting. A session registers once; later
	 * calls for an already-registered session are ignored, so a client cannot rebind
	 * itself to another client's id.
	 *
	 * The new client is sent every existing state it may see (catch-up): a state with
	 * an audience when the audience admits the new session, otherwise a state of the
	 * same partition.
	 *
	 * @param sessionId - Unique session identifier
	 * @param clientId - Client-assigned awareness ID
	 * @param transport - Transport for sending messages to this client
	 * @param partition - Presence partition for states relayed without an audience
	 */
	addClient(
		sessionId: string,
		clientId: number,
		transport: ServerTransport,
		partition: string = DEFAULT_PARTITION,
	): void {
		if (this.clients.has(sessionId)) return
		const joining: AwarenessClient = {
			sessionId,
			clientId,
			transport,
			state: null,
			partition,
			audience: null,
			deliveredTo: new Set(),
		}
		this.clients.set(sessionId, joining)

		const existingStates: Record<string, AwarenessStateWire | null> = {}
		let hasStates = false
		for (const [, client] of this.clients) {
			if (client.sessionId === sessionId) continue
			if (!client.state) continue
			if (!this.mayReceive(client, joining)) continue
			existingStates[String(client.clientId)] = client.state
			client.deliveredTo.add(sessionId)
			hasStates = true
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
	 * Remove a client and send its removal to every client that was shown its state.
	 *
	 * @param sessionId - Session ID of the disconnecting client
	 */
	removeClient(sessionId: string): void {
		const client = this.clients.get(sessionId)
		if (!client) return

		this.clients.delete(sessionId)
		for (const [, other] of this.clients) other.deliveredTo.delete(sessionId)

		if (client.deliveredTo.size === 0) return
		const msg = this.removalMessage(client)
		for (const targetId of client.deliveredTo) {
			const target = this.clients.get(targetId)
			if (target?.transport.isConnected()) target.transport.send(msg)
		}
		client.deliveredTo.clear()
	}

	/**
	 * Handle an incoming awareness update from a registered client.
	 *
	 * Only the sender's own entry is accepted: the message must be stamped with the
	 * sender's bound `clientId`, and only `states[clientId]` is stored and relayed.
	 * Entries for other clients are dropped, so a sender cannot overwrite or remove
	 * anyone else's presence.
	 *
	 * The state is sent to every other client the audience admits (without an
	 * audience: every client of the sender's partition). A client that was shown an
	 * earlier state of the sender but is not admitted now receives a removal.
	 *
	 * @param sessionId - Session ID of the sending client
	 * @param message - The awareness update message
	 * @param audience - Who may see this state; omitted means the sender's partition
	 */
	handleUpdate(
		sessionId: string,
		message: AwarenessUpdateMessage,
		audience?: AwarenessAudience,
	): void {
		const sender = this.clients.get(sessionId)
		if (!sender) return
		if (message.clientId !== sender.clientId) return

		const key = String(sender.clientId)
		if (!(key in message.states)) return
		const senderState = message.states[key] ?? null
		sender.state = senderState
		sender.audience = audience ?? null

		const sanitized: SyncMessage = {
			type: 'awareness-update',
			messageId: message.messageId,
			clientId: sender.clientId,
			states: { [key]: senderState },
		}
		let removal: SyncMessage | null = null
		for (const [, client] of this.clients) {
			if (client.sessionId === sessionId) continue
			const visible = senderState !== null && this.mayReceive(sender, client)
			if (visible) {
				if (!client.transport.isConnected()) continue
				client.transport.send(sanitized)
				sender.deliveredTo.add(client.sessionId)
			} else if (sender.deliveredTo.delete(client.sessionId)) {
				if (!client.transport.isConnected()) continue
				removal ??= senderState === null ? sanitized : this.removalMessage(sender)
				client.transport.send(removal)
			}
		}
	}

	/**
	 * Re-decide who may see a client's current state after the record its cursor names
	 * changed (F16): it moved into or out of a session's grant. Sessions that may no
	 * longer see the state get a removal; sessions that may see it now and were not
	 * shown it get the state. Later catch-ups use the new audience.
	 *
	 * @param sessionId - The client whose audience changed
	 * @param audience - The new audience
	 */
	updateAudience(sessionId: string, audience: AwarenessAudience): void {
		const sender = this.clients.get(sessionId)
		if (!sender) return
		sender.audience = audience
		if (sender.state === null) return
		const key = String(sender.clientId)
		let current: SyncMessage | null = null
		let removal: SyncMessage | null = null
		for (const [, client] of this.clients) {
			if (client.sessionId === sessionId) continue
			const visible = this.mayReceive(sender, client)
			const shown = sender.deliveredTo.has(client.sessionId)
			if (visible && !shown) {
				if (!client.transport.isConnected()) continue
				current ??= {
					type: 'awareness-update',
					messageId: generateUUIDv7(),
					clientId: sender.clientId,
					states: { [key]: sender.state },
				}
				client.transport.send(current)
				sender.deliveredTo.add(client.sessionId)
			} else if (!visible && shown) {
				sender.deliveredTo.delete(client.sessionId)
				if (!client.transport.isConnected()) continue
				removal ??= this.removalMessage(sender)
				client.transport.send(removal)
			}
		}
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

	/** True when `target` may see `source`'s current state. Fails closed. */
	private mayReceive(source: AwarenessClient, target: AwarenessClient): boolean {
		if (source.audience === null) return source.partition === target.partition
		try {
			return source.audience(target.sessionId)
		} catch {
			return false
		}
	}

	private removalMessage(client: AwarenessClient): SyncMessage {
		return {
			type: 'awareness-update',
			messageId: generateUUIDv7(),
			clientId: client.clientId,
			states: { [String(client.clientId)]: null },
		}
	}
}
