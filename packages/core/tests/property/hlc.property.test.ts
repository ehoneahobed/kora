import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { HybridLogicalClock } from '../../src/clock/hlc'
import type { HLCTimestamp } from '../../src/types'
import { MockTimeSource } from '../fixtures/timestamps'

const hlcTimestampArb = fc.record({
	wallTime: fc.nat({ max: 2 ** 48 }),
	logical: fc.nat({ max: 10000 }),
	nodeId: fc.stringMatching(/^[a-z0-9]{1,8}$/),
})

describe('HLC property-based tests', () => {
	test('now() is always monotonically increasing', () => {
		fc.assert(
			fc.property(fc.nat({ max: 500 }), (count) => {
				const time = new MockTimeSource(1000)
				const clock = new HybridLogicalClock('test', time)

				let prev = clock.now()
				for (let i = 0; i < count; i++) {
					if (Math.random() > 0.5) time.advance(1)
					const curr = clock.now()
					expect(HybridLogicalClock.compare(curr, prev)).toBeGreaterThan(0)
					prev = curr
				}
			}),
			{ numRuns: 50 },
		)
	})

	test('compare is antisymmetric: compare(a,b) = -compare(b,a)', () => {
		fc.assert(
			fc.property(hlcTimestampArb, hlcTimestampArb, (a, b) => {
				const ab = HybridLogicalClock.compare(a, b)
				const ba = HybridLogicalClock.compare(b, a)

				if (ab > 0) expect(ba).toBeLessThan(0)
				else if (ab < 0) expect(ba).toBeGreaterThan(0)
				else expect(ba).toBe(0)
			}),
		)
	})

	test('compare is transitive: if a < b and b < c then a < c', () => {
		fc.assert(
			fc.property(hlcTimestampArb, hlcTimestampArb, hlcTimestampArb, (a, b, c) => {
				const ab = HybridLogicalClock.compare(a, b)
				const bc = HybridLogicalClock.compare(b, c)
				const ac = HybridLogicalClock.compare(a, c)

				if (ab < 0 && bc < 0) expect(ac).toBeLessThan(0)
				if (ab > 0 && bc > 0) expect(ac).toBeGreaterThan(0)
			}),
		)
	})

	test('serialize/deserialize round-trips', () => {
		fc.assert(
			fc.property(hlcTimestampArb, (ts) => {
				const serialized = HybridLogicalClock.serialize(ts)
				const deserialized = HybridLogicalClock.deserialize(serialized)
				expect(deserialized).toEqual(ts)
			}),
		)
	})

	test('serialized comparison matches compare()', () => {
		fc.assert(
			fc.property(hlcTimestampArb, hlcTimestampArb, (a: HLCTimestamp, b: HLCTimestamp) => {
				const compareResult = HybridLogicalClock.compare(a, b)
				const sa = HybridLogicalClock.serialize(a)
				const sb = HybridLogicalClock.serialize(b)
				const stringCompare = sa < sb ? -1 : sa > sb ? 1 : 0

				if (compareResult < 0) expect(stringCompare).toBeLessThan(0)
				else if (compareResult > 0) expect(stringCompare).toBeGreaterThan(0)
				else expect(stringCompare).toBe(0)
			}),
		)
	})
})
