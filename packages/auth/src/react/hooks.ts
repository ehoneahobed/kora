import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AuthUser, AuthState } from '../client/auth-client'
import { AuthContext } from './auth-context'

// ---------------------------------------------------------------------------
// Internal context accessor
// ---------------------------------------------------------------------------

/**
 * Internal hook that reads and validates the AuthContext.
 * Throws a descriptive error if used outside an AuthProvider.
 */
function useAuthContext(): { client: import('../client/auth-client').AuthClient; state: AuthState; isLoading: boolean } {
	const ctx = useContext(AuthContext)
	if (ctx === null) {
		throw new Error(
			'useAuth / useCurrentUser / useAuthStatus must be used within an <AuthProvider>. ' +
				'Wrap your component tree with <AuthProvider client={authClient}>.',
		)
	}
	return ctx
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Return value of the {@link useAuth} hook.
 */
interface UseAuthResult {
	/** Current authenticated user, or null if not signed in */
	user: AuthUser | null

	/** Whether the user is currently authenticated */
	isAuthenticated: boolean

	/** Whether the auth client is still initializing (restoring session) */
	isLoading: boolean

	/** Sign up a new user account */
	signUp: (params: { email: string; password: string; name?: string }) => Promise<void>

	/** Sign in with email and password */
	signIn: (params: { email: string; password: string }) => Promise<void>

	/** Sign out the current user */
	signOut: () => Promise<void>

	/** Last error message from a sign-up, sign-in, or sign-out attempt, or null */
	error: string | null
}

/**
 * Auth status information returned by {@link useAuthStatus}.
 */
interface AuthStatus {
	/** Current authentication state */
	state: AuthState

	/** Whether the user is currently authenticated */
	isAuthenticated: boolean

	/** Whether the auth client is still initializing */
	isLoading: boolean
}

// ---------------------------------------------------------------------------
// useAuth
// ---------------------------------------------------------------------------

/**
 * React hook providing full authentication functionality.
 *
 * Returns the current user, loading state, error state, and methods for
 * sign-up, sign-in, and sign-out. Re-renders when auth state changes.
 *
 * Must be used within an {@link AuthProvider}.
 *
 * @returns An object with user info, auth methods, and status flags
 *
 * @example
 * ```typescript
 * function LoginPage() {
 *   const { user, isAuthenticated, isLoading, signIn, error } = useAuth()
 *
 *   if (isLoading) return <div>Loading...</div>
 *   if (isAuthenticated) return <div>Welcome, {user?.name}</div>
 *
 *   return (
 *     <form onSubmit={async (e) => {
 *       e.preventDefault()
 *       await signIn({ email: 'user@example.com', password: 'secret' })
 *     }}>
 *       {error && <p>{error}</p>}
 *       <button type="submit">Sign In</button>
 *     </form>
 *   )
 * }
 * ```
 */
function useAuth(): UseAuthResult {
	const { client, state, isLoading } = useAuthContext()
	const [error, setError] = useState<string | null>(null)

	// Use useSyncExternalStore to track the user reactively via auth state changes
	const userSnapshotRef = useRef<AuthUser | null>(client.currentUser)
	const stateSerializedRef = useRef<string>(JSON.stringify(client.currentUser))

	const subscribe = useCallback(
		(onStoreChange: () => void): (() => void) => {
			return client.onAuthChange(() => {
				const newUser = client.currentUser
				const newSerialized = JSON.stringify(newUser)
				if (newSerialized !== stateSerializedRef.current) {
					userSnapshotRef.current = newUser
					stateSerializedRef.current = newSerialized
					onStoreChange()
				}
			})
		},
		[client],
	)

	const getSnapshot = useCallback((): AuthUser | null => {
		return userSnapshotRef.current
	}, [])

	const user = useSyncExternalStore(subscribe, getSnapshot)

	const signUp = useCallback(
		async (params: { email: string; password: string; name?: string }): Promise<void> => {
			setError(null)
			try {
				await client.signUp(params)
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err)
				setError(message)
			}
		},
		[client],
	)

	const signIn = useCallback(
		async (params: { email: string; password: string }): Promise<void> => {
			setError(null)
			try {
				await client.signIn(params)
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err)
				setError(message)
			}
		},
		[client],
	)

	const signOut = useCallback(async (): Promise<void> => {
		setError(null)
		try {
			await client.signOut()
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err)
			setError(message)
		}
	}, [client])

	return {
		user,
		isAuthenticated: state === 'authenticated',
		isLoading,
		signUp,
		signIn,
		signOut,
		error,
	}
}

// ---------------------------------------------------------------------------
// useCurrentUser
// ---------------------------------------------------------------------------

/**
 * React hook that returns the currently authenticated user, or null.
 *
 * A lightweight alternative to {@link useAuth} when you only need the user
 * object and do not need auth methods or error state.
 *
 * Must be used within an {@link AuthProvider}.
 *
 * @returns The current AuthUser or null if not authenticated
 *
 * @example
 * ```typescript
 * function UserAvatar() {
 *   const user = useCurrentUser()
 *   if (!user) return null
 *   return <span>{user.name ?? user.email}</span>
 * }
 * ```
 */
function useCurrentUser(): AuthUser | null {
	const { client } = useAuthContext()

	const userSnapshotRef = useRef<AuthUser | null>(client.currentUser)
	const stateSerializedRef = useRef<string>(JSON.stringify(client.currentUser))

	const subscribe = useCallback(
		(onStoreChange: () => void): (() => void) => {
			return client.onAuthChange(() => {
				const newUser = client.currentUser
				const newSerialized = JSON.stringify(newUser)
				if (newSerialized !== stateSerializedRef.current) {
					userSnapshotRef.current = newUser
					stateSerializedRef.current = newSerialized
					onStoreChange()
				}
			})
		},
		[client],
	)

	const getSnapshot = useCallback((): AuthUser | null => {
		return userSnapshotRef.current
	}, [])

	return useSyncExternalStore(subscribe, getSnapshot)
}

// ---------------------------------------------------------------------------
// useAuthStatus
// ---------------------------------------------------------------------------

/**
 * React hook that returns the current authentication status.
 *
 * Re-renders only when the auth state changes, not on every auth event.
 * Use this for status indicators, route guards, and conditional rendering.
 *
 * Must be used within an {@link AuthProvider}.
 *
 * @returns An AuthStatus object with state, isAuthenticated, and isLoading flags
 *
 * @example
 * ```typescript
 * function AuthGuard({ children }: { children: React.ReactNode }) {
 *   const { isAuthenticated, isLoading } = useAuthStatus()
 *   if (isLoading) return <Spinner />
 *   if (!isAuthenticated) return <Navigate to="/login" />
 *   return <>{children}</>
 * }
 * ```
 */
function useAuthStatus(): AuthStatus {
	const { state, isLoading } = useAuthContext()

	return {
		state,
		isAuthenticated: state === 'authenticated',
		isLoading,
	}
}

export { useAuth, useCurrentUser, useAuthStatus }
export type { UseAuthResult, AuthStatus }
