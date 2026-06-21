import type { SchemaDefinition, SyncRuleDefinition } from '../types'

/**
 * Returns true when the schema declares partial sync rules at the root level.
 */
export function hasSchemaSyncRules(schema: SchemaDefinition): boolean {
	return schema.sync !== undefined && Object.keys(schema.sync).length > 0
}

/**
 * Resolve field → scope-value-key bindings for a collection.
 *
 * Sync rules take precedence over legacy `collection.scope` arrays.
 * Returns `null` when the collection has no sync filtering configured.
 */
export function getCollectionScopeBindings(
	schema: SchemaDefinition,
	collectionName: string,
): Record<string, string> | null {
	const syncRule = schema.sync?.[collectionName]
	if (syncRule && Object.keys(syncRule.where).length > 0) {
		return { ...syncRule.where }
	}

	const scopeFields = schema.collections[collectionName]?.scope ?? []
	if (scopeFields.length === 0) {
		return null
	}

	const bindings: Record<string, string> = {}
	for (const field of scopeFields) {
		bindings[field] = field
	}
	return bindings
}

/**
 * Returns whether a collection participates in sync filtering for this schema.
 */
export function isCollectionSyncScoped(schema: SchemaDefinition, collectionName: string): boolean {
	if (hasSchemaSyncRules(schema)) {
		if (schema.sync?.[collectionName]) {
			return true
		}
		const legacyScope = schema.collections[collectionName]?.scope ?? []
		return legacyScope.length > 0
	}

	return getCollectionScopeBindings(schema, collectionName) !== null
}

/**
 * Collect unique scope value keys referenced by sync rules and legacy scope fields.
 */
export function collectSchemaScopeValueKeys(schema: SchemaDefinition): string[] {
	const keys = new Set<string>()

	for (const collection of Object.values(schema.collections)) {
		for (const field of collection.scope) {
			keys.add(field)
		}
	}

	if (schema.sync) {
		for (const rule of Object.values(schema.sync)) {
			for (const scopeKey of Object.values(rule.where)) {
				keys.add(scopeKey)
			}
		}
	}

	return [...keys]
}

/**
 * Normalize developer sync rule input into internal bindings.
 */
export function normalizeSyncRuleWhere(
	collectionName: string,
	where: Record<string, boolean | string>,
): SyncRuleDefinition['where'] {
	const normalized: Record<string, string> = {}

	for (const [field, scopeKey] of Object.entries(where)) {
		if (scopeKey === true) {
			normalized[field] = field
			continue
		}

		if (typeof scopeKey === 'string' && scopeKey.length > 0) {
			normalized[field] = scopeKey
			continue
		}

		throw new Error(
			`Invalid sync rule for collection "${collectionName}": where.${field} must be true or a non-empty scope key string`,
		)
	}

	return normalized
}
