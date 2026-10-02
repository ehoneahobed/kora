import { quoteIdent } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { collectionIndexName, legacyCollectionIndexName } from '@korajs/core/internal'
import type { StorageAdapter } from '../types'

/**
 * Retire indexes created under the pre-beta.13 naming scheme (STORE-15).
 *
 * `idx_<collection>_<field>` collided across collections (`a_b`.`c` and
 * `a`.`b_c`), so one of the two indexes was silently never created. The schema
 * DDL now creates collision-free names ({@link collectionIndexName}); this pass
 * drops each legacy index that sits on the table and column it was named for,
 * once its replacement exists. A legacy name that belongs to another table is
 * left to that table's own pass, so nothing a collection still needs is dropped.
 *
 * SQLite cannot rename an index; drop-and-recreate is the rename.
 *
 * @param adapter - The opened adapter (schema DDL already applied)
 * @param schema - The schema whose collections are checked
 */
export async function dropLegacyIndexes(
	adapter: StorageAdapter,
	schema: SchemaDefinition,
): Promise<void> {
	const indexed = new Map<string, Set<string>>()
	for (const [name, definition] of Object.entries(schema.collections)) {
		indexed.set(name, new Set(definition.indexes))
	}
	for (const relation of Object.values(schema.relations)) {
		indexed.get(relation.from)?.add(relation.field)
	}

	const existing = await adapter.query<{ name: string; tbl_name: string }>(
		"SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'",
	)
	const byName = new Map(existing.map((row) => [row.name, row.tbl_name]))

	for (const [collection, fields] of indexed) {
		for (const field of fields) {
			const legacy = legacyCollectionIndexName(collection, field)
			const current = collectionIndexName(collection, field)
			if (legacy === current) continue
			if (byName.get(legacy) !== collection) continue
			if (byName.get(current) !== collection) continue
			const columns = await adapter.query<{ name: string }>(
				`SELECT name FROM pragma_index_info(${sqlString(legacy)})`,
			)
			if (columns.length !== 1 || columns[0]?.name !== field) continue
			await adapter.execute(`DROP INDEX IF EXISTS ${quoteIdent(legacy)}`)
		}
	}
}

function sqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`
}
