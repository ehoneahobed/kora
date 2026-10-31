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

/** Held events published per slice before yielding to the page. */
export const RELEASE_SLICE = 500

/** Held events beyond this many are counted, not kept (memory is bounded, never silent). */
export const MAX_HELD_EVENTS = 20_000

/**
 * Operations kept across all held `sync:received` events. Past it an event is held as a
 * summary (its `batchSize`, an empty `operations` array), so a 300k-operation stream does not
 * keep every operation twice (once in the replica, once in the held events).
 */
export const MAX_HELD_OPERATIONS = 5_000

/**
 * Wraps the engine's emitter. While `shouldHold()` is true, delivery events are kept in order
 * instead of published; {@link release} publishes them (the staged data is live now) and
 * {@link discard} forgets them (the staged data never reached the live database, and the
 * direct path will report the same operations again when it applies them).
 */
export class HoldingEmitter implements KoraEventEmitter {
	private held: KoraEvent[] = []
	private heldOperations = 0
	private summarized = 0
	private dropped = 0
	/** A release is publishing: events emitted meanwhile queue behind it, so order is kept. */
	private releasing = false
	/** Bumped by {@link discard}: a release in progress stops. */
	private generation = 0

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
		if (HELD_EVENT_TYPES.has(event.type) && (this.releasing || this.shouldHold())) {
			this.hold(event)
			return
		}
		this.inner.emit(event)
	}

	private hold(event: KoraEvent): void {
		if (this.held.length >= MAX_HELD_EVENTS) {
			this.dropped++
			return
		}
		if (event.type === 'sync:received') {
			if (this.heldOperations + event.operations.length > MAX_HELD_OPERATIONS) {
				this.summarized++
				this.held.push({ ...event, operations: [] })
				return
			}
			this.heldOperations += event.operations.length
		}
		this.held.push(event)
	}

	/**
	 * Publish what was held, in order, in slices of {@link RELEASE_SLICE} events with a yield
	 * between them (up to {@link MAX_HELD_EVENTS} events must not stall the page). Delivery
	 * events emitted while the release runs queue behind it, so listeners see them in order.
	 *
	 * @returns How many `sync:received` events were published as summaries and how many held
	 * events were dropped over the cap (both zero for any ordinary stream).
	 */
	async release(): Promise<{ summarized: number; dropped: number }> {
		const counts = { summarized: this.summarized, dropped: this.dropped }
		this.summarized = 0
		this.dropped = 0
		this.heldOperations = 0
		this.releasing = true
		const generation = this.generation
		try {
			let sinceYield = 0
			// Events emitted during the release land in `held` again; they are published after
			// the ones in hand, so order is kept however long the release takes.
			while (this.held.length > 0 && this.generation === generation) {
				const batch = this.held
				this.held = []
				for (const event of batch) {
					if (this.generation !== generation) break
					try {
						this.inner.emit(event)
					} catch {
						// A throwing listener must not undo the commit the events report.
					}
					sinceYield += 1
					if (sinceYield >= RELEASE_SLICE) {
						sinceYield = 0
						await new Promise<void>((resolve) => setTimeout(resolve, 0))
					}
				}
			}
		} finally {
			this.releasing = false
		}
		return counts
	}

	/** Forget what was held. */
	discard(): void {
		this.generation++
		this.held = []
		this.heldOperations = 0
		this.summarized = 0
		this.dropped = 0
	}

	/** How many events are held (tests and diagnostics). */
	get heldCount(): number {
		return this.held.length
	}
}
