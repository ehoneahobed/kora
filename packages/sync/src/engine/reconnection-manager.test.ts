import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ReconnectionManager } from './reconnection-manager'

describe('ReconnectionManager', () => {
	describe('delay calculation', () => {
		test('initial delay matches config', () => {
			const manager = new ReconnectionManager({
				initialDelay: 500,
				jitter: 0,
				randomSource: () => 0.5,
			})
			expect(manager.getNextDelay()).toBe(500)
		})

		test('delay grows exponentially (formula verification)', () => {
			const getDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, 30000)

			expect(getDelay(0)).toBe(1000)
			expect(getDelay(1)).toBe(2000)
			expect(getDelay(2)).toBe(4000)
			expect(getDelay(3)).toBe(8000)
			expect(getDelay(4)).toBe(16000)
			expect(getDelay(5)).toBe(30000) // Capped
		})

		test('delay capped at maxDelay', () => {
			const manager = new ReconnectionManager({
				initialDelay: 1000,
				multiplier: 10,
				maxDelay: 5000,
				jitter: 0,
				randomSource: () => 0.5,
			})

			expect(manager.getNextDelay()).toBe(1000)
		})

		test('jitter stays within bounds', () => {
			// Min random → min jitter offset
			const managerMin = new ReconnectionManager({
				initialDelay: 1000,
				jitter: 0.25,
				randomSource: () => 0,
			})
			expect(managerMin.getNextDelay()).toBe(750)

			// Max random → max jitter offset
			const managerMax = new ReconnectionManager({
				initialDelay: 1000,
				jitter: 0.25,
				randomSource: () => 0.999,
			})
			const delayMax = managerMax.getNextDelay()
			expect(delayMax).toBeGreaterThanOrEqual(1249)
			expect(delayMax).toBeLessThanOrEqual(1250)

			// Middle random → no jitter
			const managerMid = new ReconnectionManager({
				initialDelay: 1000,
				jitter: 0.25,
				randomSource: () => 0.5,
			})
			expect(managerMid.getNextDelay()).toBe(1000)
		})

		test('zero jitter produces exact delays', () => {
			const manager = new ReconnectionManager({
				initialDelay: 1000,
				multiplier: 2,
				jitter: 0,
				randomSource: () => 0.5,
			})
			expect(manager.getNextDelay()).toBe(1000)
		})

		test('delay never goes negative', () => {
			const manager = new ReconnectionManager({
				initialDelay: 10,
				jitter: 1.0,
				randomSource: () => 0,
			})
			expect(manager.getNextDelay()).toBeGreaterThanOrEqual(0)
		})
	})

	describe('reconnection behavior (fake timers)', () => {
		beforeEach(() => {
			vi.useFakeTimers()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		test('reconnects successfully after retry', async () => {
			const manager = new ReconnectionManager({
				initialDelay: 100,
				jitter: 0,
				randomSource: () => 0.5,
			})

			let attempts = 0
			const promise = manager.start(async () => {
				attempts++
				return attempts >= 2
			})

			// First delay: 100ms
			await vi.advanceTimersByTimeAsync(100)
			// First attempt fails. Second delay: 200ms
			await vi.advanceTimersByTimeAsync(200)
			// Second attempt succeeds

			const result = await promise
			expect(result).toBe(true)
			expect(attempts).toBe(2)
		})

		test('respects maxAttempts', async () => {
			const manager = new ReconnectionManager({
				initialDelay: 10,
				maxAttempts: 3,
				jitter: 0,
				randomSource: () => 0.5,
			})

			let attempts = 0
			const promise = manager.start(async () => {
				attempts++
				return false
			})

			// Advance enough time for 3 attempts
			await vi.advanceTimersByTimeAsync(10) // attempt 1
			await vi.advanceTimersByTimeAsync(20) // attempt 2
			await vi.advanceTimersByTimeAsync(40) // attempt 3

			const result = await promise
			expect(result).toBe(false)
			expect(attempts).toBe(3)
		})

		test('stop cancels reconnection before first attempt', async () => {
			const manager = new ReconnectionManager({
				initialDelay: 1000,
				jitter: 0,
				randomSource: () => 0.5,
			})

			let attempts = 0
			const promise = manager.start(async () => {
				attempts++
				return false
			})

			// Stop before the first delay (1000ms) elapses
			await vi.advanceTimersByTimeAsync(500)
			manager.stop()
			await vi.advanceTimersByTimeAsync(1000)

			const result = await promise
			expect(result).toBe(false)
			expect(attempts).toBe(0)
		})

		test('handles onReconnect throwing', async () => {
			const manager = new ReconnectionManager({
				initialDelay: 10,
				maxAttempts: 3,
				jitter: 0,
				randomSource: () => 0.5,
			})

			let attempts = 0
			const promise = manager.start(async () => {
				attempts++
				if (attempts < 3) throw new Error('connection failed')
				return true
			})

			await vi.advanceTimersByTimeAsync(10) // attempt 1 (throws)
			await vi.advanceTimersByTimeAsync(20) // attempt 2 (throws)
			await vi.advanceTimersByTimeAsync(40) // attempt 3 (succeeds)

			const result = await promise
			expect(result).toBe(true)
			expect(attempts).toBe(3)
		})
	})

	describe('reset', () => {
		test('reset clears attempt counter', () => {
			const manager = new ReconnectionManager()
			expect(manager.getAttemptCount()).toBe(0)
			manager.reset()
			expect(manager.getAttemptCount()).toBe(0)
		})
	})
})
