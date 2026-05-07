import {
	ExternalJwtProvider,
	type ExternalJwtProviderConfig,
	type ExternalUserInfo,
} from './external-jwt-provider'

// ============================================================================
// Supabase Adapter Configuration
// ============================================================================

/**
 * Configuration for the Supabase authentication adapter.
 *
 * Supabase Auth signs JWTs with HS256 using the project's JWT secret,
 * which is available in your Supabase project settings under
 * Settings -> API -> JWT Secret.
 *
 * Supabase JWTs typically contain:
 * - `sub`: User UUID
 * - `email`: User's email address
 * - `role`: The database role (e.g., "authenticated", "anon")
 * - `aud`: Audience (usually "authenticated")
 * - `app_metadata`: Provider info, roles, etc.
 * - `user_metadata`: Custom user data (name, avatar, etc.)
 *
 * @example
 * ```typescript
 * import { createSupabaseAdapter } from '@korajs/auth/server'
 *
 * const supabaseAuth = createSupabaseAdapter({
 *   jwtSecret: process.env.SUPABASE_JWT_SECRET,
 * })
 *
 * // Use with Kora sync server
 * const syncServer = new KoraSyncServer({
 *   store,
 *   auth: supabaseAuth.toSyncAuthProvider(),
 * })
 * ```
 */
export interface SupabaseAdapterConfig {
	/**
	 * Supabase JWT secret from your project settings.
	 *
	 * Found in: Supabase Dashboard -> Settings -> API -> JWT Secret
	 *
	 * This is the HS256 HMAC secret used to sign and verify Supabase Auth JWTs.
	 * Keep this secret secure and never expose it in client-side code.
	 */
	jwtSecret: string

	/**
	 * Custom claim mapping override.
	 *
	 * By default, the Supabase adapter maps:
	 * - `sub` -> `userId`
	 * - `email` -> `email`
	 * - `user_metadata.full_name` or `user_metadata.name` -> `name`
	 * - `role`, `aud`, `app_metadata` -> `metadata`
	 *
	 * Override this to customize how Supabase claims are mapped to Kora's format.
	 */
	mapClaims?: ExternalJwtProviderConfig['mapClaims']
}

// ============================================================================
// Default Supabase claim mapping
// ============================================================================

/**
 * Default claim mapping for Supabase Auth JWTs.
 *
 * Extracts user identity from Supabase's standard JWT claims and maps
 * role/audience information into Kora metadata.
 */
function defaultSupabaseClaimMapping(claims: Record<string, unknown>): ExternalUserInfo {
	const sub = claims['sub']
	if (typeof sub !== 'string' || sub.length === 0) {
		return { userId: '' }
	}

	const email = typeof claims['email'] === 'string' ? claims['email'] : undefined

	// Extract name from user_metadata (Supabase stores user profile data here)
	let name: string | undefined
	const userMetadata = claims['user_metadata']
	if (typeof userMetadata === 'object' && userMetadata !== null && !Array.isArray(userMetadata)) {
		const meta = userMetadata as Record<string, unknown>
		if (typeof meta['full_name'] === 'string' && meta['full_name'].length > 0) {
			name = meta['full_name']
		} else if (typeof meta['name'] === 'string' && meta['name'].length > 0) {
			name = meta['name']
		}
	}

	// Collect metadata from Supabase-specific claims
	const metadata: Record<string, unknown> = {}
	if (typeof claims['role'] === 'string') {
		metadata['role'] = claims['role']
	}
	if (typeof claims['aud'] === 'string') {
		metadata['aud'] = claims['aud']
	}
	if (
		typeof claims['app_metadata'] === 'object'
		&& claims['app_metadata'] !== null
		&& !Array.isArray(claims['app_metadata'])
	) {
		metadata['appMetadata'] = claims['app_metadata']
	}

	return {
		userId: sub,
		email,
		name,
		metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
	}
}

// ============================================================================
// Factory function
// ============================================================================

/**
 * Creates an ExternalJwtProvider configured for Supabase Auth.
 *
 * Supabase Auth uses HS256 signing with the project's JWT secret, making it
 * compatible with Kora's built-in `verifyJwt` utility. No external SDK is needed.
 *
 * This adapter validates the JWT signature and expiration, then maps Supabase's
 * standard claims (sub, email, role, user_metadata) to Kora's auth context format.
 *
 * @param config - Supabase adapter configuration
 * @returns An ExternalJwtProvider instance configured for Supabase
 *
 * @example
 * ```typescript
 * import { createSupabaseAdapter } from '@korajs/auth/server'
 *
 * const supabaseAuth = createSupabaseAdapter({
 *   jwtSecret: process.env.SUPABASE_JWT_SECRET,
 * })
 *
 * // Validate a Supabase access token
 * const result = await supabaseAuth.validateAccessToken(supabaseAccessToken)
 * if (result) {
 *   console.log('Supabase user:', result.userId)
 * }
 *
 * // Or use with the sync server
 * const syncServer = new KoraSyncServer({
 *   store,
 *   auth: supabaseAuth.toSyncAuthProvider(),
 * })
 * ```
 */
export function createSupabaseAdapter(config: SupabaseAdapterConfig): ExternalJwtProvider {
	return new ExternalJwtProvider({
		providerName: 'supabase',
		jwtSecret: config.jwtSecret,
		mapClaims: config.mapClaims ?? defaultSupabaseClaimMapping,
	})
}
