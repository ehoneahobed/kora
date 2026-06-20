import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import {
	DEFAULT_MAX_OPERATION_BYTES,
	SessionRateLimiter,
	measureOperationBytes,
	validateOperationSize,
} from './session-operation-limits'

function makeOp(data: Record<string, unknown> = { title: 'x' }): Operation {
	return {
		id: 'op-1',
		nodeId: 'client-1',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-1',
		data,
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'client-1' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
	}
}

describe('session operation limits', () => {
	test('validateOperationSize rejects oversized payloads', () => {
		const huge = makeOp({ blob: 'x'.repeat(DEFAULT_MAX_OPERATION_BYTES) })
		const result = validateOperationSize(huge, 1024)
		expect(result.valid).toBe(false)
		expect(result.bytes).toBeGreaterThan(1024)
	})

	test('SessionRateLimiter enforces ops per minute', () => {
		const limiter = new SessionRateLimiter(2)
		expect(limiter.allow(1)).toBe(true)
		expect(limiter.allow(1)).toBe(true)
		expect(limiter.allow(1)).toBe(false)
	})

	test('measureOperationBytes returns positive size', () => {
		expect(measureOperationBytes(makeOp())).toBeGreaterThan(0)
	})
})
