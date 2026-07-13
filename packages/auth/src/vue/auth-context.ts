import type { AuthClient, AuthState } from '../client/auth-client'

export interface AuthContextValue {
	client: AuthClient
	state: AuthState
	isLoading: boolean
	session: import('../bindings/create-auth-session').AuthSession
}

export const authContextKey = Symbol('korajs-auth-context')
