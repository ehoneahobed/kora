import { describe, expect, test, vi } from 'vitest'
import type { Operation } from '../types'
import { SimpleEventEmitter } from './event-emitter'

const fakeOperation: Operation = {
	id: 'op-1',
	nodeId: 'node-1',
	type: 'insert',
	collection: 'todos',
	recordId: 'rec-1',
	data: { title: 'Test' },
	previousData: null,
	timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-1' },
	sequenceNumber: 1,
	causalDeps: [],
	schemaVersion: 1,
}

describe('SimpleEventEmitter', () => {
	test('calls listener when event is emitted', () => {
		const emitter = new SimpleEventEmitter()
		const listener = vi.fn()
		emitter.on('operation:created', listener)

		const event = { type: 'operation:created' as const, operation: fakeOperation }
		emitter.emit(event)

		expect(listener).toHaveBeenCalledOnce()
		expect(listener).toHaveBeenCalledWith(event)
	})

	test('does not call listener for other event types', () => {
		const emitter = new SimpleEventEmitter()
		const listener = vi.fn()
		emitter.on('operation:created', listener)

		emitter.emit({ type: 'sync:connected', nodeId: 'node-1' })

		expect(listener).not.toHaveBeenCalled()
	})

	test('supports multiple listeners for the same event type', () => {
		const emitter = new SimpleEventEmitter()
		const listener1 = vi.fn()
		const listener2 = vi.fn()
		emitter.on('operation:created', listener1)
		emitter.on('operation:created', listener2)

		emitter.emit({ type: 'operation:created', operation: fakeOperation })

		expect(listener1).toHaveBeenCalledOnce()
		expect(listener2).toHaveBeenCalledOnce()
	})

	test('on() returns unsubscribe function', () => {
		const emitter = new SimpleEventEmitter()
		const listener = vi.fn()
		const unsub = emitter.on('operation:created', listener)

		unsub()
		emitter.emit({ type: 'operation:created', operation: fakeOperation })

		expect(listener).not.toHaveBeenCalled()
	})

	test('off() removes a specific listener', () => {
		const emitter = new SimpleEventEmitter()
		const listener1 = vi.fn()
		const listener2 = vi.fn()
		emitter.on('operation:created', listener1)
		emitter.on('operation:created', listener2)

		emitter.off('operation:created', listener1)
		emitter.emit({ type: 'operation:created', operation: fakeOperation })

		expect(listener1).not.toHaveBeenCalled()
		expect(listener2).toHaveBeenCalledOnce()
	})

	test('off() is safe to call with unregistered listener', () => {
		const emitter = new SimpleEventEmitter()
		const listener = vi.fn()

		// Should not throw
		emitter.off('operation:created', listener)
	})

	test('clear() removes all listeners', () => {
		const emitter = new SimpleEventEmitter()
		const listener1 = vi.fn()
		const listener2 = vi.fn()
		emitter.on('operation:created', listener1)
		emitter.on('sync:connected', listener2)

		emitter.clear()
		emitter.emit({ type: 'operation:created', operation: fakeOperation })
		emitter.emit({ type: 'sync:connected', nodeId: 'node-1' })

		expect(listener1).not.toHaveBeenCalled()
		expect(listener2).not.toHaveBeenCalled()
	})

	test('listenerCount() returns correct count', () => {
		const emitter = new SimpleEventEmitter()
		expect(emitter.listenerCount('operation:created')).toBe(0)

		const unsub1 = emitter.on('operation:created', vi.fn())
		expect(emitter.listenerCount('operation:created')).toBe(1)

		emitter.on('operation:created', vi.fn())
		expect(emitter.listenerCount('operation:created')).toBe(2)

		unsub1()
		expect(emitter.listenerCount('operation:created')).toBe(1)
	})

	test('emit does nothing when no listeners registered', () => {
		const emitter = new SimpleEventEmitter()
		// Should not throw
		emitter.emit({ type: 'operation:created', operation: fakeOperation })
	})

	test('onAny hears every event type after the typed listeners, until removed', () => {
		const emitter = new SimpleEventEmitter()
		const order: string[] = []
		emitter.on('operation:created', () => order.push('typed'))
		const stop = emitter.onAny((event) => order.push(`any:${event.type}`))

		emitter.emit({ type: 'operation:created', operation: fakeOperation })
		emitter.emit({ type: 'sync:connected', nodeId: 'n' })
		expect(order).toEqual(['typed', 'any:operation:created', 'any:sync:connected'])

		stop()
		emitter.emit({ type: 'sync:connected', nodeId: 'n' })
		expect(order).toHaveLength(3)
	})

	test('clear removes onAny listeners too', () => {
		const emitter = new SimpleEventEmitter()
		const listener = vi.fn()
		emitter.onAny(listener)
		emitter.clear()
		emitter.emit({ type: 'sync:connected', nodeId: 'n' })
		expect(listener).not.toHaveBeenCalled()
	})
})
