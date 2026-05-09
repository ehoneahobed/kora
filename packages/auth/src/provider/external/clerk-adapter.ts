import {
	ExternalJwtProvider,
	type ExternalJwtProviderConfig,
	type ExternalUserInfo,
} from './external-jwt-provider'

// ============================================================================
// Clerk Adapter Configuration
// ============================================================================

/**
 * Configuration for the Clerk authentication adapter.
 *
 * Clerk uses asymmetric signing (RS256) with JWKS key rotation, so this adapter
 * requires a custom `validateToken` function that handles JWKS-based verification.
 * The adapter provides sensible defaults for mapping Clerk's JWT claims to Kora's
 * expected format.
 *
 * Clerk JWTs typically contain:
 * - `sub`: User ID (e.g., "user_2abc123...")
 * - `email`: Primary email address (if configured in session claims)
 * - `first_name`, `last_name`: Name fields (if configured in session claims)
 * - `azp`: Authorized party (your frontend origin)
 * - `org_id`, `org_slug`, `org_role`: Organization claims (if using Clerk orgs)
 *
 * @example
 * ```typescript
 * import { createClerkAdapter } from '@korajs/auth/server'
 *
 * const clerkAuth = createClerkAdapter({
 *   validateToken: async (token) => {
 *     // Use Clerk's backend SDK or your own JWKS verification
 *     const result = await clerkClient.verifyToken(token)
 *     return result ? { sub: result.sub, ...result } : null
 *   },
 * })
 *
 * // Use with Kora sync server
 * const syncServer = new KoraSyncServer({
 *   store,
 *   auth: clerkAuth.toSyncAuthProvider(),
 * })
 * ```
 */
export interface ClerkAdapterConfig {
	/**
	 * Custom token validator for Clerk JWTs.
	 *
	 * Clerk uses RS256 signing with JWKS key rotation, which requires either
	 * Clerk's backend SDK or a JWKS-based verifier. This function receives
	 * the raw JWT and should return the decoded claims or null.
	 *
	 * @param token - The raw JWT string from the Clerk session
	 * @returns Decoded claims with at least a `sub` field, or null if invalid
	 */
	validateToken: (token: string) => Promise<{ sub: string; [key: string]: unknown } | null>

	/**
	 * Custom claim mapping override.
	 *
	 * By default, the Clerk adapter maps:
	 * - `sub` -> `userId`
	 * - `email` -> `email` (if present)
	 * - `first_name` + `last_name` -> `name` (concatenated, if present)
	 * - `org_id`, `org_slug`, `org_role` -> `metadata` (if present)
	 *
	 * Override this to customize how Clerk claims are mapped to Kora's format.
	 */
	mapClaims?: ExternalJwtProviderConfig['mapClaims']
}

// ============================================================================
// Default Clerk claim mapping
// ============================================================================

/**
 * Default claim mapping for Clerk JWTs.
 *
 * Extracts user identity from Clerk's standard session claims and maps
 * organization data into Kora metadata when available.
 */
function defaultClerkClaimMapping(claims: Record<string, unknown>): ExternalUserInfo {
	const sub = claims.sub
	if (typeof sub !== 'string' || sub.length === 0) {
		// Delegate to the base provider's error handling by returning invalid data
		// The ExternalJwtProvider will catch the missing userId
		return { userId: '' }
	}

	// Build display name from first_name and last_name if available
	const firstName = typeof claims.first_name === 'string' ? claims.first_name : ''
	const lastName = typeof claims.last_name === 'string' ? claims.last_name : ''
	const fullName = [firstName, lastName].filter(Boolean).join(' ')

	// Extract email (Clerk may include this in session claims)
	const email = typeof claims.email === 'string' ? claims.email : undefined

	// Extract organization metadata if present
	const metadata: Record<string, unknown> = {}
	if (typeof claims.org_id === 'string') {
		metadata.orgId = claims.org_id
	}
	if (typeof claims.org_slug === 'string') {
		metadata.orgSlug = claims.org_slug
	}
	if (typeof claims.org_role === 'string') {
		metadata.orgRole = claims.org_role
	}

	return {
		userId: sub,
		email,
		name: fullName.length > 0 ? fullName : undefined,
		metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
	}
}

// ============================================================================
// Factory function
// ============================================================================

/**
 * Creates an ExternalJwtProvider configured for Clerk authentication.
 *
 * Clerk uses RS256 signing with JWKS key rotation, so a custom `validateToken`
 * function must be provided. This function should use Clerk's backend SDK or
 * a JWKS-based JWT verifier to validate tokens.
 *
 * This adapter does NOT depend on `@clerk/backend` or any Clerk SDK. It only
 * provides sensible defaults for mapping Clerk's JWT claims to Kora's format.
 * The actual token verification is delegated to the provided `validateToken` function.
 *
 * @param config - Clerk adapter configuration
 * @returns An ExternalJwtProvider instance configured for Clerk
 *
 * @example
 * ```typescript
 * import { createClerkAdapter } from '@korajs/auth/server'
 *
 * const clerkAuth = createClerkAdapter({
 *   validateToken: async (token) => {
 *     // Your JWKS verification logic here
 *     const payload = await verifyWithJwks(token, CLERK_JWKS_URL)
 *     return payload
 *   },
 * })
 *
 * const result = await clerkAuth.validateAccessToken(sessionToken)
 * ```
 */
export function createClerkAdapter(config: ClerkAdapterConfig): ExternalJwtProvider {
	return new ExternalJwtProvider({
		providerName: 'clerk',
		validateToken: config.validateToken,
		mapClaims: config.mapClaims ?? defaultClerkClaimMapping,
	})
}
