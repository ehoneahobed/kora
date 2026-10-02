import type { TimeSource } from '@korajs/core'

/**
 * Configuration for the reconnection manager.
 */
export interface ReconnectionConfig {
	/** Initial delay in ms before first reconnection attempt. Defaults to 1000. */
	initialDelay?: number
	/** Maximum delay in ms between attempts. Defaults to 30000. */
	maxDelay?: number
	/** Multiplier for exponential backoff. Defaults to 2. */
	multiplier?: number
	/** Maximum number of reconnection attempts. 0 means unlimited. Defaults to 0. */
	maxAttempts?: number
	/** Jitter factor (0-1). Random variation applied to delay. Defaults to 0.25. */
	jitter?: number
	/**
	 * How long a connection must stay up (see {@link ReconnectionManager.reportConnected})
	 * before the backoff resets to the initial delay, in ms (SYNC-8). A server that
	 * accepts sessions and drops them right away therefore keeps backing off instead of
	 * being retried at the initial interval forever. Defaults to 10000.
	 */
	stableAfterMs?: number
	/** Injectable time source for deterministic testing. */
	timeSource?: TimeSource
	/** Injectable random source for deterministic jitter. Returns value in [0, 1). */
	randomSource?: () => number
}

/**
 * Manages reconnection attempts with exponential backoff and jitter.
 *
 * Formula: min(initialDelay * multiplier^attempt, maxDelay) * (1 + jitter * (random - 0.5) * 2)
 *
 * The attempt counter belongs to the manager, not to one `start()` run (SYNC-8): it
 * keeps growing across runs and resets only once a connection stayed up for
 * `stableAfterMs` ({@link reportConnected}), or on an explicit {@link reset}.
 */
export class ReconnectionManager {
	private readonly initialDelay: number
	private readonly maxDelay: number
	private readonly multiplier: number
	private readonly maxAttempts: number
	private readonly jitter: number
	private readonly stableAfterMs: number
	private readonly random: () => number

	private attempt = 0
	private timer: ReturnType<typeof setTimeout> | null = null
	private stableTimer: ReturnType<typeof setTimeout> | null = null
	private stopped = false
	private running = false
	/** A disconnect was reported while an attempt was in flight (NEW-SYNC-2). */
	private pendingRetry = false
	private waitResolve: (() => void) | null = null

	constructor(config?: ReconnectionConfig) {
		this.initialDelay = config?.initialDelay ?? 1000
		this.maxDelay = config?.maxDelay ?? 30000
		this.multiplier = config?.multiplier ?? 2
		this.maxAttempts = config?.maxAttempts ?? 0
		this.jitter = config?.jitter ?? 0.25
		this.stableAfterMs = config?.stableAfterMs ?? 10_000
		this.random = config?.randomSource ?? Math.random
	}

	/**
	 * Start reconnection attempts. Calls `onReconnect` with exponential backoff.
	 *
	 * An attempt counts as successful only when `onReconnect` returns true AND no
	 * disconnect was reported ({@link requestRetry}) while it ran: a session that
	 * drops before the attempt returns is retried, never silently lost (NEW-SYNC-2).
	 *
	 * @param onReconnect - Called on each attempt. Return `true` if reconnection succeeded
	 *   (the caller decides what success means; Kora waits for the `streaming` state).
	 * @returns Promise that resolves when reconnection succeeds or maxAttempts reached.
	 */
	async start(onReconnect: () => Promise<boolean>): Promise<boolean> {
		this.stopped = false
		this.running = true
		this.pendingRetry = false
		this.clearStableTimer()

		try {
			while (!this.stopped) {
				if (this.maxAttempts > 0 && this.attempt >= this.maxAttempts) {
					return false
				}

				const delay = this.getNextDelay()
				this.attempt++

				await this.wait(delay)

				if (this.stopped) return false

				this.pendingRetry = false
				try {
					const success = await onReconnect()
					if (this.stopped) return false
					if (success && !this.pendingRetry) {
						return true
					}
				} catch {
					// Continue retrying on failure
				}
			}

			return false
		} finally {
			this.running = false
			this.pendingRetry = false
		}
	}

	/**
	 * Report a disconnect. While a run is in flight it makes the current attempt count
	 * as failed, so the loop retries (with backoff) instead of exiting on a session
	 * that already dropped. Returns true when a running loop took the request; false
	 * means the caller should start a new run.
	 */
	requestRetry(): boolean {
		this.clearStableTimer()
		if (!this.running) return false
		this.pendingRetry = true
		return true
	}

	/**
	 * Report that a connection is up (it reached streaming). If it is still up after
	 * `stableAfterMs`, the backoff resets to the initial delay. A disconnect reported
	 * before then ({@link requestRetry} or {@link reportDisconnected}) cancels the reset.
	 */
	reportConnected(): void {
		this.clearStableTimer()
		if (this.stableAfterMs <= 0) {
			this.attempt = 0
			return
		}
		this.stableTimer = setTimeout(() => {
			this.stableTimer = null
			this.attempt = 0
		}, this.stableAfterMs)
		const timer = this.stableTimer as { unref?: () => void }
		timer.unref?.()
	}

	/** Report that the connection dropped: a pending backoff reset is cancelled. */
	reportDisconnected(): void {
		this.clearStableTimer()
	}

	/**
	 * Cancel the current backoff wait and proceed to the next reconnect attempt immediately.
	 * No-op if not waiting.
	 */
	wake(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer)
			this.timer = null
		}
		if (this.waitResolve) {
			this.waitResolve()
			this.waitResolve = null
		}
	}

	/**
	 * Stop any pending reconnection attempt.
	 */
	stop(): void {
		this.stopped = true
		this.clearStableTimer()
		if (this.timer !== null) {
			clearTimeout(this.timer)
			this.timer = null
		}
		// Resolve the pending wait promise so start() loop can exit
		if (this.waitResolve) {
			this.waitResolve()
			this.waitResolve = null
		}
	}

	/**
	 * Reset the attempt counter to the initial delay. Call after a deliberate
	 * (user-initiated) reconnection. It never clears a {@link stop}: a stopped loop
	 * stays stopped, so a stop racing a reset cannot resurrect it (SYNC-8).
	 */
	reset(): void {
		this.attempt = 0
	}

	/**
	 * Compute the next delay for the current attempt.
	 * Exposed for testing purposes.
	 */
	getNextDelay(): number {
		const baseDelay = Math.min(this.initialDelay * this.multiplier ** this.attempt, this.maxDelay)

		// Apply jitter: varies the delay by ±jitter factor
		const jitterRange = baseDelay * this.jitter
		const jitterOffset = (this.random() - 0.5) * 2 * jitterRange
		return Math.max(0, Math.round(baseDelay + jitterOffset))
	}

	/**
	 * Whether the reconnection loop is currently running.
	 */
	isRunning(): boolean {
		return this.running
	}

	/**
	 * Current attempt number (for testing).
	 */
	getAttemptCount(): number {
		return this.attempt
	}

	private clearStableTimer(): void {
		if (this.stableTimer !== null) {
			clearTimeout(this.stableTimer)
			this.stableTimer = null
		}
	}

	private wait(ms: number): Promise<void> {
		return new Promise((resolve) => {
			this.waitResolve = resolve
			this.timer = setTimeout(() => {
				this.timer = null
				this.waitResolve = null
				resolve()
			}, ms)
		})
	}
}
