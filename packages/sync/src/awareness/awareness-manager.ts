import type { KoraEventEmitter } from '@korajs/core'
import type { AwarenessChange, AwarenessMessage, AwarenessState } from './types'

/**
 * Callback for awareness change events.
 */
type AwarenessChangeListener = (change: AwarenessChange) => void

// Timeout after which a remote client's awareness is considered stale
// and will be cleaned up. This is a safety net -- normally the server
// sends explicit removal on disconnect.
const DEFAULT_TIMEOUT_MS = 30_000

let nextLocalClientId = 1

/**
 * Manages collaborative awareness state (cursor positions, user presence).
 *
 * Awareness is ephemeral -- states are never persisted, only shared with
 * currently connected peers via the sync transport. This implements a
 * lightweight protocol compatible with Yjs awareness semantics.
 *
 * Each AwarenessManager has a unique client ID and tracks both its own
 * local state and all remote clients' states.
 */
export class AwarenessManager {
	/** Unique client ID for this instance */
	readonly clientId: number

	private localState: AwarenessState | null = null
	private readonly remoteStates = new Map<number, AwarenessState>()
	private readonly listeners = new Set<AwarenessChangeListener>()
	private readonly emitter: KoraEventEmitter | null
	private readonly timeoutMs: number

	// Track when we last received an update from each remote client.
	// Used for timeout-based cleanup as a safety net in case the server
	// does not send an explicit removal on disconnect.
	private readonly lastUpdated = new Map<number, number>()
	private cleanupTimer: ReturnType<typeof setInterval> | null = null

	private sendHandler: ((message: AwarenessMessage) => void) | null = null
	private destroyed = false

	constructor(options?: {
		clientId?: number
		emitter?: KoraEventEmitter
		timeoutMs?: number
	}) {
		this.clientId = options?.clientId ?? nextLocalClientId++
		this.emitter = options?.emitter ?? null
		this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
	}

	/**
	 * Set the local user's awareness state and broadcast to peers.
	 *
	 * @param state - The awareness state to share. Pass null to clear presence.
	 */
	setLocalState(state: AwarenessState | null): void {
		if (this.destroyed) return

		this.localState = state

		const message: AwarenessMessage = {
			type: 'awareness',
			clientId: this.clientId,
			states: { [this.clientId]: state },
		}

		this.sendHandler?.(message)

		this.emitAwarenessEvent()
	}

	/**
	 * Get the local awareness state.
	 */
	getLocalState(): AwarenessState | null {
		return this.localState
	}

	/**
	 * Get all known awareness states (local + remote).
	 * Returns a new Map on each call.
	 */
	getStates(): Map<number, AwarenessState> {
		const result = new Map<number, AwarenessState>()
		if (this.localState) {
			result.set(this.clientId, this.localState)
		}
		for (const [id, state] of this.remoteStates) {
			result.set(id, state)
		}
		return result
	}

	/**
	 * Handle an incoming awareness message from the transport.
	 * This processes remote state updates and notifies listeners.
	 */
	handleRemoteMessage(message: AwarenessMessage): void {
		if (this.destroyed) return

		const added: number[] = []
		const updated: number[] = []
		const removed: number[] = []
		const now = Date.now()

		for (const [clientIdStr, state] of Object.entries(message.states)) {
			const clientId = Number(clientIdStr)

			// Ignore our own state echoed back
			if (clientId === this.clientId) continue

			if (state === null) {
				// Removal
				if (this.remoteStates.has(clientId)) {
					this.remoteStates.delete(clientId)
					this.lastUpdated.delete(clientId)
					removed.push(clientId)
				}
			} else {
				if (this.remoteStates.has(clientId)) {
					this.remoteStates.set(clientId, state)
					this.lastUpdated.set(clientId, now)
					updated.push(clientId)
				} else {
					this.remoteStates.set(clientId, state)
					this.lastUpdated.set(clientId, now)
					added.push(clientId)
				}
			}
		}

		if (added.length > 0 || updated.length > 0 || removed.length > 0) {
			const change: AwarenessChange = { added, updated, removed }
			this.notifyListeners(change)
			this.emitAwarenessEvent()
		}
	}

	/**
	 * Remove a specific remote client's awareness state.
	 * Called when the server notifies that a client has disconnected.
	 */
	removeClient(clientId: number): void {
		if (this.destroyed) return
		if (!this.remoteStates.has(clientId)) return

		this.remoteStates.delete(clientId)
		this.lastUpdated.delete(clientId)

		const change: AwarenessChange = {
			added: [],
			updated: [],
			removed: [clientId],
		}
		this.notifyListeners(change)
		this.emitAwarenessEvent()
	}

	/**
	 * Register a handler for sending awareness messages through the transport.
	 * The sync engine calls this to wire outgoing awareness messages to the transport.
	 */
	onSend(handler: (message: AwarenessMessage) => void): void {
		this.sendHandler = handler
	}

	/**
	 * Register a listener for awareness state changes.
	 * Returns an unsubscribe function.
	 */
	on(_event: 'change', listener: AwarenessChangeListener): () => void {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	/**
	 * Remove a specific change listener.
	 */
	off(_event: 'change', listener: AwarenessChangeListener): void {
		this.listeners.delete(listener)
	}

	/**
	 * Start the cleanup timer that removes stale remote states.
	 * Called when the sync engine transitions to streaming state.
	 */
	startCleanupTimer(): void {
		if (this.cleanupTimer) return

		this.cleanupTimer = setInterval(() => {
			this.cleanupStaleStates()
		}, this.timeoutMs)
	}

	/**
	 * Stop the cleanup timer.
	 */
	stopCleanupTimer(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer)
			this.cleanupTimer = null
		}
	}

	/**
	 * Clean up all resources. After calling destroy(), the manager
	 * will no longer send or receive awareness updates.
	 * Broadcasts removal of local state before shutting down.
	 */
	destroy(): void {
		if (this.destroyed) return
		this.destroyed = true

		// Broadcast removal of our local state before shutting down
		if (this.localState) {
			const message: AwarenessMessage = {
				type: 'awareness',
				clientId: this.clientId,
				states: { [this.clientId]: null },
			}
			this.sendHandler?.(message)
		}

		this.localState = null
		this.remoteStates.clear()
		this.lastUpdated.clear()
		this.listeners.clear()
		this.sendHandler = null
		this.stopCleanupTimer()
	}

	// --- Private ---

	private cleanupStaleStates(): void {
		const now = Date.now()
		const removed: number[] = []

		for (const [clientId, lastTime] of this.lastUpdated) {
			if (now - lastTime > this.timeoutMs) {
				this.remoteStates.delete(clientId)
				this.lastUpdated.delete(clientId)
				removed.push(clientId)
			}
		}

		if (removed.length > 0) {
			const change: AwarenessChange = { added: [], updated: [], removed }
			this.notifyListeners(change)
			this.emitAwarenessEvent()
		}
	}

	private notifyListeners(change: AwarenessChange): void {
		for (const listener of this.listeners) {
			listener(change)
		}
	}

	private emitAwarenessEvent(): void {
		// Cast states to Map<number, unknown> to satisfy KoraEvent's generic type
		const states: Map<number, unknown> = this.getStates()
		this.emitter?.emit({ type: 'awareness:updated', states })
	}
}
