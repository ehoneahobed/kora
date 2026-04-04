import { describe, expect, test } from 'vitest'
import {
	createSampleEvent,
	createSampleMergeTrace,
	createTimestampedEvent,
} from '../../tests/fixtures/test-helpers'
import type { TimestampedEvent } from '../types'
import { computeStatistics } from './event-stats'

describe('computeStatistics', () => {
	test('returns zeroed statistics for empty events', () => {
		const stats = computeStatistics([])

		expect(stats.totalEvents).toBe(0)
		expect(stats.eventsByCategory).toEqual({
			operation: 0,
			merge: 0,
			sync: 0,
			query: 0,
			connection: 0,
		})
		expect(stats.eventsByType).toEqual({})
		expect(stats.mergeConflicts).toBe(0)
		expect(stats.constraintViolations).toBe(0)
		expect(stats.avgMergeDuration).toBeNull()
		expect(stats.avgQueryDuration).toBeNull()
		expect(stats.syncOperationsSent).toBe(0)
		expect(stats.syncOperationsReceived).toBe(0)
	})

	test('counts events by category correctly', () => {
		const events: TimestampedEvent[] = [
			createTimestampedEvent(1, createSampleEvent('operation:created')),
			createTimestampedEvent(2, createSampleEvent('operation:applied')),
			createTimestampedEvent(3, createSampleEvent('sync:connected')),
			createTimestampedEvent(4, createSampleEvent('merge:completed')),
			createTimestampedEvent(5, createSampleEvent('query:executed')),
			createTimestampedEvent(6, createSampleEvent('connection:quality')),
		]

		const stats = computeStatistics(events)
		expect(stats.eventsByCategory.operation).toBe(2)
		expect(stats.eventsByCategory.sync).toBe(1)
		expect(stats.eventsByCategory.merge).toBe(1)
		expect(stats.eventsByCategory.query).toBe(1)
		expect(stats.eventsByCategory.connection).toBe(1)
	})

	test('counts events by type correctly', () => {
		const events: TimestampedEvent[] = [
			createTimestampedEvent(1, createSampleEvent('operation:created')),
			createTimestampedEvent(2, createSampleEvent('operation:created')),
			createTimestampedEvent(3, createSampleEvent('sync:connected')),
		]

		const stats = computeStatistics(events)
		expect(stats.eventsByType['operation:created']).toBe(2)
		expect(stats.eventsByType['sync:connected']).toBe(1)
		expect(stats.eventsByType['merge:completed']).toBeUndefined()
	})

	test('tracks merge conflicts', () => {
		const events: TimestampedEvent[] = [
			createTimestampedEvent(1, createSampleEvent('merge:conflict')),
			createTimestampedEvent(2, createSampleEvent('merge:conflict')),
			createTimestampedEvent(3, createSampleEvent('merge:completed')),
		]

		const stats = computeStatistics(events)
		expect(stats.mergeConflicts).toBe(2)
	})

	test('tracks constraint violations', () => {
		const events: TimestampedEvent[] = [
			createTimestampedEvent(1, createSampleEvent('constraint:violated')),
			createTimestampedEvent(2, createSampleEvent('constraint:violated')),
			createTimestampedEvent(3, createSampleEvent('operation:created')),
		]

		const stats = computeStatistics(events)
		expect(stats.constraintViolations).toBe(2)
	})

	test('computes average merge duration', () => {
		const events: TimestampedEvent[] = [
			createTimestampedEvent(1, {
				type: 'merge:completed',
				trace: createSampleMergeTrace({ duration: 2.0 }),
			}),
			createTimestampedEvent(2, {
				type: 'merge:completed',
				trace: createSampleMergeTrace({ duration: 4.0 }),
			}),
			createTimestampedEvent(3, {
				type: 'merge:conflict',
				trace: createSampleMergeTrace({ duration: 6.0 }),
			}),
		]

		const stats = computeStatistics(events)
		// (2 + 4 + 6) / 3 = 4.0
		expect(stats.avgMergeDuration).toBe(4.0)
	})

	test('computes average query duration', () => {
		const events: TimestampedEvent[] = [
			createTimestampedEvent(1, {
				type: 'query:executed',
				queryId: 'q1',
				duration: 3.0,
				resultCount: 10,
			}),
			createTimestampedEvent(2, {
				type: 'query:executed',
				queryId: 'q2',
				duration: 5.0,
				resultCount: 20,
			}),
		]

		const stats = computeStatistics(events)
		expect(stats.avgQueryDuration).toBe(4.0)
	})

	test('counts sync operations sent and received', () => {
		const events: TimestampedEvent[] = [
			createTimestampedEvent(1, {
				type: 'sync:sent',
				operations: [],
				batchSize: 5,
			}),
			createTimestampedEvent(2, {
				type: 'sync:sent',
				operations: [],
				batchSize: 3,
			}),
			createTimestampedEvent(3, {
				type: 'sync:received',
				operations: [],
				batchSize: 10,
			}),
		]

		const stats = computeStatistics(events)
		expect(stats.syncOperationsSent).toBe(8)
		expect(stats.syncOperationsReceived).toBe(10)
	})
})
