import { createContext } from 'react'
import type { AuthSession } from '../bindings/create-auth-session'
import type { AuthClient } from '../client/auth-client'

/**
 * Possible authentication states for the client.
 */
type AuthState = 'loading' | 'authenticated' | 'unauthenticated'

/**
 * Shape of the value provided by the AuthContext.
 */
interface AuthContextValue {
	client: AuthClient
	session: AuthSession
	state: AuthState
	isLoading: boolean
}

/**
 * React context for Kora authentication.
 */
const AuthContext = createContext<AuthContextValue | null>(null)

export { AuthContext }
export type { AuthContextValue, AuthState }
