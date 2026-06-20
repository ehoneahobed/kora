import type { SchemaDefinition } from '../types'
import { collectSchemaScopeValueKeys } from './sync-scope-bindings'

/**
 * Collect every unique scope field name declared across all collections.
 *
 * @deprecated Use {@link collectSchemaScopeValueKeys} instead.
 */
export function collectSchemaScopeFields(schema: SchemaDefinition): string[] {
	return collectSchemaScopeValueKeys(schema)
}

/**
 * Extract flat scope values from JWT (or auth) claims using schema scope field names.
 *
 * Resolution order for each scope field:
 * 1. Top-level claim with the same name
 * 2. Nested `claims.scope[field]` object
 * 3. `userId` falls back to the standard JWT `sub` claim
 *
 * @param schema - Schema with per-collection scope declarations
 * @param claims - Decoded JWT claims (unverified; client-side scope hints only)
 * @returns Flat key-value map suitable for {@link buildScopeMap}
 */
export function extractScopeValuesFromClaims(
	schema: SchemaDefinition,
	claims: Record<string, unknown>,
): Record<string, unknown> {
	const scopeFields = collectSchemaScopeValueKeys(schema)
	if (scopeFields.length === 0) {
		return {}
	}

	const nestedScope = claims.scope
	const scopeObject =
		typeof nestedScope === 'object' && nestedScope !== null && !Array.isArray(nestedScope)
			? (nestedScope as Record<string, unknown>)
			: {}

	const result: Record<string, unknown> = {}

	for (const field of scopeFields) {
		if (field in claims) {
			result[field] = claims[field]
			continue
		}

		if (field in scopeObject) {
			result[field] = scopeObject[field]
			continue
		}

		if (field === 'userId' && typeof claims.sub === 'string') {
			result.userId = claims.sub
		}
	}

	return result
}
