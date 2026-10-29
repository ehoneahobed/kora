import { afterEach, describe, expect, test, vi } from 'vitest'
import { IndexedDbPersistenceScheduler } from './indexeddb-persistence-scheduler'

describe('IndexedDbPersistenceScheduler', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	test('debounces flush until interval elapses', async () => {
		vi.useFakeTimers()
		const flush = vi.fn(async () => {})
		const scheduler = new IndexedDbPersistenceScheduler({ debounceMs: 500, flush })

		scheduler.schedule()
		scheduler.schedule()
		expect(flush).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(500)
		expect(flush).toHaveBeenCalledTimes(1)

		scheduler.dispose()
	})

	test('whenPersisted waits for the debounced snapshot and forces none', async () => {
		vi.useFakeTimers()
		const flush = vi.fn(async () => {})
		const scheduler = new IndexedDbPersistenceScheduler({ debounceMs: 500, flush })

		await expect(scheduler.whenPersisted()).resolves.toBeUndefined()
		scheduler.schedule()
		let resolved = false
		const waiting = scheduler.whenPersisted().then(() => {
			resolved = true
		})
		await vi.advanceTimersByTimeAsync(100)
		expect(resolved).toBe(false)
		expect(flush).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(400)
		await waiting
		expect(resolved).toBe(true)
		expect(flush).toHaveBeenCalledTimes(1)
		scheduler.dispose()
	})

	test('whenPersisted stays pending after a failed snapshot', async () => {
		vi.useFakeTimers()
		const scheduler = new IndexedDbPersistenceScheduler({
			debounceMs: 10,
			flush: async () => {
				throw new Error('disk full')
			},
			onError: () => {},
		})
		scheduler.schedule()
		let resolved = false
		void scheduler.whenPersisted().then(() => {
			resolved = true
		})
		await vi.advanceTimersByTimeAsync(50)
		expect(resolved).toBe(false)
		scheduler.dispose()
	})

	test('flushNow runs immediately', async () => {
		const flush = vi.fn(async () => {})
		const scheduler = new IndexedDbPersistenceScheduler({ debounceMs: 500, flush })

		await scheduler.flushNow()
		expect(flush).toHaveBeenCalledTimes(1)

		scheduler.dispose()
	})

	test('forwards flush errors to onError', async () => {
		const error = new Error('disk full')
		const onError = vi.fn()
		const scheduler = new IndexedDbPersistenceScheduler({
			debounceMs: 10,
			flush: async () => {
				throw error
			},
			onError,
		})

		await scheduler.flushNow()
		expect(onError).toHaveBeenCalledWith(error)

		scheduler.dispose()
	})

	describe('flushBarrier (RT-35 durability barrier)', () => {
		test('resolves without writing when nothing was scheduled since the last snapshot', async () => {
			const flush = vi.fn(async () => {})
			const scheduler = new IndexedDbPersistenceScheduler({ debounceMs: 500, flush })
			await scheduler.flushBarrier()
			expect(flush).not.toHaveBeenCalled()
			scheduler.schedule()
			await scheduler.flushBarrier()
			expect(flush).toHaveBeenCalledTimes(1)
			await scheduler.flushBarrier()
			expect(flush).toHaveBeenCalledTimes(1)
			scheduler.dispose()
		})

		test('a snapshot already in flight before the write does not satisfy the barrier', async () => {
			let release: () => void = () => {}
			let calls = 0
			const flush = vi.fn(async () => {
				calls++
				if (calls === 1) {
					await new Promise<void>((resolve) => {
						release = resolve
					})
				}
			})
			const scheduler = new IndexedDbPersistenceScheduler({ debounceMs: 500, flush })
			scheduler.schedule()
			const first = scheduler.flushNow() // snapshot 1 starts, covering generation 1
			scheduler.schedule() // generation 2 committed while snapshot 1 is running
			const barrier = scheduler.flushBarrier()
			release()
			await first
			await barrier
			// Snapshot 1 (relaxed), the one flushNow takes for generation 2 (relaxed), and the
			// barrier's own strict snapshot: a relaxed one never satisfies a barrier.
			expect(flush).toHaveBeenCalledTimes(3)
			expect(flush).toHaveBeenLastCalledWith(expect.objectContaining({ strict: true }))
			scheduler.dispose()
		})

		test('rejects when the snapshot cannot be written, and still reports it', async () => {
			const error = new Error('quota')
			const onError = vi.fn()
			const scheduler = new IndexedDbPersistenceScheduler({
				debounceMs: 500,
				flush: async () => {
					throw error
				},
				onError,
			})
			scheduler.schedule()
			await expect(scheduler.flushBarrier()).rejects.toBe(error)
			expect(onError).toHaveBeenCalledWith(error)
			scheduler.dispose()
		})

		test('cancels the pending debounce and persists immediately', async () => {
			vi.useFakeTimers()
			const flush = vi.fn(async () => {})
			const scheduler = new IndexedDbPersistenceScheduler({ debounceMs: 500, flush })
			scheduler.schedule()
			await scheduler.flushBarrier()
			expect(flush).toHaveBeenCalledTimes(1)
			await vi.advanceTimersByTimeAsync(1000)
			expect(flush).toHaveBeenCalledTimes(1)
			scheduler.dispose()
		})
	})

	test('flushNow keeps writing while writes landed during the snapshot (STORE-7)', async () => {
		let live = 1
		const persisted: number[] = []
		const gate: { release: () => void } = { release: () => {} }
		const scheduler = new IndexedDbPersistenceScheduler({
			debounceMs: 60_000,
			flush: async () => {
				const snapshot = live
				if (persisted.length === 0) {
					await new Promise<void>((resolve) => {
						gate.release = resolve
					})
				}
				persisted.push(snapshot)
			},
		})
		const first = scheduler.flushNow()
		await Promise.resolve()
		live = 2
		scheduler.schedule()
		expect(scheduler.isDirty()).toBe(true)
		const second = scheduler.flushNow()
		gate.release()
		await Promise.all([first, second])
		expect(persisted.at(-1)).toBe(2)
		expect(scheduler.isDirty()).toBe(false)
		scheduler.dispose()
	})

	test('flushNow stops after a failed snapshot instead of retrying forever', async () => {
		const onError = vi.fn()
		const flush = vi.fn(async () => {
			throw new Error('quota')
		})
		const scheduler = new IndexedDbPersistenceScheduler({ debounceMs: 60_000, flush, onError })
		scheduler.schedule()
		await scheduler.flushNow()
		expect(flush).toHaveBeenCalledTimes(1)
		expect(onError).toHaveBeenCalledTimes(1)
		expect(scheduler.isDirty()).toBe(true)
		scheduler.dispose()
	})
})

