import type { KoraEventType } from '@korajs/core'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { filterEvents } from '../../src/filter/event-filter'
import { Instrumenter } from '../../src/instrumenter/instrumenter'
import { computeStatistics } from '../../src/stats/event-stats'
import {
	createMockEmitter,
	createSampleEvent,
	createSampleMergeTrace,
} from '../fixtures/test-helpers'

describe('full-flow integration', () => {
	let emitter: ReturnType<typeof createMockEmitter>

	beforeEach(() => {
		emitter = createMockEmitter()
		vi.useFakeTimers()
		vi.setSystemTime(1000)
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	test('instrumenter records events, filter them, compute stats — full pipeline', () => {
		const inst = new Instrumenter(emitter, { bridgeEnabled: false })

		// Emit a variety of events
		vi.setSystemTime(1000)
		emitter.emit(createSampleEvent('operation:created'))

		vi.setSystemTime(2000)
		emitter.emit(createSampleEvent('merge:conflict'))

		vi.setSystemTime(3000)
		emitter.emit(createSampleEvent('query:executed'))

		vi.setSystemTime(4000)
		emitter.emit(createSampleEvent('sync:sent'))

		vi.setSystemTime(5000)
		emitter.emit(createSampleEvent('connection:quality'))

		// Full pipeline: buffer -> filter -> stats
		const all = inst.getBuffer().getAll()
		expect(all).toHaveLength(5)

		// Filter to only merge events
		const mergeEvents = filterEvents(all, { categories: ['merge'] })
		expect(mergeEvents).toHaveLength(1)
		expect(mergeEvents[0]?.event.type).toBe('merge:conflict')

		// Filter by time range
		const midRange = filterEvents(all, { timeRange: { start: 2000, end: 4000 } })
		expect(midRange).toHaveLength(3)

		// Compute stats on all events
		const stats = computeStatistics(all)
		expect(stats.totalEvents).toBe(5)
		expect(stats.mergeConflicts).toBe(1)
		expect(stats.eventsByCategory.operation).toBe(1)
		expect(stats.eventsByCategory.sync).toBe(1)

		inst.destroy()
	})

	test('instrumenter + MessageBridge: events flow through bridge', () => {
		const received: unknown[] = []

		// Mock window for bridge
		vi.stubGlobal('window', {
			addEventListener: vi.fn((_type: string, handler: (e: MessageEvent) => void) => {
				// Store the handler so postMessage can call it
				;(window as unknown as { _handler: typeof handler })._handler = handler
			}),
			removeEventListener: vi.fn(),
			postMessage: vi.fn((data: unknown) => {
				// Simulate synchronous dispatch
				const handler = (window as unknown as { _handler?: (e: MessageEvent) => void })._handler
				if (handler) {
					handler({ data } as MessageEvent)
				}
			}),
		})

		const inst = new Instrumenter(emitter, { bridgeEnabled: true, channelName: 'test' })
		const bridge = inst.getBridge()
		expect(bridge).not.toBeNull()

		bridge?.onReceive((event) => received.push(event))

		emitter.emit(createSampleEvent('operation:created'))

		// Event should have been posted through bridge
		expect(received).toHaveLength(1)
		expect((received[0] as { event: { type: string } }).event.type).toBe('operation:created')

		// And also in the buffer
		expect(inst.getBuffer().size).toBe(1)

		inst.destroy()
	})

	test('buffer eviction under load: 15,000 events into 10,000 buffer', () => {
		const inst = new Instrumenter(emitter, { bridgeEnabled: false, bufferSize: 10_000 })

		for (let i = 0; i < 15_000; i++) {
			emitter.emit(createSampleEvent('operation:created'))
		}

		const buffer = inst.getBuffer()
		expect(buffer.size).toBe(10_000)

		// Oldest events (IDs 1-5000) should be evicted
		const all = buffer.getAll()
		expect(all[0]?.id).toBe(5001)
		expect(all[all.length - 1]?.id).toBe(15_000)

		inst.destroy()
	})

	test('pause/resume: events during pause are not recorded', () => {
		const inst = new Instrumenter(emitter, { bridgeEnabled: false })

		emitter.emit(createSampleEvent('operation:created'))
		expect(inst.getBuffer().size).toBe(1)

		inst.pause()

		// These should be dropped
		emitter.emit(createSampleEvent('sync:connected'))
		emitter.emit(createSampleEvent('merge:started'))
		expect(inst.getBuffer().size).toBe(1)

		inst.resume()

		emitter.emit(createSampleEvent('query:executed'))
		expect(inst.getBuffer().size).toBe(2)

		const types = inst
			.getBuffer()
			.getAll()
			.map((e) => e.event.type)
		expect(types).toEqual(['operation:created', 'query:executed'])

		inst.destroy()
	})

	test('destroy cleans up everything: no listeners remain on emitter', () => {
		const inst = new Instrumenter(emitter, { bridgeEnabled: false })

		expect(emitter.totalListenerCount()).toBe(15)

		inst.destroy()

		expect(emitter.totalListenerCount()).toBe(0)

		// Emitting after destroy does not affect the buffer
		emitter.emit(createSampleEvent('operation:created'))
		expect(inst.getBuffer().size).toBe(0)

		// Double destroy is safe
		inst.destroy()
	})
})
