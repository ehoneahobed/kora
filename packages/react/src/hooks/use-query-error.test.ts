import type { CollectionRecord, QueryBuilder, QueryStore } from '@korajs/store'
import { QueryStoreCache } from '@korajs/store'
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { Component, createElement } from 'react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeApp, createFakeQuery, row } from '../../tests/fixtures/fake-query'
import { KoraProvider } from '../context/kora-context'
import { useQuery, useQueryState } from './use-query'

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

/**
 * A QueryStore with the STORE-12 error channel (`getError`), as the store package
 * exposes it: the error is set by the subscription's error callback and cleared by
 * the next result.
 */
class ErrorChannelQueryStore {
	private rows: readonly CollectionRecord[] = Object.freeze([])
	private loaded = false
	private error: Error | null = null
	private readonly listeners = new Set<() => void>()
	private unsubscribe: (() => void) | null = null

	constructor(private readonly query: QueryBuilder) {}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		if (!this.unsubscribe) {
			const subscribeWithError = this.query.subscribe as unknown as (
				cb: (rows: CollectionRecord[]) => void,
				onError: (error: Error) => void,
			) => () => void
			this.unsubscribe = subscribeWithError(
				(rows) => {
					this.loaded = true
					this.error = null
					this.rows = Object.freeze([...rows])
					this.notify()
				},
				(error) => {
					this.error = error
					this.notify()
				},
			)
		}
		return () => {
			this.listeners.delete(listener)
		}
	}
	getSnapshot = (): readonly CollectionRecord[] => this.rows
	hasSnapshot = (): boolean => this.loaded
	getError = (): Error | null => this.error
	destroy(): void {
		this.unsubscribe?.()
	}
	private notify(): void {
		for (const listener of this.listeners) listener()
	}
}

class ErrorChannelCache extends QueryStoreCache {
	private readonly stores = new Map<string, ErrorChannelQueryStore>()
	override getOrCreate<T>(query: QueryBuilder<T>): QueryStore<T> {
		const key = JSON.stringify(query.getDescriptor())
		let store = this.stores.get(key)
		if (!store) {
			store = new ErrorChannelQueryStore(query as unknown as QueryBuilder)
			this.stores.set(key, store)
		}
		return store as unknown as QueryStore<T>
	}
	override release(): void {}
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
	override state = { error: null as Error | null }
	static getDerivedStateFromError(error: Error) {
		return { error }
	}
	override render() {
		return this.state.error
			? createElement('p', { role: 'alert' }, this.state.error.message)
			: this.props.children
	}
}

describe('useQuery error state (STORE-12 consumer)', () => {
	it('throws a failed query to the nearest error boundary', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		const fake = createFakeQuery('boundary', [row('a')])
		const app = createFakeApp({ queryStoreCache: new ErrorChannelCache() })
		function List() {
			const rows = useQuery(fake.query)
			return createElement('span', null, `rows:${rows.length}`)
		}
		render(createElement(KoraProvider, { app }, createElement(Boundary, null, createElement(List))))
		await waitFor(() => expect(screen.getByText('rows:1')).toBeTruthy())
		act(() => fake.fail(new Error('no such column: "createdAt"')))
		expect(screen.getByRole('alert').textContent).toBe('no such column: "createdAt"')
	})

	it('throwOnError: false keeps the last rows', async () => {
		const fake = createFakeQuery('inline', [row('a')])
		const app = createFakeApp({ queryStoreCache: new ErrorChannelCache() })
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(KoraProvider, { app }, children)
		const { result } = renderHook(() => useQuery(fake.query, { throwOnError: false }), {
			wrapper,
		})
		await waitFor(() => expect(result.current).toHaveLength(1))
		act(() => fake.fail(new Error('boom')))
		expect(result.current).toHaveLength(1)
	})

	it('useQueryState returns the error and clears it when results flow again', async () => {
		const fake = createFakeQuery('state', [row('a')])
		const app = createFakeApp({ queryStoreCache: new ErrorChannelCache() })
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(KoraProvider, { app }, children)
		const { result } = renderHook(() => useQueryState(fake.query), { wrapper })
		await waitFor(() => expect(result.current.ready).toBe(true))
		expect(result.current.error).toBeNull()
		const stable = result.current

		act(() => fake.fail(new Error('boom')))
		expect(result.current.error?.message).toBe('boom')
		expect(result.current.data).toBe(stable.data)

		act(() => fake.emit([row('a'), row('b')]))
		expect(result.current.error).toBeNull()
		expect(result.current.data).toHaveLength(2)
	})

	it('works with a query store that has no error channel (older store build)', async () => {
		const fake = createFakeQuery('legacy', [row('a')])
		const app = createFakeApp({})
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(KoraProvider, { app }, children)
		const { result } = renderHook(() => useQueryState(fake.query), { wrapper })
		await waitFor(() => expect(result.current.data).toHaveLength(1))
		expect(result.current.error).toBeNull()
	})
})
