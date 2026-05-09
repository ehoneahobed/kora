import type { SchemaDefinition } from '../types'

/**
 * Per-collection scope map: `{ collectionName: { field: value, ... } }`
 *
 * Used to filter which operations a client should receive during sync.
 */
export type ScopeMap = Record<string, Record<string, unknown>>

/**
 * Build a per-collection scope map from the schema's scope declarations
 * and the client's flat scope values.
 *
 * For each collection:
 * - If it declares scope fields, build a filter from the matching flat values.
 * - If it declares no scope fields, include it with an empty filter (no restriction).
 *
 * @param schema - The schema definition with scope declarations
 * @param scopeValues - Flat key-value scope values from the client
 * @returns A per-collection scope map
 *
 * @example
 * ```typescript
 * // Schema declares: sales.scope = ['orgId', 'storeId']
 * // Client provides: { orgId: 'org-123', storeId: 'store-456' }
 * // Result: { sales: { orgId: 'org-123', storeId: 'store-456' }, products: {} }
 * ```
 */
export function buildScopeMap(
	schema: SchemaDefinition,
	scopeValues: Record<string, unknown>,
): ScopeMap {
	const result: ScopeMap = {}

	for (const [collName, collDef] of Object.entries(schema.collections)) {
		if (collDef.scope.length > 0) {
			const collScope: Record<string, unknown> = {}
			for (const field of collDef.scope) {
				if (field in scopeValues) {
					collScope[field] = scopeValues[field]
				}
			}
			result[collName] = collScope
		} else {
			// Collections without scope declarations are fully visible
			result[collName] = {}
		}
	}

	return result
}
