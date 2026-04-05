import type { FieldDescriptor, HLCTimestamp, Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import type { OperationRow, RawCollectionRow } from '../types'
import {
	deserializeOperation,
	deserializeOperationWithCollection,
	deserializeRecord,
	serializeOperation,
	serializeRecord,
} from './serializer'

function field(
	kind: FieldDescriptor['kind'],
	overrides?: Partial<FieldDescriptor>,
): FieldDescriptor {
	return {
		kind,
		required: true,
		defaultValue: undefined,
		auto: false,
		enumValues: null,
		itemKind: null,
		...overrides,
	}
}

describe('serializeRecord', () => {
	test('passes string, number, timestamp, enum values through unchanged', () => {
		const fields: Record<string, FieldDescriptor> = {
			title: field('string'),
			count: field('number'),
			createdAt: field('timestamp'),
			status: field('enum', { enumValues: ['active', 'done'] }),
		}
		const data = { title: 'Hello', count: 42, createdAt: 1712188800000, status: 'active' }
		const result = serializeRecord(data, fields)
		expect(result).toEqual(data)
	})

	test('converts boolean to 0/1', () => {
		const fields: Record<string, FieldDescriptor> = {
			completed: field('boolean'),
			active: field('boolean'),
		}
		const result = serializeRecord({ completed: true, active: false }, fields)
		expect(result.completed).toBe(1)
		expect(result.active).toBe(0)
	})

	test('serializes array to JSON string', () => {
		const fields: Record<string, FieldDescriptor> = {
			tags: field('array', { itemKind: 'string' }),
		}
		const result = serializeRecord({ tags: ['a', 'b', 'c'] }, fields)
		expect(result.tags).toBe('["a","b","c"]')
	})

	test('passes richtext Uint8Array through unchanged', () => {
		const fields: Record<string, FieldDescriptor> = {
			notes: field('richtext'),
		}
		const bytes = new Uint8Array([1, 2, 3])
		const result = serializeRecord({ notes: bytes }, fields)
		expect(result.notes).toBe(bytes)
	})

	test('encodes richtext strings to binary updates', () => {
		const fields: Record<string, FieldDescriptor> = {
			notes: field('richtext'),
		}
		const result = serializeRecord({ notes: 'hello' }, fields)
		expect(result.notes).toBeInstanceOf(Uint8Array)
	})

	test('handles null values', () => {
		const fields: Record<string, FieldDescriptor> = {
			title: field('string'),
		}
		const result = serializeRecord({ title: null }, fields)
		expect(result.title).toBeNull()
	})

	test('handles unknown fields gracefully', () => {
		const fields: Record<string, FieldDescriptor> = {}
		const result = serializeRecord({ unknown: 'value' }, fields)
		expect(result.unknown).toBe('value')
	})
})

describe('deserializeRecord', () => {
	test('maps _created_at/_updated_at to camelCase and strips _deleted', () => {
		const fields: Record<string, FieldDescriptor> = {
			title: field('string'),
		}
		const row: RawCollectionRow = {
			id: 'rec-1',
			title: 'Hello',
			_created_at: 1000,
			_updated_at: 2000,
			_deleted: 0,
		}
		const result = deserializeRecord(row, fields)
		expect(result.id).toBe('rec-1')
		expect(result.createdAt).toBe(1000)
		expect(result.updatedAt).toBe(2000)
		expect(result.title).toBe('Hello')
		expect(result).not.toHaveProperty('_deleted')
		expect(result).not.toHaveProperty('_created_at')
		expect(result).not.toHaveProperty('_updated_at')
	})

	test('converts 0/1 back to boolean', () => {
		const fields: Record<string, FieldDescriptor> = {
			completed: field('boolean'),
		}
		const row: RawCollectionRow = {
			id: 'rec-1',
			completed: 1,
			_created_at: 1000,
			_updated_at: 2000,
			_deleted: 0,
		}
		const result = deserializeRecord(row, fields)
		expect(result.completed).toBe(true)
	})

	test('parses JSON string back to array', () => {
		const fields: Record<string, FieldDescriptor> = {
			tags: field('array', { itemKind: 'string' }),
		}
		const row: RawCollectionRow = {
			id: 'rec-1',
			tags: '["a","b"]' as unknown as number,
			_created_at: 1000,
			_updated_at: 2000,
			_deleted: 0,
		}
		const result = deserializeRecord(row, fields)
		expect(result.tags).toEqual(['a', 'b'])
	})

	test('handles null field values', () => {
		const fields: Record<string, FieldDescriptor> = {
			assignee: field('string', { required: false }),
		}
		const row: RawCollectionRow = {
			id: 'rec-1',
			_created_at: 1000,
			_updated_at: 2000,
			_deleted: 0,
		}
		const result = deserializeRecord(row, fields)
		expect(result.assignee).toBeNull()
	})
})

describe('serializeOperation', () => {
	const timestamp: HLCTimestamp = { wallTime: 1712188800000, logical: 0, nodeId: 'node-1' }

	const baseOp: Operation = {
		id: 'op-hash-1',
		nodeId: 'node-1',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-1',
		data: { title: 'Ship it', completed: false },
		previousData: null,
		timestamp,
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
	}

	test('serializes an insert operation', () => {
		const row = serializeOperation(baseOp)
		expect(row.id).toBe('op-hash-1')
		expect(row.node_id).toBe('node-1')
		expect(row.type).toBe('insert')
		expect(row.record_id).toBe('rec-1')
		expect(row.data).toBe('{"title":"Ship it","completed":false}')
		expect(row.previous_data).toBeNull()
		expect(row.timestamp).toBe('001712188800000:00000:node-1')
		expect(row.sequence_number).toBe(1)
		expect(row.causal_deps).toBe('[]')
		expect(row.schema_version).toBe(1)
	})

	test('serializes a delete operation with null data', () => {
		const deleteOp: Operation = { ...baseOp, type: 'delete', data: null }
		const row = serializeOperation(deleteOp)
		expect(row.data).toBeNull()
	})

	test('serializes an update operation with previousData', () => {
		const updateOp: Operation = {
			...baseOp,
			type: 'update',
			data: { completed: true },
			previousData: { completed: false },
			causalDeps: ['op-hash-0'],
		}
		const row = serializeOperation(updateOp)
		expect(row.data).toBe('{"completed":true}')
		expect(row.previous_data).toBe('{"completed":false}')
		expect(row.causal_deps).toBe('["op-hash-0"]')
	})
})

describe('deserializeOperation', () => {
	test('deserializes an operation row back to an Operation', () => {
		const row: OperationRow = {
			id: 'op-hash-1',
			node_id: 'node-1',
			type: 'insert',
			record_id: 'rec-1',
			data: '{"title":"Ship it"}',
			previous_data: null,
			timestamp: '001712188800000:00000:node-1',
			sequence_number: 1,
			causal_deps: '[]',
			schema_version: 1,
		}
		const op = deserializeOperation(row)
		expect(op.id).toBe('op-hash-1')
		expect(op.nodeId).toBe('node-1')
		expect(op.type).toBe('insert')
		expect(op.recordId).toBe('rec-1')
		expect(op.data).toEqual({ title: 'Ship it' })
		expect(op.previousData).toBeNull()
		expect(op.timestamp).toEqual({
			wallTime: 1712188800000,
			logical: 0,
			nodeId: 'node-1',
		})
		expect(op.sequenceNumber).toBe(1)
		expect(op.causalDeps).toEqual([])
		expect(op.schemaVersion).toBe(1)
	})

	test('deserializes update operation with previousData', () => {
		const row: OperationRow = {
			id: 'op-hash-2',
			node_id: 'node-1',
			type: 'update',
			record_id: 'rec-1',
			data: '{"completed":true}',
			previous_data: '{"completed":false}',
			timestamp: '001712188800000:00001:node-1',
			sequence_number: 2,
			causal_deps: '["op-hash-1"]',
			schema_version: 1,
		}
		const op = deserializeOperation(row)
		expect(op.data).toEqual({ completed: true })
		expect(op.previousData).toEqual({ completed: false })
		expect(op.causalDeps).toEqual(['op-hash-1'])
	})

	test('collection defaults to empty string (caller provides it)', () => {
		const row: OperationRow = {
			id: 'op-1',
			node_id: 'n',
			type: 'insert',
			record_id: 'r',
			data: '{}',
			previous_data: null,
			timestamp: '001712188800000:00000:n',
			sequence_number: 1,
			causal_deps: '[]',
			schema_version: 1,
		}
		const op = deserializeOperation(row)
		expect(op.collection).toBe('')
	})
})

describe('deserializeOperationWithCollection', () => {
	test('sets collection name on deserialized operation', () => {
		const row: OperationRow = {
			id: 'op-1',
			node_id: 'n',
			type: 'insert',
			record_id: 'r',
			data: '{}',
			previous_data: null,
			timestamp: '001712188800000:00000:n',
			sequence_number: 1,
			causal_deps: '[]',
			schema_version: 1,
		}
		const op = deserializeOperationWithCollection(row, 'todos')
		expect(op.collection).toBe('todos')
	})
})
