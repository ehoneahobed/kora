import { describe, expect, test } from 'vitest'
import { APPLY_FAILURE_CODES, defaultApplyFailureReason, isApplyFailure } from './apply-result'

describe('ApplyResult helpers', () => {
	test('isApplyFailure identifies non-success outcomes', () => {
		expect(isApplyFailure('applied')).toBe(false)
		expect(isApplyFailure('duplicate')).toBe(false)
		expect(isApplyFailure('skipped')).toBe(true)
		expect(isApplyFailure('rejected')).toBe(true)
		expect(isApplyFailure('deferred')).toBe(true)
	})

	test('defaultApplyFailureReason supplies clock drift overrides', () => {
		const reason = defaultApplyFailureReason('rejected', {
			code: APPLY_FAILURE_CODES.CLOCK_DRIFT,
			message: 'Clock drift detected',
			retriable: false,
		})
		expect(reason.code).toBe(APPLY_FAILURE_CODES.CLOCK_DRIFT)
		expect(reason.retriable).toBe(false)
	})
})
