import { fc, test as propTest } from '@fast-check/vitest'
import { describe, expect, test, vi } from 'vitest'
import { MockTimeSource } from '../../tests/fixtures/timestamps'
import { InvalidTimestampError, RemoteClockDriftError } from '../errors/errors'
import type { HLCTimestamp } from '../types'
import { HybridLogicalClock, MAX_LOGICAL } from './hlc'

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

	describe('advanceTo()', () => {
		test('advances the clock so subsequent now() sorts after the target', () => {
			const time = new MockTimeSource(1000)
			const clock = new HybridLogicalClock('n', time)
			clock.now() // wallTime = 1000

			const target: HLCTimestamp = { wallTime: 500_000, logical: 7, nodeId: 'n' }
			clock.advanceTo(target)

			const next = clock.now()
			expect(HybridLogicalClock.compare(next, target)).toBeGreaterThan(0)
			// Physical time (1000) is behind the adopted wallTime, so the logical
			// counter carries the ordering.
			expect(next.wallTime).toBe(500_000)
			expect(next.logical).toBe(8)
		})

		test('is a no-op when the target is behind the current clock state', () => {
			const time = new MockTimeSource(10_000)
			const clock = new HybridLogicalClock('n', time)
			const before = clock.now() // wallTime = 10_000

			clock.advanceTo({ wallTime: 5_000, logical: 99, nodeId: 'n' })

			const after = clock.now()
			// Monotonicity preserved: nothing moved backward.
			expect(HybridLogicalClock.compare(after, before)).toBeGreaterThan(0)
			expect(after.wallTime).toBe(10_000)
			expect(after.logical).toBe(1)
		})

		test('is a no-op when the target equals the current state', () => {
			const time = new MockTimeSource(2_000)
			const clock = new HybridLogicalClock('n', time)
			const current = clock.now()

			clock.advanceTo(current)

			const next = clock.now()
			expect(HybridLogicalClock.compare(next, current)).toBeGreaterThan(0)
		})

		test('advances by logical counter alone when wallTime is equal', () => {
			const time = new MockTimeSource(3_000)
			const clock = new HybridLogicalClock('n', time)
			clock.now() // { wallTime: 3000, logical: 0 }

			clock.advanceTo({ wallTime: 3_000, logical: 5, nodeId: 'n' })

			const next = clock.now()
			expect(next.wallTime).toBe(3_000)
			expect(next.logical).toBe(6)
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

	describe('logical counter bound (MAX_LOGICAL)', () => {
		test('now() carries into wallTime instead of exceeding MAX_LOGICAL', () => {
			// Physical clock frozen in the past (drift-freeze after a corrected
			// fast clock): every now() increments logical until it saturates.
			const time = new MockTimeSource(1000)
			const clock = new HybridLogicalClock('n', time)

			let previous = clock.now() // { wallTime: 1000, logical: 0 }
			let maxLogicalSeen = previous.logical
			let sawCarry = false

			for (let i = 0; i < MAX_LOGICAL + 5; i++) {
				const current = clock.now()
				maxLogicalSeen = Math.max(maxLogicalSeen, current.logical)
				// Monotonicity must hold across the carry boundary too.
				expect(HybridLogicalClock.compare(current, previous)).toBeGreaterThan(0)
				if (current.wallTime !== previous.wallTime) {
					sawCarry = true
					// The carry bumps wallTime by exactly 1ms and resets logical.
					expect(current.wallTime).toBe(previous.wallTime + 1)
					expect(current.logical).toBe(0)
					expect(previous.logical).toBe(MAX_LOGICAL)
				}
				previous = current
			}

			expect(maxLogicalSeen).toBe(MAX_LOGICAL)
			expect(sawCarry).toBe(true)
			// Every timestamp issued around the boundary is serializable.
			expect(() => HybridLogicalClock.serialize(previous)).not.toThrow()
			// This drives MAX_LOGICAL (99,999) + 5 synchronous now() calls, each
			// with its own assertions: pure CPU work against a MockTimeSource,
			// no real waiting. Vitest's default 5s timeout is still real
			// wall-clock though, and `pnpm test` fans out via `turbo run test
			// --concurrency=6`, so several packages' worker pools compete for
			// the same cores at once. Under that contention this loop can miss
			// 5s on an otherwise-passing machine, the same class of load-induced
			// slowness already worked around in packages/auth/vitest.config.ts.
			// Explicit timeout here, not a global bump, since only this test is
			// CPU-heavy enough to need it.
		}, 20_000)

		test('receive() carries when remote.logical === MAX_LOGICAL', () => {
			const time = new MockTimeSource(1000)
			const clock = new HybridLogicalClock('n', time)
			clock.now()

			const remote: HLCTimestamp = { wallTime: 2000, logical: MAX_LOGICAL, nodeId: 'remote' }
			const ts = clock.receive(remote)

			// remote.logical + 1 would overflow the 5-digit slot; the overflow
			// carries into wallTime so the result stays serializable and ordered.
			expect(ts.wallTime).toBe(2001)
			expect(ts.logical).toBe(0)
			expect(HybridLogicalClock.compare(ts, remote)).toBeGreaterThan(0)
		})

		test('receive() rejects logical > MAX_LOGICAL without mutating state', () => {
			const time = new MockTimeSource(1000)
			const clock = new HybridLogicalClock('n', time)
			clock.now() // { wallTime: 1000, logical: 0 }

			const invalid: HLCTimestamp = { wallTime: 1000, logical: MAX_LOGICAL + 1, nodeId: 'remote' }
			expect(() => clock.receive(invalid)).toThrow(InvalidTimestampError)

			// State unchanged: the next local timestamp is exactly what it would
			// have been had receive() never been called.
			const next = clock.now()
			expect(next.wallTime).toBe(1000)
			expect(next.logical).toBe(1)
		})

		test('receive() rejects non-integer and negative fields without mutating state', () => {
			const time = new MockTimeSource(1000)
			const clock = new HybridLogicalClock('n', time)
			clock.now()

			const malformed: HLCTimestamp[] = [
				{ wallTime: 1000.5, logical: 0, nodeId: 'r' },
				{ wallTime: 1000, logical: 0.5, nodeId: 'r' },
				{ wallTime: -1, logical: 0, nodeId: 'r' },
				{ wallTime: 1000, logical: -1, nodeId: 'r' },
				{ wallTime: Number.NaN, logical: 0, nodeId: 'r' },
			]
			for (const remote of malformed) {
				expect(() => clock.receive(remote)).toThrow(InvalidTimestampError)
			}

			const next = clock.now()
			expect(next.wallTime).toBe(1000)
			expect(next.logical).toBe(1)
		})

		test('InvalidTimestampError carries the offending values', () => {
			const clock = new HybridLogicalClock('n', new MockTimeSource(1000))
			clock.now()
			try {
				clock.receive({ wallTime: 1000, logical: MAX_LOGICAL + 7, nodeId: 'r' })
				expect.unreachable('receive() should have thrown')
			} catch (error) {
				expect(error).toBeInstanceOf(InvalidTimestampError)
				if (error instanceof InvalidTimestampError) {
					expect(error.code).toBe('INVALID_TIMESTAMP_FIELDS')
					expect(error.context).toMatchObject({ wallTime: 1000, logical: MAX_LOGICAL + 7 })
				}
			}
		})

		test('serialize() throws on out-of-range logical and wallTime', () => {
			expect(() =>
				HybridLogicalClock.serialize({ wallTime: 1000, logical: MAX_LOGICAL + 1, nodeId: 'n' }),
			).toThrow(InvalidTimestampError)
			expect(() =>
				HybridLogicalClock.serialize({ wallTime: 10 ** 15, logical: 0, nodeId: 'n' }),
			).toThrow(InvalidTimestampError)
			expect(() => HybridLogicalClock.serialize({ wallTime: -1, logical: 0, nodeId: 'n' })).toThrow(
				InvalidTimestampError,
			)
			expect(() =>
				HybridLogicalClock.serialize({ wallTime: 1000, logical: 0.5, nodeId: 'n' }),
			).toThrow(InvalidTimestampError)
			// Boundary values remain serializable.
			expect(() =>
				HybridLogicalClock.serialize({ wallTime: 10 ** 15 - 1, logical: MAX_LOGICAL, nodeId: 'n' }),
			).not.toThrow()
		})

		test('advanceTo() normalizes logical overflow by carrying into wallTime', () => {
			const time = new MockTimeSource(1000)
			const clock = new HybridLogicalClock('n', time)
			clock.now()

			// 250_000 logical = 2 full carries (2ms) + 50_000 remainder.
			clock.advanceTo({ wallTime: 5000, logical: 2 * (MAX_LOGICAL + 1) + 50_000, nodeId: 'n' })

			const next = clock.now()
			expect(next.wallTime).toBe(5002)
			expect(next.logical).toBe(50_001)
			expect(() => HybridLogicalClock.serialize(next)).not.toThrow()
		})

		test('advanceTo() at the logical cap still leaves room for the next increment', () => {
			const time = new MockTimeSource(1000)
			const clock = new HybridLogicalClock('n', time)
			clock.now()

			const target: HLCTimestamp = { wallTime: 5000, logical: MAX_LOGICAL, nodeId: 'n' }
			clock.advanceTo(target)

			// The increment past the cap carries into wallTime.
			const next = clock.now()
			expect(next.wallTime).toBe(5001)
			expect(next.logical).toBe(0)
			expect(HybridLogicalClock.compare(next, target)).toBeGreaterThan(0)
		})

		const validTimestampArb = fc.record({
			wallTime: fc.integer({ min: 0, max: 10 ** 15 - 1 }),
			logical: fc.integer({ min: 0, max: MAX_LOGICAL }),
			nodeId: fc.string({ minLength: 1, maxLength: 12 }),
		})

		propTest.prop([validTimestampArb, validTimestampArb], { numRuns: 1000 })(
			'serialized ordering matches compare() for all valid timestamps',
			(a, b) => {
				const sa = HybridLogicalClock.serialize(a)
				const sb = HybridLogicalClock.serialize(b)
				const compared = HybridLogicalClock.compare(a, b)
				const serializedSign = sa < sb ? -1 : sa > sb ? 1 : 0
				expect(Math.sign(compared)).toBe(serializedSign)
			},
		)
	})

	describe('clock drift', () => {
		test('warns when drift exceeds 60 seconds', () => {
			const onDriftWarning = vi.fn()
			const time = new MockTimeSource(1000)
			const clock = new HybridLogicalClock('n', time, onDriftWarning)

			// Initialize clock to avoid cold-start drift bypass
			clock.now()

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

		test('rejects a far-future remote timestamp BEFORE adopting it', () => {
			const time = new MockTimeSource(1000)
			const clock = new HybridLogicalClock('n', time)

			// Initialize clock so validation is active
			clock.now()

			const remote: HLCTimestamp = {
				wallTime: 1000 + 6 * 60_000, // 6 minutes ahead
				logical: 0,
				nodeId: 'remote',
			}

			expect(() => clock.receive(remote)).toThrow(RemoteClockDriftError)

			// The poisoned timestamp must NOT have been adopted: the clock still
			// issues timestamps near physical time, not near the rejected value.
			const next = clock.now()
			expect(next.wallTime).toBeLessThan(1000 + 60_000)
		})

		test('accepts far-future remote on cold start only when no reference offset is known', () => {
			const time = new MockTimeSource(1000)
			const cold = new HybridLogicalClock('n', time)
			const remote: HLCTimestamp = { wallTime: 1000 + 6 * 60_000, logical: 0, nodeId: 'r' }
			// Cold start without reference: legacy-compatible acceptance
			expect(() => cold.receive(remote)).not.toThrow()

			const informed = new HybridLogicalClock('n2', new MockTimeSource(1000))
			informed.setReferenceOffset(0)
			// Cold start WITH a reference offset: validation applies
			expect(() => informed.receive(remote)).toThrow(RemoteClockDriftError)
		})

		test('a slow local clock with known reference offset accepts legitimate remote timestamps', () => {
			// Device clock is one hour behind real time; server-derived offset corrects it.
			const time = new MockTimeSource(1000)
			const clock = new HybridLogicalClock('n', time)
			clock.now()
			clock.setReferenceOffset(60 * 60_000)

			const remote: HLCTimestamp = { wallTime: 1000 + 60 * 60_000, logical: 0, nodeId: 'r' }
			expect(() => clock.receive(remote)).not.toThrow()
		})

		test('now() never throws and never blocks writes when the physical clock jumps backward', () => {
			const onDriftError = vi.fn()
			const time = new MockTimeSource(10_000_000)
			const clock = new HybridLogicalClock('n', time, undefined, onDriftError)

			const before = clock.now() // wallTime = 10_000_000

			// User corrects a fast clock: physical time jumps 6 minutes backward
			time.set(10_000_000 - 6 * 60_000)

			const after = clock.now()
			// Monotonicity preserved, write not blocked
			expect(HybridLogicalClock.compare(after, before)).toBeGreaterThan(0)
			// Severity escalated through the callback instead of an exception
			expect(onDriftError).toHaveBeenCalledWith(expect.any(Number))
		})
	})
})
