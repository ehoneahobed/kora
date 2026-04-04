import type { AuthContext, AuthProvider } from '../types'

/**
 * Auth provider that accepts all connections.
 * Returns a default anonymous context for any token.
 * Useful for development and testing.
 */
export class NoAuthProvider implements AuthProvider {
	async authenticate(_token: string): Promise<AuthContext> {
		return { userId: 'anonymous' }
	}
}
