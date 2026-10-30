import type {
	KoraEvent,
	KoraEventByType,
	KoraEventEmitter,
	KoraEventListener,
	KoraEventType,
} from './events'

type AnyListener = (event: never) => void

/**
 * Concrete implementation of KoraEventEmitter.
 * Simple, synchronous event emitter for internal use across @kora packages.
 *
 * @example
 * ```typescript
 * const emitter = new SimpleEventEmitter()
 * const unsub = emitter.on('operation:created', (event) => {
 *   console.log(event.operation.id)
 * })
 * emitter.emit({ type: 'operation:created', operation: someOp })
 * unsub() // unsubscribe
 * ```
 */
export class SimpleEventEmitter implements KoraEventEmitter {
	private listeners = new Map<string, Set<AnyListener>>()
	private readonly wildcardListeners = new Set<(event: KoraEvent) => void>()

	on<T extends KoraEventType>(type: T, listener: KoraEventListener<T>): () => void {
		let set = this.listeners.get(type)
		if (!set) {
			set = new Set()
			this.listeners.set(type, set)
		}
		set.add(listener as AnyListener)

		return () => {
			this.off(type, listener)
		}
	}

	off<T extends KoraEventType>(type: T, listener: KoraEventListener<T>): void {
		const set = this.listeners.get(type)
		if (set) {
			set.delete(listener as AnyListener)
			if (set.size === 0) {
				this.listeners.delete(type)
			}
		}
	}

	/**
	 * Listen to every event type, in emit order, after the typed listeners of that event.
	 * Used to hold the events emitted before an optional, lazily loaded consumer (DevTools)
	 * is ready, so loading it later loses nothing.
	 *
	 * @returns A function that removes the listener.
	 */
	onAny(listener: (event: KoraEvent) => void): () => void {
		this.wildcardListeners.add(listener)
		return () => {
			this.wildcardListeners.delete(listener)
		}
	}

	emit<T extends KoraEventType>(event: KoraEventByType<T>): void {
		const set = this.listeners.get(event.type)
		if (set) {
			for (const listener of set) {
				;(listener as (event: KoraEventByType<T>) => void)(event)
			}
		}
		for (const listener of this.wildcardListeners) {
			listener(event)
		}
	}

	/** Remove all listeners for all event types. */
	clear(): void {
		this.listeners.clear()
		this.wildcardListeners.clear()
	}

	/** Get the number of listeners for a specific event type. */
	listenerCount(type: KoraEventType): number {
		return this.listeners.get(type)?.size ?? 0
	}
}
