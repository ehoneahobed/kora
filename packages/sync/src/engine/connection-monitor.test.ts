import { describe, expect, test } from 'vitest'
import { ConnectionMonitor } from './connection-monitor'

function createTimeSource(startTime = 1000) {
	let now = startTime
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms
		},
	}
}

describe('ConnectionMonitor', () => {
	test('defaults to good quality with no data', () => {
		const monitor = new ConnectionMonitor()
		expect(monitor.getQuality()).toBe('good')
	})

	test('reports excellent for low latency and 0 missed acks', () => {
		const monitor = new ConnectionMonitor()
		monitor.recordLatency(50)
		monitor.recordLatency(60)
		monitor.recordLatency(40)
		expect(monitor.getQuality()).toBe('excellent')
	})

	test('reports good for moderate latency', () => {
		const monitor = new ConnectionMonitor()
		monitor.recordLatency(150)
		monitor.recordLatency(200)
		expect(monitor.getQuality()).toBe('good')
	})

	test('reports fair for higher latency', () => {
		const monitor = new ConnectionMonitor()
		monitor.recordLatency(500)
		monitor.recordLatency(800)
		expect(monitor.getQuality()).toBe('fair')
	})

	test('reports poor for very high latency', () => {
		const monitor = new ConnectionMonitor()
		monitor.recordLatency(3000)
		monitor.recordLatency(4000)
		expect(monitor.getQuality()).toBe('poor')
	})

	test('missed acks degrade quality', () => {
		const monitor = new ConnectionMonitor()
		monitor.recordLatency(50) // Would be excellent
		monitor.recordMissedAck()
		monitor.recordMissedAck()
		monitor.recordMissedAck()
		monitor.recordMissedAck() // 4 missed acks
		expect(monitor.getQuality()).toBe('poor')
	})

	test('successful latency resets missed acks', () => {
		const monitor = new ConnectionMonitor()
		monitor.recordMissedAck()
		monitor.recordMissedAck()
		monitor.recordMissedAck()
		monitor.recordLatency(50) // Resets missed acks
		expect(monitor.getQuality()).toBe('excellent')
	})

	test('reports offline when no activity for staleThreshold', () => {
		const ts = createTimeSource()
		const monitor = new ConnectionMonitor({
			staleThreshold: 30000,
			timeSource: ts,
		})

		monitor.recordLatency(50) // Activity at time 1000

		ts.advance(31000) // 31 seconds later
		expect(monitor.getQuality()).toBe('offline')
	})

	test('activity prevents offline status', () => {
		const ts = createTimeSource()
		const monitor = new ConnectionMonitor({
			staleThreshold: 30000,
			timeSource: ts,
		})

		ts.advance(29000) // Almost stale
		monitor.recordActivity() // Resets activity timer

		ts.advance(29000) // Another 29 seconds — still within threshold
		expect(monitor.getQuality()).not.toBe('offline')
	})

	test('rolling window limits samples', () => {
		const monitor = new ConnectionMonitor({ windowSize: 3 })

		// Add 3 high latency samples
		monitor.recordLatency(5000)
		monitor.recordLatency(5000)
		monitor.recordLatency(5000)
		expect(monitor.getQuality()).toBe('poor')

		// Add 3 low latency samples, pushing out the old ones
		monitor.recordLatency(50)
		monitor.recordLatency(50)
		monitor.recordLatency(50)
		expect(monitor.getQuality()).toBe('excellent')
	})

	test('reset clears all metrics', () => {
		const monitor = new ConnectionMonitor()
		monitor.recordLatency(5000)
		monitor.recordMissedAck()
		monitor.recordMissedAck()
		monitor.recordMissedAck()
		monitor.recordMissedAck()

		monitor.reset()

		expect(monitor.getQuality()).toBe('good')
		expect(monitor.getAverageLatency()).toBeNull()
		expect(monitor.getMissedAcks()).toBe(0)
	})

	test('getAverageLatency returns null with no samples', () => {
		const monitor = new ConnectionMonitor()
		expect(monitor.getAverageLatency()).toBeNull()
	})

	test('getAverageLatency computes correctly', () => {
		const monitor = new ConnectionMonitor()
		monitor.recordLatency(100)
		monitor.recordLatency(200)
		monitor.recordLatency(300)
		expect(monitor.getAverageLatency()).toBe(200)
	})

	test('1 missed ack still allows good quality', () => {
		const monitor = new ConnectionMonitor()
		monitor.recordLatency(150)
		monitor.recordMissedAck() // Only 1
		expect(monitor.getQuality()).toBe('good')
	})

	test('poor quality with no samples but many missed acks', () => {
		const monitor = new ConnectionMonitor()
		monitor.recordMissedAck()
		monitor.recordMissedAck()
		monitor.recordMissedAck()
		monitor.recordMissedAck()
		expect(monitor.getQuality()).toBe('poor')
	})
})
