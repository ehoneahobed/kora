import { type Readable, readable } from 'svelte/store'
import type { AuthSessionSnapshot } from '../bindings/create-auth-session'
import type {
	AuthUser,
	LinkedOAuthAccount,
	OAuthAuthorizationOptions,
	OAuthAuthorizationResult,
	OAuthCallbackParams,
} from '../client/auth-client'
import { getAuthContext } from './auth-context'

export interface UseAuthResult extends AuthSessionSnapshot {
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
	/** Email the signed-in user a verification link. */
	sendVerificationEmail: () => Promise<{ sent: boolean; alreadyVerified: boolean }>
	/** Verify an address with the token from a verification link; `user.emailVerified` follows. */
	verifyEmail: (token: string) => Promise<{ email: string }>
	/** Email a password reset link to `email`, if it has an account. */
	requestPasswordReset: (email: string) => Promise<void>
	/** Set a new password with the token from a reset link; every session of the account ends. */
	resetPassword: (token: string, password: string) => Promise<void>
	/** Change the signed-in user's password; this device stays signed in, others are signed out. */
	changePassword: (currentPassword: string, newPassword: string) => Promise<void>
	signOut: () => Promise<void>
}

export function createAuthStore(): Readable<UseAuthResult> {
	const { session } = getAuthContext()

	return readable<UseAuthResult>(buildResult(session), (set) => {
		const sync = (): void => {
			set(buildResult(session))
		}
		sync()
		return session.subscribe(sync)
	})
}

/** @alias createAuthStore */
export const useAuth = createAuthStore

function buildResult(session: ReturnType<typeof getAuthContext>['session']): UseAuthResult {
	const snapshot = session.getSnapshot()
	return {
		...snapshot,
		signUp: (params) => session.signUp(params),
		signIn: (params) => session.signIn(params),
		signInWithOAuth: (provider, options) => session.signInWithOAuth(provider, options),
		completeOAuthSignIn: (provider, params) => session.completeOAuthSignIn(provider, params),
		getOAuthAuthorizationUrl: (provider, options) =>
			session.getOAuthAuthorizationUrl(provider, options),
		linkOAuth: (provider, params) => session.linkOAuth(provider, params),
		listLinkedAccounts: () => session.listLinkedAccounts(),
		unlinkOAuth: (provider) => session.unlinkOAuth(provider),
		sendVerificationEmail: () => session.sendVerificationEmail(),
		verifyEmail: (token) => session.verifyEmail(token),
		requestPasswordReset: (email) => session.requestPasswordReset(email),
		resetPassword: (token, password) => session.resetPassword(token, password),
		changePassword: (currentPassword, newPassword) =>
			session.changePassword(currentPassword, newPassword),
		signOut: () => session.signOut(),
	}
}

export function createCurrentUserStore(): Readable<AuthUser | null> {
	const { session } = getAuthContext()
	return readable<AuthUser | null>(session.getSnapshot().user, (set) => {
		const sync = (): void => {
			set(session.getSnapshot().user)
		}
		sync()
		return session.subscribe(sync)
	})
}

/** @alias createCurrentUserStore */
export const useCurrentUser = createCurrentUserStore

export function createAuthStatusStore(): Readable<{
	state: AuthSessionSnapshot['state']
	isAuthenticated: boolean
	isLoading: boolean
}> {
	const { session } = getAuthContext()
	return readable(
		{
			state: session.getSnapshot().state,
			isAuthenticated: session.getSnapshot().isAuthenticated,
			isLoading: session.getSnapshot().isLoading,
		},
		(set) => {
			const sync = (): void => {
				const snapshot = session.getSnapshot()
				set({
					state: snapshot.state,
					isAuthenticated: snapshot.isAuthenticated,
					isLoading: snapshot.isLoading,
				})
			}
			sync()
			return session.subscribe(sync)
		},
	)
}

/** @alias createAuthStatusStore */
export const useAuthStatus = createAuthStatusStore
