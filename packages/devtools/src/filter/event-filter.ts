import type { KoraEventType } from '@kora/core'
import type { EventCategory, EventFilterCriteria, TimestampedEvent } from '../types'
import { eventTypeToCategory } from '../types'

/**
 * Maps a KoraEventType to its EventCategory.
 * Re-exported from types for public API convenience.
 */
export function getEventCategory(type: KoraEventType): EventCategory {
	return eventTypeToCategory(type)
}

/**
 * Extracts the collection name from an event, if present.
 * Only operation events and query:subscribed carry a collection field directly.
 * For other event types that embed operations, we inspect the nested operation.
 */
function extractCollection(event: TimestampedEvent): string | null {
	const e = event.event
	switch (e.type) {
		case 'operation:created':
		case 'operation:applied':
			return e.operation.collection
		case 'merge:started':
			return e.operationA.collection
		case 'merge:completed':
		case 'merge:conflict':
			return e.trace.operationA.collection
		case 'constraint:violated':
			return e.trace.operationA.collection
		case 'query:subscribed':
			return e.collection
		case 'query:invalidated':
			return e.trigger.collection
		case 'sync:sent':
			return e.operations[0]?.collection ?? null
		case 'sync:received':
			return e.operations[0]?.collection ?? null
		default:
			return null
	}
}

/**
 * Filters a list of timestamped events by the given criteria.
 * All criteria are combined with AND logic: an event must match all specified criteria.
 * Returns all events if no criteria are specified.
 */
export function filterEvents(
	events: readonly TimestampedEvent[],
	criteria: EventFilterCriteria,
): readonly TimestampedEvent[] {
	const { categories, types, timeRange, collection } = criteria

	// Fast path: no filters
	if (!categories && !types && !timeRange && !collection) {
		return events
	}

	// Pre-compute the set of allowed types from categories for efficient lookup
	const categorySet = categories ? new Set<EventCategory>(categories) : null
	const typeSet = types ? new Set<KoraEventType>(types) : null

	return events.filter((event) => {
		// Category filter
		if (categorySet) {
			const cat = eventTypeToCategory(event.event.type)
			if (!categorySet.has(cat)) return false
		}

		// Specific type filter
		if (typeSet) {
			if (!typeSet.has(event.event.type)) return false
		}

		// Time range filter (on receivedAt)
		if (timeRange) {
			if (event.receivedAt < timeRange.start || event.receivedAt > timeRange.end) {
				return false
			}
		}

		// Collection filter
		if (collection) {
			const eventCollection = extractCollection(event)
			if (eventCollection !== collection) return false
		}

		return true
	})
}
