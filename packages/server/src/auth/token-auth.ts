import type { AuthContext, AuthProvider } from '../types'

/**
 * Options for creating a TokenAuthProvider.
 */
export interface TokenAuthProviderOptions {
	/**
	 * Validate a token and return an AuthContext if valid, or null if rejected.
	 * This is where you implement your auth logic (JWT verification, database lookup, etc.).
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
		return this.validate(token)
	}
}
