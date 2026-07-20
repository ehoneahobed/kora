import type { CollectionAccessor, Store } from '@korajs/store'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, shallowRef } from 'vue'
import { koraContextKey } from '../context'
import type { KoraContextValue } from '../types'
import { useCollection } from './use-collection'

describe('useCollection', () => {
	it('returns the collection accessor for the given name', () => {
		const collection = { insert: vi.fn() } as unknown as CollectionAccessor
		const store = {
			collection: vi.fn((name: string) => {
				if (name !== 'todos') throw new Error(`Unknown collection "${name}"`)
				return collection
			}),
		} as unknown as Store

		const contextRef = shallowRef<KoraContextValue | null>({
			store,
			syncEngine: null,
			app: null,
			events: null,
			subscribeSyncStatus: null,
			queryStoreCache: {} as KoraContextValue['queryStoreCache'],
		})

		let captured: CollectionAccessor | null = null
		mount(
			defineComponent({
				setup() {
					captured = useCollection('todos')
					return () => h('div')
				},
			}),
			{ global: { provide: { [koraContextKey]: contextRef } } },
		)

		expect(captured).toBe(collection)
		expect(store.collection).toHaveBeenCalledWith('todos')
	})
})
