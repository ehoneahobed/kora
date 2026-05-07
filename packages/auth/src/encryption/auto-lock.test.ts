import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AutoLockManager } from './auto-lock'

describe('auto-lock', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	describe('constructor', () => {
		test('throws for non-positive timeout', () => {
			expect(() => new AutoLockManager({ timeout: 0, onLock: vi.fn() })).toThrow(
				/positive number/,
			)
			expect(() => new AutoLockManager({ timeout: -1000, onLock: vi.fn() })).toThrow(
				/positive number/,
			)
		})

		test('starts in unlocked state', () => {
			const manager = new AutoLockManager({ timeout: 5000, onLock: vi.fn() })
			expect(manager.isLocked).toBe(false)
		})
	})

	describe('start / stop', () => {
		test('locks after timeout elapses', () => {
			const onLock = vi.fn()
			const manager = new AutoLockManager({ timeout: 5000, onLock })

			manager.start()
			expect(manager.isLocked).toBe(false)
			expect(onLock).not.toHaveBeenCalled()

			// Advance time to just before the timeout
			vi.advanceTimersByTime(4999)
			expect(manager.isLocked).toBe(false)
			expect(onLock).not.toHaveBeenCalled()

			// Advance to exactly the timeout
			vi.advanceTimersByTime(1)
			expect(manager.isLocked).toBe(true)
			expect(onLock).toHaveBeenCalledTimes(1)
		})

		test('stop prevents lock from firing', () => {
			const onLock = vi.fn()
			const manager = new AutoLockManager({ timeout: 5000, onLock })

			manager.start()
			vi.advanceTimersByTime(3000)

			manager.stop()

			// Advance well past the original timeout
			vi.advanceTimersByTime(10000)
			expect(manager.isLocked).toBe(false)
			expect(onLock).not.toHaveBeenCalled()
		})

		test('multiple starts do not create multiple timers', () => {
			const onLock = vi.fn()
			const manager = new AutoLockManager({ timeout: 5000, onLock })

			manager.start()
			manager.start() // should be a no-op
			manager.start() // should be a no-op

			vi.advanceTimersByTime(5000)

			// onLock should only fire once, not three times
			expect(onLock).toHaveBeenCalledTimes(1)
		})

		test('start resets locked state', () => {
			const onLock = vi.fn()
			const manager = new AutoLockManager({ timeout: 5000, onLock })

			manager.start()
			vi.advanceTimersByTime(5000)
			expect(manager.isLocked).toBe(true)

			// Stop and start again
			manager.stop()
			manager.start()
			expect(manager.isLocked).toBe(false)
		})
	})

	describe('reportActivity', () => {
		test('resets the inactivity timer', () => {
			const onLock = vi.fn()
			const manager = new AutoLockManager({ timeout: 5000, onLock })

			manager.start()

			// Advance 4 seconds (1 second left)
			vi.advanceTimersByTime(4000)
			expect(manager.isLocked).toBe(false)

			// Report activity, which resets the 5-second timer
			manager.reportActivity()

			// Advance another 4 seconds (would have been past the original timeout)
			vi.advanceTimersByTime(4000)
			expect(manager.isLocked).toBe(false)
			expect(onLock).not.toHaveBeenCalled()

			// Advance the remaining 1 second to complete the new timer
			vi.advanceTimersByTime(1000)
			expect(manager.isLocked).toBe(true)
			expect(onLock).toHaveBeenCalledTimes(1)
		})

		test('multiple rapid activities only keep one timer', () => {
			const onLock = vi.fn()
			const manager = new AutoLockManager({ timeout: 5000, onLock })

			manager.start()

			// Simulate rapid user interactions
			for (let i = 0; i < 100; i++) {
				vi.advanceTimersByTime(10)
				manager.reportActivity()
			}

			// Total elapsed: 1000ms of activity. Timer should have been reset each time.
			// Now advance 4999ms more (just under timeout from last activity)
			vi.advanceTimersByTime(4999)
			expect(manager.isLocked).toBe(false)

			// One more millisecond should trigger the lock
			vi.advanceTimersByTime(1)
			expect(manager.isLocked).toBe(true)
			expect(onLock).toHaveBeenCalledTimes(1)
		})

		test('does nothing when not running', () => {
			const onLock = vi.fn()
			const manager = new AutoLockManager({ timeout: 5000, onLock })

			// Not started yet
			manager.reportActivity()

			vi.advanceTimersByTime(10000)
			expect(manager.isLocked).toBe(false)
			expect(onLock).not.toHaveBeenCalled()
		})

		test('does nothing when already locked', () => {
			const onLock = vi.fn()
			const manager = new AutoLockManager({ timeout: 5000, onLock })

			manager.start()
			vi.advanceTimersByTime(5000)
			expect(manager.isLocked).toBe(true)
			expect(onLock).toHaveBeenCalledTimes(1)

			// Activity after lock should not restart the timer or call onLock again
			manager.reportActivity()
			vi.advanceTimersByTime(10000)
			expect(onLock).toHaveBeenCalledTimes(1)
		})
	})

	describe('manual lock', () => {
		test('locks immediately and calls onLock', () => {
			const onLock = vi.fn()
			const manager = new AutoLockManager({ timeout: 5000, onLock })

			manager.start()
			manager.lock()

			expect(manager.isLocked).toBe(true)
			expect(onLock).toHaveBeenCalledTimes(1)
		})

		test('clears the pending timer on manual lock', () => {
			const onLock = vi.fn()
			const manager = new AutoLockManager({ timeout: 5000, onLock })

			manager.start()
			manager.lock()

			// Advance past the original timeout
			vi.advanceTimersByTime(10000)

			// onLock should only have been called once (from manual lock), not twice
			expect(onLock).toHaveBeenCalledTimes(1)
		})

		test('calling lock when already locked does not invoke onLock again', () => {
			const onLock = vi.fn()
			const manager = new AutoLockManager({ timeout: 5000, onLock })

			manager.start()
			manager.lock()
			manager.lock()
			manager.lock()

			expect(onLock).toHaveBeenCalledTimes(1)
		})

		test('lock works even when not started', () => {
			const onLock = vi.fn()
			const manager = new AutoLockManager({ timeout: 5000, onLock })

			manager.lock()

			expect(manager.isLocked).toBe(true)
			expect(onLock).toHaveBeenCalledTimes(1)
		})
	})

	describe('unlock', () => {
		test('unlocks and restarts the timer when running', () => {
			const onLock = vi.fn()
			const manager = new AutoLockManager({ timeout: 5000, onLock })

			manager.start()
			vi.advanceTimersByTime(5000)
			expect(manager.isLocked).toBe(true)
			expect(onLock).toHaveBeenCalledTimes(1)

			manager.unlock()
			expect(manager.isLocked).toBe(false)

			// Timer should restart after unlock
			vi.advanceTimersByTime(5000)
			expect(manager.isLocked).toBe(true)
			expect(onLock).toHaveBeenCalledTimes(2)
		})

		test('unlock when not running just clears lock state', () => {
			const onLock = vi.fn()
			const manager = new AutoLockManager({ timeout: 5000, onLock })

			manager.lock()
			expect(manager.isLocked).toBe(true)

			manager.unlock()
			expect(manager.isLocked).toBe(false)

			// No timer should fire because manager was never started
			vi.advanceTimersByTime(10000)
			expect(manager.isLocked).toBe(false)
			expect(onLock).toHaveBeenCalledTimes(1) // only from the manual lock
		})
	})

	describe('timeout values', () => {
		test('works with very short timeout (1ms)', () => {
			const onLock = vi.fn()
			const manager = new AutoLockManager({ timeout: 1, onLock })

			manager.start()
			vi.advanceTimersByTime(1)

			expect(manager.isLocked).toBe(true)
			expect(onLock).toHaveBeenCalledTimes(1)
		})

		test('works with long timeout (1 hour)', () => {
			const onLock = vi.fn()
			const oneHour = 60 * 60 * 1000
			const manager = new AutoLockManager({ timeout: oneHour, onLock })

			manager.start()

			vi.advanceTimersByTime(oneHour - 1)
			expect(manager.isLocked).toBe(false)

			vi.advanceTimersByTime(1)
			expect(manager.isLocked).toBe(true)
			expect(onLock).toHaveBeenCalledTimes(1)
		})
	})
})
