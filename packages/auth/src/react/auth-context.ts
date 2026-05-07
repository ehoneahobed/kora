import { createContext } from 'react'
import type { AuthClient } from '../client/auth-client'

/**
 * Possible authentication states for the client.
 * - 'loading': Initial state while restoring tokens from storage
 * - 'authenticated': User is signed in with a valid session
 * - 'unauthenticated': No valid session exists
 */
type AuthState = 'loading' | 'authenticated' | 'unauthenticated'

/**
 * Shape of the value provided by the AuthContext.
 * Includes the AuthClient instance, reactive state, and a loading flag.
 */
interface AuthContextValue {
	/** The underlying AuthClient instance for direct access */
	client: AuthClient

	/** Current authentication state */
	state: AuthState

	/** Whether the client is still initializing (restoring session from storage) */
	isLoading: boolean
}

/**
 * React context for Kora authentication.
 *
 * Provides the AuthClient and reactive auth state to child components.
 * Must be provided by an AuthProvider higher in the component tree.
 * Defaults to null — hooks that consume this context throw if it is missing.
 */
const AuthContext = createContext<AuthContextValue | null>(null)

export { AuthContext }
export type { AuthContextValue, AuthState }
