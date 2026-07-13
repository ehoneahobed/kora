import { QueryStoreCache } from '@korajs/store'
import { cleanup, render, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KoraAppLike } from '../../src/types'
import AppFallbackFlow from '../fixtures/AppFallbackFlow.svelte'
import AppReadyFlow from '../fixtures/AppReadyFlow.svelte'
import MutationFlow from '../fixtures/MutationFlow.svelte'
import QueryFlow from '../fixtures/QueryFlow.svelte'
import SyncStatusFlow from '../fixtures/SyncStatusFlow.svelte'
import { createTestStore, tick } from '../fixtures/test-helpers'

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

describe('Integration: full flow', () => {
	it('createQueryStore reactively updates when store data changes', async () => {
		const store = await createTestStore()
		const { getByTestId } = render(QueryFlow, { props: { store } })

		expect(getByTestId('count').textContent).toBe('0')

		await store.collection('todos').insert({ title: 'Test todo' })
		await tick()

		await waitFor(() => {
			expect(getByTestId('count').textContent).toBe('1')
		})

		await store.close()
	})

	it('createMutation + createQueryStore work together', async () => {
		const store = await createTestStore()
		const { getByTestId } = render(MutationFlow, { props: { store } })

		expect(getByTestId('count').textContent).toBe('0')
		await userEvent.click(getByTestId('add'))
		await tick(50)

		await waitFor(() => {
			expect(getByTestId('count').textContent).toBe('1')
		})

		await store.close()
	})

	it('createSyncStatusStore shows offline without sync engine', async () => {
		const store = await createTestStore()
		const { getByTestId } = render(SyncStatusFlow, { props: { store } })

		expect(getByTestId('status').textContent).toBe('offline')
		await store.close()
	})
})

describe('Integration: KoraProvider component', () => {
	it('waits for app.ready before rendering children', async () => {
		const store = await createTestStore()
		let resolveReady!: () => void
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve
		})

		const app: KoraAppLike = {
			ready,
			getStore: () => store,
			getSyncEngine: () => null,
		}

		const { getByTestId, queryByTestId } = render(AppReadyFlow, {
			props: { app, store },
		})

		expect(queryByTestId('count')).toBeNull()

		resolveReady()
		await ready

		await waitFor(() => {
			expect(getByTestId('count').textContent).toBe('0')
		})

		await store.close()
	})

	it('shows fallback while app.ready is pending', async () => {
		const store = await createTestStore()
		let resolveReady!: () => void
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve
		})

		const app: KoraAppLike = {
			ready,
			getStore: () => store,
			getSyncEngine: () => null,
		}

		const { getByTestId, queryByTestId } = render(AppFallbackFlow, { props: { app } })

		expect(getByTestId('fallback').textContent).toBe('Loading...')
		expect(queryByTestId('child')).toBeNull()

		resolveReady()
		await ready

		await waitFor(() => {
			expect(getByTestId('child').textContent).toBe('Loaded!')
			expect(queryByTestId('fallback')).toBeNull()
		})

		await store.close()
	})
})
