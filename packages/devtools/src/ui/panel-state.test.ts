import type { KoraEvent, Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import type { TimestampedEvent } from '../types'
import { buildPanelModel } from './panel-state'

function makeSampleOperation(overrides?: Partial<Operation>): Operation {
	return {
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
		...overrides,
	}
}

function makeOperationEvent(type: 'operation:created' | 'operation:applied'): KoraEvent {
	return {
		type,
		operation: makeSampleOperation(),
		...(type === 'operation:applied' ? { duration: 2 } : {}),
	} as KoraEvent
}

describe('buildPanelModel', () => {
	test('builds timeline, operations, conflicts, and network state', () => {
		const traceOperation = makeSampleOperation({
			id: 'op-2',
			nodeId: 'node-b',
			data: { title: 'Remote' },
			previousData: { title: 'Hello' },
			timestamp: { wallTime: 2, logical: 0, nodeId: 'node-b' },
			sequenceNumber: 2,
			causalDeps: ['op-1'],
		})

		const events: TimestampedEvent[] = [
			{ id: 1, receivedAt: 1000, event: { type: 'sync:connected', nodeId: 'node-a' } },
			{ id: 2, receivedAt: 1100, event: makeOperationEvent('operation:created') },
			{
				id: 3,
				receivedAt: 1200,
				event: { type: 'sync:sent', operations: [traceOperation], batchSize: 1 },
			},
			{ id: 4, receivedAt: 1300, event: { type: 'sync:acknowledged', sequenceNumber: 3 } },
			{
				id: 5,
				receivedAt: 1400,
				event: {
					type: 'merge:conflict',
					trace: {
						operationA: makeSampleOperation(),
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

describe('instant-updates rows', () => {
	test('a transaction is one row for all of its writes (S6a)', () => {
		const events: TimestampedEvent[] = [
			{
				id: 1,
				receivedAt: 10,
				event: {
					type: 'store:write-pending',
					writeId: 'w1',
					collection: 'todos',
					collections: ['todos', 'lists'],
					recordIds: ['a', 'b', 'c'],
					kind: 'transaction',
					predicted: true,
				},
			},
			{
				id: 2,
				receivedAt: 40,
				event: {
					type: 'store:write-settled',
					writeId: 'w1',
					collection: 'todos',
					collections: ['todos', 'lists'],
					outcome: 'rolled-back',
					pendingMs: 30,
				},
			},
			{
				id: 3,
				receivedAt: 50,
				event: {
					type: 'store:write-pending',
					writeId: 'w2',
					collection: 'todos',
					collections: ['todos'],
					recordIds: ['d'],
					kind: 'transaction',
					predicted: false,
					reason: 'atomic-op',
				},
			},
			{
				id: 4,
				receivedAt: 60,
				event: {
					type: 'store:write-settled',
					writeId: 'w3',
					collection: 'todos',
					outcome: 'committed',
					pendingMs: 2,
				},
			},
		]
		const labels = buildPanelModel(events).timeline.map((row) => row.label)
		expect(labels).toEqual([
			'write shown before commit: transaction todos, lists (3)',
			'transaction rolled-back: todos, lists after 30ms pending',
			'write not shown early: transaction todos (atomic-op)',
			'write committed: todos after 2ms pending',
		])
	})
})
