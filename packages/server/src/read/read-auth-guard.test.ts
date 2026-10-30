import { afterEach, describe, expect, test, vi } from 'vitest'
import type { AuthContext } from '../types'
import { ReadAuthGuard, ReadAuthTimeoutError } from './read-auth-guard'

const ANN: AuthContext = { userId: 'ann', scopes: {} }
// 8 concurrent / 40 per second / burst 8 splits into a clean lane of 6 / 30 / 6 and a
// suspect lane of 2 / 10 / 2.
const options = {
	ttlMs: 5_000,
	maxConcurrentMisses: 8,
	missesPerSecond: 40,
	missBurst: 8,
	timeoutMs: 1_000,
}

function clock(start = 1_000_000) {
	let t = start
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms
		},
	}
}

afterEach(() => {
	vi.useRealTimers()
})

describe('ReadAuthGuard', () => {
	test('remembers a success for the ttl and no longer', async () => {
		const c = clock()
		const guard = new ReadAuthGuard(options, c.now)
		let calls = 0
		const call = async () => {
			calls += 1
			return ANN
		}
		expect((await guard.resolve('tok', call)).kind).toBe('context')
		expect(guard.lookup('tok')).toEqual({ kind: 'context', context: ANN })
		c.advance(4_999)
		expect(guard.lookup('tok').kind).toBe('context')
		c.advance(2)
		expect(guard.lookup('tok').kind).toBe('unknown')
		expect(calls).toBe(1)
	})

	test('never remembers past the credential expiry', async () => {
		const c = clock()
		const guard = new ReadAuthGuard(options, c.now)
		await guard.resolve('tok', async () => ({ ...ANN, expiresAt: c.now() + 1_000 }))
		c.advance(999)
		expect(guard.lookup('tok').kind).toBe('context')
		c.advance(1)
		expect(guard.lookup('tok').kind).toBe('unknown')
	})

	test('a context that is already expired is not remembered', async () => {
		const c = clock()
		const guard = new ReadAuthGuard(options, c.now)
		await guard.resolve('tok', async () => ({ ...ANN, expiresAt: c.now() - 1 }))
		expect(guard.lookup('tok').kind).toBe('unknown')
	})

	test('a refused token stays refused for a short time only, even with a long ttl', async () => {
		const c = clock()
		const guard = new ReadAuthGuard({ ...options, ttlMs: 60_000 }, c.now)
		await guard.resolve('junk', async () => null)
		expect(guard.lookup('junk').kind).toBe('denied')
		c.advance(1_999)
		expect(guard.lookup('junk').kind).toBe('denied')
		c.advance(2)
		expect(guard.lookup('junk').kind).toBe('unknown')
	})

	test('concurrent first requests with one token share one provider call', async () => {
		const guard = new ReadAuthGuard({ ...options, maxConcurrentMisses: 8 }, clock().now)
		let calls = 0
		let release: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const call = async () => {
			calls += 1
			await gate
			return ANN
		}
		const all = Array.from({ length: 500 }, () => guard.resolve('same', call))
		release()
		const results = await Promise.all(all)
		expect(calls).toBe(1)
		expect(results.every((r) => r.kind === 'context')).toBe(true)
	})

	test('a provider that throws rejects every waiter and remembers nothing', async () => {
		const guard = new ReadAuthGuard(options, clock().now)
		const call = async (): Promise<AuthContext | null> => {
			throw new Error('down')
		}
		await expect(guard.resolve('tok', call)).rejects.toThrow('down')
		expect(guard.lookup('tok').kind).toBe('unknown')
		// The slot was released: a later call is admitted.
		expect((await guard.resolve('tok', async () => ANN)).kind).toBe('context')
	})

	test('distinct unseen tokens are capped by concurrency; cached ones never are', async () => {
		const c = clock()
		// A burst large enough that only the concurrency cap can refuse.
		const guard = new ReadAuthGuard({ ...options, missBurst: 100, missesPerSecond: 1000 }, c.now)
		await guard.resolve('known', async () => ANN)
		const releases: Array<() => void> = []
		const hang = () =>
			new Promise<AuthContext | null>((resolve) => {
				releases.push(() => resolve(null))
			})
		// The suspect lane holds 2 in flight.
		const a = guard.resolve('g1', hang, 'suspect')
		const b = guard.resolve('g2', hang, 'suspect')
		await Promise.resolve()
		expect((await guard.resolve('g3', hang, 'suspect')).kind).toBe('busy')
		expect(guard.lookup('known').kind).toBe('context')
		for (const r of releases) r()
		await Promise.all([a, b])
	})

	test('distinct unseen tokens are capped by rate, and refill with time', async () => {
		const c = clock()
		const guard = new ReadAuthGuard(options, c.now)
		// The clean lane's burst is 6.
		for (let i = 0; i < 6; i++) {
			expect((await guard.resolve(`r${i}`, async () => null)).kind).toBe('context')
		}
		const spent = await guard.resolve('g4', async () => null)
		expect(spent.kind).toBe('busy')
		if (spent.kind === 'busy') expect(spent.retryAfterMs).toBeGreaterThan(0)
		c.advance(100)
		expect((await guard.resolve('g4', async () => null)).kind).toBe('context')
	})

	test('addresses that were failing cannot spend the clean share of the budget', async () => {
		const guard = new ReadAuthGuard(options, clock().now)
		// The suspect lane (burst 2) is spent...
		await guard.resolve('s1', async () => null, 'suspect')
		await guard.resolve('s2', async () => null, 'suspect')
		expect((await guard.resolve('s3', async () => null, 'suspect')).kind).toBe('busy')
		// ...and a clean cold read is still served.
		expect((await guard.resolve('cold', async () => ANN, 'clean')).kind).toBe('context')
	})

	test('a provider that never answers frees its slot at the deadline and is not cached late', async () => {
		vi.useFakeTimers()
		const guard = new ReadAuthGuard({ ...options, maxConcurrentMisses: 8 }, clock().now)
		let answer: (value: AuthContext | null) => void = () => {}
		const hung = guard.resolve(
			'hang',
			() =>
				new Promise<AuthContext | null>((resolve) => {
					answer = resolve
				}),
			'suspect',
		)
		const outcome = expect(hung).rejects.toBeInstanceOf(ReadAuthTimeoutError)
		await vi.advanceTimersByTimeAsync(1_000)
		await outcome
		// The slot is free again: both suspect slots can be taken.
		expect((await guard.resolve('next', async () => ANN, 'suspect')).kind).toBe('context')
		// The provider answers after the deadline: nothing is remembered.
		answer(ANN)
		await vi.advanceTimersByTimeAsync(0)
		expect(guard.lookup('hang').kind).toBe('unknown')
	})

	test('every waiter of a call that timed out is rejected', async () => {
		vi.useFakeTimers()
		const guard = new ReadAuthGuard(options, clock().now)
		const call = () => new Promise<AuthContext | null>(() => {})
		const waiters = [
			guard.resolve('t', call),
			guard.resolve('t', call),
			guard.resolve('t', call),
		].map((p) => expect(p).rejects.toBeInstanceOf(ReadAuthTimeoutError))
		await vi.advanceTimersByTimeAsync(1_000)
		await Promise.all(waiters)
	})

	test('a call in flight when an eviction happens is used once and never cached', async () => {
		const guard = new ReadAuthGuard(options, clock().now)
		let release: () => void = () => {}
		const pending = guard.resolve(
			'tok',
			() =>
				new Promise<AuthContext | null>((resolve) => {
					release = () => resolve(ANN)
				}),
		)
		await Promise.resolve()
		guard.evict('ann')
		release()
		expect(((await pending) as { context: AuthContext }).context).toEqual(ANN)
		expect(guard.lookup('tok').kind).toBe('unknown')
		// Calls that start after the eviction are cached again.
		await guard.resolve('tok', async () => ANN)
		expect(guard.lookup('tok').kind).toBe('context')
	})

	test('evict forgets one user, or everyone when no user is named', async () => {
		const guard = new ReadAuthGuard(options, clock().now)
		await guard.resolve('a', async () => ANN)
		await guard.resolve('b', async () => ({ userId: 'bob', scopes: {} }))
		guard.evict('ann')
		expect(guard.lookup('a').kind).toBe('unknown')
		expect(guard.lookup('b').kind).toBe('context')
		guard.evict()
		expect(guard.lookup('b').kind).toBe('unknown')
	})

	test('a zero ttl remembers nothing', async () => {
		const guard = new ReadAuthGuard({ ...options, ttlMs: 0 }, clock().now)
		await guard.resolve('tok', async () => ANN)
		await guard.resolve('junk', async () => null)
		expect(guard.size).toBe(0)
	})

	test('the cache is bounded: past 10,000 entries the oldest go first', async () => {
		const guard = new ReadAuthGuard(
			{ ...options, maxConcurrentMisses: 8, missesPerSecond: 1_000_000, missBurst: 1_000_000 },
			clock().now,
		)
		for (let i = 0; i <= 10_000; i++) await guard.resolve(`t${i}`, async () => ANN)
		expect(guard.size).toBeLessThanOrEqual(10_000)
		expect(guard.size).toBeGreaterThan(8_000)
		expect(guard.lookup('t0').kind).toBe('unknown')
		expect(guard.lookup('t10000').kind).toBe('context')
		// Refused tokens are bounded the same way.
		const refusing = new ReadAuthGuard(
			{ ...options, missesPerSecond: 1_000_000, missBurst: 1_000_000 },
			clock().now,
		)
		for (let i = 0; i <= 10_000; i++) await refusing.resolve(`n${i}`, async () => null)
		expect(refusing.size).toBeLessThanOrEqual(10_000)
		expect(refusing.lookup('n0').kind).toBe('unknown')
	})

	test('the fingerprint hides the token and differs per token', () => {
		const guard = new ReadAuthGuard(options, clock().now)
		expect(guard.fingerprint('secret-token')).not.toContain('secret')
		expect(guard.fingerprint('a')).not.toBe(guard.fingerprint('b'))
		expect(guard.fingerprint('a')).toBe(guard.fingerprint('a'))
	})
})
