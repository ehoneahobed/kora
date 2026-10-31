import { AuthProvider, useAuth } from '@korajs/auth/react'
import { useEffect } from 'react'
import { authClient, completeOAuthCallbackFromLocation } from './auth'
import { publishAuth } from './auth-state'

/** Publishes the session to the screen (see auth-state.ts). Renders nothing. */
function SessionPublisher() {
	const { user, isAuthenticated, error, signInWithOAuth, signOut } = useAuth()
	useEffect(() => {
		publishAuth({
			loading: false,
			user: user ? { id: user.id, email: user.email } : null,
			isAuthenticated,
			error: error ?? null,
			signIn: () => void signInWithOAuth('google'),
			signOut,
		})
	}, [user, isAuthenticated, error, signInWithOAuth, signOut])
	return null
}

/**
 * The sign-in client, mounted after the first paint. Everything that needs `@korajs/auth` lives
 * behind this component so the task list does not carry it.
 */
export default function AuthBridge() {
	useEffect(() => {
		void completeOAuthCallbackFromLocation().catch((callbackError) => {
			console.error('[Kora Auth] OAuth callback failed:', callbackError)
		})
	}, [])
	return (
		<AuthProvider client={authClient} fallback={null}>
			<SessionPublisher />
		</AuthProvider>
	)
}
