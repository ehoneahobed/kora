import { afterEach, describe, expect, test, vi } from 'vitest'
import { ReconnectionManager } from './reconnection-manager'

/**
 * Backoff that survives runs (SYNC-8) and retries that a disconnect racing an attempt
 * cannot lose (NEW-SYNC-2). Fake timers; jitter disabled.
 */

function manager(stableAfterMs = 10_000): ReconnectionManager {
	return new ReconnectionManager({
		initialDelay: 100,
		maxDelay: 10_000,
		jitter: 0,
		stableAfterMs,
		randomSource: () => 0.5,
	})
}

afterEach(() => {
	vi.useRealTimers()
})

describe('ReconnectionManager backoff across runs (SYNC-8)', () => {
	test('a new run continues the backoff of the previous one', async () => {
		vi.useFakeTimers()
		const m = manager()
		const first = m.start(async () => true)
		await vi.advanceTimersByTimeAsync(100)
		expect(await first).toBe(true)
		expect(m.getAttemptCount()).toBe(1)
		// The session dropped before it was stable: the next run waits longer.
		expect(m.getNextDelay()).toBe(200)
	})

	test('the backoff resets only after a connection stayed up for stableAfterMs', async () => {
		vi.useFakeTimers()
		const m = manager(10_000)
		let attempts = 0
		const run = m.start(async () => ++attempts === 3)
		await vi.advanceTimersByTimeAsync(100 + 200 + 400)
		expect(await run).toBe(true)
		expect(m.getAttemptCount()).toBe(3)
		m.reportConnected()
		vi.advanceTimersByTime(9_999)
		expect(m.getAttemptCount()).toBe(3)
		m.reportDisconnected()
		vi.advanceTimersByTime(60_000)
		expect(m.getAttemptCount()).toBe(3)
		m.reportConnected()
		vi.advanceTimersByTime(10_000)
		expect(m.getAttemptCount()).toBe(0)
	})

	test('reset() never clears a stop', async () => {
		vi.useFakeTimers()
		const m = manager()
		let attempts = 0
		const run = m.start(async () => {
			attempts++
			return false
		})
		m.stop()
		m.reset()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(await run).toBe(false)
		expect(attempts).toBe(0)
	})
})

describe('ReconnectionManager pending retry (NEW-SYNC-2)', () => {
	test('a disconnect reported during an attempt makes it count as failed', async () => {
		vi.useFakeTimers()
		const m = manager()
		let attempts = 0
		const run = m.start(async () => {
			attempts++
			// The first two sessions drop while the attempt is still in flight.
			if (attempts <= 2) expect(m.requestRetry()).toBe(true)
			return true
		})
		await vi.advanceTimersByTimeAsync(100 + 200 + 400)
		expect(await run).toBe(true)
		expect(attempts).toBe(3)
	})

	test('requestRetry outside a run tells the caller to start one', () => {
		expect(manager().requestRetry()).toBe(false)
	})
})
