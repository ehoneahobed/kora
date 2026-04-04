import type { TimestampedEvent } from '../types'

const DEFAULT_CHANNEL = 'kora-devtools'

/** Shape of messages posted through the bridge */
interface BridgeMessage {
	source: string
	payload: TimestampedEvent
}

/**
 * Communicates between the page context and a DevTools panel via window.postMessage.
 * All messages are namespaced with a `source` field to avoid collisions with other
 * postMessage consumers on the page.
 *
 * Safe to instantiate in non-browser environments (SSR/Node) — all operations
 * become no-ops when `window` is not available.
 */
export class MessageBridge {
	private readonly channelName: string
	private readonly listeners: Set<(event: TimestampedEvent) => void> = new Set()
	private readonly messageHandler: ((event: MessageEvent) => void) | null
	private destroyed = false

	constructor(channelName: string = DEFAULT_CHANNEL) {
		this.channelName = channelName

		if (typeof window === 'undefined') {
			this.messageHandler = null
			return
		}

		// Single shared handler that dispatches to all registered callbacks
		this.messageHandler = (event: MessageEvent) => {
			if (this.destroyed) return
			const data = event.data as Partial<BridgeMessage> | undefined
			if (!data || data.source !== this.channelName) return

			for (const listener of this.listeners) {
				listener(data.payload as TimestampedEvent)
			}
		}

		window.addEventListener('message', this.messageHandler)
	}

	/**
	 * Post a timestamped event through the bridge.
	 * No-op if window is not available or the bridge has been destroyed.
	 */
	send(event: TimestampedEvent): void {
		if (this.destroyed || typeof window === 'undefined') return

		const message: BridgeMessage = {
			source: this.channelName,
			payload: event,
		}
		window.postMessage(message, '*')
	}

	/**
	 * Register a callback for events received through the bridge.
	 * Returns an unsubscribe function.
	 */
	onReceive(callback: (event: TimestampedEvent) => void): () => void {
		if (this.destroyed) return () => {}

		this.listeners.add(callback)
		return () => {
			this.listeners.delete(callback)
		}
	}

	/**
	 * Remove all listeners and detach from window.
	 * After calling destroy, all operations become no-ops.
	 */
	destroy(): void {
		if (this.destroyed) return
		this.destroyed = true
		this.listeners.clear()

		if (this.messageHandler && typeof window !== 'undefined') {
			window.removeEventListener('message', this.messageHandler)
		}
	}
}
