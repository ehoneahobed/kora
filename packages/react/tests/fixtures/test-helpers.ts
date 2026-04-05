import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import type { SyncEngine } from '@korajs/sync'
import { render } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { KoraProvider } from '../../src/context/kora-context'

/**
 * Default test schema: a simple todos collection.
 */
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

/**
 * Create a Store instance backed by an in-memory SQLite database.
 * Opens the store automatically.
 *
 * @param schema - Schema to use (defaults to defaultSchema)
 * @returns An opened Store ready for testing
 */
export async function createTestStore(schema: SchemaDefinition = defaultSchema): Promise<Store> {
	const adapter = new BetterSqlite3Adapter(':memory:')
	const store = new Store({ schema, adapter })
	await store.open()
	return store
}

/**
 * Render a component wrapped in KoraProvider.
 */
export function renderWithProvider(
	ui: ReactNode,
	options: { store: Store; syncEngine?: SyncEngine | null },
): RenderResult {
	const { store, syncEngine } = options
	return render(createElement(KoraProvider, { store, syncEngine: syncEngine ?? null }, ui))
}

/**
 * Wait for a short time to allow microtasks and async operations to complete.
 */
export function tick(ms = 15): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
