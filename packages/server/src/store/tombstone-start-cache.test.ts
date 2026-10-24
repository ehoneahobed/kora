import { afterEach, describe, expect, test, vi } from 'vitest'
import { TombstoneStartCache } from './scope-snapshot'

describe('TombstoneStartCache', () => {
	afterEach(() => vi.restoreAllMocks())

	const key = TombstoneStartCache.key('comments', 'c1', 'op1', 10)

	test('a decided start is computed once, then served from the cache', async () => {
		const cache = new TombstoneStartCache()
		let calls = 0
		const compute = async () => {
			calls++
			return 7
		}
		expect(await cache.resolve(key, compute)).toBe(7)
		expect(await cache.resolve(key, compute)).toBe(7)
		expect(calls).toBe(1)
	})

	test('concurrent lookups of one key share a single computation', async () => {
		const cache = new TombstoneStartCache()
		let calls = 0
		let release: (value: number) => void = () => {}
		const compute = () => {
			calls++
			return new Promise<number>((resolve) => {
				release = resolve
			})
		}
		const all = Promise.all([
			cache.resolve(key, compute),
			cache.resolve(key, compute),
			cache.resolve(key, compute),
		])
		release(4)
		expect(await all).toEqual([4, 4, 4])
		expect(calls).toBe(1)
	})

	test('an undecided answer is not stored as decided, and a failure is not cached at all', async () => {
		const cache = new TombstoneStartCache()
		expect(await cache.resolve(key, async () => null)).toBeNull()
		const other = TombstoneStartCache.key('comments', 'c1', 'op2', 11)
		await expect(
			cache.resolve(other, async () => {
				throw new Error('unavailable')
			}),
		).rejects.toThrow('unavailable')
		expect(cache.size).toBe(0)
		expect(await cache.resolve(other, async () => 3)).toBe(3)
	})

	test('a different operation of the same record is a different entry', async () => {
		const cache = new TombstoneStartCache()
		await cache.resolve(TombstoneStartCache.key('comments', 'c1', 'a', 10), async () => 1)
		await cache.resolve(TombstoneStartCache.key('comments', 'c1', 'b', 20), async () => 2)
		expect(
			await cache.resolve(TombstoneStartCache.key('comments', 'c1', 'a', 10), async () => 99),
		).toBe(1)
		expect(
			await cache.resolve(TombstoneStartCache.key('comments', 'c1', 'b', 20), async () => 99),
		).toBe(2)
	})

	test('clear forgets decided answers, and a lookup in flight across it is not stored', async () => {
		const cache = new TombstoneStartCache()
		await cache.resolve(key, async () => 5)
		cache.clear()
		expect(cache.size).toBe(0)
		let release: (value: number) => void = () => {}
		const pending = cache.resolve(
			key,
			() =>
				new Promise<number>((resolve) => {
					release = resolve
				}),
		)
		cache.clear()
		release(8)
		expect(await pending).toBe(8)
		expect(cache.size).toBe(0)
		expect(await cache.resolve(key, async () => 9)).toBe(9)
	})

	test('an undecided answer is reused briefly, then asked again', async () => {
		const cache = new TombstoneStartCache()
		let calls = 0
		const compute = async () => {
			calls++
			return null
		}
		const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
		await cache.resolve(key, compute)
		await cache.resolve(key, compute)
		expect(calls).toBe(1)
		now.mockReturnValue(10_000)
		await cache.resolve(key, compute)
		expect(calls).toBe(2)
	})
})
