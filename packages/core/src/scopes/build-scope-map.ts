import type { SchemaDefinition } from '../types'
import {
	collectSchemaScopeValueKeys,
	getCollectionScopeBindings,
	hasSchemaSyncRules,
	isCollectionSyncScoped,
} from './sync-scope-bindings'

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
 * Supports both legacy `collection.scope` arrays and declarative `schema.sync`
 * rules (`sync: { todos: { where: { userId: true } } }`).
 *
 * When `schema.sync` is present, only collections with sync rules or legacy
 * scope fields are included in the result. Other collections are omitted so
 * sync engines treat them as out of scope (partial sync).
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
	const partialSync = hasSchemaSyncRules(schema)

	for (const collName of Object.keys(schema.collections)) {
		if (partialSync && !isCollectionSyncScoped(schema, collName)) {
			continue
		}

		const bindings = getCollectionScopeBindings(schema, collName)
		if (bindings) {
			const collScope: Record<string, unknown> = {}
			for (const [field, scopeKey] of Object.entries(bindings)) {
				if (scopeKey in scopeValues) {
					collScope[field] = scopeValues[scopeKey]
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

export { collectSchemaScopeValueKeys as collectSchemaScopeFields } from './sync-scope-bindings'
