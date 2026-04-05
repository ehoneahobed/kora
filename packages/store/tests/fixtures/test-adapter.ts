import type { SchemaDefinition } from '@korajs/core'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { minimalSchema } from './test-schema'

/**
 * Create an in-memory BetterSqlite3Adapter pre-opened with a test schema.
 *
 * @param schema - The schema to use (defaults to minimalSchema)
 * @returns An opened adapter ready for testing
 */
export async function createTestAdapter(
	schema: SchemaDefinition = minimalSchema,
): Promise<BetterSqlite3Adapter> {
	const adapter = new BetterSqlite3Adapter(':memory:')
	await adapter.open(schema)
	return adapter
}
