import { isPendingStore } from '@korajs/core/bindings'
import type { Store } from '@korajs/store'
import { QueryStoreCache } from '@korajs/store'
import { cleanup, render, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import EarlyProviderFlow from '../../tests/fixtures/EarlyProviderFlow.svelte'
import type { KoraAppLike, KoraContextValue } from '../types'

afterEach(() => {
	cleanup()
})

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
		},
	}
}

describe('KoraProvider renders before the store opens (S4a, D6)', () => {
	it('renders the children at once with a pending store that serves the early accessors', async () => {
		const { app, earlyAccessor, open } = deferredApp()
		const contexts: KoraContextValue[] = []
		const view = render(EarlyProviderFlow, {
			app,
			report: (context: KoraContextValue) => contexts.push(context),
		})
		expect(view.queryByText('shell')).not.toBeNull()
		expect(view.queryByText('gate')).toBeNull()
		const context = contexts[0] as KoraContextValue
		expect(isPendingStore(context.store)).toBe(true)
		expect(context.store.collection('todos')).toBe(earlyAccessor)
		await open()
		// The context is live: the same object serves the real store once it opened.
		await waitFor(() => expect(isPendingStore(context.store)).toBe(false))
		expect(view.queryByText('shell')).not.toBeNull()
	})

	it('waitForStorage shows the fallback until the store opens', async () => {
		const { app, open } = deferredApp()
		const view = render(EarlyProviderFlow, { app, waitForStorage: true, report: () => {} })
		expect(view.queryByText('gate')).not.toBeNull()
		expect(view.queryByText('shell')).toBeNull()
		await open()
		await waitFor(() => expect(view.queryByText('shell')).not.toBeNull())
		expect(view.queryByText('gate')).toBeNull()
	})

	it('with waitForStorage the children only ever see the real store', async () => {
		const { app, realStore, open } = deferredApp()
		const contexts: KoraContextValue[] = []
		render(EarlyProviderFlow, {
			app,
			waitForStorage: true,
			report: (context: KoraContextValue) => contexts.push(context),
		})
		await open()
		await waitFor(() => expect(contexts.length).toBeGreaterThan(0))
		expect(contexts[0]?.store).toBe(realStore)
	})

	it('mounts a new bridge for the new app when the app prop changes', async () => {
		const first = deferredApp()
		const second = deferredApp()
		const contexts: KoraContextValue[] = []
		const view = render(EarlyProviderFlow, {
			app: first.app,
			report: (context: KoraContextValue) => contexts.push(context),
		})
		await first.open()
		await waitFor(() => expect(isPendingStore(contexts[0]?.store as Store)).toBe(false))

		await view.rerender({
			app: second.app,
			report: (context: KoraContextValue) => contexts.push(context),
		})
		await waitFor(() => expect(contexts.at(-1)?.app).toBe(second.app))
		const latest = contexts.at(-1) as KoraContextValue
		// The second app has not opened: its children read a pending store, never the first one's.
		expect(isPendingStore(latest.store)).toBe(true)
		await second.open()
		await waitFor(() => expect(isPendingStore(latest.store)).toBe(false))
		expect(latest.store).toBe(second.realStore)
	})
})
