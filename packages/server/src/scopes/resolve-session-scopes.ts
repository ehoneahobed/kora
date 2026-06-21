import type { ScopeMap } from '@korajs/core'
import { type SchemaDefinition, buildScopeMap } from '@korajs/core'

export interface ResolveSessionScopesOptions {
	/** Scope map sent by the client during handshake */
	handshakeScope?: ScopeMap
	/** Scope map from the auth provider (server-controlled) */
	authScopes?: ScopeMap
	/** Flat scope values used to derive schema sync rules */
	scopeValues?: Record<string, unknown>
}

/**
 * Resolve the effective per-session sync scope map.
 *
 * Combines schema sync rules, auth scopes, and client handshake scopes into
 * a single unified model. Auth scopes take precedence over handshake scopes
 * per collection; schema sync rules define which collections participate in
 * partial sync.
 */
export function resolveSessionScopes(
	schema: SchemaDefinition | null,
	options: ResolveSessionScopesOptions,
): ScopeMap | undefined {
	const { handshakeScope, authScopes, scopeValues } = options

	let resolved: ScopeMap | undefined

	if (schema && scopeValues && Object.keys(scopeValues).length > 0) {
		resolved = buildScopeMap(schema, scopeValues)
	} else if (handshakeScope) {
		resolved = { ...handshakeScope }
	} else if (authScopes) {
		resolved = { ...authScopes }
	}

	if (schema && !resolved && scopeValues) {
		resolved = buildScopeMap(schema, scopeValues)
	}

	if (authScopes) {
		resolved = mergeScopeMaps(resolved, authScopes, 'auth')
	}

	if (handshakeScope) {
		resolved = mergeScopeMaps(resolved, handshakeScope, 'handshake')
	}

	return resolved && Object.keys(resolved).length > 0 ? resolved : undefined
}

function mergeScopeMaps(
	base: ScopeMap | undefined,
	overlay: ScopeMap,
	source: 'auth' | 'handshake',
): ScopeMap {
	const merged: ScopeMap = { ...(base ?? {}) }

	for (const [collection, overlayScope] of Object.entries(overlay)) {
		if (source === 'auth') {
			merged[collection] = { ...(merged[collection] ?? {}), ...overlayScope }
		} else {
			merged[collection] = { ...(overlayScope ?? {}), ...(merged[collection] ?? {}) }
		}
	}

	return merged
}
