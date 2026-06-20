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
})
