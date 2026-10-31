import type {
	KoraEvent,
	KoraEventByType,
	KoraEventEmitter,
	KoraEventListener,
	KoraEventType,
} from '@korajs/core'

/**
 * Events about the delivery of operations: what was received, acknowledged, applied or could
 * not be. While a stream is staged these describe data that is not in the live database yet,
 * so they are held and published only once the merge has committed (events after commit only).
 */
const HELD_EVENT_TYPES: ReadonlySet<string> = new Set([
	'sync:received',
	'sync:acknowledged',
	'sync:apply-failed',
	'sync:apply-blocked',
	'sync:apply-retrying',
	'sync:apply-recovered',
	'sync:apply-abandoned',
	'sync:scope-retracted',
	'sync:delivery-stalled',
])

/**
 * Wraps the engine's emitter. While `shouldHold()` is true, delivery events are kept in order
 * instead of published; {@link release} publishes them (the staged data is live now) and
 * {@link discard} forgets them (the staged data never reached the live database, and the
 * direct path will report the same operations again when it applies them).
 */
export class HoldingEmitter implements KoraEventEmitter {
	private held: KoraEvent[] = []

	constructor(
		private readonly inner: KoraEventEmitter,
		private readonly shouldHold: () => boolean,
	) {}

	on<T extends KoraEventType>(type: T, listener: KoraEventListener<T>): () => void {
		return this.inner.on(type, listener)
	}

	off<T extends KoraEventType>(type: T, listener: KoraEventListener<T>): void {
		this.inner.off(type, listener)
	}

	emit<T extends KoraEventType>(event: KoraEventByType<T>): void {
		if (HELD_EVENT_TYPES.has(event.type) && this.shouldHold()) {
			this.held.push(event)
			return
		}
		this.inner.emit(event)
	}

	/** Publish what was held, in order. */
	release(): void {
		const events = this.held
		this.held = []
		for (const event of events) {
			try {
				this.inner.emit(event)
			} catch {
				// A throwing listener must not undo the commit the events report.
			}
		}
	}

	/** Forget what was held. */
	discard(): void {
		this.held = []
	}

	/** How many events are held (tests and diagnostics). */
	get heldCount(): number {
		return this.held.length
	}
}
