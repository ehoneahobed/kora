import { describe, expect, test, vi } from 'vitest'
import { MockTimeSource } from '../../tests/fixtures/timestamps'
import { ClockDriftError } from '../errors/errors'
import type { HLCTimestamp } from '../types'
import { HybridLogicalClock } from './hlc'

describe('HybridLogicalClock', () => {
	describe('now()', () => {
		test('produces a timestamp with the correct nodeId', () => {
			const clock = new HybridLogicalClock('node-1', new MockTimeSource(1000))
			const ts = clock.now()
			expect(ts.nodeId).toBe('node-1')
		})

		test('uses physical time when it advances', () => {
			const time = new MockTimeSource(1000)
			const clock = new HybridLogicalClock('n', time)

			const ts1 = clock.now()
			expect(ts1.wallTime).toBe(1000)
			expect(ts1.logical).toBe(0)

			time.advance(100)
			const ts2 = clock.now()
			expect(ts2.wallTime).toBe(1100)
			expect(ts2.logical).toBe(0)
		})

		test('increments logical counter when physical time does not advance', () => {
			const clock = new HybridLogicalClock('n', new MockTimeSource(1000))

			const ts1 = clock.now()
			const ts2 = clock.now()
			const ts3 = clock.now()

			expect(ts1.wallTime).toBe(1000)
			expect(ts2.wallTime).toBe(1000)
			expect(ts3.wallTime).toBe(1000)

			expect(ts1.logical).toBe(0)
			expect(ts2.logical).toBe(1)
			expect(ts3.logical).toBe(2)
		})

		test('is monotonically increasing', () => {
			const time = new MockTimeSource(1000)
			const clock = new HybridLogicalClock('n', time)

			const timestamps: HLCTimestamp[] = []
			for (let i = 0; i < 100; i++) {
				timestamps.push(clock.now())
				// Occasionally advance time
				if (i % 10 === 0) time.advance(1)
			}

			for (let i = 1; i < timestamps.length; i++) {
				const prev = timestamps[i - 1]
				const curr = timestamps[i]
				if (prev && curr) {
					expect(HybridLogicalClock.compare(curr, prev)).toBeGreaterThan(0)
				}
			}
		})

		test('resets logical counter when physical time advances', () => {
			const time = new MockTimeSource(1000)
			const clock = new HybridLogicalClock('n', time)

			clock.now() // wallTime=1000, logical=0
			clock.now() // wallTime=1000, logical=1

			time.advance(1)
			const ts = clock.now()
			expect(ts.wallTime).toBe(1001)
			expect(ts.logical).toBe(0)
		})
	})

	describe('receive()', () => {
		test('advances wallTime to remote when remote is ahead', () => {
			const clock = new HybridLogicalClock('n', new MockTimeSource(1000))
			clock.now() // initialize

			const remote: HLCTimestamp = { wallTime: 2000, logical: 5, nodeId: 'remote' }
			const ts = clock.receive(remote)

			expect(ts.wallTime).toBe(2000)
			expect(ts.logical).toBe(6) // remote.logical + 1
		})

		test('increments logical when wallTimes match', () => {
			const time = new MockTimeSource(1000)
			const clock = new HybridLogicalClock('n', time)
			clock.now() // wallTime=1000, logical=0

			const remote: HLCTimestamp = { wallTime: 1000, logical: 3, nodeId: 'remote' }
			const ts = clock.receive(remote)

			expect(ts.wallTime).toBe(1000)
			expect(ts.logical).toBe(4) // max(0, 3) + 1
		})

		test('uses physical time when it dominates both', () => {
			const time = new MockTimeSource(3000)
			const clock = new HybridLogicalClock('n', time)
			clock.now() // wallTime=3000

			time.advance(1000)
			const remote: HLCTimestamp = { wallTime: 2000, logical: 5, nodeId: 'remote' }
			const ts = clock.receive(remote)

			expect(ts.wallTime).toBe(4000)
			expect(ts.logical).toBe(0)
		})

		test('increments local logical when local wallTime dominates', () => {
			const time = new MockTimeSource(1000)
			const clock = new HybridLogicalClock('n', time)

			// Push HLC wallTime ahead by calling now() repeatedly won't work since
			// wallTime is pinned to physical time. Instead, receive a high remote.
			const highRemote: HLCTimestamp = { wallTime: 5000, logical: 0, nodeId: 'remote' }
			clock.receive(highRemote)
			// Now local wallTime=5000, logical=1

			const lowerRemote: HLCTimestamp = { wallTime: 3000, logical: 10, nodeId: 'remote' }
			const ts = clock.receive(lowerRemote)

			// Local wallTime (5000) > remote wallTime (3000) && wallTime (5000) >= physicalTime (1000)
			expect(ts.wallTime).toBe(5000)
			expect(ts.logical).toBe(2) // previous logical (1) + 1
		})
	})

	describe('compare()', () => {
		test('returns negative when a is earlier by wallTime', () => {
			const a: HLCTimestamp = { wallTime: 1000, logical: 0, nodeId: 'a' }
			const b: HLCTimestamp = { wallTime: 2000, logical: 0, nodeId: 'b' }
			expect(HybridLogicalClock.compare(a, b)).toBeLessThan(0)
		})

		test('returns positive when a is later by wallTime', () => {
			const a: HLCTimestamp = { wallTime: 2000, logical: 0, nodeId: 'a' }
			const b: HLCTimestamp = { wallTime: 1000, logical: 0, nodeId: 'b' }
			expect(HybridLogicalClock.compare(a, b)).toBeGreaterThan(0)
		})

		test('breaks wallTime ties using logical counter', () => {
			const a: HLCTimestamp = { wallTime: 1000, logical: 5, nodeId: 'a' }
			const b: HLCTimestamp = { wallTime: 1000, logical: 3, nodeId: 'b' }
			expect(HybridLogicalClock.compare(a, b)).toBeGreaterThan(0)
		})

		test('breaks logical ties using nodeId lexicographically', () => {
			const a: HLCTimestamp = { wallTime: 1000, logical: 0, nodeId: 'alpha' }
			const b: HLCTimestamp = { wallTime: 1000, logical: 0, nodeId: 'beta' }
			expect(HybridLogicalClock.compare(a, b)).toBeLessThan(0)
		})

		test('returns zero for identical timestamps', () => {
			const a: HLCTimestamp = { wallTime: 1000, logical: 5, nodeId: 'same' }
			const b: HLCTimestamp = { wallTime: 1000, logical: 5, nodeId: 'same' }
			expect(HybridLogicalClock.compare(a, b)).toBe(0)
		})
	})

	describe('serialize/deserialize', () => {
		test('round-trips correctly', () => {
			const ts: HLCTimestamp = { wallTime: 1712188800000, logical: 42, nodeId: 'node-abc' }
			const serialized = HybridLogicalClock.serialize(ts)
			const deserialized = HybridLogicalClock.deserialize(serialized)
			expect(deserialized).toEqual(ts)
		})

		test('serialized form sorts lexicographically like compare()', () => {
			const timestamps: HLCTimestamp[] = [
				{ wallTime: 1000, logical: 5, nodeId: 'b' },
				{ wallTime: 2000, logical: 0, nodeId: 'a' },
				{ wallTime: 1000, logical: 3, nodeId: 'a' },
				{ wallTime: 1000, logical: 5, nodeId: 'a' },
			]

			const sortedByCompare = [...timestamps].sort(HybridLogicalClock.compare)
			const sortedBySerialized = [...timestamps].sort((a, b) => {
				const sa = HybridLogicalClock.serialize(a)
				const sb = HybridLogicalClock.serialize(b)
				return sa < sb ? -1 : sa > sb ? 1 : 0
			})

			expect(sortedBySerialized).toEqual(sortedByCompare)
		})

		test('handles nodeId with colons', () => {
			const ts: HLCTimestamp = { wallTime: 1000, logical: 0, nodeId: 'node:with:colons' }
			const roundTripped = HybridLogicalClock.deserialize(HybridLogicalClock.serialize(ts))
			expect(roundTripped).toEqual(ts)
		})

		test('throws on invalid format', () => {
			expect(() => HybridLogicalClock.deserialize('invalid')).toThrow()
		})
	})

	describe('clock drift', () => {
		test('warns when drift exceeds 60 seconds', () => {
			const onDriftWarning = vi.fn()
			const time = new MockTimeSource(1000)
			const clock = new HybridLogicalClock('n', time, onDriftWarning)

			// Push HLC ahead via remote message
			const remote: HLCTimestamp = {
				wallTime: 1000 + 90_000, // 90 seconds ahead
				logical: 0,
				nodeId: 'remote',
			}
			clock.receive(remote)

			expect(onDriftWarning).toHaveBeenCalledWith(expect.any(Number))
			expect(onDriftWarning.mock.calls[0]?.[0]).toBeGreaterThan(60_000)
		})

		test('throws ClockDriftError when drift exceeds 5 minutes', () => {
			const time = new MockTimeSource(1000)
			const clock = new HybridLogicalClock('n', time)

			// Push HLC ahead via remote message
			const remote: HLCTimestamp = {
				wallTime: 1000 + 6 * 60_000, // 6 minutes ahead
				logical: 0,
				nodeId: 'remote',
			}

			expect(() => clock.receive(remote)).toThrow(ClockDriftError)
		})

		test('throws ClockDriftError on now() when physical clock goes backward beyond 5 minutes', () => {
			const time = new MockTimeSource(10_000_000)
			const clock = new HybridLogicalClock('n', time)

			clock.now() // wallTime = 10_000_000

			// Physical clock goes way backward
			time.set(10_000_000 - 6 * 60_000)

			expect(() => clock.now()).toThrow(ClockDriftError)
		})
	})
})
