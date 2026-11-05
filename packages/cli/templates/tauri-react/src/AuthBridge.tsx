import { AuthProvider, useAuth } from '@korajs/auth/react'
import { useEffect } from 'react'
import { completeOAuthCallbackFromLocation, getDesktopAuth, openOAuthSignIn } from './auth'
import { publishAuth } from './auth-state'

/** Publishes the session to the screen (see auth-state.ts). Renders nothing. */
function SessionPublisher({ syncUrl }: { syncUrl: string | null }) {
	const { user, isAuthenticated, isLoading, error, signOut } = useAuth()
	useEffect(() => {
		publishAuth({
			loading: isLoading,
			user: user ? { id: user.id, email: user.email } : null,
			isAuthenticated,
			error: error ?? null,
			signIn: () => void openOAuthSignIn(getDesktopAuth(syncUrl).authClient),
			signOut,
		})
	}, [user, isAuthenticated, isLoading, error, signOut, syncUrl])
	return null
}

/**
 * The sign-in client, mounted after the first paint. Everything that needs `@korajs/auth` lives
 * behind this component so the task list does not carry it.
 */
export default function AuthBridge({ syncUrl }: { syncUrl: string | null }) {
	const { authClient } = getDesktopAuth(syncUrl)
	useEffect(() => {
		void completeOAuthCallbackFromLocation(authClient).catch((callbackError) => {
			console.error('[Kora Auth] OAuth callback failed:', callbackError)
		})
	}, [authClient])
	return (
		<AuthProvider client={authClient} fallback={null}>
			<SessionPublisher syncUrl={syncUrl} />
		</AuthProvider>
	)
}
