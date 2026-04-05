import type { Store } from '@kora/store'
import type { SyncEngine, SyncStatusInfo } from '@kora/sync'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KoraProvider } from '../../src/context/kora-context'
import { useCollection } from '../../src/hooks/use-collection'
import { useMutation } from '../../src/hooks/use-mutation'
import { useQuery } from '../../src/hooks/use-query'
import { useSyncStatus } from '../../src/hooks/use-sync-status'
import type { KoraAppLike } from '../../src/types'
import { createTestStore, defaultSchema, tick } from '../fixtures/test-helpers'

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

describe('Integration: full flow', () => {
	it('useQuery reactively updates when store data changes', async () => {
		const store = await createTestStore()

		function TodoList(): ReturnType<typeof createElement> {
			const todos = useQuery(store.collection('todos').where({}))
			return createElement('div', { 'data-testid': 'count' }, String(todos.length))
		}

		render(createElement(KoraProvider, { store }, createElement(TodoList)))

		// Initially empty
		await waitFor(() => {
			expect(screen.getByTestId('count').textContent).toBe('0')
		})

		// Insert a record
		await act(async () => {
			await store.collection('todos').insert({ title: 'Test todo' })
			await tick()
		})

		await waitFor(() => {
			expect(screen.getByTestId('count').textContent).toBe('1')
		})

		await store.close()
	})

	it('useMutation + useQuery: mutate and see results', async () => {
		const store = await createTestStore()

		function TodoApp(): ReturnType<typeof createElement> {
			const todos = useQuery(store.collection('todos').where({}))
			const { mutate } = useMutation((title: string) => store.collection('todos').insert({ title }))

			return createElement(
				'div',
				null,
				createElement('div', { 'data-testid': 'count' }, String(todos.length)),
				createElement('button', {
					type: 'button',
					'data-testid': 'add',
					onClick: () => mutate('New todo'),
				}),
			)
		}

		render(createElement(KoraProvider, { store }, createElement(TodoApp)))

		await waitFor(() => {
			expect(screen.getByTestId('count').textContent).toBe('0')
		})

		await act(async () => {
			screen.getByTestId('add').click()
			await tick(50)
		})

		await waitFor(() => {
			expect(screen.getByTestId('count').textContent).toBe('1')
		})

		await store.close()
	})

	it('useSyncStatus shows offline without sync engine', async () => {
		const store = await createTestStore()

		function StatusDisplay(): ReturnType<typeof createElement> {
			const status = useSyncStatus()
			return createElement('span', { 'data-testid': 'status' }, status.status)
		}

		render(createElement(KoraProvider, { store }, createElement(StatusDisplay)))

		expect(screen.getByTestId('status').textContent).toBe('offline')

		await store.close()
	})

	it('multiple hooks in one component work together', async () => {
		const store = await createTestStore()
		const syncEngine = {
			getStatus: vi.fn().mockReturnValue({
				status: 'synced',
				pendingOperations: 0,
				lastSyncedAt: 99999,
			} as SyncStatusInfo),
		} as unknown as SyncEngine

		function FullApp(): ReturnType<typeof createElement> {
			const todos = useQuery(store.collection('todos').where({}))
			const { mutate } = useMutation((title: string) => store.collection('todos').insert({ title }))
			const status = useSyncStatus()
			const todosCollection = useCollection('todos')

			return createElement(
				'div',
				null,
				createElement('div', { 'data-testid': 'count' }, String(todos.length)),
				createElement('div', { 'data-testid': 'status' }, status.status),
				createElement('div', { 'data-testid': 'has-collection' }, todosCollection ? 'yes' : 'no'),
				createElement('button', {
					type: 'button',
					'data-testid': 'add',
					onClick: () => mutate('Todo'),
				}),
			)
		}

		render(createElement(KoraProvider, { store, syncEngine }, createElement(FullApp)))

		await waitFor(() => {
			expect(screen.getByTestId('count').textContent).toBe('0')
		})
		expect(screen.getByTestId('status').textContent).toBe('synced')
		expect(screen.getByTestId('has-collection').textContent).toBe('yes')

		await act(async () => {
			screen.getByTestId('add').click()
			await tick(50)
		})

		await waitFor(() => {
			expect(screen.getByTestId('count').textContent).toBe('1')
		})

		await store.close()
	})

	it('unmount cleans up all subscriptions', async () => {
		const store = await createTestStore()

		function TodoList(): ReturnType<typeof createElement> {
			const todos = useQuery(store.collection('todos').where({}))
			return createElement('div', { 'data-testid': 'count' }, String(todos.length))
		}

		const { unmount } = render(createElement(KoraProvider, { store }, createElement(TodoList)))

		await waitFor(() => {
			expect(screen.getByTestId('count').textContent).toBe('0')
		})

		// Unmount should not throw or leak
		unmount()

		// Insert after unmount should not cause errors
		await store.collection('todos').insert({ title: 'After unmount' })
		await tick()

		await store.close()
	})
})

