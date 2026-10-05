import type { SchemaDefinition } from '@korajs/core'
import {
	type SqliteQueryFn,
	readSqliteTableCatalog,
	sqliteConstraintRelaxationStatements,
} from '@korajs/core/internal'
import type { StorageAdapter } from '../types'

/**
 * One-time migration (RT-101): rebuild collection tables that still carry value-domain
 * constraints (an enum `CHECK`, `NOT NULL` on a schema field) created by beta.12 and
 * earlier DDL. Validation is the single authority for the value domain; a table
 * constraint cannot evolve with the schema, so it refused enum values added later and
 * nulls of fields made optional.
 *
 * Every table is rebuilt in ONE transaction (all or nothing), preserving rows, columns,
 * defaults, keys, indexes and triggers. Foreign key enforcement is switched off around
 * it when the database enforces foreign keys, as SQLite's table-rebuild procedure
 * requires. Idempotent: a relaxed table is left alone, so later opens do nothing;
 * resumable: an interrupted rebuild rolls back and runs again at the next open.
 *
 * Works for every client adapter (better-sqlite3, SQLite WASM/OPFS, and the IndexedDB
 * adapter, which runs SQLite in memory): they all store in SQLite.
 *
 * @param adapter - The opened adapter (schema DDL already applied)
 * @param schema - The schema whose collection tables are checked
 * @returns The collections whose tables were rebuilt
 */
export async function relaxValueDomainConstraints(
	adapter: StorageAdapter,
	schema: SchemaDefinition,
): Promise<string[]> {
	const collections = Object.keys(schema.collections)
	// Only enum checks on the schema's enum fields are Kora's; any other CHECK was added
	// by hand and is kept through the rebuild, and never triggers one (RT-111).
	const enumColumns = (collection: string): string[] =>
		Object.entries(schema.collections[collection]?.fields ?? {})
			.filter(([, descriptor]) => descriptor.kind === 'enum')
			.map(([field]) => field)
	const viaAdapter: SqliteQueryFn = (sql) => adapter.query<Record<string, unknown>>(sql)
	const pending: string[] = []
	for (const collection of collections) {
		const catalog = await readSqliteTableCatalog(viaAdapter, collection)
		if (
			catalog &&
			sqliteConstraintRelaxationStatements(catalog, enumColumns(collection)).length > 0
		) {
			pending.push(collection)
		}
	}
	if (pending.length === 0) return []

	const enforced = await adapter.query<{ foreign_keys: number }>('PRAGMA foreign_keys')
	const foreignKeysOn = Number(enforced[0]?.foreign_keys) === 1
	if (foreignKeysOn) await adapter.execute('PRAGMA foreign_keys = OFF')
	const rebuilt: string[] = []
	try {
		await adapter.transaction(async (tx) => {
			const viaTx: SqliteQueryFn = (sql) => tx.query<Record<string, unknown>>(sql)
			// Re-read inside the transaction: another tab may have relaxed a table already.
			for (const collection of pending) {
				const catalog = await readSqliteTableCatalog(viaTx, collection)
				if (!catalog) continue
				const statements = sqliteConstraintRelaxationStatements(catalog, enumColumns(collection))
				if (statements.length === 0) continue
				for (const sql of statements) await tx.execute(sql)
				rebuilt.push(collection)
			}
		})
	} finally {
		if (foreignKeysOn) await adapter.execute('PRAGMA foreign_keys = ON')
	}
	return rebuilt
}
