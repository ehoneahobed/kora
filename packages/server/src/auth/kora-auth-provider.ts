import type { AuthContext, AuthProvider } from '../types'

/**
 * Validates a Kora auth JWT and returns identity claims.
 * This interface matches the signature of TokenManager.validateToken()
 * from @korajs/auth without requiring a direct import.
 */
interface TokenValidator {
	validateToken(token: string): {
		sub: string
		dev: string
		type: string
	} | null
	validateTokenWithRevocation?(token: string): Promise<{
		sub: string
		dev: string
		type: string
	} | null>
}

/**
 * Looks up a user by ID. Returns null if the user doesn't exist.
 * This interface matches InMemoryUserStore.findById() from @korajs/auth
 * without requiring a direct import.
 */
interface UserLookup {
	findById(userId: string): Promise<{
		id: string
		email: string
		name: string
	} | null>
}

/**
 * Optional device touch callback for updating last-seen timestamps.
 */
interface DeviceToucher {
	touchDevice(deviceId: string): Promise<void>
}

/**
 * Configuration for creating a KoraAuthProvider.
 */
export interface KoraAuthProviderOptions {
	/**
	 * Token validator that verifies JWT signatures and returns claims.
	 * Typically a `TokenManager` instance from `@korajs/auth/server`.
	 * If the validator also implements `validateTokenWithRevocation`, the sync
	 * server uses it so signed-out sessions and revoked devices are rejected.
	 */
	tokenValidator: TokenValidator

	/**
	 * User lookup for verifying the user still exists.
	 * Typically an `InMemoryUserStore` instance from `@korajs/auth/server`.
	 */
	userLookup: UserLookup

	/**
	 * Optional device tracker for updating last-seen timestamps.
	 * Typically the same `InMemoryUserStore` if it implements `touchDevice`.
	 */
	deviceTracker?: DeviceToucher

	/**
	 * Optional scope resolver. Called with the user ID to determine
	 * which collections/records the user can sync.
	 */
	resolveScopes?: (userId: string) => Promise<Record<string, Record<string, unknown>>>
}

/**
 * Auth provider that bridges `@korajs/auth` token management with the
 * sync server's authentication layer.
 *
 * Validates access tokens issued by `@korajs/auth`'s `TokenManager`,
 * verifies the user still exists, and optionally computes per-user
 * sync scopes. This is the recommended way to connect @korajs/auth
 * to @korajs/server.
 *
 * @example
 * ```typescript
 * import { TokenManager, InMemoryUserStore } from '@korajs/auth/server'
 * import { KoraAuthProvider, KoraSyncServer } from '@korajs/server'
 *
 * const tokenManager = new TokenManager({ secret: 'my-secret' })
 * const userStore = new InMemoryUserStore()
 *
 * const auth = new KoraAuthProvider({
 *   tokenValidator: tokenManager,
 *   userLookup: userStore,
 *   deviceTracker: userStore,
 *   resolveScopes: async (userId) => ({
 *     forms: { userId },
 *     responses: { formOwnerId: userId },
 *   }),
 * })
 *
 * const server = new KoraSyncServer({ store, auth })
 * ```
 */
export class KoraAuthProvider implements AuthProvider {
	private readonly tokenValidator: TokenValidator
	private readonly userLookup: UserLookup
	private readonly deviceTracker: DeviceToucher | undefined
	private readonly resolveScopes:
		| ((userId: string) => Promise<Record<string, Record<string, unknown>>>)
		| undefined

	constructor(options: KoraAuthProviderOptions) {
		this.tokenValidator = options.tokenValidator
		this.userLookup = options.userLookup
		this.deviceTracker = options.deviceTracker
		this.resolveScopes = options.resolveScopes
	}

	async authenticate(token: string): Promise<AuthContext | null> {
		// Validate the JWT signature and expiration
		const payload = this.tokenValidator.validateTokenWithRevocation
			? await this.tokenValidator.validateTokenWithRevocation(token)
			: this.tokenValidator.validateToken(token)
		if (payload === null) {
			return null
		}

		// Only accept access tokens for sync authentication
		if (payload.type !== 'access') {
			return null
		}

		// Verify the user still exists (may have been deleted since token was issued)
		const user = await this.userLookup.findById(payload.sub)
		if (user === null) {
			return null
		}

		// Update device last-seen timestamp
		if (this.deviceTracker) {
			await this.deviceTracker.touchDevice(payload.dev)
		}

		// Compute sync scopes if a resolver is configured
		const scopes = this.resolveScopes ? await this.resolveScopes(payload.sub) : undefined

		return {
			userId: payload.sub,
			scopes,
			metadata: {
				deviceId: payload.dev,
				email: user.email,
				name: user.name,
			},
		}
	}
}
