import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
	createSampleEvent,
	createSampleMergeTrace,
	createSampleOperation,
	createTimestampedEvent,
} from '../../tests/fixtures/test-helpers'
import type { TimestampedEvent } from '../types'
import { formatDuration, formatTime, formatValue, truncate } from './components'
import { buildPanelModel } from './panel-state'
import type { ConflictItem, DevtoolsPanelModel, OperationItem, TimelineItem } from './panel-state'

// ============================================================================
// Components helpers tests
// ============================================================================

describe('formatTime', () => {
	test('formats timestamp to HH:MM:SS.mmm', () => {
		// Use a known timestamp: 2026-01-15T10:30:45.123Z
		const ts = new Date('2026-01-15T10:30:45.123Z').getTime()
		const result = formatTime(ts)
		// Result depends on local timezone, but should match pattern
		expect(result).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/)
	})
})

describe('truncate', () => {
	test('returns string unchanged if under max', () => {
		expect(truncate('hello', 10)).toBe('hello')
	})

	test('truncates with ellipsis', () => {
		expect(truncate('hello world', 8)).toBe('hello w…')
	})

	test('handles exact length', () => {
		expect(truncate('hello', 5)).toBe('hello')
	})
})

describe('formatValue', () => {
	test('formats null', () => {
		expect(formatValue(null)).toBe('null')
	})

	test('formats undefined', () => {
		expect(formatValue(undefined)).toBe('null')
	})

	test('formats strings with quotes', () => {
		expect(formatValue('hello')).toBe('"hello"')
	})

	test('formats numbers', () => {
		expect(formatValue(42)).toBe('42')
	})

	test('formats objects as JSON', () => {
		expect(formatValue({ a: 1 })).toBe('{\n  "a": 1\n}')
	})
})

describe('formatDuration', () => {
	test('formats sub-millisecond as microseconds', () => {
		expect(formatDuration(0.5)).toBe('500µs')
	})

	test('formats milliseconds', () => {
		expect(formatDuration(12.5)).toBe('12.5ms')
	})

	test('formats seconds', () => {
		expect(formatDuration(2500)).toBe('2.50s')
	})
})

// ============================================================================
// Panel model building tests (extended)
// ============================================================================

