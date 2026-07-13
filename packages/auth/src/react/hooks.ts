import { useContext, useSyncExternalStore } from 'react'
import type {
	AuthState,
	AuthUser,
	LinkedOAuthAccount,
	OAuthAuthorizationOptions,
	OAuthAuthorizationResult,
	OAuthCallbackParams,
} from '../client/auth-client'
import { AuthContext } from './auth-context'

function useAuthContext() {
	const ctx = useContext(AuthContext)
	if (ctx === null) {
		throw new Error(
			'useAuth / useCurrentUser / useAuthStatus must be used within an <AuthProvider>. ' +
				'Wrap your component tree with <AuthProvider client={authClient}>.',
		)
	}
	return ctx
}

interface UseAuthResult {
	user: AuthUser | null
	isAuthenticated: boolean
	isLoading: boolean
	signUp: (params: {
		email: string
		password: string
		name?: string
		deviceId?: string
		devicePublicKey?: string
	}) => Promise<void>
	signIn: (params: {
		email: string
		password: string
		deviceId?: string
		devicePublicKey?: string
	}) => Promise<void>
	signInWithOAuth: (
		provider: string,
		options?: OAuthAuthorizationOptions,
	) => Promise<OAuthAuthorizationResult>
	completeOAuthSignIn: (provider: string, params: OAuthCallbackParams) => Promise<void>
	getOAuthAuthorizationUrl: (
		provider: string,
		options?: OAuthAuthorizationOptions,
	) => Promise<OAuthAuthorizationResult>
	linkOAuth: (provider: string, params: OAuthCallbackParams) => Promise<LinkedOAuthAccount | null>
	listLinkedAccounts: () => Promise<LinkedOAuthAccount[]>
	unlinkOAuth: (provider: string) => Promise<void>
	signOut: () => Promise<void>
	error: string | null
	initError: Error | null
}

interface AuthStatus {
	state: AuthState
	isAuthenticated: boolean
	isLoading: boolean
}

function useAuthSessionSnapshot() {
	const { session } = useAuthContext()

	return useSyncExternalStore(
		(onStoreChange) => session.subscribe(onStoreChange),
		() => session.getSnapshot(),
		() => session.getSnapshot(),
	)
}

function useAuth(): UseAuthResult {
	const { session } = useAuthContext()
	const snapshot = useAuthSessionSnapshot()

	return {
		user: snapshot.user,
		isAuthenticated: snapshot.isAuthenticated,
		isLoading: snapshot.isLoading,
		error: snapshot.error,
		initError: snapshot.initError,
		signUp: (params) => session.signUp(params),
		signIn: (params) => session.signIn(params),
		signInWithOAuth: (provider, options) => session.signInWithOAuth(provider, options),
		completeOAuthSignIn: (provider, params) => session.completeOAuthSignIn(provider, params),
		getOAuthAuthorizationUrl: (provider, options) =>
			session.getOAuthAuthorizationUrl(provider, options),
		linkOAuth: (provider, params) => session.linkOAuth(provider, params),
		listLinkedAccounts: () => session.listLinkedAccounts(),
		unlinkOAuth: (provider) => session.unlinkOAuth(provider),
		signOut: () => session.signOut(),
	}
}

function useCurrentUser(): AuthUser | null {
	return useAuthSessionSnapshot().user
}

function useAuthStatus(): AuthStatus {
	const snapshot = useAuthSessionSnapshot()
	return {
		state: snapshot.state,
		isAuthenticated: snapshot.isAuthenticated,
		isLoading: snapshot.isLoading,
	}
}

export { useAuth, useCurrentUser, useAuthStatus }
export type { UseAuthResult, AuthStatus }
