import { describe, expect, test } from 'vitest'
import {
	cpuAllowanceMs,
	evaluateCell,
	k1TargetMs,
	k2LimitMs,
	longestStall,
	totalBlockingTime,
} from '../bench/parity/contract'

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

	test('warm Kora gets the same margin as cold (the 2026-11-06 decision)', () => {
		// A worker-backed store pays a query round trip the baseline's in-memory cache does not;
		// 100 ms is the line below which a user cannot tell.
		expect(evaluateCell('P5', 'warm', [2, 2, 2], [60, 60, 60]).pass).toBe(true)
		expect(evaluateCell('P5', 'warm', [2, 2, 2], [103, 103, 103]).pass).toBe(false)
		expect(evaluateCell('P2', 'warm', [155, 155, 155], [218, 218, 218]).pass).toBe(true)
		expect(evaluateCell('P1', 'warm', [100, 100, 100], [190, 190, 190]).pass).toBe(true)
	})

	test('a timeout fails the cell', () => {
		const verdict = evaluateCell('P6', 'cold', [100, 100, 100], [50, null, 50])
		expect(verdict.kora.p95).toBe(Number.POSITIVE_INFINITY)
		expect(verdict.pass).toBe(false)
	})

	test('P8 allows 50 ms of blocking and P9 is a 32 KiB ratchet', () => {
		expect(evaluateCell('P8', 'cold', [0, 0, 0], [50, 50, 50]).pass).toBe(true)
		expect(evaluateCell('P8', 'cold', [0, 0, 0], [51, 51, 51]).pass).toBe(false)
		expect(evaluateCell('P9', 'cold', [62, 62, 62], [94, 94, 94]).pass).toBe(true)
		expect(evaluateCell('P9', 'cold', [62, 62, 62], [95, 95, 95]).pass).toBe(false)
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

describe('K1 ratchet (the 2026-11-06 decision)', () => {
	test('allows the measured level at 1x and twice that at a throttled CPU', () => {
		expect(k1TargetMs('broadband', 1)).toBe(17_000)
		expect(k1TargetMs('broadband', 4)).toBe(34_000)
		expect(k1TargetMs('4g', 1)).toBe(19_000)
	})

	test('has no limit for a profile it does not know', () => {
		expect(k1TargetMs('unknown', 1)).toBe(Number.POSITIVE_INFINITY)
	})

	test('4x CPU ratchet: allowances apply only above 1x and only to P2, P3, P8 and K2', () => {
		expect(cpuAllowanceMs('P8', 'cold', 1)).toBe(0)
		expect(evaluateCell('P8', 'cold', [0, 0, 0], [450, 450, 450], 4).pass).toBe(true)
		expect(evaluateCell('P8', 'cold', [0, 0, 0], [500, 500, 500], 4).pass).toBe(true)
		expect(evaluateCell('P8', 'cold', [0, 0, 0], [501, 501, 501], 4).pass).toBe(false)
		expect(evaluateCell('P8', 'warm', [0, 0, 0], [250, 250, 250], 4).pass).toBe(true)
		expect(evaluateCell('P8', 'warm', [0, 0, 0], [251, 251, 251], 4).pass).toBe(false)
		expect(evaluateCell('P2', 'cold', [500, 500, 500], [650, 650, 650], 4).pass).toBe(true)
		expect(evaluateCell('P2', 'cold', [500, 500, 500], [651, 651, 651], 4).pass).toBe(false)
		expect(evaluateCell('P2', 'cold', [500, 500, 500], [651, 651, 651], 1).pass).toBe(false)
		expect(evaluateCell('P6', 'cold', [100, 100, 100], [201, 201, 201], 4).pass).toBe(false)
		expect(k2LimitMs(1)).toBe(50)
		expect(k2LimitMs(4)).toBe(150)
	})
})
