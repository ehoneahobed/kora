import { describe, expect, test } from 'vitest'
import {
	ClockDriftError,
	KoraError,
	MergeConflictError,
	OperationError,
	SchemaValidationError,
	StorageError,
	SyncError,
} from './errors'

describe('KoraError', () => {
	test('creates error with message, code, and context', () => {
		const err = new KoraError('something failed', 'TEST_ERROR', { key: 'value' })
		expect(err.message).toBe('something failed')
		expect(err.code).toBe('TEST_ERROR')
		expect(err.context).toEqual({ key: 'value' })
		expect(err.name).toBe('KoraError')
		expect(err).toBeInstanceOf(Error)
		expect(err).toBeInstanceOf(KoraError)
	})

	test('creates error without context', () => {
		const err = new KoraError('fail', 'NO_CTX')
		expect(err.context).toBeUndefined()
	})
})

describe('SchemaValidationError', () => {
	test('has correct code and name', () => {
		const err = new SchemaValidationError('bad schema', { collection: 'todos' })
		expect(err.code).toBe('SCHEMA_VALIDATION')
		expect(err.name).toBe('SchemaValidationError')
		expect(err).toBeInstanceOf(KoraError)
	})
})

describe('OperationError', () => {
	test('has correct code and name', () => {
		const err = new OperationError('bad op', { field: 'title' })
		expect(err.code).toBe('OPERATION_ERROR')
		expect(err.name).toBe('OperationError')
		expect(err).toBeInstanceOf(KoraError)
	})
})

describe('MergeConflictError', () => {
	test('includes field and operation info in message', () => {
		const err = new MergeConflictError(
			{ id: 'op-a', collection: 'todos' },
			{ id: 'op-b', collection: 'todos' },
			'title',
		)
		expect(err.message).toContain('title')
		expect(err.message).toContain('todos')
		expect(err.code).toBe('MERGE_CONFLICT')
		expect(err.name).toBe('MergeConflictError')
		expect(err.field).toBe('title')
		expect(err.context).toEqual({ operationA: 'op-a', operationB: 'op-b', field: 'title' })
	})
})

describe('SyncError', () => {
	test('has correct code and name', () => {
		const err = new SyncError('connection lost', { nodeId: 'abc' })
		expect(err.code).toBe('SYNC_ERROR')
		expect(err.name).toBe('SyncError')
	})
})

describe('StorageError', () => {
	test('has correct code and name', () => {
		const err = new StorageError('disk full')
		expect(err.code).toBe('STORAGE_ERROR')
		expect(err.name).toBe('StorageError')
	})
})

describe('ClockDriftError', () => {
	test('includes drift information in message and context', () => {
		const hlcTime = 1700000000000
		const physicalTime = 1700000000000 - 6 * 60 * 1000 // 6 minutes behind
		const err = new ClockDriftError(hlcTime, physicalTime)
		expect(err.message).toContain('360s')
		expect(err.message).toContain('5 minutes')
		expect(err.code).toBe('CLOCK_DRIFT')
		expect(err.name).toBe('ClockDriftError')
		expect(err.currentHlcTime).toBe(hlcTime)
		expect(err.physicalTime).toBe(physicalTime)
		expect(err.context).toHaveProperty('driftSeconds', 360)
	})
})
