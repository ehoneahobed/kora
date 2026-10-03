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
			expect(flush).toHaveBeenCalledTimes(2)
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
