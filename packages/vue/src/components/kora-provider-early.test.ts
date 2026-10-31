import { isPendingStore } from '@korajs/core/bindings'
import type { Store } from '@korajs/store'
import { QueryStoreCache } from '@korajs/store'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, toRaw } from 'vue'
import { useKoraContext, useKoraContextRef } from '../context'
import type { KoraAppLike } from '../types'
import { KoraProvider } from './kora-provider'

function deferredApp(withCollections = true): {
	app: KoraAppLike
	earlyAccessor: object
	realStore: Store
	open: () => Promise<void>
} {
	const earlyAccessor = { kind: 'early-accessor' }
	const realStore = { collection: vi.fn() } as unknown as Store
	let resolveReady: () => void = () => {}
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve
	})
	const queryStoreCache = new QueryStoreCache()
	const app: KoraAppLike = {
		ready,
		getStore: () => realStore,
		getSyncEngine: () => null,
		getQueryStoreCache: () => queryStoreCache,
		...(withCollections ? { collections: { todos: earlyAccessor } } : {}),
	}
	return {
		app,
		earlyAccessor,
		realStore,
		open: async () => {
			resolveReady()
			await ready
			await flushPromises()
		},
	}
}

describe('KoraProvider renders before the store opens (S4a, D6)', () => {
	it('renders the slot at once and serves the early accessors from the pending store', async () => {
		const { app, earlyAccessor, realStore, open } = deferredApp()
		let seen: Store | null = null
		const Child = defineComponent({
			setup() {
				seen = useKoraContext().store
				return () => h('p', 'shell')
			},
		})
		const wrapper = mount(KoraProvider, {
			props: { app, fallback: 'gate' },
			slots: { default: () => h(Child) },
		})
		expect(wrapper.text()).toBe('shell')
		expect(isPendingStore(seen)).toBe(true)
		expect((seen as unknown as Store).collection('todos')).toBe(earlyAccessor)

		await open()
		// A component set up before the swap keeps a stable tree; new ones get the real store.
		expect(wrapper.text()).toBe('shell')
		const Late = defineComponent({
			setup() {
				const context = useKoraContextRef()
				// Read on every render: the ref swaps to the real store once it opened.
				return () => {
					seen = context.value.store
					return h('i', 'late')
				}
			},
		})
		const second = mount(KoraProvider, { props: { app }, slots: { default: () => h(Late) } })
		await flushPromises()
		// The context is shared through a ref, so a component may read a reactive view of the store.
		expect(second.text()).toBe('late')
		expect(toRaw(seen as unknown as Store)).toBe(realStore)
	})

	it('waitForStorage holds the slot back until the store opens', async () => {
		const { app, open } = deferredApp()
		const wrapper = mount(KoraProvider, {
			props: { app, waitForStorage: true, fallback: 'gate' },
			slots: { default: () => h('p', 'shell') },
		})
		expect(wrapper.text()).toBe('gate')
		await open()
		expect(wrapper.text()).toBe('shell')
	})

	it('an app without early accessors keeps the gate', () => {
		const { app } = deferredApp(false)
		const wrapper = mount(KoraProvider, {
			props: { app, fallback: 'gate' },
			slots: { default: () => h('p', 'shell') },
		})
		expect(wrapper.text()).toBe('gate')
	})
})
