import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createSampleEvent, createTimestampedEvent } from '../../tests/fixtures/test-helpers'
import { MessageBridge } from './message-bridge'

/**
 * These tests run in Node where `window` is not available.
 * We mock the global window object for browser-like tests
 * and test no-op behavior for the non-browser case separately.
 */

describe('MessageBridge', () => {
	describe('with mocked window', () => {
		let messageListeners: Array<(event: MessageEvent) => void>
		let postedMessages: Array<{ data: unknown; origin: string }>

		beforeEach(() => {
			messageListeners = []
			postedMessages = []

			// Mock window with addEventListener, removeEventListener, postMessage
			const win = {
				addEventListener: vi.fn((type: string, handler: (event: MessageEvent) => void) => {
					if (type === 'message') {
						messageListeners.push(handler)
					}
				}),
				removeEventListener: vi.fn((type: string, handler: (event: MessageEvent) => void) => {
					if (type === 'message') {
						messageListeners = messageListeners.filter((h) => h !== handler)
					}
				}),
				postMessage: vi.fn((data: unknown, _origin: string) => {
					postedMessages.push({ data, origin: _origin })
					// Simulate synchronous dispatch to listeners
					for (const listener of messageListeners) {
						listener({ data } as MessageEvent)
					}
				}),
			}

			vi.stubGlobal('window', win)
		})

		afterEach(() => {
			vi.unstubAllGlobals()
		})

		test('send posts message with correct source', () => {
			const bridge = new MessageBridge('test-channel')
			const event = createTimestampedEvent(1, createSampleEvent('operation:created'))

			bridge.send(event)

			expect(postedMessages).toHaveLength(1)
			const posted = postedMessages[0]?.data as { source: string; payload: unknown }
			expect(posted.source).toBe('test-channel')
			expect(posted.payload).toBe(event)

			bridge.destroy()
		})

		test('onReceive receives events matching the channel name', () => {
			const bridge = new MessageBridge('test-channel')
			const received: unknown[] = []
			bridge.onReceive((event) => received.push(event))

			const event = createTimestampedEvent(1, createSampleEvent('sync:connected'))
			bridge.send(event)

			expect(received).toHaveLength(1)
			expect(received[0]).toBe(event)

			bridge.destroy()
		})

		test('ignores messages from other sources', () => {
			const bridge = new MessageBridge('test-channel')
			const received: unknown[] = []
			bridge.onReceive((event) => received.push(event))

			// Simulate a message from a different source
			for (const listener of messageListeners) {
				listener({
					data: { source: 'other-source', payload: { id: 99 } },
				} as MessageEvent)
			}

			expect(received).toHaveLength(0)

			bridge.destroy()
		})

		test('unsubscribe stops receiving events', () => {
			const bridge = new MessageBridge('test-channel')
			const received: unknown[] = []
			const unsub = bridge.onReceive((event) => received.push(event))

			const event1 = createTimestampedEvent(1, createSampleEvent('operation:created'))
			bridge.send(event1)
			expect(received).toHaveLength(1)

			unsub()

			const event2 = createTimestampedEvent(2, createSampleEvent('operation:created'))
			bridge.send(event2)
			expect(received).toHaveLength(1)

			bridge.destroy()
		})

		test('destroy cleans up all listeners', () => {
			const bridge = new MessageBridge('test-channel')
			const received: unknown[] = []
			bridge.onReceive((event) => received.push(event))

			bridge.destroy()

			// Listeners removed from window
			expect(messageListeners).toHaveLength(0)

			// Further sends are no-ops
			const event = createTimestampedEvent(1, createSampleEvent('operation:created'))
			bridge.send(event)
			expect(postedMessages).toHaveLength(0)
			expect(received).toHaveLength(0)
		})
	})

	describe('without window (non-browser)', () => {
		test('operations are no-ops when window is undefined', () => {
			// In Node test env, window is not defined by default unless we stub it.
			// Remove any stub to ensure window is undefined.
			vi.unstubAllGlobals()

			const bridge = new MessageBridge('test-channel')
			const event = createTimestampedEvent(1, createSampleEvent('operation:created'))

			// Should not throw
			bridge.send(event)

			const received: unknown[] = []
			const unsub = bridge.onReceive((e) => received.push(e))
			expect(received).toHaveLength(0)
			unsub()

			bridge.destroy()
		})
	})
})
