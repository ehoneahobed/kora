/// <reference lib="dom" />

const DEFAULT_DEBOUNCE_MS = 500

/** What a snapshot write is told about the snapshot it takes. */
export interface IndexedDbFlushOptions {
	/** A barrier snapshot: IndexedDB durability `strict`. */
	strict: boolean
	/**
	 * Call at the moment the snapshot reads the database (inside the export transaction,
	 * which no write can interleave with). Writes scheduled until then are in the snapshot,
	 * so barriers that arrive before it share it instead of waiting for another one. A flush
	 * that never calls it covers the writes scheduled when it started.
	 */
	readPoint: () => void
}

export interface IndexedDbPersistenceSchedulerOptions {
	/** Debounce interval before writing a snapshot. Defaults to 500ms. */
	debounceMs?: number
	/** Persist the in-memory database to IndexedDB. */
	flush: (options: IndexedDbFlushOptions) => Promise<void>
	/** Called when persistence fails (mutation already committed in memory). */
	onError?: (error: unknown) => void
}

/**
 * Coalesces IndexedDB snapshot writes: debounces rapid mutations and flushes
 * immediately on tab hide (`visibilitychange`) or explicit {@link flushNow}.
 */
export class IndexedDbPersistenceScheduler {
	private readonly debounceMs: number
	private readonly flush: (options: IndexedDbFlushOptions) => Promise<void>
	private readonly onError: ((error: unknown) => void) | undefined
	private timer: ReturnType<typeof setTimeout> | null = null
	private inFlight: Promise<void> | null = null
	private disposed = false
	/**
	 * Mutation generations (RT-35): `scheduled` counts schedule() calls (one per committed
	 * write), `persisted` is the generation the last SUCCESSFUL snapshot covered. A
	 * snapshot covers every generation scheduled before it started.
	 */
	private scheduledGeneration = 0
	private persistedGeneration = 0
	/**
	 * Generation covered by the last successful STRICT snapshot (IndexedDB durability
	 * `strict`: `complete` fires after the data reached disk). Barriers wait on this one;
	 * debounced background snapshots stay `relaxed` and only advance `persistedGeneration`.
	 */
	private strictGeneration = 0
	/** Error of the last snapshot attempt, cleared by the next success. */
	private lastFlushError: unknown = null
	/** Callers waiting for a snapshot to cover a generation ({@link whenPersisted}). */
	private persistedWaiters: Array<{ target: number; resolve: () => void }> = []
	private readonly onVisibilityChange: () => void

