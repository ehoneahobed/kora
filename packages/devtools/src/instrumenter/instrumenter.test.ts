import type { KoraEventType } from '@kora/core'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMockEmitter, createSampleEvent } from '../../tests/fixtures/test-helpers'
import { Instrumenter } from './instrumenter'

describe('Instrumenter', () => {
	let emitter: ReturnType<typeof createMockEmitter>

	beforeEach(() => {
		emitter = createMockEmitter()
		vi.useFakeTimers()
		vi.setSystemTime(5000)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	test('records events from emitter into buffer', () => {
		const inst = new Instrumenter(emitter, { bridgeEnabled: false })

		emitter.emit(createSampleEvent('operation:created'))
		emitter.emit(createSampleEvent('sync:connected'))

		const all = inst.getBuffer().getAll()
		expect(all).toHaveLength(2)
		expect(all[0]?.event.type).toBe('operation:created')
		expect(all[1]?.event.type).toBe('sync:connected')

		inst.destroy()
	})

	test('assigns sequential IDs to events', () => {
		const inst = new Instrumenter(emitter, { bridgeEnabled: false })

		emitter.emit(createSampleEvent('operation:created'))
		emitter.emit(createSampleEvent('operation:applied'))
		emitter.emit(createSampleEvent('merge:started'))

		const ids = inst
			.getBuffer()
			.getAll()
			.map((e) => e.id)
		expect(ids).toEqual([1, 2, 3])

		inst.destroy()
	})

	test('timestamps events with receivedAt', () => {
		const inst = new Instrumenter(emitter, { bridgeEnabled: false })

		vi.setSystemTime(10_000)
		emitter.emit(createSampleEvent('operation:created'))

		vi.setSystemTime(20_000)
		emitter.emit(createSampleEvent('sync:connected'))

		const all = inst.getBuffer().getAll()
		expect(all[0]?.receivedAt).toBe(10_000)
		expect(all[1]?.receivedAt).toBe(20_000)

		inst.destroy()
	})

	test('forwards events to bridge when enabled', () => {
		// Stub window so MessageBridge is active
		vi.stubGlobal('window', {
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			postMessage: vi.fn(),
		})

		const inst = new Instrumenter(emitter, { bridgeEnabled: true, channelName: 'test' })
		expect(inst.getBridge()).not.toBeNull()

		emitter.emit(createSampleEvent('operation:created'))

		// postMessage should have been called
		expect(window.postMessage).toHaveBeenCalledTimes(1)
		const callArgs = vi.mocked(window.postMessage).mock.calls[0]
		expect((callArgs?.[0] as { source: string } | undefined)?.source).toBe('test')

		inst.destroy()
		vi.unstubAllGlobals()
	})

	test('does not forward when bridge is disabled', () => {
		const inst = new Instrumenter(emitter, { bridgeEnabled: false })
		expect(inst.getBridge()).toBeNull()

		emitter.emit(createSampleEvent('operation:created'))

		// Events are still in the buffer
		expect(inst.getBuffer().size).toBe(1)

		inst.destroy()
	})

	test('pause stops recording', () => {
		const inst = new Instrumenter(emitter, { bridgeEnabled: false })

		emitter.emit(createSampleEvent('operation:created'))
		expect(inst.getBuffer().size).toBe(1)

		inst.pause()
		expect(inst.isPaused()).toBe(true)

		emitter.emit(createSampleEvent('sync:connected'))
		emitter.emit(createSampleEvent('merge:started'))
		expect(inst.getBuffer().size).toBe(1)

		inst.destroy()
	})

	test('resume restarts recording', () => {
		const inst = new Instrumenter(emitter, { bridgeEnabled: false })

		inst.pause()
		emitter.emit(createSampleEvent('operation:created'))
		expect(inst.getBuffer().size).toBe(0)

		inst.resume()
		expect(inst.isPaused()).toBe(false)

		emitter.emit(createSampleEvent('sync:connected'))
		expect(inst.getBuffer().size).toBe(1)

		inst.destroy()
	})

	test('destroy removes all listeners from emitter', () => {
		const inst = new Instrumenter(emitter, { bridgeEnabled: false })

		// Should have registered 15 listeners (one per event type)
		expect(emitter.totalListenerCount()).toBe(15)

		inst.destroy()

		expect(emitter.totalListenerCount()).toBe(0)

		// Events after destroy are not recorded
		emitter.emit(createSampleEvent('operation:created'))
		expect(inst.getBuffer().size).toBe(0)
	})

	test('respects buffer size config', () => {
		const inst = new Instrumenter(emitter, { bridgeEnabled: false, bufferSize: 3 })

		for (let i = 0; i < 5; i++) {
			emitter.emit(createSampleEvent('operation:created'))
		}

		expect(inst.getBuffer().size).toBe(3)
		expect(inst.getBuffer().capacity).toBe(3)

		inst.destroy()
	})

	test('handles all 15 event types', () => {
		const inst = new Instrumenter(emitter, { bridgeEnabled: false })

		const allTypes: KoraEventType[] = [
			'operation:created',
			'operation:applied',
			'merge:started',
			'merge:completed',
			'merge:conflict',
			'constraint:violated',
			'sync:connected',
			'sync:disconnected',
			'sync:sent',
			'sync:received',
			'sync:acknowledged',
			'query:subscribed',
			'query:invalidated',
			'query:executed',
			'connection:quality',
		]

		for (const type of allTypes) {
			emitter.emit(createSampleEvent(type))
		}

		expect(inst.getBuffer().size).toBe(15)

		const recordedTypes = inst
			.getBuffer()
			.getAll()
			.map((e) => e.event.type)
		expect(recordedTypes).toEqual(allTypes)

		inst.destroy()
	})
})
