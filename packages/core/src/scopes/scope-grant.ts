import type { ScopeMap } from './build-scope-map'

/**
 * Reserved key in a server scope grant that carries VERIFIED claim values
 * (for example `{ userId: <jwt sub>, orgId: <from your user store> }`).
 *
 * An auth provider usually cannot know the sync schema, so instead of listing
 * every collection it returns `{ $claims: { userId } }` and the sync server binds
 * each schema-scoped collection from those values when the session starts. A
 * collection whose scope bindings cannot all be resolved from the claims is
 * denied (fail closed), never widened to "everything".
 *
 * Collection names must start with a letter, so `$claims` can never collide with
 * a real collection. Any consumer that does not expand it sees a key that matches
 * no collection, which is also fail-closed.
 */
export const SCOPE_CLAIMS_KEY = '$claims' as const

/**
 * Build a server scope grant from verified claim values, optionally combined
 * with explicit per-collection grants. Explicit entries win over claim-derived
 * bindings for the same collection.
 *
 * @param claims - Verified scope values, keyed by the scope binding names your
 *   schema uses (`scope: ['userId']` binds the `userId` value)
 * @param explicit - Optional explicit per-collection predicates
 * @returns A scope grant suitable for `AuthContext.scopes`
 *
 * @example
 * ```typescript
 * return { userId: payload.sub, scopes: claimScopes({ userId: payload.sub, orgId }) }
 * ```
 */
export function claimScopes(claims: Record<string, unknown>, explicit?: ScopeMap): ScopeMap {
	return { ...(explicit ?? {}), [SCOPE_CLAIMS_KEY]: { ...claims } }
}

/**
 * Read the verified claim values carried by a scope grant, if any.
 *
 * @param grant - A scope grant (possibly containing {@link SCOPE_CLAIMS_KEY})
 * @returns The claim values, or null when the grant has none
 */
export function getScopeClaims(grant: ScopeMap | undefined): Record<string, unknown> | null {
	if (!grant) return null
	const claims = grant[SCOPE_CLAIMS_KEY]
	return claims && typeof claims === 'object' ? claims : null
}
