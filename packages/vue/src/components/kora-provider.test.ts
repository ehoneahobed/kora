import type { Store } from '@korajs/store'
import { QueryStoreCache } from '@korajs/store'
import type { SyncEngine } from '@korajs/sync'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { koraContextKey, useKoraContext } from '../context'
import type { KoraAppLike } from '../types'
import { KoraProvider } from './kora-provider'

afterEach(() => {
	vi.restoreAllMocks()
})

function createMockStore(): Store {
	return {
		collection: vi.fn(),
		getSchema: vi.fn(),
		getVersionVector: vi.fn(),
		getNodeId: vi.fn(),
	} as unknown as Store
}

function createMockSyncEngine(): SyncEngine {
	return {
		getStatus: vi.fn().mockReturnValue({
			status: 'offline',
			pendingOperations: 0,
			lastSyncedAt: null,
		}),
		start: vi.fn(),
		stop: vi.fn(),
	} as unknown as SyncEngine
}

function createMockApp(options?: { syncEngine?: SyncEngine | null }): {
	app: KoraAppLike
	store: Store
	resolve: () => void
} {
	const store = createMockStore()
	const syncEngine = options?.syncEngine ?? null
	const queryStoreCache = new QueryStoreCache()
	let resolveReady: (() => void) | undefined
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve
	})

	const app: KoraAppLike = {
		ready,
		getStore: () => store,
		getSyncEngine: () => syncEngine,
		getQueryStoreCache: () => queryStoreCache,
	}

	return { app, store, resolve: resolveReady as () => void }
}

const ContextReader = defineComponent({
	setup() {
		const ctx = useKoraContext()
		return () =>
			h('div', null, [
				h('span', { 'data-testid': 'has-store' }, ctx.store ? 'yes' : 'no'),
				h('span', { 'data-testid': 'has-sync' }, ctx.syncEngine ? 'yes' : 'no'),
			])
	},
})

describe('KoraProvider', () => {
	describe('store prop', () => {
		it('renders children within the provider', () => {
			const store = createMockStore()
			const wrapper = mount(
				defineComponent({
					setup: () => () =>
						h(KoraProvider, { store }, () => h('div', { 'data-testid': 'child' }, 'Hello')),
				}),
			)
			expect(wrapper.get('[data-testid="child"]').text()).toBe('Hello')
		})

		it('provides store via context', () => {
			const store = createMockStore()
			const wrapper = mount(
				defineComponent({
					setup: () => () => h(KoraProvider, { store }, () => h(ContextReader)),
				}),
			)
			expect(wrapper.get('[data-testid="has-store"]').text()).toBe('yes')
		})

		it('provides syncEngine when specified', () => {
			const store = createMockStore()
			const syncEngine = createMockSyncEngine()
			const wrapper = mount(
				defineComponent({
					setup: () => () => h(KoraProvider, { store, syncEngine }, () => h(ContextReader)),
				}),
			)
			expect(wrapper.get('[data-testid="has-sync"]').text()).toBe('yes')
		})

		it('throws when useKoraContext is used outside provider', () => {
			const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
			expect(() => mount(ContextReader)).toThrow('useKoraContext() requires <KoraProvider>')
			spy.mockRestore()
		})
	})

	describe('app prop', () => {
		it('renders children after app.ready resolves', async () => {
			const { app, resolve } = createMockApp()
			const wrapper = mount(
				defineComponent({
					setup: () => () =>
						h(KoraProvider, { app }, () => h('div', { 'data-testid': 'child' }, 'Ready!')),
				}),
			)

			expect(wrapper.find('[data-testid="child"]').exists()).toBe(false)
			resolve()
			await app.ready
			await wrapper.vm.$nextTick()

			expect(wrapper.get('[data-testid="child"]').text()).toBe('Ready!')
		})

		it('renders fallback while app.ready is pending', async () => {
			const { app, resolve } = createMockApp()
			const wrapper = mount(
				defineComponent({
					setup: () => () =>
						h(
							KoraProvider,
							{ app, fallback: h('div', { 'data-testid': 'loading' }, 'Loading...') },
							() => h('div', { 'data-testid': 'child' }, 'Ready!'),
						),
				}),
			)

			expect(wrapper.get('[data-testid="loading"]').text()).toBe('Loading...')
			expect(wrapper.find('[data-testid="child"]').exists()).toBe(false)

			resolve()
			await app.ready
			await wrapper.vm.$nextTick()

			expect(wrapper.get('[data-testid="child"]').text()).toBe('Ready!')
			expect(wrapper.find('[data-testid="loading"]').exists()).toBe(false)
		})
	})
})
