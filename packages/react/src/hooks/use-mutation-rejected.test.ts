import type { Operation } from '@korajs/core'
import type { MutationRejection } from '@korajs/core/bindings'
import {
	SimpleEventEmitter,
	currentWriteObserver,
	notifyWriteObserver,
} from '@korajs/core/internal'
import type { Store } from '@korajs/store'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { StrictMode, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KoraProvider } from '../context/kora-context'
import type { KoraAppLike } from '../types'
import { useMutation } from './use-mutation'

afterEach(cleanup)

function mockApp(events: SimpleEventEmitter): KoraAppLike {
	const store = { collection: vi.fn() } as unknown as Store
	return { ready: Promise.resolve(), events, getStore: () => store, getSyncEngine: () => null }
}

/** A fake local write reporting its operation ids to the caller's observer. */
function fakeWrite(...ids: string[]): Promise<string> {
	const observer = currentWriteObserver()
	return Promise.resolve().then(() => {
		notifyWriteObserver(
			observer,
			ids.map((id) => ({ id }) as Operation),
		)
		return 'ok'
	})
}

function refuse(events: SimpleEventEmitter, operationId: string): void {
	events.emit({
		type: 'sync:operation-rejected',
		operationId,
		collection: 'todos',
		recordId: 'rec-1',
		code: 'WINDOW_CLOSED',
		message: 'Submissions are closed',
		retriable: false,
	})
}

let handle: { mutateAsync: (id: string) => Promise<string> } | null = null

function Tester({
	ids,
	onRejected,
}: {
	ids: (id: string) => string[]
	onRejected: (r: MutationRejection<[string]>) => void
}): ReturnType<typeof createElement> {
	const mutation = useMutation((id: string) => fakeWrite(...ids(id)), { onRejected })
	handle = mutation
	return createElement(
		'span',
		{ 'data-testid': 'rejected' },
		mutation.rejected ? `${mutation.rejected.code}:${mutation.rejected.args[0]}` : 'none',
	)
}

async function mount(
	events: SimpleEventEmitter,
	onRejected: (r: MutationRejection<[string]>) => void,
	ids: (id: string) => string[] = (id) => [id],
) {
	const result = render(
		createElement(
			StrictMode,
			null,
			createElement(
				KoraProvider,
				{ app: mockApp(events) },
				createElement(Tester, { ids, onRejected }),
			),
		),
	)
	await waitFor(() => expect(screen.getByTestId('rejected').textContent).toBe('none'))
	return result
}

describe('useMutation rejected', () => {
	it('reports an immediate refusal through rejected and onRejected', async () => {
		const events = new SimpleEventEmitter()
		const onRejected = vi.fn()
		await mount(events, onRejected)

		await act(async () => {
			await handle?.mutateAsync('a')
		})
		act(() => refuse(events, 'a'))

		expect(screen.getByTestId('rejected').textContent).toBe('WINDOW_CLOSED:a')
		expect(onRejected).toHaveBeenCalledTimes(1)
	})

	it('reports a refusal that arrives after later writes resolved', async () => {
		const events = new SimpleEventEmitter()
		const onRejected = vi.fn()
		await mount(events, onRejected)

		await act(async () => {
			await handle?.mutateAsync('first')
			await handle?.mutateAsync('second')
		})
		act(() => {
			events.emit({ type: 'sync:operations-acknowledged', operationIds: ['second'] })
			refuse(events, 'second')
			refuse(events, 'first')
		})

		expect(onRejected).toHaveBeenCalledTimes(1)
		expect(screen.getByTestId('rejected').textContent).toBe('WINDOW_CLOSED:first')
	})

	it('reports a multi-operation write once', async () => {
		const events = new SimpleEventEmitter()
		const onRejected = vi.fn()
		await mount(events, onRejected, (id) => [`${id}-1`, `${id}-2`])

		await act(async () => {
			await handle?.mutateAsync('tx')
		})
		act(() => {
			refuse(events, 'tx-2')
			refuse(events, 'tx-1')
		})

		expect(onRejected).toHaveBeenCalledTimes(1)
		expect(onRejected.mock.calls[0]?.[0].operationIds).toEqual(['tx-1', 'tx-2'])
	})

	it('reports nothing after unmount and leaves no listeners behind', async () => {
		const events = new SimpleEventEmitter()
		const onRejected = vi.fn()
		const { unmount } = await mount(events, onRejected)

		await act(async () => {
			await handle?.mutateAsync('gone')
		})
		unmount()
		refuse(events, 'gone')

		expect(onRejected).not.toHaveBeenCalled()
		// A controller a discarded StrictMode render created is reaped by useController's
		// orphan timer (1s); after it, nothing listens any more.
		await waitFor(() => expect(events.listenerCount('sync:operation-rejected')).toBe(0), {
			timeout: 3000,
		})
	})

	it('without a provider useMutation still works and tracks nothing', async () => {
		function Bare(): ReturnType<typeof createElement> {
			const mutation = useMutation(() => fakeWrite('x'))
			handle = mutation as unknown as typeof handle
			return createElement('span', { 'data-testid': 'bare' }, String(mutation.rejected))
		}
		render(createElement(Bare))
		await act(async () => {
			await handle?.mutateAsync('x')
		})
		expect(screen.getByTestId('bare').textContent).toBe('null')
	})
})
