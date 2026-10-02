/// <reference lib="dom" />

const DEFAULT_DEBOUNCE_MS = 500

export interface IndexedDbPersistenceSchedulerOptions {
	/** Debounce interval before writing a snapshot. Defaults to 500ms. */
	debounceMs?: number
	/** Persist the in-memory database to IndexedDB. */
	flush: () => Promise<void>
	/** Called when persistence fails (mutation already committed in memory). */
	onError?: (error: unknown) => void
}

/**
 * Coalesces IndexedDB snapshot writes: debounces rapid mutations and flushes
 * immediately on tab hide (`visibilitychange`) or explicit {@link flushNow}.
 */
export class IndexedDbPersistenceScheduler {
	private readonly debounceMs: number
	private readonly flush: () => Promise<void>
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
	/** Error of the last snapshot attempt, cleared by the next success. */
	private lastFlushError: unknown = null
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
		if (this.persistedGeneration >= target) return
		if (this.disposed) {
			throw new Error('IndexedDB persistence was disposed before the writes were persisted')
		}
		if (this.timer !== null) {
			clearTimeout(this.timer)
			this.timer = null
		}
		// At most two rounds: one that may have started before `target`, then one after.
		for (let round = 0; round < 3 && this.persistedGeneration < target; round++) {
			if (this.inFlight) {
				try {
					await this.inFlight
				} catch {
					// runFlush never rejects; the error is in lastFlushError.
				}
				continue
			}
			this.inFlight = this.runFlush()
			try {
				await this.inFlight
			} finally {
				this.inFlight = null
			}
			if (this.persistedGeneration < target) break
		}
		if (this.persistedGeneration < target) {
			throw this.lastFlushError instanceof Error
				? this.lastFlushError
				: new Error('IndexedDB snapshot was not persisted')
		}
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

	private async runFlush(): Promise<void> {
		const generation = this.scheduledGeneration
		try {
			await this.flush()
			this.persistedGeneration = Math.max(this.persistedGeneration, generation)
			this.lastFlushError = null
		} catch (error) {
			this.lastFlushError = error
			this.onError?.(error)
		}
	}
}
