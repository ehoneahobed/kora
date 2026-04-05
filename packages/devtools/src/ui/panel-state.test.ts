import type { KoraEvent } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import type { TimestampedEvent } from '../types'
import { buildPanelModel } from './panel-state'

function makeOperationEvent(type: 'operation:created' | 'operation:applied'): KoraEvent {
	return {
		type,
		operation: {
			id: 'op-1',
			nodeId: 'node-a',
			type: 'update',
			collection: 'todos',
			recordId: 'rec-1',
			data: { title: 'Hello' },
			previousData: { title: 'Old' },
			timestamp: { wallTime: 1, logical: 0, nodeId: 'node-a' },
			sequenceNumber: 3,
			causalDeps: ['op-0'],
			schemaVersion: 1,
		},
		...(type === 'operation:applied' ? { duration: 2 } : {}),
	} as KoraEvent
}

describe('buildPanelModel', () => {
	test('builds timeline, operations, conflicts, and network state', () => {
		const traceOperation = {
			id: 'op-2',
			nodeId: 'node-b',
			type: 'update' as const,
			collection: 'todos',
			recordId: 'rec-1',
			data: { title: 'Remote' },
			previousData: { title: 'Hello' },
			timestamp: { wallTime: 2, logical: 0, nodeId: 'node-b' },
			sequenceNumber: 2,
			causalDeps: ['op-1'],
			schemaVersion: 1,
		}

		const events: TimestampedEvent[] = [
			{ id: 1, receivedAt: 1000, event: { type: 'sync:connected', nodeId: 'node-a' } },
			{ id: 2, receivedAt: 1100, event: makeOperationEvent('operation:created') },
			{ id: 3, receivedAt: 1200, event: { type: 'sync:sent', operations: [traceOperation], batchSize: 1 } },
			{ id: 4, receivedAt: 1300, event: { type: 'sync:acknowledged', sequenceNumber: 3 } },
			{
				id: 5,
				receivedAt: 1400,
				event: {
					type: 'merge:conflict',
					trace: {
						operationA: makeOperationEvent('operation:created').operation,
						operationB: traceOperation,
						field: 'title',
						strategy: 'crdt-text',
						inputA: 'A',
						inputB: 'B',
						base: 'base',
						output: 'AB',
						tier: 1,
						constraintViolated: null,
						duration: 7,
					},
				},
			},
		]

		const model = buildPanelModel(events)

		expect(model.timeline).toHaveLength(5)
		expect(model.operations).toHaveLength(1)
		expect(model.operations[0]?.causalDeps).toEqual(['op-0'])
		expect(model.conflicts).toHaveLength(1)
		expect(model.conflicts[0]?.strategy).toBe('crdt-text')
		expect(model.network.connected).toBe(true)
		expect(model.network.pendingAcks).toBe(0)
		expect(model.network.sentOps).toBe(1)
		expect(model.network.versionVector).toEqual([{ nodeId: 'node-a', sequenceNumber: 3 }])
	})
})
