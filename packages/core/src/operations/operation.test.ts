import { describe, expect, test } from 'vitest'
import { HybridLogicalClock } from '../clock/hlc'
import { OperationError } from '../errors/errors'
import type { OperationInput } from '../types'
import { MockTimeSource } from '../../tests/fixtures/timestamps'
import {
	createOperation,
	isValidOperation,
	validateOperationParams,
	verifyOperationIntegrity,
} from './operation'

function makeClock(nodeId = 'test-node'): HybridLogicalClock {
	return new HybridLogicalClock(nodeId, new MockTimeSource(1000))
}

function makeInsertInput(overrides?: Partial<OperationInput>): OperationInput {
	return {
		nodeId: 'test-node',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-1',
		data: { title: 'test' },
		previousData: null,
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

describe('createOperation', () => {
	test('creates a valid operation with content-addressed id', async () => {
		const clock = makeClock()
		const op = await createOperation(makeInsertInput(), clock)

		expect(op.id).toMatch(/^[0-9a-f]{64}$/)
		expect(op.nodeId).toBe('test-node')
		expect(op.type).toBe('insert')
		expect(op.collection).toBe('todos')
		expect(op.data).toEqual({ title: 'test' })
		expect(op.timestamp.nodeId).toBe('test-node')
	})

	test('freezes the returned operation', async () => {
		const clock = makeClock()
		const op = await createOperation(makeInsertInput(), clock)

		expect(Object.isFrozen(op)).toBe(true)
		expect(() => {
			;(op as Record<string, unknown>).type = 'delete'
		}).toThrow()
	})

	test('deep-freezes nested objects', async () => {
		const clock = makeClock()
		const op = await createOperation(makeInsertInput({ data: { nested: { value: 1 } } }), clock)

		expect(Object.isFrozen(op.data)).toBe(true)
		expect(() => {
			;(op.data as Record<string, unknown>).nested = 'modified'
		}).toThrow()
	})

	test('does not share references with input', async () => {
		const clock = makeClock()
		const data = { title: 'test' }
		const deps = ['dep-1']
		const op = await createOperation(makeInsertInput({ data, causalDeps: deps }), clock)

		data.title = 'modified'
		deps.push('dep-2')

		expect(op.data).toEqual({ title: 'test' })
		expect(op.causalDeps).toEqual(['dep-1'])
	})

	test('produces deterministic ids for same input', async () => {
		const clock1 = makeClock()
		const clock2 = makeClock()
		const input = makeInsertInput()

		const op1 = await createOperation(input, clock1)
		const op2 = await createOperation(input, clock2)

		// Both clocks at same time with same nodeId -> same timestamp -> same id
		expect(op1.id).toBe(op2.id)
	})
})

describe('validateOperationParams', () => {
	test('accepts valid insert input', () => {
		expect(() => validateOperationParams(makeInsertInput())).not.toThrow()
	})

	test('accepts valid update input', () => {
		expect(() =>
			validateOperationParams(
				makeInsertInput({
					type: 'update',
					data: { title: 'updated' },
					previousData: { title: 'original' },
				}),
			),
		).not.toThrow()
	})

	test('accepts valid delete input', () => {
		expect(() =>
			validateOperationParams(makeInsertInput({ type: 'delete', data: null })),
		).not.toThrow()
	})

	test('rejects empty nodeId', () => {
		expect(() => validateOperationParams(makeInsertInput({ nodeId: '' }))).toThrow(
			OperationError,
		)
	})

	test('rejects invalid type', () => {
		expect(() =>
			validateOperationParams(makeInsertInput({ type: 'invalid' as 'insert' })),
		).toThrow(OperationError)
	})

	test('rejects insert with null data', () => {
		expect(() => validateOperationParams(makeInsertInput({ data: null }))).toThrow(
			OperationError,
		)
	})

	test('rejects update with null data', () => {
		expect(() =>
			validateOperationParams(makeInsertInput({ type: 'update', data: null })),
		).toThrow(OperationError)
	})

	test('rejects update with null previousData', () => {
		expect(() =>
			validateOperationParams(
				makeInsertInput({ type: 'update', data: { title: 'x' }, previousData: null }),
			),
		).toThrow(OperationError)
	})

	test('rejects delete with non-null data', () => {
		expect(() =>
			validateOperationParams(
				makeInsertInput({ type: 'delete', data: { leftover: true } }),
			),
		).toThrow(OperationError)
	})

	test('rejects negative sequenceNumber', () => {
		expect(() => validateOperationParams(makeInsertInput({ sequenceNumber: -1 }))).toThrow(
			OperationError,
		)
	})

	test('rejects schemaVersion less than 1', () => {
		expect(() => validateOperationParams(makeInsertInput({ schemaVersion: 0 }))).toThrow(
			OperationError,
		)
	})
})

describe('verifyOperationIntegrity', () => {
	test('returns true for a valid operation', async () => {
		const clock = makeClock()
		const op = await createOperation(makeInsertInput(), clock)
		expect(await verifyOperationIntegrity(op)).toBe(true)
	})

	test('returns false for a tampered operation', async () => {
		const clock = makeClock()
		const op = await createOperation(makeInsertInput(), clock)

		// Create a tampered copy (bypass freeze for test purposes)
		const tampered = JSON.parse(JSON.stringify(op)) as typeof op
		tampered.data = { title: 'tampered' }

		expect(await verifyOperationIntegrity(tampered)).toBe(false)
	})
})

describe('isValidOperation', () => {
	test('returns true for a valid operation', async () => {
		const clock = makeClock()
		const op = await createOperation(makeInsertInput(), clock)
		expect(isValidOperation(op)).toBe(true)
	})

	test('returns false for null', () => {
		expect(isValidOperation(null)).toBe(false)
	})

	test('returns false for non-object', () => {
		expect(isValidOperation('string')).toBe(false)
	})

	test('returns false for object missing required fields', () => {
		expect(isValidOperation({ id: 'abc' })).toBe(false)
	})
})
