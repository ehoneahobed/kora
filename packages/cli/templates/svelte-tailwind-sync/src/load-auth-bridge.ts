import { failAuth } from './auth-state'

/**
 * Starts loading the sign-in bridge component. A failed load (a stale chunk after a deploy, a
 * dropped request) must not take the app down: the screen is told why, and the returned promise
 * still rejects so the `{#await}` block renders nothing for it.
 */
export function loadAuthBridge<T>(load: () => Promise<T>): Promise<T> {
	const bridge = load()
	bridge.catch((error: unknown) => {
		console.error(
			'[Kora Auth] The sign-in client did not load; the app keeps working offline:',
			error,
		)
		failAuth()
	})
	return bridge
}
