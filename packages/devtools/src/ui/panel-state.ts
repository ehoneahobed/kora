import type { KoraEvent, Operation } from '@kora/core'
import type { TimestampedEvent } from '../types'

export interface TimelineItem {
	id: number
	type: KoraEvent['type']
	label: string
	color: string
	receivedAt: number
	dependsOn: string[]
}

export interface ConflictItem {
	id: number
	timestamp: number
	collection: string
	field: string
	strategy: string
	tier: 1 | 2 | 3
	inputA: unknown
	inputB: unknown
	output: unknown
	constraintViolated: string | null
}

export interface OperationItem {
	id: number
	timestamp: number
	operationId: string
	collection: string
	recordId: string
	opType: Operation['type']
	data: Record<string, unknown> | null
	causalDeps: string[]
	nodeId: string
	sequenceNumber: number
}

export interface NetworkStatusModel {
	connected: boolean
	quality: string | null
	pendingAcks: number
	lastSyncAt: number | null
	sentOps: number
	receivedOps: number
	versionVector: Array<{ nodeId: string; sequenceNumber: number }>
}

export interface DevtoolsPanelModel {
	timeline: TimelineItem[]
	conflicts: ConflictItem[]
	operations: OperationItem[]
	network: NetworkStatusModel
}

export function buildPanelModel(events: readonly TimestampedEvent[]): DevtoolsPanelModel {
	const timeline = events.map((entry) => ({
		id: entry.id,
		type: entry.event.type,
		label: timelineLabel(entry.event),
		color: timelineColor(entry.event.type),
		receivedAt: entry.receivedAt,
		dependsOn: extractCausalDependencies(entry.event),
	}))

	const conflicts = events
		.flatMap((entry) => {
			if (entry.event.type !== 'merge:completed' && entry.event.type !== 'merge:conflict') {
				return []
			}

			const trace = entry.event.trace
			return [
				{
					id: entry.id,
					timestamp: entry.receivedAt,
					collection: trace.operationA.collection,
					field: trace.field,
					strategy: trace.strategy,
					tier: trace.tier,
					inputA: trace.inputA,
					inputB: trace.inputB,
					output: trace.output,
					constraintViolated: trace.constraintViolated,
				},
			]
		})

	const operations = events
		.map((entry) => {
			const operation = extractOperation(entry.event)
			if (!operation) return null

			return {
				id: entry.id,
				timestamp: entry.receivedAt,
				operationId: operation.id,
				collection: operation.collection,
				recordId: operation.recordId,
				opType: operation.type,
				data: operation.data,
				causalDeps: operation.causalDeps,
				nodeId: operation.nodeId,
				sequenceNumber: operation.sequenceNumber,
			}
		})
		.filter((item): item is OperationItem => item !== null)

	const network = buildNetworkStatus(events, operations)

	return {
		timeline,
		conflicts,
		operations,
		network,
	}
}

function buildNetworkStatus(
	events: readonly TimestampedEvent[],
	operations: readonly OperationItem[],
): NetworkStatusModel {
	let connected = false
	let quality: string | null = null
	let pendingAcks = 0
	let lastSyncAt: number | null = null
	let sentOps = 0
	let receivedOps = 0

	for (const entry of events) {
		switch (entry.event.type) {
			case 'sync:connected':
				connected = true
				lastSyncAt = entry.receivedAt
				break
			case 'sync:disconnected':
				connected = false
				break
			case 'connection:quality':
				quality = entry.event.quality
				break
			case 'sync:sent':
				sentOps += entry.event.operations.length
				pendingAcks += entry.event.operations.length
				lastSyncAt = entry.receivedAt
				break
			case 'sync:received':
				receivedOps += entry.event.operations.length
				lastSyncAt = entry.receivedAt
				break
			case 'sync:acknowledged':
				pendingAcks = Math.max(0, pendingAcks - 1)
				lastSyncAt = entry.receivedAt
				break
		}
	}

	const vector = new Map<string, number>()
	for (const operation of operations) {
		const current = vector.get(operation.nodeId) ?? 0
		if (operation.sequenceNumber > current) {
			vector.set(operation.nodeId, operation.sequenceNumber)
		}
	}

	return {
		connected,
		quality,
		pendingAcks,
		lastSyncAt,
		sentOps,
		receivedOps,
		versionVector: [...vector.entries()]
			.map(([nodeId, sequenceNumber]) => ({ nodeId, sequenceNumber }))
			.sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
	}
}

function timelineLabel(event: KoraEvent): string {
	switch (event.type) {
		case 'operation:created':
		case 'operation:applied':
			return `${event.operation.type} ${event.operation.collection}/${event.operation.recordId}`
		case 'merge:started':
			return `merge start ${event.operationA.collection}`
		case 'merge:completed':
			return `merge complete ${event.trace.field}`
		case 'merge:conflict':
			return `merge conflict ${event.trace.field}`
		case 'constraint:violated':
			return `constraint ${event.constraint}`
		case 'sync:connected':
			return `sync connected ${event.nodeId}`
		case 'sync:disconnected':
			return `sync disconnected`
		case 'sync:sent':
			return `sync sent ${event.batchSize}`
		case 'sync:received':
			return `sync received ${event.batchSize}`
		case 'sync:acknowledged':
			return `sync ack ${event.sequenceNumber}`
		case 'query:subscribed':
			return `query subscribed ${event.collection}`
		case 'query:invalidated':
			return `query invalidated ${event.queryId}`
		case 'query:executed':
			return `query executed ${event.queryId}`
		case 'connection:quality':
			return `connection ${event.quality}`
	}
}

function timelineColor(type: KoraEvent['type']): string {
	if (type.startsWith('operation:')) return '#22c55e'
	if (type.startsWith('sync:')) return '#a855f7'
	if (type.startsWith('merge:') || type.startsWith('constraint:')) return '#f59e0b'
	if (type.startsWith('query:')) return '#0ea5e9'
	return '#64748b'
}

function extractCausalDependencies(event: KoraEvent): string[] {
	const operation = extractOperation(event)
	return operation?.causalDeps ?? []
}

function extractOperation(event: KoraEvent): Operation | null {
	switch (event.type) {
		case 'operation:created':
		case 'operation:applied':
			return event.operation
		case 'query:invalidated':
			return event.trigger
		default:
			return null
	}
}
