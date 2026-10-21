import { describe, expect, test, vi } from 'vitest'
import { SimpleEventEmitter } from '../events/event-emitter'
import type { Operation } from '../types'
import { currentWriteObserver, notifyWriteObserver } from '../writes/write-observer'
import { MAX_TRACKED_WRITES, createMutationController } from './create-mutation-controller'
import type { MutationRejection } from './types'

/** A fake local write: reports its operations to the observer current when it starts. */
function localWrite(...ids: string[]): Promise<string> {
	const observer = currentWriteObserver()
	return Promise.resolve().then(() => {
		notifyWriteObserver(
			observer,
			ids.map((id) => ({ id }) as Operation),
		)
		return ids.join(',')
	})
}

function refuse(
	events: SimpleEventEmitter,
	operationId: string,
	overrides: { code?: string; retriable?: boolean } = {},
): void {
	events.emit({
		type: 'sync:operation-rejected',
		operationId,
		collection: 'todos',
		recordId: `rec-${operationId}`,
		code: overrides.code ?? 'WINDOW_CLOSED',
		message: 'Submissions are closed',
		retriable: overrides.retriable ?? false,
	})
}

describe('createMutationController rejection tracking', () => {
	test('a refusal right after the write sets rejected and calls onRejected', async () => {
		const events = new SimpleEventEmitter()
		const onRejected = vi.fn()
		const controller = createMutationController({
			mutationFn: (title: string) => localWrite(`op-${title}`),
			options: { onRejected },
			events,
		})

		await controller.mutateAsync('a')
		refuse(events, 'op-a')

		const rejected = controller.getSnapshot().rejected
		expect(rejected).toMatchObject({
			code: 'WINDOW_CLOSED',
			message: 'Submissions are closed',
			collection: 'todos',
			recordId: 'rec-op-a',
			operationId: 'op-a',
			operationIds: ['op-a'],
			reverted: true,
			args: ['a'],
		})
		expect(onRejected).toHaveBeenCalledTimes(1)
		expect(onRejected).toHaveBeenCalledWith(rejected)
	})

	test('a refusal long after other writes resolved is attributed to its own call', async () => {
		const events = new SimpleEventEmitter()
		const onRejected = vi.fn()
		const controller = createMutationController({
			mutationFn: (id: string) => localWrite(id),
			options: { onRejected },
			events,
		})

		await controller.mutateAsync('first')
		await controller.mutateAsync('second')
		await controller.mutateAsync('third')
		// Offline for a while: nothing happens until the device syncs.
		expect(controller.getSnapshot().rejected).toBeNull()

		events.emit({ type: 'sync:operations-acknowledged', operationIds: ['first', 'third'] })
		refuse(events, 'second', { code: 'ACCESS_DENIED' })

		expect(onRejected).toHaveBeenCalledTimes(1)
		expect(onRejected.mock.calls[0]?.[0]).toMatchObject({ code: 'ACCESS_DENIED', args: ['second'] })
	})

	test('a transaction is one write: any refused operation reports it once, with every id', async () => {
		const events = new SimpleEventEmitter()
		const onRejected = vi.fn()
		const controller = createMutationController({
			mutationFn: () => localWrite('tx-1', 'tx-2', 'tx-3'),
			options: { onRejected },
			events,
		})

		await controller.mutateAsync()
		refuse(events, 'tx-2')
		refuse(events, 'tx-3')

		expect(onRejected).toHaveBeenCalledTimes(1)
		const rejection = onRejected.mock.calls[0]?.[0] as MutationRejection
		expect(rejection.operationId).toBe('tx-2')
		expect(rejection.operationIds).toEqual(['tx-1', 'tx-2', 'tx-3'])
	})

	test('several writes started by one call are one write', async () => {
		const events = new SimpleEventEmitter()
		const onRejected = vi.fn()
		const controller = createMutationController({
			mutationFn: () => {
				// Both start synchronously, so both see this call's observer.
				return Promise.all([localWrite('w-1'), localWrite('w-2')])
			},
			options: { onRejected },
			events,
		})

		await controller.mutateAsync()
		refuse(events, 'w-2')

		expect(onRejected.mock.calls[0]?.[0]).toMatchObject({ operationIds: ['w-1', 'w-2'] })
	})

	test('an accepted write is forgotten: a later event naming it is not a refusal of this hook', async () => {
		const events = new SimpleEventEmitter()
		const onRejected = vi.fn()
		const controller = createMutationController({
			mutationFn: () => localWrite('ok-1'),
			options: { onRejected },
			events,
		})

		await controller.mutateAsync()
		events.emit({ type: 'sync:operations-acknowledged', operationIds: ['ok-1'] })
		refuse(events, 'ok-1')

		expect(onRejected).not.toHaveBeenCalled()
		expect(controller.getSnapshot().rejected).toBeNull()
	})

	test('retriable rejections and other writers are ignored', async () => {
		const events = new SimpleEventEmitter()
		const onRejected = vi.fn()
		const controller = createMutationController({
			mutationFn: () => localWrite('mine'),
			options: { onRejected },
			events,
		})

		await controller.mutateAsync()
		refuse(events, 'mine', { retriable: true })
		refuse(events, 'someone-elses')

		expect(onRejected).not.toHaveBeenCalled()
	})

	test('a write kept locally (OUT_OF_UPLINK_SCOPE) is reported as not reverted', async () => {
		const events = new SimpleEventEmitter()
		const controller = createMutationController({
			mutationFn: () => localWrite('out'),
			events,
		})

		await controller.mutateAsync()
		refuse(events, 'out', { code: 'OUT_OF_UPLINK_SCOPE' })

		expect(controller.getSnapshot().rejected?.reverted).toBe(false)
	})

	test('a record leaving the sync scope refuses its unsent writes (SCOPE_RETRACTED)', async () => {
		const events = new SimpleEventEmitter()
		const controller = createMutationController({
			mutationFn: () => localWrite('retracted'),
			events,
		})

		await controller.mutateAsync()
		events.emit({
			type: 'sync:scope-retracted',
			collection: 'todos',
			recordId: 'rec-1',
			quarantinedOperationIds: ['retracted'],
		})

		expect(controller.getSnapshot().rejected).toMatchObject({
			code: 'SCOPE_RETRACTED',
			operationId: 'retracted',
			reverted: true,
		})
	})

	test('a write re-authored under a new id before upload is still tracked', async () => {
		const events = new SimpleEventEmitter()
		const controller = createMutationController({
			mutationFn: () => localWrite('old-id'),
			events,
		})

		await controller.mutateAsync()
		events.emit({
			type: 'sync:operations-rewritten',
			reason: 'clock-rebase',
			idMapping: { 'old-id': 'new-id' },
		})
		refuse(events, 'new-id')

		expect(controller.getSnapshot().rejected).toMatchObject({
			operationId: 'new-id',
			operationIds: ['new-id'],
		})
	})

	test('after destroy (unmount) nothing is reported and listeners are removed', async () => {
		const events = new SimpleEventEmitter()
		const onRejected = vi.fn()
		const controller = createMutationController({
			mutationFn: () => localWrite('gone'),
			options: { onRejected },
			events,
		})

		await controller.mutateAsync()
		controller.destroy()
		refuse(events, 'gone')

		expect(onRejected).not.toHaveBeenCalled()
		expect(events.listenerCount('sync:operation-rejected')).toBe(0)
		expect(events.listenerCount('sync:operations-acknowledged')).toBe(0)
	})

	test('reset clears rejected', async () => {
		const events = new SimpleEventEmitter()
		const controller = createMutationController({
			mutationFn: () => localWrite('r'),
			events,
		})
		await controller.mutateAsync()
		refuse(events, 'r')
		expect(controller.getSnapshot().rejected).not.toBeNull()

		controller.reset()
		expect(controller.getSnapshot().rejected).toBeNull()
	})

	test('tracking is bounded: the oldest unsynced write is evicted first', async () => {
		const events = new SimpleEventEmitter()
		const onRejected = vi.fn()
		const controller = createMutationController({
			mutationFn: (id: string) => localWrite(id),
			options: { onRejected },
			events,
		})

		for (let i = 0; i <= MAX_TRACKED_WRITES; i++) await controller.mutateAsync(`w${i}`)
		refuse(events, 'w0')
		expect(onRejected).not.toHaveBeenCalled()
		refuse(events, `w${MAX_TRACKED_WRITES}`)
		expect(onRejected).toHaveBeenCalledTimes(1)
	})

	test('a write started after the first await of the function is not attributed', async () => {
		const events = new SimpleEventEmitter()
		const onRejected = vi.fn()
		const controller = createMutationController({
			mutationFn: async () => {
				await Promise.resolve()
				return localWrite('late')
			},
			options: { onRejected },
			events,
		})

		await controller.mutateAsync()
		refuse(events, 'late')
		expect(onRejected).not.toHaveBeenCalled()
	})

	test('without events nothing is tracked and the mutation still runs', async () => {
		const controller = createMutationController({ mutationFn: () => localWrite('x') })
		await expect(controller.mutateAsync()).resolves.toBe('x')
		expect(controller.getSnapshot().rejected).toBeNull()
	})
})
