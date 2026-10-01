import { type ScopeMap, claimScopes } from '@korajs/core'

type MaybePromise<T> = T | Promise<T>

/**
 * Verified identity of a sync session, derived on the server from a validated
 * access token. Never contains client-supplied values.
 */
export interface VerifiedSyncClaims {
	/** Verified user id (`sub`). */
	userId: string
	/** Verified device id (`dev`). */
	deviceId: string
	/** The user's email from the user store. */
	email: string
	/** The user's display name from the user store. */
	name: string
}

/**
 * Server-side scope derivation for the sync auth provider (AUTH-1).
 *
 * The result is the session's complete grant: the client handshake can only
 * narrow it, and a schema-scoped collection whose binding is unresolved is
 * denied (`SCOPE_REQUIRED`), never widened.
 */
export interface SyncScopeOptions {
	/**
	 * Extra verified scope values merged over the default `{ userId }`, for
	 * example `{ orgId: await orgOf(userId) }`. Every schema-scoped collection is
	 * bound from these values. Return `undefined`/`null` for a key to deny the
	 * collections that need it.
	 */
	scopeValues?: (claims: VerifiedSyncClaims) => MaybePromise<Record<string, unknown>>
	/**
	 * Full explicit grant. When provided it replaces the default derivation:
	 * collections it omits are not visible. Use `claimScopes(values, explicit)`
	 * from `@korajs/core` to combine claim binding with explicit predicates.
	 */
	resolveScopes?: (claims: VerifiedSyncClaims) => MaybePromise<ScopeMap>
}

/** Auth context returned to `@korajs/server` by the sync auth provider. */
export interface SyncAuthContext {
	userId: string
	scopes?: Record<string, Record<string, unknown>>
	metadata?: Record<string, unknown>
	/** Access-token expiry (ms since epoch); a session must not outlive it (AUTH-11). */
	expiresAt?: number
}

/** Structural `AuthProvider` returned by `toSyncAuthProvider()`. */
export interface SyncAuthProvider {
	authenticate(token: string): Promise<SyncAuthContext | null>
}

/**
 * Compute the server grant for a verified session.
 *
 * @param claims - Verified identity
 * @param options - Scope derivation options
 * @returns The scope grant (possibly carrying `$claims` for schema binding)
 */
export async function resolveSyncGrant(
	claims: VerifiedSyncClaims,
	options: SyncScopeOptions,
): Promise<ScopeMap> {
	if (options.resolveScopes) {
		return options.resolveScopes(claims)
	}
	const extra = options.scopeValues ? await options.scopeValues(claims) : {}
	// The verified subject always wins over anything a resolver returns for
	// `userId`, so a buggy resolver cannot rebind a session to another user.
	return claimScopes({ ...extra, userId: claims.userId })
}
