import { describe, expect, test } from 'vitest'
import type { AuthContext } from '../types'
import { ReadAuthGuard } from './read-auth-guard'

const ANN: AuthContext = { userId: 'ann', scopes: {} }
const options = { ttlMs: 5_000, maxConcurrentMisses: 2, missesPerSecond: 10, missBurst: 3 }

function clock(start = 1_000_000) {
	let t = start
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms
		},
	}
}

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

	test('a refused token is answered from the negative cache for the ttl', async () => {
		const c = clock()
		const guard = new ReadAuthGuard(options, c.now)
		await guard.resolve('junk', async () => null)
		expect(guard.lookup('junk').kind).toBe('denied')
		c.advance(5_001)
		expect(guard.lookup('junk').kind).toBe('unknown')
	})

	test('concurrent first requests with one token share one provider call', async () => {
		const guard = new ReadAuthGuard({ ...options, maxConcurrentMisses: 1 }, clock().now)
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

	test('distinct unseen tokens are capped by concurrency, then by rate; cached ones never are', async () => {
		const c = clock()
		// A burst large enough that only the concurrency cap can refuse the third call.
		const guard = new ReadAuthGuard({ ...options, missBurst: 100 }, c.now)
		await guard.resolve('known', async () => ANN)
		const releases: Array<() => void> = []
		const hang = () =>
			new Promise<AuthContext | null>((resolve) => {
				releases.push(() => resolve(null))
			})
		const a = guard.resolve('g1', hang)
		const b = guard.resolve('g2', hang)
		// Two in flight: a third distinct token is refused, a cached one is untouched.
		expect((await guard.resolve('g3', hang)).kind).toBe('busy')
		expect(guard.lookup('known').kind).toBe('context')
		for (const r of releases) r()
		await Promise.all([a, b])
		// Now the rate cap alone: a fresh guard whose burst of 3 is spent refuses until time passes.
		const rated = new ReadAuthGuard(options, c.now)
		for (const token of ['r1', 'r2', 'r3']) await rated.resolve(token, async () => null)
		const spent = await rated.resolve('g4', async () => null)
		expect(spent.kind).toBe('busy')
		if (spent.kind === 'busy') expect(spent.retryAfterMs).toBeGreaterThan(0)
		c.advance(100)
		expect((await rated.resolve('g4', async () => null)).kind).toBe('context')
	})

	test('evict forgets one user, or everyone when no user is named', async () => {
		const guard = new ReadAuthGuard({ ...options, missBurst: 10 }, clock().now)
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

	test('the fingerprint hides the token and differs per token', () => {
		const guard = new ReadAuthGuard(options, clock().now)
		expect(guard.fingerprint('secret-token')).not.toContain('secret')
		expect(guard.fingerprint('a')).not.toBe(guard.fingerprint('b'))
		expect(guard.fingerprint('a')).toBe(guard.fingerprint('a'))
	})
})
