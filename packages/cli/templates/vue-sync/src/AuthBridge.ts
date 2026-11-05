import { AuthProvider, useAuth, useAuthStatus } from '@korajs/auth/vue'
import { defineComponent, h, onMounted, watchEffect } from 'vue'
import { authClient, completeOAuthCallbackFromLocation } from './auth'
import { publishAuth } from './auth-state'

/** Publishes the session to the screen (see auth-state.ts). Renders nothing. */
const SessionPublisher = defineComponent({
	name: 'SessionPublisher',
	setup() {
		const auth = useAuth()
		const status = useAuthStatus()
		watchEffect(() => {
			publishAuth({
				loading: status.isLoading,
				user: auth.user ? { id: auth.user.id, email: auth.user.email } : null,
				isAuthenticated: auth.isAuthenticated,
				error: auth.error ?? null,
				signIn: () => void auth.signInWithOAuth('google'),
				signOut: auth.signOut,
			})
		})
		return () => null
	},
})

/**
 * The sign-in client, mounted after the first paint. Everything that needs `@korajs/auth` lives
 * behind this component so the task list does not carry it.
 */
export default defineComponent({
	name: 'AuthBridge',
	setup() {
		onMounted(() => {
			void completeOAuthCallbackFromLocation().catch((callbackError) => {
				console.error('[Kora Auth] OAuth callback failed:', callbackError)
			})
		})
		return () =>
			h(
				AuthProvider,
				{ client: authClient, fallback: null },
				{ default: () => h(SessionPublisher) },
			)
	},
})
