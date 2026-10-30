import { describe, expect, test } from 'vitest'
import { ReadLimiter, resolveReadLimits } from './read-limits'

describe('resolveReadLimits', () => {
	test('defaults, with burst following perSecond', () => {
		const limits = resolveReadLimits({ rate: { perSecond: 5 } })
		expect(limits.maxRows).toBe(500)
		expect(limits.burst).toBe(5)
	})

	test('refuses limits that are not positive integers', () => {
		for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => resolveReadLimits({ maxRows: bad })).toThrow(RangeError)
		}
		expect(() => resolveReadLimits({ rate: { concurrent: 0 } })).toThrow(/concurrent/)
	})
})

describe('ReadLimiter', () => {
	const limits = { perSecond: 2, burst: 3, concurrent: 2, maxConcurrent: 3 }

	test('a bucket refills with the injected clock, not real time', () => {
		let now = 0
		const limiter = new ReadLimiter(limits, () => now)
		for (let i = 0; i < 3; i++) {
			const admission = limiter.admit('a')
			expect(admission.admitted).toBe(true)
			if (admission.admitted) admission.release()
		}
		const refused = limiter.admit('a')
		expect(refused).toMatchObject({ admitted: false, reason: 'rate' })
		if (!refused.admitted) expect(refused.retryAfterMs).toBe(500)
		now += 500
		expect(limiter.admit('a').admitted).toBe(true)
	})

	test('caps reads in flight per principal and releases exactly once', () => {
		const limiter = new ReadLimiter({ ...limits, burst: 100 }, () => 0)
		const first = limiter.admit('a')
		const second = limiter.admit('a')
		expect(limiter.admit('a')).toMatchObject({ admitted: false, reason: 'concurrent' })
		if (first.admitted) {
			first.release()
			first.release()
		}
		expect(limiter.admit('a').admitted).toBe(true)
		expect(limiter.admit('a')).toMatchObject({ admitted: false, reason: 'concurrent' })
		void second
	})

	test('caps reads in flight on the whole server', () => {
		const limiter = new ReadLimiter({ ...limits, burst: 100, concurrent: 10 }, () => 0)
		for (const key of ['a', 'b', 'c']) expect(limiter.admit(key).admitted).toBe(true)
		expect(limiter.admit('d')).toMatchObject({ admitted: false, reason: 'busy' })
	})

	test('principals are independent', () => {
		const limiter = new ReadLimiter({ ...limits, burst: 1 }, () => 0)
		expect(limiter.admit('a').admitted).toBe(true)
		expect(limiter.admit('a').admitted).toBe(false)
		expect(limiter.admit('b').admitted).toBe(true)
	})
})
