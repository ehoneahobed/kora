import type { KoraEvent, KoraEventType } from '@kora/core'

/** A KoraEvent wrapped with a reception timestamp and sequential ID */
export interface TimestampedEvent {
	/** Auto-incrementing sequential ID */
	id: number
	/** The original framework event */
	event: KoraEvent
	/** Date.now() when the instrumenter captured the event */
	receivedAt: number
}

/** Event categories for filtering and grouping */
export type EventCategory = 'operation' | 'merge' | 'sync' | 'query' | 'connection'

/** Maps each KoraEventType to its category */
const EVENT_TYPE_CATEGORIES: Record<KoraEventType, EventCategory> = {
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

/** Look up the category for a given event type */
export function eventTypeToCategory(type: KoraEventType): EventCategory {
	return EVENT_TYPE_CATEGORIES[type]
}

/** All event categories */
export const EVENT_CATEGORIES = ['operation', 'merge', 'sync', 'query', 'connection'] as const

/** Configuration for the Instrumenter */
export interface DevtoolsConfig {
	/** Max events in the ring buffer (default: 10000) */
	bufferSize?: number
	/** Enable message bridge for DevTools panel communication (default: true) */
	bridgeEnabled?: boolean
	/** Custom message channel name (default: 'kora-devtools') */
	channelName?: string
}

/** Filter criteria for querying events */
export interface EventFilterCriteria {
	/** Filter by event categories */
	categories?: EventCategory[]
	/** Filter by specific event types */
	types?: KoraEventType[]
	/** Filter by reception time range */
	timeRange?: { start: number; end: number }
	/** Filter by collection name (extracted from operation events) */
	collection?: string
}

/** Aggregated statistics computed from a set of events */
export interface EventStatistics {
	totalEvents: number
	eventsByCategory: Record<EventCategory, number>
	eventsByType: Partial<Record<KoraEventType, number>>
	mergeConflicts: number
	constraintViolations: number
	avgMergeDuration: number | null
	avgQueryDuration: number | null
	syncOperationsSent: number
	syncOperationsReceived: number
}
