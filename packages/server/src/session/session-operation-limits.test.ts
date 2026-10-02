import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import {
	CombinedRateLimiter,
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

describe('CombinedRateLimiter (per-node and per-user budgets)', () => {
	test('wouldAllow charges nothing', () => {
		const limiter = new SessionRateLimiter(2)
		expect(limiter.wouldAllow(2)).toBe(true)
		expect(limiter.wouldAllow(3)).toBe(false)
		expect(limiter.allow(2)).toBe(true)
		expect(limiter.wouldAllow(1)).toBe(false)
	})

	test('a refusal by the user budget spends none of the node budget', () => {
		const node = new SessionRateLimiter(10)
		const user = new SessionRateLimiter(3)
		const combined = new CombinedRateLimiter(node, user)
		expect(combined.allow(3)).toBe(true)
		expect(combined.allow(1)).toBe(false)
		expect(node.wouldAllow(7)).toBe(true)
		expect(combined.limit).toBe(3)
	})

	test('a node over its own budget spends none of the shared user budget', () => {
		const user = new SessionRateLimiter(10)
		const greedy = new CombinedRateLimiter(new SessionRateLimiter(2), user)
		expect(greedy.allow(2)).toBe(true)
		expect(greedy.allow(1)).toBe(false)
		expect(greedy.allow(1)).toBe(false)
		expect(user.wouldAllow(8)).toBe(true)
		const sibling = new CombinedRateLimiter(new SessionRateLimiter(2), user)
		expect(sibling.allow(2)).toBe(true)
	})

	test('retryAfterMs reports the blocking budget', () => {
		const combined = new CombinedRateLimiter(
			new SessionRateLimiter(5),
			new SessionRateLimiter(1, 1000),
		)
		expect(combined.retryAfterMs()).toBe(0)
		combined.allow(1)
		expect(combined.retryAfterMs()).toBeGreaterThan(0)
		expect(combined.retryAfterMs()).toBeLessThanOrEqual(1000)
	})
})
