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
	 * Scopes to apply to anonymous connections. This is the complete anonymous
	 * grant: anonymous sessions can sync exactly these collections, and the
	 * client handshake can only narrow them, never add one.
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
 * When a client connects with a token, the primary auth provider decides:
 * a valid token authenticates normally and an invalid, expired or revoked one
 * is rejected (the client refreshes and reconnects). Only a client that sends
 * no token at all is accepted as anonymous, with exactly `anonymousScopes`.
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

	async authenticate(token: string): Promise<AuthContext | null> {
		// A presented credential is either valid or rejected. It is never silently
		// downgraded to anonymous: an expired or revoked token from a signed-in
		// user must make the client refresh, not sync that user's local writes
		// against the anonymous grant.
		if (token) {
			return this.primary.authenticate(token)
		}

		// Fall back to scoped anonymous access
		this.anonymousCounter++
		return {
			userId: `${this.anonymousPrefix}-${Date.now()}-${this.anonymousCounter}`,
			// A fresh copy per session: the grant must not be shared mutable state.
			scopes: Object.fromEntries(
				Object.entries(this.anonymousScopes).map(([collection, predicate]) => [
					collection,
					{ ...predicate },
				]),
			),
		}
	}
}
