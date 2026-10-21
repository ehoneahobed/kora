import type { Operation } from '@korajs/core'
import {
	SimpleEventEmitter,
	currentWriteObserver,
	notifyWriteObserver,
} from '@korajs/core/internal'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, shallowRef } from 'vue'
import { koraContextKey } from '../context'
import type { UseMutationResult } from '../types'
import { useMutation } from './use-mutation'

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
	let handle: UseMutationResult<string, [string]> | undefined
	const wrapper = mount(
		defineComponent({
			setup() {
				const mutation = useMutation((id: string) => fakeWrite(...ids(id)), { onRejected })
				handle = mutation
				return () =>
					h(
						'span',
						{ 'data-testid': 'rejected' },
						mutation.rejected.value
							? `${mutation.rejected.value.code}:${mutation.rejected.value.args[0]}`
							: 'none',
					)
			},
		}),
		{
			global: {
				provide: {
					[koraContextKey]: shallowRef({
						store: {},
						syncEngine: null,
						app: null,
						events,
						subscribeSyncStatus: null,
						queryStoreCache: null,
					}),
				},
			},
		},
	)
	if (!handle) throw new Error('Expected the mutation handle')
	return { events, onRejected, handle, wrapper }
}

describe('useMutation rejected (Vue)', () => {
	it('reports an immediate refusal through rejected and onRejected', async () => {
		const { events, onRejected, handle, wrapper } = mountRejected()
		await handle.mutateAsync('a')
		refuse(events, 'a')
		await flushPromises()

		expect(wrapper.get('[data-testid="rejected"]').text()).toBe('WINDOW_CLOSED:a')
		expect(onRejected).toHaveBeenCalledTimes(1)
	})

	it('reports a delayed refusal of an earlier write; an accepted write is not reported', async () => {
		const { events, onRejected, handle } = mountRejected()
		await handle.mutateAsync('first')
		await handle.mutateAsync('second')
		events.emit({ type: 'sync:operations-acknowledged', operationIds: ['second'] })
		refuse(events, 'second')
		refuse(events, 'first')

		expect(onRejected).toHaveBeenCalledTimes(1)
		expect(handle.rejected.value?.args).toEqual(['first'])
	})

	it('reports a multi-operation write once with every id', async () => {
		const { events, onRejected, handle } = mountRejected((id) => [`${id}-1`, `${id}-2`])
		await handle.mutateAsync('tx')
		refuse(events, 'tx-2')
		refuse(events, 'tx-1')

		expect(onRejected).toHaveBeenCalledTimes(1)
		expect(handle.rejected.value?.operationIds).toEqual(['tx-1', 'tx-2'])
	})

	it('reports nothing after unmount', async () => {
		const { events, onRejected, handle, wrapper } = mountRejected()
		await handle.mutateAsync('gone')
		wrapper.unmount()
		refuse(events, 'gone')

		expect(onRejected).not.toHaveBeenCalled()
		expect(events.listenerCount('sync:operation-rejected')).toBe(0)
	})
})
