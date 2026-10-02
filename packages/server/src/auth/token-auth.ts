import { claimScopes } from '@korajs/core'
import type { AuthContext, AuthProvider } from '../types'

/**
 * Options for creating a TokenAuthProvider.
 */
export interface TokenAuthProviderOptions {
	/**
	 * Validate a token and return an AuthContext if valid, or null if rejected.
	 * This is where you implement your auth logic (JWT verification, database lookup, etc.).
	 *
	 * Return `scopes` to grant sync access explicitly. When the returned context
	 * has no scopes, schema-scoped collections are bound to `{ userId }` and any
	 * collection scoped by another key is denied.
	 */
	validate: (token: string) => Promise<AuthContext | null>
}

/**
 * Token-based auth provider that delegates validation to a user-provided function.
 *
 * @example
 * ```typescript
 * const auth = new TokenAuthProvider({
 *   validate: async (token) => {
 *     const user = await verifyJWT(token)
 *     return user ? { userId: user.id } : null
 *   }
 * })
 * ```
 */
export class TokenAuthProvider implements AuthProvider {
	private readonly validate: (token: string) => Promise<AuthContext | null>

	constructor(options: TokenAuthProviderOptions) {
		this.validate = options.validate
	}

	async authenticate(token: string): Promise<AuthContext | null> {
		const context = await this.validate(token)
		if (!context) return null
		if (
			context.scopes === undefined &&
			context.downlinkScopes === undefined &&
			context.uplinkScopes === undefined
		) {
			// No explicit grant: bind scoped collections to the verified user id
			// rather than letting the client handshake choose (AUTH-1, fail closed).
			return { ...context, scopes: claimScopes({ userId: context.userId }) }
		}
		return context
	}
}