describe('buildPanelModel extended', () => {
	test('builds timeline from mixed events', () => {
		const events: TimestampedEvent[] = [
			createTimestampedEvent(1, createSampleEvent('operation:created'), 1000),
			createTimestampedEvent(2, createSampleEvent('sync:connected'), 1001),
			createTimestampedEvent(3, createSampleEvent('merge:conflict'), 1002),
			createTimestampedEvent(4, createSampleEvent('query:executed'), 1003),
			createTimestampedEvent(5, createSampleEvent('connection:quality'), 1004),
		]

		const model = buildPanelModel(events)

		expect(model.timeline).toHaveLength(5)
		expect(model.timeline[0]?.type).toBe('operation:created')
		expect(model.timeline[1]?.type).toBe('sync:connected')
	})

	test('extracts conflicts from merge events', () => {
		const events: TimestampedEvent[] = [
			createTimestampedEvent(1, createSampleEvent('merge:completed'), 1000),
			createTimestampedEvent(
				2,
				createSampleEvent('merge:conflict', {
					trace: createSampleMergeTrace({ field: 'title', strategy: 'lww', tier: 1 }),
				}),
				1001,
			),
		]

		const model = buildPanelModel(events)

		expect(model.conflicts).toHaveLength(2)
		expect(model.conflicts[1]?.field).toBe('title')
		expect(model.conflicts[1]?.strategy).toBe('lww')
		expect(model.conflicts[1]?.tier).toBe(1)
	})

	test('extracts operations from operation events', () => {
		const op = createSampleOperation({ id: 'op-1', collection: 'todos', type: 'insert' })
		const events: TimestampedEvent[] = [
			createTimestampedEvent(1, { type: 'operation:created', operation: op }, 1000),
			createTimestampedEvent(2, { type: 'operation:applied', operation: op, duration: 1.5 }, 1001),
		]

		const model = buildPanelModel(events)

		expect(model.operations).toHaveLength(2)
		expect(model.operations[0]?.opType).toBe('insert')
		expect(model.operations[0]?.collection).toBe('todos')
	})

	test('builds network status from sync events', () => {
		const events: TimestampedEvent[] = [
			createTimestampedEvent(1, createSampleEvent('sync:connected'), 1000),
			createTimestampedEvent(2, createSampleEvent('sync:sent'), 1001),
			createTimestampedEvent(3, createSampleEvent('sync:received'), 1002),
			createTimestampedEvent(4, createSampleEvent('sync:acknowledged'), 1003),
			createTimestampedEvent(
				5,
				createSampleEvent('connection:quality', { quality: 'excellent' } as { quality: 'good' }),
				1004,
			),
		]

		const model = buildPanelModel(events)

		expect(model.network.connected).toBe(true)
		expect(model.network.sentOps).toBeGreaterThan(0)
		expect(model.network.receivedOps).toBeGreaterThan(0)
		expect(model.network.lastSyncAt).toBe(1003)
	})

	test('tracks disconnection', () => {
		const events: TimestampedEvent[] = [
			createTimestampedEvent(1, createSampleEvent('sync:connected'), 1000),
			createTimestampedEvent(2, createSampleEvent('sync:disconnected'), 1001),
		]

		const model = buildPanelModel(events)
		expect(model.network.connected).toBe(false)
	})

	test('builds version vector from operations', () => {
		const events: TimestampedEvent[] = [
			createTimestampedEvent(
				1,
				{
					type: 'operation:created',
					operation: createSampleOperation({
						nodeId: 'node-a',
						sequenceNumber: 5,
					}),
				},
				1000,
			),
			createTimestampedEvent(
				2,
				{
					type: 'operation:created',
					operation: createSampleOperation({
						nodeId: 'node-b',
						sequenceNumber: 3,
					}),
				},
				1001,
			),
			createTimestampedEvent(
				3,
				{
					type: 'operation:created',
					operation: createSampleOperation({
						nodeId: 'node-a',
						sequenceNumber: 8,
					}),
				},
				1002,
			),
		]

		const model = buildPanelModel(events)

		const vv = model.network.versionVector
		expect(vv).toHaveLength(2)

		const nodeA = vv.find((v) => v.nodeId === 'node-a')
		const nodeB = vv.find((v) => v.nodeId === 'node-b')
		expect(nodeA?.sequenceNumber).toBe(8) // Max of 5 and 8
		expect(nodeB?.sequenceNumber).toBe(3)
	})

	test('assigns correct colors to event types', () => {
		const events: TimestampedEvent[] = [
			createTimestampedEvent(1, createSampleEvent('operation:created'), 1000),
			createTimestampedEvent(2, createSampleEvent('sync:sent'), 1001),
			createTimestampedEvent(3, createSampleEvent('merge:conflict'), 1002),
			createTimestampedEvent(4, createSampleEvent('query:executed'), 1003),
			createTimestampedEvent(5, createSampleEvent('connection:quality'), 1004),
		]

		const model = buildPanelModel(events)

		expect(model.timeline[0]?.color).toBe('#22c55e') // operation = green
		expect(model.timeline[1]?.color).toBe('#a855f7') // sync = purple
		expect(model.timeline[2]?.color).toBe('#f59e0b') // merge = amber
		expect(model.timeline[3]?.color).toBe('#0ea5e9') // query = blue
		expect(model.timeline[4]?.color).toBe('#64748b') // connection = slate
	})

	test('extracts causal dependencies', () => {
		const op = createSampleOperation({ causalDeps: ['dep-1', 'dep-2'] })
		const events: TimestampedEvent[] = [
			createTimestampedEvent(1, { type: 'operation:created', operation: op }, 1000),
		]

		const model = buildPanelModel(events)
		expect(model.timeline[0]?.dependsOn).toEqual(['dep-1', 'dep-2'])
	})

	test('handles empty event list', () => {
		const model = buildPanelModel([])

		expect(model.timeline).toHaveLength(0)
		expect(model.conflicts).toHaveLength(0)
		expect(model.operations).toHaveLength(0)
		expect(model.network.connected).toBe(false)
		expect(model.network.versionVector).toHaveLength(0)
	})

	test('handles constraint violation events', () => {
		const events: TimestampedEvent[] = [
			createTimestampedEvent(
				1,
				createSampleEvent('constraint:violated', {
					trace: createSampleMergeTrace({
						constraintViolated: 'unique:email',
						tier: 2,
						strategy: 'first-write-wins',
					}),
				}),
				1000,
			),
		]

		const model = buildPanelModel(events)
		expect(model.conflicts).toHaveLength(1)
		expect(model.conflicts[0]?.constraintViolated).toBe('unique:email')
		expect(model.conflicts[0]?.tier).toBe(2)
	})
})
