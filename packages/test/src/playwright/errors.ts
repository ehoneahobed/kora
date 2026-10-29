import { KoraError } from '@korajs/core'

/**
 * Thrown by the Playwright helpers when an offline-readiness expectation is not met, or when a
 * helper is used where the browser cannot support it (for example `killTab` outside Chromium).
 *
 * @example
 * ```typescript
 * try {
 *   await waitForOfflineStatus(page, 'ready', { timeoutMs: 2000 })
 * } catch (error) {
 *   if (error instanceof OfflineAssertionError) console.error(error.code, error.context)
 * }
 * ```
 */
export class OfflineAssertionError extends KoraError {
	constructor(message: string, code: string, context?: Record<string, unknown>) {
		super(message, code, context)
		this.name = 'OfflineAssertionError'
	}
}
