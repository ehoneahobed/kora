import { MAX_LOGICAL } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { SERVER_MAX_TIMESTAMP_FUTURE_MS, isOperationTimestampValid } from './operation-validation'

function makeOp(wallTime: number, logical = 0): Operation {
	return {
		id: 'op-1',
		nodeId: 'n1',
		type: 'insert',
		collection: 'todos',
		recordId: 'r1',
		data: { title: 'x' },
		previousData: null,
		timestamp: { wallTime, logical, nodeId: 'n1' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
	}
}

describe('isOperationTimestampValid', () => {
	test('accepts timestamps within tolerance', () => {
		const now = 1_000_000
		expect(isOperationTimestampValid(makeOp(now), now)).toBe(true)
		expect(isOperationTimestampValid(makeOp(now + SERVER_MAX_TIMESTAMP_FUTURE_MS), now)).toBe(true)
	})

	test('rejects timestamps beyond tolerance', () => {
		const now = 1_000_000
		expect(isOperationTimestampValid(makeOp(now + SERVER_MAX_TIMESTAMP_FUTURE_MS + 1), now)).toBe(
			false,
		)
	})

	test('accepts logical at the serialization cap (99999)', () => {
		const now = 1_000_000
		expect(isOperationTimestampValid(makeOp(now, MAX_LOGICAL), now)).toBe(true)
		expect(MAX_LOGICAL).toBe(99_999)
	})

	test('rejects logical beyond the serialization cap (100000)', () => {
		const now = 1_000_000
		expect(isOperationTimestampValid(makeOp(now, 100_000), now)).toBe(false)
	})

	test('rejects non-integer wallTime or logical', () => {
		const now = 1_000_000
		expect(isOperationTimestampValid(makeOp(now + 0.5), now)).toBe(false)
		expect(isOperationTimestampValid(makeOp(now, 0.5), now)).toBe(false)
		expect(isOperationTimestampValid(makeOp(Number.NaN), now)).toBe(false)
	})

	test('rejects negative wallTime or logical', () => {
		const now = 1_000_000
		expect(isOperationTimestampValid(makeOp(-1), now)).toBe(false)
		expect(isOperationTimestampValid(makeOp(now, -1), now)).toBe(false)
	})
})
