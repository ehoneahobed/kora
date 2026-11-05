import { defineComponent } from 'vue'
import { failAuth } from './auth-state'

/**
 * Rendered by the async sign-in bridge when its chunk cannot be loaded (a stale chunk after a
 * deploy, a dropped request). A failed load must not take the app down: the screen is told, and
 * nothing renders.
 */
export const AuthLoadError = defineComponent({
	setup() {
		console.error('[Kora Auth] The sign-in client did not load; the app keeps working offline.')
		failAuth()
		return () => null
	},
})
