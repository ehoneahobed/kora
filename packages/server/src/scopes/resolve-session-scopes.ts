import type { ScopeMap } from '@korajs/core'
import {
	KoraError,
	SCOPE_CLAIMS_KEY,
	type SchemaDefinition,
	getCollectionScopeBindings,
	getScopeClaims,
	hasSchemaSyncRules,
	isCollectionSyncScoped,
} from '@korajs/core'
import { assertScopeValuesDefined } from './scope-predicate-errors'

export interface ResolveSessionScopesOptions {
	/** Scope map sent by the client during handshake. It can only NARROW the grant. */
	handshakeScope?: ScopeMap
	/**
	 * The server grant from the auth provider. Its collection set is authoritative:
	 * a collection it does not list is not visible, whatever the handshake asks for.
	 * It may carry verified claim values under `$claims` (see `claimScopes` in
	 * `@korajs/core`), which are bound to every schema-scoped collection.
	 */
	authScopes?: ScopeMap
	/**
	 * Verified, server-derived scope values (for example `{ userId: sub }`). Treated
	 * exactly like `$claims` in `authScopes`. Never pass client-supplied values here.
	 */
	scopeValues?: Record<string, unknown>
	/**
	 * True when an auth provider authenticated this session. An authenticated
	 * session whose provider returned no grant at all is denied every
	 * schema-scoped collection instead of trusting the client handshake.
	 *
	 * Leave it false only for servers without an auth provider (or with
	 * `NoAuthProvider`), where the handshake is a client-side filter, not a grant.
	 * @default false
	 */
	authenticated?: boolean
	/**
	 * What to do when a schema-scoped collection's bindings cannot all be resolved
	 * from the verified claims. `'deny'` hides the collection (fail closed);
	 * `'throw'` raises {@link ScopeRequiredError} so the caller can reject the
	 * handshake with `SCOPE_REQUIRED`.
	 * @default 'deny'
	 */
	onUnresolved?: 'deny' | 'throw'
}

/** A schema-scoped collection the session was denied because a binding was unresolved. */
export interface DeniedScopeCollection {
	collection: string
	/** Scope binding keys (for example `orgId`) that had no verified value. */
	missingKeys: string[]
}

/** Detailed result of {@link resolveSessionScopeGrant}. */
export interface ResolvedSessionScopeGrant {
	/**
	 * Effective scope map. `undefined` means "no scoping" and is only ever returned
	 * for unauthenticated servers without a grant. An empty object means "nothing
	 * visible".
	 */
	scopes: ScopeMap | undefined
	/** Collections denied because their scope bindings could not be resolved. */
	denied: DeniedScopeCollection[]
}

/**
 * Thrown (with `onUnresolved: 'throw'`) when an authenticated session cannot be
 * bound to a schema-scoped collection because the server grant lacks a value.
 */
export class ScopeRequiredError extends KoraError {
	constructor(public readonly denied: DeniedScopeCollection[]) {
		super(
			`Sync scope required: ${denied
				.map((d) => `"${d.collection}" needs ${d.missingKeys.map((k) => `"${k}"`).join(', ')}`)
				.join('; ')}. The server could not derive these values from the verified token.`,
			'SCOPE_REQUIRED',
			{
				denied,
				fix: 'Return the missing scope values from your auth provider, for example createKoraAuthServer({ scopeValues: async (claims) => ({ orgId: await lookupOrg(claims.sub) }) }) or a resolveScopes grant.',
			},
		)
		this.name = 'ScopeRequiredError'
	}
}

const warnedDenials = new Set<string>()

/**
 * Resolve the effective per-session sync scope map.
 *
 * The result is the INTERSECTION of the server grant and the client handshake:
 * - The collection set is the grant's collection set. A handshake can never add
 *   a collection.
 * - Per collection, handshake predicates only narrow: grant fields win, a
 *   handshake field on an unconstrained field is added, and for an `$in` grant a
 *   handshake value is used only when it is a subset of the granted values.
 * - Schema-scoped collections bound from verified claims fail closed: an
 *   unresolved binding denies the collection instead of producing `{}`.
 *
 * Invariant: the effective scope is a subset of the server grant, and no
 * schema-scoped collection resolves to `{}` from claims for an authenticated
 * principal.
 *
 * @returns The effective scope map; `undefined` only for unauthenticated servers
 *   with neither a grant nor a handshake scope
 */
export function resolveSessionScopes(
	schema: SchemaDefinition | null,
	options: ResolveSessionScopesOptions,
): ScopeMap | undefined {
	return resolveSessionScopeGrant(schema, options).scopes
}

/**
 * Same as {@link resolveSessionScopes}, but also reports which collections were
 * denied for unresolved bindings, so a caller can surface `SCOPE_REQUIRED`.
 */