describe('Integration: app prop', () => {
	it('KoraProvider with app prop waits for ready then renders', async () => {
		const store = await createTestStore()
		let resolveReady: () => void
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve
		})

		const app: KoraAppLike = {
			ready,
			getStore: () => store,
			getSyncEngine: () => null,
		}

		function TodoList(): ReturnType<typeof createElement> {
			const todos = useQuery(store.collection('todos').where({}))
			return createElement('div', { 'data-testid': 'count' }, String(todos.length))
		}

		render(createElement(KoraProvider, { app }, createElement(TodoList)))

		// Before ready, children should not be rendered
		expect(screen.queryByTestId('count')).toBeNull()

		// Resolve ready
		await act(async () => {
			resolveReady!()
		})

		// Now children should render with query data
		await waitFor(() => {
			expect(screen.getByTestId('count').textContent).toBe('0')
		})

		// Insert and verify reactivity works through the app prop path
		await act(async () => {
			await store.collection('todos').insert({ title: 'App prop test' })
			await tick()
		})

		await waitFor(() => {
			expect(screen.getByTestId('count').textContent).toBe('1')
		})

		await store.close()
	})

	it('KoraProvider with app prop provides useCollection access', async () => {
		const store = await createTestStore()
		const app: KoraAppLike = {
			ready: Promise.resolve(),
			getStore: () => store,
			getSyncEngine: () => null,
		}

		function CollectionUser(): ReturnType<typeof createElement> {
			const todos = useCollection('todos')
			return createElement(
				'div',
				{ 'data-testid': 'has-collection' },
				todos ? 'yes' : 'no',
			)
		}

		render(createElement(KoraProvider, { app }, createElement(CollectionUser)))

		await waitFor(() => {
			expect(screen.getByTestId('has-collection').textContent).toBe('yes')
		})

		await store.close()
	})

	it('KoraProvider with app prop shows fallback then children', async () => {
		const store = await createTestStore()
		let resolveReady: () => void
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve
		})

		const app: KoraAppLike = {
			ready,
			getStore: () => store,
			getSyncEngine: () => null,
		}

		const fallback = createElement('div', { 'data-testid': 'fallback' }, 'Loading...')

		render(
			createElement(
				KoraProvider,
				{ app, fallback },
				createElement('div', { 'data-testid': 'child' }, 'Loaded!'),
			),
		)

		// Fallback shown before ready
		expect(screen.getByTestId('fallback').textContent).toBe('Loading...')
		expect(screen.queryByTestId('child')).toBeNull()

		await act(async () => {
			resolveReady!()
		})

		// Children shown after ready
		await waitFor(() => {
			expect(screen.getByTestId('child').textContent).toBe('Loaded!')
			expect(screen.queryByTestId('fallback')).toBeNull()
		})

		await store.close()
	})
})
