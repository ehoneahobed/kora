import type { KoraEventType } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { createSampleEvent, createTimestampedEvent } from '../../tests/fixtures/test-helpers'
import { filterEvents, getEventCategory } from './event-filter'

describe('getEventCategory', () => {
	test('maps all 15 event types to correct categories', () => {
		const expected: Record<KoraEventType, string> = {
			'operation:created': 'operation',
			'operation:applied': 'operation',
			'merge:started': 'merge',
			'merge:completed': 'merge',
			'merge:conflict': 'merge',
			'constraint:violated': 'merge',
			'sync:connected': 'sync',
			'sync:disconnected': 'sync',
			'sync:sent': 'sync',
			'sync:received': 'sync',
			'sync:acknowledged': 'sync',
			'query:subscribed': 'query',
			'query:invalidated': 'query',
			'query:executed': 'query',
			'connection:quality': 'connection',
		}

		for (const [type, category] of Object.entries(expected)) {
			expect(getEventCategory(type as KoraEventType)).toBe(category)
		}
	})
})

describe('filterEvents', () => {
	const events = [
		createTimestampedEvent(1, createSampleEvent('operation:created'), 1000),
		createTimestampedEvent(2, createSampleEvent('sync:connected'), 2000),
		createTimestampedEvent(3, createSampleEvent('merge:conflict'), 3000),
		createTimestampedEvent(4, createSampleEvent('query:executed'), 4000),
		createTimestampedEvent(5, createSampleEvent('connection:quality'), 5000),
		createTimestampedEvent(6, createSampleEvent('operation:applied'), 6000),
		createTimestampedEvent(7, createSampleEvent('constraint:violated'), 7000),
	]

	test('returns all events when no criteria specified', () => {
		const result = filterEvents(events, {})
		expect(result).toHaveLength(7)
	})

	test('filters by single category', () => {
		const result = filterEvents(events, { categories: ['operation'] })
		expect(result).toHaveLength(2)
		expect(result.map((e) => e.event.type)).toEqual(['operation:created', 'operation:applied'])
	})

	test('filters by multiple categories', () => {
		const result = filterEvents(events, { categories: ['operation', 'sync'] })
		expect(result).toHaveLength(3)
		expect(result.map((e) => e.event.type)).toEqual([
			'operation:created',
			'sync:connected',
			'operation:applied',
		])
	})

	test('filters by specific event types', () => {
		const result = filterEvents(events, {
			types: ['merge:conflict', 'constraint:violated'],
		})
		expect(result).toHaveLength(2)
		expect(result.map((e) => e.id)).toEqual([3, 7])
	})

	test('filters by time range', () => {
		const result = filterEvents(events, {
			timeRange: { start: 2000, end: 5000 },
		})
		expect(result).toHaveLength(4)
		expect(result.map((e) => e.id)).toEqual([2, 3, 4, 5])
	})

	test('filters by collection name', () => {
		// All sample events use 'todos' collection by default
		const result = filterEvents(events, { collection: 'todos' })
		// operation:created, sync:connected (no collection), merge:conflict (has trace),
		// query:executed (no collection), connection:quality (no collection), operation:applied, constraint:violated
		// Events with collections: operation:created, merge:conflict, operation:applied, constraint:violated
		expect(result.length).toBeGreaterThan(0)
		// Events without collection info won't match
		const noMatch = filterEvents(events, { collection: 'nonexistent' })
		expect(noMatch).toHaveLength(0)
	})

	test('combines multiple criteria with AND logic', () => {
		const result = filterEvents(events, {
			categories: ['merge'],
			timeRange: { start: 1000, end: 5000 },
		})
		// Only merge events within the time range: merge:conflict at 3000
		expect(result).toHaveLength(1)
		expect(result[0]?.event.type).toBe('merge:conflict')
	})
})
