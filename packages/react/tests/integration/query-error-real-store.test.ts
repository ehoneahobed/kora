import type { KoraEvent } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { Component, createElement } from 'react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KoraProvider } from '../../src/context/kora-context'
import { useQuery, useQueryState } from '../../src/hooks/use-query'
import { defaultSchema } from '../fixtures/test-helpers'

/**
 * Cross-track seam (Phase 4): the React error state must be driven by the REAL store's
 * error channel (QueryStore.getError(), set from QueryBuilder.subscribe's `onError`, the
 * same failure the store emits as `query:error`). A query error does not change
 * getSnapshot(), so the component must re-render from the error alone.
 */

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
	override state = { error: null as Error | null }
	static getDerivedStateFromError(error: Error) {
		return { error }
	}
	override render() {
		return this.state.error
			? createElement('p', { role: 'alert' }, `boundary:${this.state.error.message}`)
			: this.props.children
	}
}

async function openStore(): Promise<{ store: Store; events: KoraEvent[] }> {
	const emitter = new SimpleEventEmitter()
	const events: KoraEvent[] = []
	emitter.on('query:error', (event) => events.push(event))
	const store = new Store({
		schema: defaultSchema,
		adapter: new BetterSqlite3Adapter(':memory:'),
		nodeId: 'react-error-node',
		emitter,
	})
	await store.open()
	return { store, events }
}

describe('useQuery / useQueryState with the real store error channel', () => {
	it('a failing query reaches the error boundary, and the store emits query:error', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		const { store, events } = await openStore()
		try {
			function List() {
				// $regex is not supported by the SQL compiler: the initial run fails.
				const rows = useQuery(store.collection('todos').where({ title: { $regex: 'x' } }))
				return createElement('span', null, `rows:${rows.length}`)
			}
			render(
				createElement(KoraProvider, { store }, createElement(Boundary, null, createElement(List))),
			)
			await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/^boundary:/))
			expect(events).toEqual([expect.objectContaining({ type: 'query:error', phase: 'initial' })])
		} finally {
			await store.close()
		}
	})

	it('useQueryState renders the error inline (no boundary) from the real store', async () => {
		const { store } = await openStore()
		try {
			function List() {
				const { data, error, ready } = useQueryState(
					store.collection('todos').where({ title: { $regex: 'x' } }),
				)
				if (error) return createElement('p', { role: 'alert' }, `inline:${error.message}`)
				return createElement('span', null, `rows:${data.length}:${String(ready)}`)
			}
			render(createElement(KoraProvider, { store }, createElement(List)))
			expect(screen.getByText('rows:0:false')).toBeTruthy()
			await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/^inline:/))
		} finally {
			await store.close()
		}
	})
})
