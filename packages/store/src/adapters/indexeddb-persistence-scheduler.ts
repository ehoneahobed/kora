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

	/** Cancel any pending debounce and persist immediately. */
	async flushNow(): Promise<void> {
		if (this.disposed) return
		if (this.timer !== null) {
			clearTimeout(this.timer)
			this.timer = null
		}
		if (this.inFlight) {
			await this.inFlight
			return
		}
		this.inFlight = this.runFlush()
		try {
			await this.inFlight
		} finally {
			this.inFlight = null
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
		try {
			await this.flush()
		} catch (error) {
			this.onError?.(error)
		}
	}
}
