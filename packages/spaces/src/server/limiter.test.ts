import { describe, expect, test } from 'vitest'
import { memoryLimiter } from './limiter'

describe('memoryLimiter', () => {
	test('allows `limit` hits per window, per key, and restarts with the next window', () => {
		let now = 0
		const limiter = memoryLimiter(() => now)
		expect([1, 2, 3].map(() => limiter.hit('a', 2, 1000))).toEqual([true, true, false])
		expect(limiter.hit('b', 2, 1000)).toBe(true)
		now = 1000
		expect(limiter.hit('a', 2, 1000)).toBe(true)
	})

	test('stays correct past the pruning threshold with nothing expired', () => {
		const limiter = memoryLimiter(() => 0)
		for (let i = 0; i < 25_000; i++) limiter.hit(`k${i}`, 1, 60_000)
		expect(limiter.hit('k24999', 1, 60_000)).toBe(false)
		expect(limiter.hit('fresh', 1, 60_000)).toBe(true)
	})

	test('a flood of short windows does not evict a daily cap', () => {
		const limiter = memoryLimiter(() => 0)
		expect(limiter.hit('daily', 1, 86_400_000)).toBe(true)
		for (let i = 0; i < 120_000; i++) limiter.hit(`minute${i}`, 1, 60_000)
		expect(limiter.hit('daily', 1, 86_400_000)).toBe(false)
	})

	test('a sustained flood of unique keys stays under twice the ceiling', () => {
		const limiter = memoryLimiter(() => 0)
		let peak = 0
		for (let i = 0; i < 700_000; i++) {
			limiter.hit(`k${i}`, 1, 60_000)
			if (limiter.size > peak) peak = limiter.size
		}
		expect(peak).toBeLessThanOrEqual(200_000)
	})

	test('release gives one hit back within the window', () => {
		const limiter = memoryLimiter(() => 0)
		expect(limiter.hit('a', 1, 1000)).toBe(true)
		limiter.release('a')
		expect(limiter.hit('a', 1, 1000)).toBe(true)
		expect(limiter.hit('a', 1, 1000)).toBe(false)
	})
})
