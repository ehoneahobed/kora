import { AppNotReadyError } from '@korajs/core'
import { isPendingStore } from '@korajs/core/bindings'
import type { Store } from '@korajs/store'
import { act, cleanup, render, screen } from '@testing-library/react'
import { StrictMode, createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KoraAppLike } from '../types'
import { KoraProvider, useKoraContext } from './kora-context'

afterEach(() => {
	cleanup()
})

interface Deferred {
	app: KoraAppLike
	earlyAccessor: object
	realStore: Store
	open: () => Promise<void>
	fail: (error: Error) => Promise<void>
}

/** An app whose store opens when the test says so, and whose accessors work before that. */
function deferredApp(): Deferred {
	const earlyAccessor = { kind: 'early-accessor' }
	const realStore = { collection: vi.fn(() => ({ kind: 'real-accessor' })) } as unknown as Store
	let resolveReady: () => void = () => {}
	let rejectReady: (error: Error) => void = () => {}
	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve
		rejectReady = reject
	})
	ready.catch(() => {})
	const app: KoraAppLike = {
		ready,
		getStore: () => realStore,
		getSyncEngine: () => null,
		collections: { todos: earlyAccessor },
	}
	return {
		app,
		earlyAccessor,
		realStore,
		open: async () => {
			await act(async () => {
				resolveReady()
				await ready
			})
		},
		fail: async (error) => {
			await act(async () => {
				rejectReady(error)
				await ready.catch(() => {})
			})
		},
	}
}

function StoreProbe(): ReturnType<typeof createElement> {
	const { store } = useKoraContext()
	return createElement(
		'div',
		null,
		createElement('span', { 'data-testid': 'pending' }, String(isPendingStore(store))),
	)
}

describe('KoraProvider renders before the store opens (S4a, D6)', () => {
	it('renders its children at once, without waiting for app.ready', () => {
		const { app } = deferredApp()
		render(
			createElement(KoraProvider, { app, fallback: 'gate' }, createElement('p', null, 'shell')),
		)
		expect(screen.getByText('shell')).toBeTruthy()
		expect(screen.queryByText('gate')).toBeNull()
	})

	it('hands hooks a pending store that serves the early accessors, then swaps in the real store', async () => {
		const { app, earlyAccessor, realStore, open } = deferredApp()
		let seen: Store | null = null
		function Capture(): null {
			seen = useKoraContext().store
			return null
		}
		render(createElement(KoraProvider, { app }, createElement(Capture), createElement(StoreProbe)))
		expect(screen.getByTestId('pending').textContent).toBe('true')
		const pending = seen as unknown as Store
		expect(pending.collection('todos')).toBe(earlyAccessor)

		await open()
		expect(screen.getByTestId('pending').textContent).toBe('false')
		expect(seen).toBe(realStore)
	})

	it('the pending store refuses everything but collection(), naming the fix', () => {
		const { app } = deferredApp()
		let seen: Store | null = null
		function Capture(): null {
			seen = useKoraContext().store
			return null
		}
		render(createElement(KoraProvider, { app }, createElement(Capture)))
		const pending = seen as unknown as Store
		expect(() => pending.getNodeId()).toThrow(AppNotReadyError)
		expect(() => pending.collection('missing')).toThrow(/not in the schema/)
	})

	it('waitForStorage restores the gate: the fallback shows until the store opens', async () => {
		const { app, open } = deferredApp()
		render(
			createElement(
				KoraProvider,
				{ app, waitForStorage: true, fallback: 'gate' },
				createElement('p', null, 'shell'),
			),
		)
		expect(screen.getByText('gate')).toBeTruthy()
		expect(screen.queryByText('shell')).toBeNull()
		await open()
		expect(screen.getByText('shell')).toBeTruthy()
		expect(screen.queryByText('gate')).toBeNull()
	})

	it('an app without early accessors keeps the gate (older or hand-made app objects)', () => {
		const { app } = deferredApp()
		const { collections: _omitted, ...legacy } = app
		render(
			createElement(
				KoraProvider,
				{ app: legacy as KoraAppLike, fallback: 'gate' },
				createElement('p', null, 'shell'),
			),
		)
		expect(screen.getByText('gate')).toBeTruthy()
		expect(screen.queryByText('shell')).toBeNull()
	})

	it('a store that fails to open replaces the tree with the error, as before', async () => {
		const { app, fail } = deferredApp()
		const log = vi.spyOn(console, 'error').mockImplementation(() => {})
		render(createElement(KoraProvider, { app }, createElement('p', null, 'shell')))
		await fail(new Error('disk full'))
		expect(screen.getByText(/disk full/)).toBeTruthy()
		expect(screen.queryByText('shell')).toBeNull()
		log.mockRestore()
	})

	it('survives React.StrictMode double mounting: one tree, swapped once', async () => {
		const { app, realStore, open } = deferredApp()
		const stores: Store[] = []
		function Capture(): null {
			stores.push(useKoraContext().store)
			return null
		}
		render(
			createElement(StrictMode, null, createElement(KoraProvider, { app }, createElement(Capture))),
		)
		expect(isPendingStore(stores.at(-1))).toBe(true)
		await open()
		expect(stores.at(-1)).toBe(realStore)
		// No render saw the real store and then the pending one again (no tearing back).
		const firstReal = stores.findIndex((store) => store === realStore)
		expect(stores.slice(firstReal).every((store) => store === realStore)).toBe(true)
	})

	it('renders the children on the server too (the first render is the same everywhere)', () => {
		const { app } = deferredApp()
		const html = renderToString(
			createElement(KoraProvider, { app, fallback: 'gate' }, createElement('p', null, 'shell')),
		)
		expect(html).toContain('shell')
		expect(html).not.toContain('gate')
	})
})
