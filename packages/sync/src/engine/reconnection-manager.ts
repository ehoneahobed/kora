import type { TimeSource } from '@kora/core'

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
	/** Injectable time source for deterministic testing. */
	timeSource?: TimeSource
	/** Injectable random source for deterministic jitter. Returns value in [0, 1). */
	randomSource?: () => number
}

/**
 * Manages reconnection attempts with exponential backoff and jitter.
 *
 * Formula: min(initialDelay * multiplier^attempt, maxDelay) * (1 + jitter * (random - 0.5) * 2)
 */
export class ReconnectionManager {
	private readonly initialDelay: number
	private readonly maxDelay: number
	private readonly multiplier: number
	private readonly maxAttempts: number
	private readonly jitter: number
	private readonly random: () => number

	private attempt = 0
	private timer: ReturnType<typeof setTimeout> | null = null
	private stopped = false
	private waitResolve: (() => void) | null = null

	constructor(config?: ReconnectionConfig) {
		this.initialDelay = config?.initialDelay ?? 1000
		this.maxDelay = config?.maxDelay ?? 30000
		this.multiplier = config?.multiplier ?? 2
		this.maxAttempts = config?.maxAttempts ?? 0
		this.jitter = config?.jitter ?? 0.25
		this.random = config?.randomSource ?? Math.random
	}

	/**
	 * Start reconnection attempts. Calls `onReconnect` with exponential backoff.
	 *
	 * @param onReconnect - Called on each attempt. Return `true` if reconnection succeeded.
	 * @returns Promise that resolves when reconnection succeeds or maxAttempts reached.
	 */
	async start(onReconnect: () => Promise<boolean>): Promise<boolean> {
		this.stopped = false
		this.attempt = 0

		while (!this.stopped) {
			if (this.maxAttempts > 0 && this.attempt >= this.maxAttempts) {
				return false
			}

			const delay = this.getNextDelay()
			this.attempt++

			await this.wait(delay)

			if (this.stopped) return false

			try {
				const success = await onReconnect()
				if (success) {
					this.reset()
					return true
				}
			} catch {
				// Continue retrying on failure
			}
		}

		return false
	}

	/**
	 * Stop any pending reconnection attempt.
	 */
	stop(): void {
		this.stopped = true
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
	 * Reset the attempt counter. Call after a successful manual reconnection.
	 */
	reset(): void {
		this.attempt = 0
		this.stopped = false
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
	 * Current attempt number (for testing).
	 */
	getAttemptCount(): number {
		return this.attempt
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
