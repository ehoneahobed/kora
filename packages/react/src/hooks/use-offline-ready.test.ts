import { OFFLINE_STATUS_UNKNOWN, type OfflineStatus } from '@korajs/core/bindings'
import type { Store } from '@korajs/store'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KoraProvider } from '../context/kora-context'
import type { KoraAppLike } from '../types'
import { useOfflineReady } from './use-offline-ready'

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

function status(overrides: Partial<OfflineStatus> = {}): OfflineStatus {
	return { ...OFFLINE_STATUS_UNKNOWN, ...overrides }
}

function fakeApp(initial: OfflineStatus) {
	let current = initial
	const listeners = new Set<(next: OfflineStatus) => void>()
	const app = {
		ready: Promise.resolve(),
		getStore: () => ({}) as Store,
		getSyncEngine: () => null,
		offline: {
			status: () => current,
			subscribe: (listener: (next: OfflineStatus) => void) => {
				listeners.add(listener)
				return () => listeners.delete(listener)
			},
		},
	} as unknown as KoraAppLike
	return {
		app,
		set(next: OfflineStatus) {
			current = next
			for (const listener of listeners) listener(next)
		},
		listeners,
	}
}

function Probe() {
	const offline = useOfflineReady()
	return createElement(
		'span',
		{ 'data-testid': 'state' },
		`${offline.state}:${offline.reasons.join(',')}`,
	)
}

describe('useOfflineReady', () => {
	it('renders the status of app.offline and follows its changes', async () => {
		const fake = fakeApp(status({ state: 'preparing', reasons: ['data-syncing'] }))
		render(createElement(KoraProvider, { app: fake.app }, createElement(Probe)))
		expect((await screen.findByTestId('state')).textContent).toBe('preparing:data-syncing')
		// The subscription is attached in a commit effect: update only once it exists, or the
		// change can land before anything listens.
		await waitFor(() => expect(fake.listeners.size).toBe(1))

		act(() => fake.set(status({ state: 'ready', reasons: [] })))
		expect(screen.getByTestId('state').textContent).toBe('ready:')
	})

	it('unsubscribes on unmount', async () => {
		const fake = fakeApp(status())
		const view = render(createElement(KoraProvider, { app: fake.app }, createElement(Probe)))
		await screen.findByTestId('state')
		expect(fake.listeners.size).toBe(1)
		view.unmount()
		expect(fake.listeners.size).toBe(0)
	})

	it('is not ready with an app that has no offline API', async () => {
		const app = {
			ready: Promise.resolve(),
			getStore: () => ({}) as Store,
			getSyncEngine: () => null,
		} as unknown as KoraAppLike
		render(createElement(KoraProvider, { app }, createElement(Probe)))
		expect((await screen.findByTestId('state')).textContent).toMatch(/^not-ready:/)
	})

	it('server render reports not-ready with server-rendering', () => {
		const html = renderToString(
			createElement(KoraProvider, { store: {} as Store, app: undefined }, createElement(Probe)),
		)
		expect(html).toContain('not-ready:server-rendering')
	})
})
