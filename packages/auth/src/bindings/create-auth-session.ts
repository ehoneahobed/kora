import type {
	AuthClient,
	AuthState,
	AuthUser,
	LinkedOAuthAccount,
	OAuthAuthorizationOptions,
	OAuthAuthorizationResult,
	OAuthCallbackParams,
} from '../client/auth-client'

export interface AuthSessionSnapshot {
	state: AuthState
	user: AuthUser | null
	isAuthenticated: boolean
	isLoading: boolean
	initError: Error | null
	error: string | null
}

export interface AuthSession {
	readonly client: AuthClient
	getSnapshot(): AuthSessionSnapshot
	subscribe(listener: () => void): () => void
	signUp(params: {
		email: string
		password: string
		name?: string
		deviceId?: string
		devicePublicKey?: string
	}): Promise<void>
	signIn(params: {
		email: string
		password: string
		deviceId?: string
		devicePublicKey?: string
	}): Promise<void>
	signInWithOAuth(
		provider: string,
		options?: OAuthAuthorizationOptions,
	): Promise<OAuthAuthorizationResult>
	completeOAuthSignIn(provider: string, params: OAuthCallbackParams): Promise<void>
	getOAuthAuthorizationUrl(
		provider: string,
		options?: OAuthAuthorizationOptions,
	): Promise<OAuthAuthorizationResult>
	linkOAuth(provider: string, params: OAuthCallbackParams): Promise<LinkedOAuthAccount | null>
	listLinkedAccounts(): Promise<LinkedOAuthAccount[]>
	unlinkOAuth(provider: string): Promise<void>
	signOut(): Promise<void>
	destroy(): void
}

/**
 * Framework-agnostic auth session: initialization, reactive snapshot, and client methods.
 */
export function createAuthSession(client: AuthClient): AuthSession {
	let state: AuthState = client.state
	let isLoading = true
	let initError: Error | null = null
	let lastError: string | null = null

	const listeners = new Set<() => void>()
	let snapshot = buildSnapshot()

	const refreshSnapshot = (): void => {
		snapshot = buildSnapshot()
	}

	const notify = (): void => {
		refreshSnapshot()
		for (const listener of listeners) {
			listener()
		}
	}

	function buildSnapshot(): AuthSessionSnapshot {
		return {
			state,
			user: client.currentUser,
			isAuthenticated: state === 'authenticated',
			isLoading,
			initError,
			error: lastError,
		}
	}

	const captureError = (error: unknown): void => {
		lastError = error instanceof Error ? error.message : String(error)
		notify()
	}

	const run = async (action: () => Promise<void>): Promise<void> => {
		lastError = null
		try {
			await action()
		} catch (error) {
			captureError(error)
		}
	}

	const runWithResult = async <T>(action: () => Promise<T>): Promise<T | null> => {
		lastError = null
		try {
			return await action()
		} catch (error) {
			captureError(error)
			return null
		}
	}

	const unsubscribeAuth = client.onAuthChange((nextState) => {
		state = nextState
		notify()
	})

	void client
		.initialize()
		.then(() => {
			state = client.state
			isLoading = false
			notify()
		})
		.catch((error: unknown) => {
			initError = error instanceof Error ? error : new Error(String(error))
			isLoading = false
			notify()
		})

	return {
		client,
		getSnapshot: () => snapshot,
		subscribe(listener) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		signUp: (params) =>
			run(async () => {
				await client.signUp(params)
			}),
		signIn: (params) =>
			run(async () => {
				await client.signIn(params)
			}),
		signInWithOAuth: async (provider, options) => {
			lastError = null
			try {
				return await client.signInWithOAuth(provider, options)
			} catch (error) {
				captureError(error)
				throw error instanceof Error ? error : new Error(String(error))
			}
		},
		completeOAuthSignIn: (provider, params) =>
			run(async () => {
				await client.completeOAuthSignIn(provider, params)
			}),
		getOAuthAuthorizationUrl: async (provider, options) => {
			lastError = null
			try {
				return await client.getOAuthAuthorizationUrl(provider, options)
			} catch (error) {
				captureError(error)
				throw error instanceof Error ? error : new Error(String(error))
			}
		},
		linkOAuth: (provider, params) => runWithResult(async () => client.linkOAuth(provider, params)),
		listLinkedAccounts: () =>
			runWithResult(async () => client.listLinkedAccounts()).then((value) => value ?? []),
		unlinkOAuth: (provider) =>
			run(async () => {
				await client.unlinkOAuth(provider)
			}),
		signOut: () =>
			run(async () => {
				await client.signOut()
			}),
		destroy() {
			unsubscribeAuth()
			listeners.clear()
		},
	}
}