describe('strict barrier snapshots (offline readiness A0)', () => {
	test('a barrier is not satisfied by a relaxed background snapshot', async () => {
		const calls: boolean[] = []
		const scheduler = new IndexedDbPersistenceScheduler({
			debounceMs: 0,
			flush: async ({ strict }) => {
				calls.push(strict)
			},
		})
		scheduler.schedule()
		await scheduler.flushNow()
		expect(calls).toEqual([false])
		await scheduler.flushBarrier()
		expect(calls).toEqual([false, true])
		scheduler.dispose()
	})

	test('concurrent barriers share one strict snapshot (group commit)', async () => {
		const calls: boolean[] = []
		const scheduler = new IndexedDbPersistenceScheduler({
			debounceMs: 500,
			flush: async ({ strict }) => {
				calls.push(strict)
			},
		})
		scheduler.schedule()
		scheduler.schedule()
		scheduler.schedule()
		await Promise.all([
			scheduler.flushBarrier(),
			scheduler.flushBarrier(),
			scheduler.flushBarrier(),
		])
		expect(calls).toEqual([true])
		scheduler.dispose()
	})
})

describe('barrier for a peer tab (follower)', () => {
	test('forces a strict snapshot even though this tab scheduled no write', async () => {
		const calls: boolean[] = []
		const scheduler = new IndexedDbPersistenceScheduler({
			debounceMs: 500,
			flush: async ({ strict }) => {
				calls.push(strict)
			},
		})
		await scheduler.flushBarrierForPeer()
		expect(calls).toEqual([true])
		scheduler.dispose()
	})

	test('barriers arriving before the snapshot read the database share it; later ones need the next', async () => {
		const calls: boolean[] = []
		let reachRead: () => void = () => {}
		const reading = new Promise<void>((resolve) => {
			reachRead = resolve
		})
		let proceed: () => void = () => {}
		const mayRead = new Promise<void>((resolve) => {
			proceed = resolve
		})
		let first = true
		const scheduler = new IndexedDbPersistenceScheduler({
			debounceMs: 500,
			flush: async ({ strict, readPoint }) => {
				if (first) {
					first = false
					await mayRead
					readPoint()
					reachRead()
					await Promise.resolve()
				} else {
					readPoint()
				}
				calls.push(strict)
			},
		})
		scheduler.schedule()
		const own = scheduler.flushBarrier()
		// Arrives while the snapshot is in flight but has not read the database yet.
		const early = scheduler.flushBarrierForPeer()
		proceed()
		await reading
		// Arrives after the snapshot read the database: it is not in it.
		const late = scheduler.flushBarrierForPeer()
		await Promise.all([own, early, late])
		expect(calls).toEqual([true, true])
		scheduler.dispose()
	})

	test('peer barriers and this tab barriers issued together share one strict snapshot', async () => {
		const calls: boolean[] = []
		const scheduler = new IndexedDbPersistenceScheduler({
			debounceMs: 500,
			flush: async ({ strict, readPoint }) => {
				await Promise.resolve()
				readPoint()
				calls.push(strict)
			},
		})
		scheduler.schedule()
		await Promise.all([
			scheduler.flushBarrierForPeer(),
			scheduler.flushBarrierForPeer(),
			scheduler.flushBarrier(),
		])
		expect(calls).toEqual([true])
		scheduler.dispose()
	})

	test('rejects when the snapshot fails, and a disposed scheduler refuses', async () => {
		const error = new Error('quota')
		const scheduler = new IndexedDbPersistenceScheduler({
			debounceMs: 500,
			flush: async () => {
				throw error
			},
		})
		await expect(scheduler.flushBarrierForPeer()).rejects.toBe(error)
		scheduler.dispose()
		await expect(scheduler.flushBarrierForPeer()).rejects.toThrow('disposed')
	})
})
