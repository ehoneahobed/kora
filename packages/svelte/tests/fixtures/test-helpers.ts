import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'

export const defaultSchema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				completed: t.boolean().default(false),
			},
		},
	},
})

export async function createTestStore(schema: SchemaDefinition = defaultSchema): Promise<Store> {
	const adapter = new BetterSqlite3Adapter(':memory:')
	const store = new Store({ schema, adapter })
	await store.open()
	return store
}

export function tick(ms = 15): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
