import type { Operation } from '@korajs/core'
import {
	SimpleEventEmitter,
	currentWriteObserver,
	notifyWriteObserver,
} from '@korajs/core/internal'
import { cleanup, render } from '@testing-library/svelte'
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MutationRejected from '../../tests/fixtures/MutationRejected.svelte'
import type { UseMutationResult } from '../types'
import { createMutation } from './use-mutation'

afterEach(cleanup)

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

function mountRejected(ids: (id: string) => string[] = (id) => [id]) {
	const events = new SimpleEventEmitter()
	const onRejected = vi.fn()
	let handle: UseMutationResult<unknown, [string]> | undefined
	const view = render(MutationRejected, {
		props: {
			events,
			mutationFn: (id: string) => fakeWrite(...ids(id)),
			onRejected,
			onready: (mutation: UseMutationResult<unknown, [string]>) => {
				handle = mutation
			},
		},
	})
	if (!handle) throw new Error('Expected the mutation handle')
	return { events, onRejected, handle, view }
}

describe('createMutation rejected', () => {
	it('reports an immediate refusal through rejected, subscribeRejected and onRejected', async () => {
		const { events, onRejected, handle, view } = mountRejected()
		await handle.mutateAsync('a')
		refuse(events, 'a')
		flushSync()

		expect(handle.rejected).toMatchObject({ code: 'WINDOW_CLOSED', args: ['a'] })
		expect(onRejected).toHaveBeenCalledTimes(1)
		expect(view.getByTestId('rejected').textContent).toBe('WINDOW_CLOSED:a')
	})

	it('reports a delayed refusal of an earlier write; an accepted write is not reported', async () => {
		const { events, onRejected, handle } = mountRejected()
		await handle.mutateAsync('first')
		await handle.mutateAsync('second')
		events.emit({ type: 'sync:operations-acknowledged', operationIds: ['second'] })
		refuse(events, 'second')
		refuse(events, 'first')

		expect(onRejected).toHaveBeenCalledTimes(1)
		expect(handle.rejected?.args).toEqual(['first'])
	})

	it('reports a multi-operation write once with every id', async () => {
		const { events, onRejected, handle } = mountRejected((id) => [`${id}-1`, `${id}-2`])
		await handle.mutateAsync('tx')
		refuse(events, 'tx-1')
		refuse(events, 'tx-2')

		expect(onRejected).toHaveBeenCalledTimes(1)
		expect(handle.rejected?.operationIds).toEqual(['tx-1', 'tx-2'])
	})

	it('reports nothing after the component is destroyed', async () => {
		const { events, onRejected, handle, view } = mountRejected()
		await handle.mutateAsync('gone')
		view.unmount()
		refuse(events, 'gone')

		expect(onRejected).not.toHaveBeenCalled()
		expect(events.listenerCount('sync:operation-rejected')).toBe(0)
	})

	it('outside a component it runs without tracking', async () => {
		const mutation = createMutation(() => fakeWrite('x'))
		await expect(mutation.mutateAsync()).resolves.toBe('ok')
		expect(mutation.rejected).toBeNull()
	})
})
