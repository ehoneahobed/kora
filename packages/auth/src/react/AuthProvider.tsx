import { createElement, useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { AuthClient, AuthState } from '../client/auth-client'
import { AuthContext } from './auth-context'

/**
 * Props for the AuthProvider component.
 */
interface AuthProviderProps {
	/** The AuthClient instance to provide to child components */
	client: AuthClient

	/** Child components that will have access to auth context */
	children: ReactNode

	/**
	 * Optional fallback content to render while the auth client is initializing.
	 * If not provided, children are rendered with `isLoading: true` in the context.
	 */
	fallback?: ReactNode
}

/**
 * React context provider that wraps the AuthClient for use with auth hooks.
 *
 * Calls `client.initialize()` on mount to restore any existing session from
 * stored tokens. Subscribes to auth state changes and re-renders children
 * when the state transitions.
 *
 * Must be placed above any component that uses {@link useAuth},
 * {@link useCurrentUser}, or {@link useAuthStatus}.
 *
 * @param props - Provider props including the AuthClient instance and children
 * @returns A React element wrapping children in the AuthContext
 *
 * @example
 * ```typescript
 * import { AuthClient } from '@korajs/auth'
 * import { AuthProvider } from '@korajs/auth/react'
 *
 * const authClient = new AuthClient({ serverUrl: 'http://localhost:3001' })
 *
 * function App() {
 *   return (
 *     <AuthProvider client={authClient} fallback={<div>Loading...</div>}>
 *       <MyApp />
 *     </AuthProvider>
 *   )
 * }
 * ```
 */
function AuthProvider({ client, children, fallback }: AuthProviderProps): ReactElement {
	const [state, setState] = useState<AuthState>(client.state)
	const [isLoading, setIsLoading] = useState(true)
	const [initError, setInitError] = useState<Error | null>(null)

	// Initialize the auth client on mount
	useEffect(() => {
		let cancelled = false

		// Subscribe to auth state changes
		const unsubscribe = client.onAuthChange((newState) => {
			if (!cancelled) {
				setState(newState)
			}
		})

		client
			.initialize()
			.then(() => {
				if (!cancelled) {
					setState(client.state)
					setIsLoading(false)
				}
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					const err = error instanceof Error ? error : new Error(String(error))
					console.error('[Kora Auth] Initialization failed:', err)
					setInitError(err)
					setIsLoading(false)
				}
			})

		return () => {
			cancelled = true
			unsubscribe()
		}
	}, [client])

	// Show error if initialization failed
	if (initError) {
		return createElement(
			'div',
			{
				style: { color: 'red', padding: '1rem', fontFamily: 'monospace' },
				role: 'alert',
			},
			createElement('strong', null, 'Kora Auth initialization error: '),
			initError.message,
		)
	}

	// Show fallback while loading
	if (isLoading && fallback !== undefined) {
		return fallback as ReactElement
	}

	const contextValue = {
		client,
		state,
		isLoading,
	}

	return createElement(AuthContext.Provider, { value: contextValue }, children)
}

export { AuthProvider }
export type { AuthProviderProps }