export function resolveSessionScopeGrant(
	schema: SchemaDefinition | null,
	options: ResolveSessionScopesOptions,
): ResolvedSessionScopeGrant {
	const { handshakeScope, authScopes, scopeValues } = options
	const denied: DeniedScopeCollection[] = []

	let grant: ScopeMap | undefined
	if (authScopes !== undefined || scopeValues !== undefined) {
		const claims = mergeClaims(getScopeClaims(authScopes), scopeValues)
		const explicit = withoutReservedKeys(authScopes ?? {})
		// A grant value of undefined/null (a failed lookup) would match every record
		// lacking the field: refuse it rather than widen the grant (RT-8).
		assertScopeValuesDefined(explicit)
		if (!schema && claims && Object.keys(explicit).length === 0) {
			// RT-89: verified claims alone (TokenAuthProvider without explicit scopes) bind to
			// schema-scoped collections, and a schemaless server has none it knows of. Such a
			// grant names no collection, so it is no grant at all: "unscoped", exactly like an
			// absent grant on a schemaless server. Treating it as an EMPTY grant hid every
			// collection from the session and refused every upload.
			grant = undefined
			warnSchemalessClaims()
		} else {
			grant = { ...explicit }
			if (claims && schema) {
				const derived = bindClaimsToSchema(schema, claims, denied)
				for (const [collection, predicate] of Object.entries(derived)) {
					if (!(collection in grant)) grant[collection] = predicate
				}
			}
		}
	} else if (options.authenticated) {
		// An authenticated principal with no grant is not trusted to choose its own
		// scope: unscoped collections stay visible, scoped ones are denied.
		grant = schema ? bindClaimsToSchema(schema, {}, denied) : {}
	}

	// Explicitly granted collections cover a denial for the same collection.
	const effectiveDenied = grant ? denied.filter((entry) => !(entry.collection in grant)) : denied

	if (effectiveDenied.length > 0) {
		if (options.onUnresolved === 'throw') {
			throw new ScopeRequiredError(effectiveDenied)
		}
		warnDenied(effectiveDenied)
	}

	if (grant === undefined) {
		const scopes = handshakeScope ? withoutReservedKeys(handshakeScope) : undefined
		assertScopeValuesDefined(scopes)
		return { scopes, denied: effectiveDenied }
	}

	const scopes = intersectScopes(grant, handshakeScope)
	assertScopeValuesDefined(scopes)
	return { scopes, denied: effectiveDenied }
}

/**
 * Bind verified claim values to every schema collection. Mirrors `buildScopeMap`'s
 * collection selection, but never emits `{}` for a scoped collection whose
 * bindings are unresolved: those are recorded in `denied` and left out.
 */
function bindClaimsToSchema(
	schema: SchemaDefinition,
	claims: Record<string, unknown>,
	denied: DeniedScopeCollection[],
): ScopeMap {
	const result: ScopeMap = {}
	const partialSync = hasSchemaSyncRules(schema)
	for (const collection of Object.keys(schema.collections)) {
		if (partialSync && !isCollectionSyncScoped(schema, collection)) continue
		const bindings = getCollectionScopeBindings(schema, collection)
		if (!bindings) {
			result[collection] = {}
			continue
		}
		const predicate: Record<string, unknown> = {}
		const missingKeys: string[] = []
		for (const [field, key] of Object.entries(bindings)) {
			const value = claims[key]
			if (value === undefined || value === null) {
				missingKeys.push(key)
				continue
			}
			predicate[field] = Array.isArray(value) ? { $in: [...value] } : value
		}
		if (missingKeys.length > 0) {
			denied.push({ collection, missingKeys })
			continue
		}
		result[collection] = predicate
	}
	return result
}

function intersectScopes(grant: ScopeMap, handshake: ScopeMap | undefined): ScopeMap {
	const result: ScopeMap = {}
	for (const [collection, granted] of Object.entries(grant)) {
		const requested = handshake?.[collection] ?? {}
		const predicate: Record<string, unknown> = { ...granted }
		for (const [field, wanted] of Object.entries(requested)) {
			if (!(field in granted)) {
				predicate[field] = wanted
				continue
			}
			const allowed = granted[field]
			if (isInPredicate(allowed) && isSubsetOf(wanted, allowed.$in)) {
				predicate[field] = wanted
			}
			// Otherwise the grant wins: a handshake can never widen a granted field.
		}
		result[collection] = predicate
	}
	return result
}

function isInPredicate(value: unknown): value is { $in: unknown[] } {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Array.isArray((value as { $in?: unknown }).$in)
	)
}

function isSubsetOf(wanted: unknown, allowed: unknown[]): boolean {
	const values = isInPredicate(wanted) ? wanted.$in : [wanted]
	return values.every((value) => allowed.some((candidate) => Object.is(candidate, value)))
}

function mergeClaims(
	fromGrant: Record<string, unknown> | null,
	scopeValues: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
	if (!fromGrant && !scopeValues) return null
	return { ...(scopeValues ?? {}), ...(fromGrant ?? {}) }
}

function withoutReservedKeys(scopes: ScopeMap): ScopeMap {
	const result: ScopeMap = {}
	for (const [collection, predicate] of Object.entries(scopes)) {
		if (collection === SCOPE_CLAIMS_KEY) continue
		result[collection] = { ...(predicate ?? {}) }
	}
	return result
}

let warnedSchemalessClaims = false

function warnSchemalessClaims(): void {
	if (warnedSchemalessClaims) return
	warnedSchemalessClaims = true
	console.warn(
		'[kora] The auth provider returned verified claims but no sync scopes, and this sync ' +
			'server has no schema, so the claims cannot be bound to any collection: sessions sync ' +
			'unscoped (each client chooses its own scope). Give the server store your schema ' +
			'(await store.setSchema(schema)) to bind them, ' +
			'or return explicit `scopes` from the auth provider.',
	)
}

function warnDenied(denied: DeniedScopeCollection[]): void {
	for (const entry of denied) {
		const key = `${entry.collection}:${entry.missingKeys.join(',')}`
		if (warnedDenials.has(key)) continue
		warnedDenials.add(key)
		const keys = entry.missingKeys.map((k) => `"${k}"`).join(', ')
		console.warn(
			`[kora] SCOPE_REQUIRED: sync access to "${entry.collection}" is denied because the server grant has no verified value for ${keys}. Supply it from your auth provider (createKoraAuthServer({ scopeValues }) or resolveScopes). Kora never lets the client choose these values.`,
		)
	}
}
