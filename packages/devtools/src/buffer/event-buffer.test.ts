import { describe, expect, test } from 'vitest'
import { createSampleEvent, createTimestampedEvent } from '../../tests/fixtures/test-helpers'
import { EventBuffer } from './event-buffer'

function makeEvent(id: number): ReturnType<typeof createTimestampedEvent> {
	return createTimestampedEvent(id, createSampleEvent('operation:created'))
}

describe('EventBuffer', () => {
	test('push and retrieve events', () => {
		const buffer = new EventBuffer(100)
		const event = makeEvent(1)
		buffer.push(event)

		const all = buffer.getAll()
		expect(all).toHaveLength(1)
		expect(all[0]).toBe(event)
	})

	test('respects capacity limit', () => {
		const buffer = new EventBuffer(3)
		for (let i = 1; i <= 5; i++) {
			buffer.push(makeEvent(i))
		}

		expect(buffer.size).toBe(3)
		expect(buffer.capacity).toBe(3)
	})

	test('evicts oldest events when full', () => {
		const buffer = new EventBuffer(3)
		for (let i = 1; i <= 5; i++) {
			buffer.push(makeEvent(i))
		}

		const all = buffer.getAll()
		expect(all).toHaveLength(3)
		// Oldest (1, 2) should be evicted; 3, 4, 5 remain
		expect(all.map((e) => e.id)).toEqual([3, 4, 5])
	})

	test('getAll returns events in insertion order', () => {
		const buffer = new EventBuffer(100)
		for (let i = 1; i <= 5; i++) {
			buffer.push(makeEvent(i))
		}

		const ids = buffer.getAll().map((e) => e.id)
		expect(ids).toEqual([1, 2, 3, 4, 5])
	})

	test('getRange returns correct subset by ID', () => {
		const buffer = new EventBuffer(100)
		for (let i = 1; i <= 10; i++) {
			buffer.push(makeEvent(i))
		}

		const range = buffer.getRange(3, 7)
		expect(range.map((e) => e.id)).toEqual([3, 4, 5, 6, 7])
	})

	test('getByType filters events by event type', () => {
		const buffer = new EventBuffer(100)
		buffer.push(createTimestampedEvent(1, createSampleEvent('operation:created')))
		buffer.push(createTimestampedEvent(2, createSampleEvent('sync:connected')))
		buffer.push(createTimestampedEvent(3, createSampleEvent('operation:applied')))
		buffer.push(createTimestampedEvent(4, createSampleEvent('sync:connected')))

		const syncEvents = buffer.getByType('sync:connected')
		expect(syncEvents).toHaveLength(2)
		expect(syncEvents.map((e) => e.id)).toEqual([2, 4])
	})

	test('clear empties the buffer', () => {
		const buffer = new EventBuffer(100)
		for (let i = 1; i <= 5; i++) {
			buffer.push(makeEvent(i))
		}

		buffer.clear()
		expect(buffer.size).toBe(0)
		expect(buffer.getAll()).toHaveLength(0)
	})

	test('size tracks correctly through push and wrap', () => {
		const buffer = new EventBuffer(3)
		expect(buffer.size).toBe(0)

		buffer.push(makeEvent(1))
		expect(buffer.size).toBe(1)

		buffer.push(makeEvent(2))
		buffer.push(makeEvent(3))
		expect(buffer.size).toBe(3)

		// Wrap around — size stays at capacity
		buffer.push(makeEvent(4))
		expect(buffer.size).toBe(3)
	})

	test('throws if capacity is less than 1', () => {
		expect(() => new EventBuffer(0)).toThrow('capacity must be at least 1')
		expect(() => new EventBuffer(-5)).toThrow('capacity must be at least 1')
	})
})
