import { describe, expect, test } from 'vitest'
import type { Operation } from '@korajs/core'
import { isOperationTimestampValid, SERVER_MAX_TIMESTAMP_FUTURE_MS } from './operation-validation'

function makeOp(wallTime: number): Operation {
	return {
		id: 'op-1',
		nodeId: 'n1',
		type: 'insert',
		collection: 'todos',
		recordId: 'r1',
		data: { title: 'x' },
		previousData: null,
		timestamp: { wallTime, logical: 0, nodeId: 'n1' },
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
})
