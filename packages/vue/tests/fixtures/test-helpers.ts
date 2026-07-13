import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import type { SyncEngine } from '@korajs/sync'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, type Component } from 'vue'
import { KoraProvider } from '../../src/components/kora-provider'

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

export function mountWithProvider(
	component: Component,
	options: { store: Store; syncEngine?: SyncEngine | null; app?: never },
): VueWrapper {
	return mount(
		defineComponent({
			setup(_, { slots }) {
				return () =>
					h(
						KoraProvider,
						{ store: options.store, syncEngine: options.syncEngine ?? null },
						() => h(component, null, slots),
					)
			},
		}),
	)
}

export function tick(ms = 15): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
