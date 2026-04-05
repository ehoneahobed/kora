import type { KoraEventType } from '@korajs/core'
import type { EventCategory, EventStatistics, TimestampedEvent } from '../types'
import { EVENT_CATEGORIES, eventTypeToCategory } from '../types'

/**
 * Computes aggregate statistics from a collection of timestamped events.
 * Processes the event list in a single pass for efficiency.
 */
export function computeStatistics(events: readonly TimestampedEvent[]): EventStatistics {
	const eventsByCategory: Record<EventCategory, number> = {
		operation: 0,
		merge: 0,
		sync: 0,
		query: 0,
		connection: 0,
	}
	const eventsByType: Partial<Record<KoraEventType, number>> = {}

	let mergeConflicts = 0
	let constraintViolations = 0
	let mergeDurationSum = 0
	let mergeDurationCount = 0
	let queryDurationSum = 0
	let queryDurationCount = 0
	let syncOperationsSent = 0
	let syncOperationsReceived = 0

	for (const timestamped of events) {
		const e = timestamped.event

		// Category count
		const category = eventTypeToCategory(e.type)
		eventsByCategory[category]++

		// Type count
		eventsByType[e.type] = (eventsByType[e.type] ?? 0) + 1

		// Type-specific aggregations
		switch (e.type) {
			case 'merge:completed':
				mergeDurationSum += e.trace.duration
				mergeDurationCount++
				break
			case 'merge:conflict':
				mergeConflicts++
				mergeDurationSum += e.trace.duration
				mergeDurationCount++
				break
			case 'constraint:violated':
				constraintViolations++
				break
			case 'query:executed':
				queryDurationSum += e.duration
				queryDurationCount++
				break
			case 'sync:sent':
				syncOperationsSent += e.batchSize
				break
			case 'sync:received':
				syncOperationsReceived += e.batchSize
				break
		}
	}

	return {
		totalEvents: events.length,
		eventsByCategory,
		eventsByType,
		mergeConflicts,
		constraintViolations,
		avgMergeDuration: mergeDurationCount > 0 ? mergeDurationSum / mergeDurationCount : null,
		avgQueryDuration: queryDurationCount > 0 ? queryDurationSum / queryDurationCount : null,
		syncOperationsSent,
		syncOperationsReceived,
	}
}
