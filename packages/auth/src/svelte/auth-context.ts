import { getContext, setContext } from 'svelte'
import { type AuthSession, createAuthSession } from '../bindings/create-auth-session'
import type { AuthClient, AuthState } from '../client/auth-client'

const authContextKey = Symbol('korajs-auth-context')

export interface AuthContextValue {
	client: AuthClient
	session: AuthSession
	get state(): AuthState
	get isLoading(): boolean
}

/**
 * Initialize auth context inside a Svelte component (root layout).
 * Must be called during component initialization before children render.
 */
export function initAuthProvider(client: AuthClient): AuthContextValue {
	const session = createAuthSession(client)

	const value: AuthContextValue = {
		client,
		session,
		get state() {
			return session.getSnapshot().state
		},
		get isLoading() {
			return session.getSnapshot().isLoading
		},
	}

	setContext(authContextKey, value)
	return value
}

export function getAuthContext(): AuthContextValue {
	const context = getContext<AuthContextValue | undefined>(authContextKey)
	if (!context) {
		throw new Error(
			'Auth context missing. Call initAuthProvider(client) in your root layout component.',
		)
	}
	return context
}

export function destroyAuthProvider(context: AuthContextValue): void {
	context.session.destroy()
}
