import type { AuthContext, AuthProvider } from '../types'

/**
 * Configuration for creating a MixedAuthProvider.
 */
export interface MixedAuthProviderOptions {
	/**
	 * Primary auth provider that validates tokens from authenticated users.
	 * Typically a `KoraAuthProvider`, `TokenAuthProvider`, or the result of
	 * `authRoutes.toSyncAuthProvider()`.
	 */
	primary: AuthProvider

	/**
	 * Scopes to apply to anonymous connections.
	 * Each key is a collection name; the value is a filter object
	 * (use `{}` for unrestricted access to that collection).
	 *
	 * @example
	 * ```typescript
	 * // Anonymous users can only sync the 'responses' collection
	 * anonymousScopes: { responses: {} }
	 *
	 * // Anonymous users can read published forms
	 * anonymousScopes: { forms: { status: 'published' } }
	 * ```
	 */
	anonymousScopes: Record<string, Record<string, unknown>>

	/**
	 * Prefix for generated anonymous user IDs.
	 * A unique suffix is appended to each connection.
	 * @default 'anon'
	 */
	anonymousPrefix?: string
}

/**
 * Auth provider that supports both authenticated and anonymous connections.
 *
 * When a client connects with a valid token, the primary auth provider
 * handles authentication normally. When a client connects without a token
 * (or with an invalid one), the connection is accepted as anonymous with
 * restricted sync scopes.
 *
 * This is the recommended pattern for apps that need public data access
 * alongside authenticated users — for example, a form builder where
 * authenticated users create forms but anyone can submit responses.
 *
 * @example
 * ```typescript
 * import { MixedAuthProvider, KoraAuthProvider } from '@korajs/server'
 *
 * const auth = new MixedAuthProvider({
 *   primary: authRoutes.toSyncAuthProvider(),
 *   anonymousScopes: {
 *     // Anonymous users can only sync the 'responses' collection
 *     responses: {},
 *   },
 * })
 *
 * const server = new KoraSyncServer({ store, auth })
 * ```
 *
 * @example
 * ```typescript
 * // On the client, return an empty token for unauthenticated users:
 * const app = createApp({
 *   schema,
 *   sync: {
 *     url: 'wss://my-server.com/kora',
 *     auth: async () => ({
 *       token: (await authClient.getAccessToken()) ?? '',
 *     }),
 *   },
 * })
 * ```
 */
export class MixedAuthProvider implements AuthProvider {
	private readonly primary: AuthProvider
	private readonly anonymousScopes: Record<string, Record<string, unknown>>
	private readonly anonymousPrefix: string
	private anonymousCounter = 0

	constructor(options: MixedAuthProviderOptions) {
		this.primary = options.primary
		this.anonymousScopes = options.anonymousScopes
		this.anonymousPrefix = options.anonymousPrefix ?? 'anon'
	}

	async authenticate(token: string): Promise<AuthContext> {
		// Try authenticated path first when a token is provided
		if (token) {
			const ctx = await this.primary.authenticate(token)
			if (ctx) return ctx
		}

		// Fall back to scoped anonymous access
		this.anonymousCounter++
		return {
			userId: `${this.anonymousPrefix}-${Date.now()}-${this.anonymousCounter}`,
			scopes: this.anonymousScopes,
		}
	}
}
