import { describe, expect, test } from 'vitest'
import { evaluateCell, longestStall, totalBlockingTime } from '../bench/parity/contract'

describe('parity contract (first-visit-parity.md, section 2.4)', () => {
	test('uses the absolute floors for short metrics', () => {
		const verdict = evaluateCell('P2', 'cold', [30, 30, 30], [129, 129, 179])
		expect(verdict.limitP50).toBe(130)
		expect(verdict.limitP95).toBe(180)
		expect(verdict.pass).toBe(true)
	})

	test('uses the relative margins for long metrics', () => {
		const verdict = evaluateCell('P2', 'cold', [2000, 2000, 2000], [2201, 2201, 2201])
		expect(verdict.limitP50).toBe(2200)
		expect(verdict.limitP95).toBe(2300)
		expect(verdict.pass).toBe(false)
	})

	test('fails a cell when either quantile is over', () => {
		const verdict = evaluateCell('P4-course', 'cold', [100, 100, 100], [100, 100, 500])
		expect(verdict.kora.median).toBe(100)
		expect(verdict.pass).toBe(false)
	})

	test('warm Kora must be at or below the baseline p50 on P2 to P6', () => {
		expect(evaluateCell('P5', 'warm', [2, 2, 2], [30, 30, 30]).pass).toBe(false)
		expect(evaluateCell('P5', 'warm', [40, 40, 40], [30, 30, 30]).pass).toBe(true)
		// P1 keeps the normal margin warm.
		expect(evaluateCell('P1', 'warm', [100, 100, 100], [190, 190, 190]).pass).toBe(true)
	})

	test('a timeout fails the cell', () => {
		const verdict = evaluateCell('P6', 'cold', [100, 100, 100], [50, null, 50])
		expect(verdict.kora.p95).toBe(Number.POSITIVE_INFINITY)
		expect(verdict.pass).toBe(false)
	})

	test('P8 allows 50 ms of blocking and P9 20 KiB', () => {
		expect(evaluateCell('P8', 'cold', [0, 0, 0], [50, 50, 50]).pass).toBe(true)
		expect(evaluateCell('P8', 'cold', [0, 0, 0], [51, 51, 51]).pass).toBe(false)
		expect(evaluateCell('P9', 'cold', [62, 62, 62], [82, 82, 82]).pass).toBe(true)
		expect(evaluateCell('P9', 'cold', [62, 62, 62], [83, 83, 83]).pass).toBe(false)
	})

	test('total blocking time counts stall minus 50 ms inside the window', () => {
		const stalls: Array<[number, number]> = [
			[100, 60],
			[200, 150],
			[40_000, 500],
		]
		expect(totalBlockingTime(stalls, 0, 30_000)).toBe(110)
		expect(longestStall(stalls, 0, 30_000)).toBe(150)
		expect(longestStall(stalls, 300, 30_000)).toBe(0)
	})
})
