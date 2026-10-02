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
})
