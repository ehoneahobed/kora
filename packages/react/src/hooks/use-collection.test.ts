import type { CollectionAccessor, Store } from '@korajs/store'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KoraProvider } from '../context/kora-context'
import { useCollection } from './use-collection'

afterEach(() => {
	cleanup()
})

function createMockStore(collections: Record<string, CollectionAccessor> = {}): Store {
	return {
		collection: vi.fn((name: string) => {
			const col = collections[name]
			if (!col) {
				throw new Error(`Unknown collection "${name}"`)
			}
			return col
		}),
		getSchema: vi.fn(),
		getVersionVector: vi.fn(),
		getNodeId: vi.fn(),
	} as unknown as Store
}

function createMockCollectionAccessor(): CollectionAccessor {
	return {
		insert: vi.fn(),
		findById: vi.fn(),
		update: vi.fn(),
		delete: vi.fn(),
		where: vi.fn(),
	} as unknown as CollectionAccessor
}

describe('useCollection', () => {
	it('returns a collection accessor', () => {
		const todosAccessor = createMockCollectionAccessor()
		const store = createMockStore({ todos: todosAccessor })

		function CollectionUser(): ReturnType<typeof createElement> {
			const todos = useCollection('todos')
			return createElement('span', { 'data-testid': 'has-collection' }, todos ? 'yes' : 'no')
		}

		render(createElement(KoraProvider, { store }, createElement(CollectionUser)))

		expect(screen.getByTestId('has-collection').textContent).toBe('yes')
		expect(store.collection).toHaveBeenCalledWith('todos')
	})

	it('memoizes by collection name', () => {
		const todosAccessor = createMockCollectionAccessor()
		const store = createMockStore({ todos: todosAccessor })
		let renderCount = 0

		function CollectionUser(): ReturnType<typeof createElement> {
			useCollection('todos')
			renderCount++
			return createElement('span', null, 'ok')
		}

		const { rerender } = render(
			createElement(KoraProvider, { store }, createElement(CollectionUser)),
		)

		// Force re-render with same props
		rerender(createElement(KoraProvider, { store }, createElement(CollectionUser)))

		// store.collection should only be called once due to memoization
		expect(store.collection).toHaveBeenCalledTimes(1)
	})

	it('throws for unknown collection', () => {
		const store = createMockStore({})
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

		function CollectionUser(): ReturnType<typeof createElement> {
			useCollection('nonexistent')
			return createElement('span', null, 'ok')
		}

		expect(() => {
			render(createElement(KoraProvider, { store }, createElement(CollectionUser)))
		}).toThrow('Unknown collection "nonexistent"')

		spy.mockRestore()
	})
})