	constructor(options: IndexedDbPersistenceSchedulerOptions) {
		this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
		this.flush = options.flush
		this.onError = options.onError
		this.onVisibilityChange = () => {
			if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
				void this.flushNow()
			}
		}
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', this.onVisibilityChange)
		}
	}

	/** Schedule a debounced snapshot write. */
	schedule(): void {
		if (this.disposed) return
		this.scheduledGeneration++
		if (this.debounceMs <= 0) {
			void this.flushNow()
			return
		}
		if (this.timer !== null) {
			clearTimeout(this.timer)
		}
		this.timer = setTimeout(() => {
			this.timer = null
			void this.flushNow()
		}, this.debounceMs)
	}

	/**
	 * Cancel any pending debounce and persist immediately. Resolves only when a snapshot
	 * taken after every write scheduled so far was written (STORE-7): a snapshot already in
	 * flight may predate the latest writes, so the call waits for it and then writes again
	 * while anything is still dirty. A failed snapshot ends the loop (the failure is
	 * reported through `onError`; {@link flushBarrier} is the variant that rejects).
	 */
	async flushNow(): Promise<void> {
		if (this.disposed) return
		if (this.timer !== null) {
			clearTimeout(this.timer)
			this.timer = null
		}
		// With nothing in flight, "persist immediately" writes one snapshot even when no
		// write was scheduled (callers use it to force the first snapshot).
		let mustRun = this.inFlight === null
		for (;;) {
			if (this.inFlight) {
				await this.inFlight
				continue
			}
			if (!mustRun && this.persistedGeneration >= this.scheduledGeneration) return
			mustRun = false
			this.inFlight = this.runFlush()
			try {
				await this.inFlight
			} finally {
				this.inFlight = null
			}
			if (this.lastFlushError !== null) return
		}
	}

	/**
	 * Resolve once a successful snapshot covers every write scheduled so far. Unlike
	 * {@link flushBarrier} it forces nothing: it waits for the debounced snapshot, so it adds
	 * no snapshot of its own. Never settles if the scheduler is disposed first.
	 */
	whenPersisted(): Promise<void> {
		const target = this.scheduledGeneration
		if (this.persistedGeneration >= target) return Promise.resolve()
		return new Promise<void>((resolve) => {
			this.persistedWaiters.push({ target, resolve })
		})
	}

	/** Whether a snapshot write is in flight. */
	isFlushing(): boolean {
		return this.inFlight !== null
	}

	/** Whether a write was scheduled that no successful snapshot covers yet. */
	isDirty(): boolean {
		return this.persistedGeneration < this.scheduledGeneration
	}

	/**
	 * Durability barrier (RT-35): resolve once every write scheduled before this call is
	 * in a snapshot persisted to IndexedDB. A snapshot already in flight may predate the
	 * latest write, so the barrier waits for it and then writes a fresh one when needed.
	 * Rejects when the snapshot cannot be written: the caller must treat the writes as
	 * not durable (for example, not upload them yet).
	 */
	async flushBarrier(): Promise<void> {
		const target = this.scheduledGeneration
		if (this.strictGeneration >= target) return
		if (this.disposed) {
			throw new Error('IndexedDB persistence was disposed before the writes were persisted')
		}
		if (this.timer !== null) {
			clearTimeout(this.timer)
			this.timer = null
		}
		// Group commit: concurrent barriers share the snapshot in flight and the next one.
		// At most three rounds: one in flight that may predate `target` (or be relaxed), then
		// a strict one started after it.
		for (let round = 0; round < 3 && this.strictGeneration < target; round++) {
			if (this.inFlight) {
				await this.inFlight
				continue
			}
			this.inFlight = this.runFlush(true)
			try {
				await this.inFlight
			} finally {
				this.inFlight = null
			}
			if (this.strictGeneration < target) break
		}
		if (this.strictGeneration < target) {
			throw this.lastFlushError instanceof Error
				? this.lastFlushError
				: new Error('IndexedDB snapshot was not persisted')
		}
	}

	/**
	 * Durability barrier for writes this scheduler was never told about: another tab's
	 * writes, committed in the database this tab's worker holds, before a follower asked
	 * for a snapshot. Counts as one scheduled write, so the barrier waits for a strict
	 * snapshot STARTED after the request (one already in flight may predate the follower's
	 * write) and shares it with every other barrier waiting here, this tab's own included.
	 */
	flushBarrierForPeer(): Promise<void> {
		this.scheduledGeneration++
		return this.flushBarrier()
	}

	dispose(): void {
		this.disposed = true
		if (this.timer !== null) {
			clearTimeout(this.timer)
			this.timer = null
		}
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', this.onVisibilityChange)
		}
	}

	private async runFlush(strict = false): Promise<void> {
		let generation = this.scheduledGeneration
		const readPoint = (): void => {
			generation = Math.max(generation, this.scheduledGeneration)
		}
		try {
			await this.flush({ strict, readPoint })
			this.persistedGeneration = Math.max(this.persistedGeneration, generation)
			if (strict) this.strictGeneration = Math.max(this.strictGeneration, generation)
			this.lastFlushError = null
			const ready = this.persistedWaiters.filter((w) => w.target <= this.persistedGeneration)
			this.persistedWaiters = this.persistedWaiters.filter(
				(w) => w.target > this.persistedGeneration,
			)
			for (const waiter of ready) waiter.resolve()
		} catch (error) {
			this.lastFlushError = error
			this.onError?.(error)
		}
	}
}
