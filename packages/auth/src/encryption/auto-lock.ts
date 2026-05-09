/**
 * Configuration for the AutoLockManager.
 */
export interface AutoLockConfig {
	/** Inactivity timeout in milliseconds before auto-locking. */
	timeout: number
	/** Callback invoked when the lock engages (either by timeout or manual lock). */
	onLock: () => void
}

/**
 * Manages inactivity-based auto-locking for the encrypted local store.
 *
 * The AutoLockManager starts an inactivity timer when {@link start} is called.
 * If no user activity is reported via {@link reportActivity} within the configured
 * timeout, the manager transitions to the locked state and invokes the `onLock`
 * callback.
 *
 * This class has no DOM dependencies. It uses `setTimeout` and `clearTimeout` for
 * timing and accepts an `onLock` callback for side effects. The consuming code is
 * responsible for wiring DOM events (e.g., visibility changes, user interactions)
 * to {@link reportActivity}.
 *
 * @example
 * ```typescript
 * const manager = new AutoLockManager({
 *   timeout: 15 * 60 * 1000, // 15 minutes
 *   onLock: () => {
 *     // Clear decrypted data from memory
 *     // Show lock screen
 *   }
 * })
 *
 * manager.start()
 *
 * // Call on user interactions to reset the timer
 * document.addEventListener('click', () => manager.reportActivity())
 * document.addEventListener('keydown', () => manager.reportActivity())
 *
 * // Check lock state
 * if (manager.isLocked) {
 *   // Prompt for passphrase
 * }
 * ```
 */
export class AutoLockManager {
	private readonly _timeout: number
	private readonly _onLock: () => void
	private _timerId: ReturnType<typeof setTimeout> | null = null
	private _isLocked = false
	private _isRunning = false

	constructor(config: AutoLockConfig) {
		if (config.timeout <= 0) {
			throw new Error(
				`AutoLockManager timeout must be a positive number, but received ${config.timeout}.`,
			)
		}

		this._timeout = config.timeout
		this._onLock = config.onLock
	}

	/**
	 * Whether the manager is currently in the locked state.
	 *
	 * Becomes `true` when the inactivity timeout fires or {@link lock} is called manually.
	 * Returns to `false` only when {@link unlock} is called.
	 */
	get isLocked(): boolean {
		return this._isLocked
	}

	/**
	 * Starts monitoring for inactivity.
	 *
	 * Begins the inactivity countdown. If the manager is already running, this is
	 * a no-op to prevent creating multiple timers. Calling `start()` also resets
	 * the locked state if the manager was previously locked.
	 */
	start(): void {
		if (this._isRunning) {
			return
		}

		this._isRunning = true
		this._isLocked = false
		this._startTimer()
	}

	/**
	 * Stops monitoring for inactivity.
	 *
	 * Clears the pending inactivity timer. Does not change the lock state: if
	 * the manager was locked, it remains locked. If unlocked, it remains unlocked.
	 * To resume monitoring, call {@link start} again.
	 */
	stop(): void {
		this._isRunning = false
		this._clearTimer()
	}

	/**
	 * Reports user activity, resetting the inactivity timer.
	 *
	 * Call this whenever the user interacts with the application (clicks, key presses,
	 * touches, etc.). If the manager is not running or is already locked, this is a no-op.
	 */
	reportActivity(): void {
		if (!this._isRunning || this._isLocked) {
			return
		}

		this._clearTimer()
		this._startTimer()
	}

	/**
	 * Manually locks the manager immediately.
	 *
	 * Clears the inactivity timer and transitions to the locked state. The `onLock`
	 * callback is invoked. The manager remains running but locked: call {@link unlock}
	 * to return to the unlocked state, which will restart the inactivity timer.
	 */
	lock(): void {
		this._clearTimer()

		if (!this._isLocked) {
			this._isLocked = true
			this._onLock()
		}
	}

	/**
	 * Unlocks the manager, returning to the unlocked state.
	 *
	 * If the manager is running, the inactivity timer is restarted. If the manager
	 * is not running (was stopped), it simply clears the locked state without
	 * starting a timer.
	 */
	unlock(): void {
		this._isLocked = false

		if (this._isRunning) {
			this._clearTimer()
			this._startTimer()
		}
	}

	/**
	 * Starts the inactivity timer. When it fires, the manager locks.
	 */
	private _startTimer(): void {
		this._timerId = setTimeout(() => {
			this._timerId = null
			this._isLocked = true
			this._onLock()
		}, this._timeout)
	}

	/**
	 * Clears the pending inactivity timer, if any.
	 */
	private _clearTimer(): void {
		if (this._timerId !== null) {
			clearTimeout(this._timerId)
			this._timerId = null
		}
	}
}
