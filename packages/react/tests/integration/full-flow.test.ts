import type { SyncEngine, SyncStatusInfo } from '@kora/sync'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KoraProvider } from '../../src/context/kora-context'
import { useCollection } from '../../src/hooks/use-collection'
import { useMutation } from '../../src/hooks/use-mutation'
import { useQuery } from '../../src/hooks/use-query'
import { useSyncStatus } from '../../src/hooks/use-sync-status'
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
