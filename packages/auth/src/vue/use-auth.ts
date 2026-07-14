import { computed, onScopeDispose, reactive } from 'vue'
import type {
	AuthUser,
	LinkedOAuthAccount,
	OAuthAuthorizationOptions,
	OAuthAuthorizationResult,
	OAuthCallbackParams,
} from '../client/auth-client'
import { useAuthContext } from './auth-provider'

export interface UseAuthResult {
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
}

export interface AuthStatus {
	state: import('../client/auth-client').AuthState
	isAuthenticated: boolean
	isLoading: boolean
}

export function useAuth(): UseAuthResult {
	const { session } = useAuthContext()
	const state = reactive({ ...session.getSnapshot() })

	const sync = (): void => {
		Object.assign(state, session.getSnapshot())
	}

	const unsubscribe = session.subscribe(sync)
	sync()

	onScopeDispose(unsubscribe)

	return {
		get user() {
			return state.user
		},
		get isAuthenticated() {
			return state.isAuthenticated
		},
		get isLoading() {
			return state.isLoading
		},
		get error() {
			return state.error
		},
		signUp: (params) => session.signUp(params).then(sync),
		signIn: (params) => session.signIn(params).then(sync),
		signInWithOAuth: (provider, options) =>
			session.signInWithOAuth(provider, options).then((result) => {
				sync()
				return result
			}),
		completeOAuthSignIn: (provider, params) =>
			session.completeOAuthSignIn(provider, params).then(sync),
		getOAuthAuthorizationUrl: (provider, options) =>
			session.getOAuthAuthorizationUrl(provider, options).then((result) => {
				sync()
				return result
			}),
		linkOAuth: (provider, params) =>
			session.linkOAuth(provider, params).then((result) => {
				sync()
				return result
			}),
		listLinkedAccounts: () =>
			session.listLinkedAccounts().then((result) => {
				sync()
				return result
			}),
		unlinkOAuth: (provider) => session.unlinkOAuth(provider).then(sync),
		signOut: () => session.signOut().then(sync),
	}
}

export function useCurrentUser() {
	const { session } = useAuthContext()
	const state = reactive({ user: session.getSnapshot().user })

	const sync = (): void => {
		state.user = session.getSnapshot().user
	}

	const unsubscribe = session.subscribe(sync)
	onScopeDispose(unsubscribe)

	return computed(() => state.user)
}

export function useAuthStatus(): AuthStatus {
	const { session } = useAuthContext()
	const state = reactive({
		state: session.getSnapshot().state,
		isAuthenticated: session.getSnapshot().isAuthenticated,
		isLoading: session.getSnapshot().isLoading,
	})

	const sync = (): void => {
		const snapshot = session.getSnapshot()
		state.state = snapshot.state
		state.isAuthenticated = snapshot.isAuthenticated
		state.isLoading = snapshot.isLoading
	}

	const unsubscribe = session.subscribe(sync)
	sync()
	onScopeDispose(unsubscribe)

	return state
}
