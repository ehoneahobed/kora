import { afterEach, describe, expect, it } from 'vitest'
import { installClockSkew } from './clock'

const RealDate = Date

afterEach(() => {
	globalThis.Date = RealDate
	const g = globalThis as { __koraRealDate?: unknown }
	g.__koraRealDate = undefined
})

describe('installClockSkew', () => {
	it('offsets Date.now() and new Date() within the real-time bounds', () => {
		installClockSkew(60_000)
		const before = RealDate.now()
		const skewedNow = Date.now()
		const skewedDate = new Date().getTime()
		const after = RealDate.now()
		expect(skewedNow).toBeGreaterThanOrEqual(before + 60_000)
		expect(skewedNow).toBeLessThanOrEqual(after + 60_000)
		expect(skewedDate).toBeGreaterThanOrEqual(before + 60_000)
		expect(skewedDate).toBeLessThanOrEqual(after + 60_000)
	})

	it('moves the clock back for a negative offset', () => {
		installClockSkew(-5_000)
		const before = RealDate.now()
		expect(Date.now()).toBeLessThanOrEqual(before - 5_000 + 1_000)
		expect(Date.now()).toBeLessThan(before)
	})

	it('leaves explicit dates, statics and instanceof alone', () => {
		installClockSkew(60_000)
		expect(new Date(0).getTime()).toBe(0)
		expect(new Date('2020-01-01T00:00:00Z').toISOString()).toBe('2020-01-01T00:00:00.000Z')
		expect(Date.UTC(2020, 0, 1)).toBe(1577836800000)
		expect(new Date() instanceof RealDate).toBe(true)
		expect(typeof Date()).toBe('string')
	})

	it('replaces an earlier skew instead of stacking, and 0 restores real time', () => {
		installClockSkew(60_000)
		installClockSkew(10_000)
		const before = RealDate.now()
		expect(Date.now() - before).toBeLessThan(20_000)
		installClockSkew(0)
		const after = RealDate.now()
		expect(Date.now()).toBeGreaterThanOrEqual(before)
		expect(Date.now()).toBeLessThanOrEqual(after + 1_000)
	})
})
