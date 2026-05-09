import type { KoraEvent, KoraEventByType, KoraEventEmitter } from '@korajs/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncMetricsCollector } from './metrics-collector'

function createMockTimeSource(start = 1000): { now: () => number; advance: (ms: number) => void } {
	let current = start
	return {
		now: () => current,
		advance: (ms: number) => {
			current += ms
		},
	}
}

function createMockEmitter(): KoraEventEmitter & { events: KoraEvent[] } {
	const events: KoraEvent[] = []
	return {
		events,
		on: vi.fn(() => () => {}),
		off: vi.fn(),
		emit: (event: KoraEvent) => {
			events.push(event)
		},
	}
}

describe('SyncMetricsCollector', () => {
	let time: ReturnType<typeof createMockTimeSource>
	let collector: SyncMetricsCollector
	let emitter: ReturnType<typeof createMockEmitter>

	beforeEach(() => {
		vi.useFakeTimers()
		time = createMockTimeSource()
		emitter = createMockEmitter()
		collector = new SyncMetricsCollector({
			rttWindowSize: 100,
			bandwidthWindowSize: 20,
			diagnosticsInterval: 5000,
			timeSource: time,
		})
		collector.attachEmitter(emitter)
	})

	afterEach(() => {
		collector.dispose()
		vi.useRealTimers()
	})

	describe('initial state', () => {
		it('returns sensible defaults for an empty collector', () => {
			const snapshot = collector.getSnapshot()
			expect(snapshot.status).toBe('offline')
			expect(snapshot.connectedAt).toBeNull()
			expect(snapshot.disconnectedAt).toBeNull()
			expect(snapshot.reconnectAttempts).toBe(0)
			expect(snapshot.rttMs).toBe(0)
			expect(snapshot.rttP50Ms).toBe(0)
			expect(snapshot.rttP95Ms).toBe(0)
			expect(snapshot.rttP99Ms).toBe(0)
			expect(snapshot.operationsSent).toBe(0)
			expect(snapshot.operationsReceived).toBe(0)
			expect(snapshot.bytesSent).toBe(0)
			expect(snapshot.bytesReceived).toBe(0)
			expect(snapshot.pendingOperations).toBe(0)
			expect(snapshot.outboundQueueSize).toBe(0)
			expect(snapshot.lastSyncedAt).toBeNull()
			expect(snapshot.syncDuration).toBeNull()
			expect(snapshot.initialSyncComplete).toBe(false)
			expect(snapshot.initialSyncProgress).toBe(0)
			expect(snapshot.lastError).toBeNull()
			expect(snapshot.errorCount).toBe(0)
			expect(snapshot.quality).toBe('offline')
			expect(snapshot.effectiveBandwidth).toBeNull()
		})
	})

	describe('connection tracking', () => {
		it('records connected timestamp', () => {
			collector.recordConnected()
			expect(collector.getSnapshot().connectedAt).toBe(1000)
		})

		it('records disconnected timestamp', () => {
			collector.recordConnected()
			time.advance(500)
			collector.recordDisconnected()
			expect(collector.getSnapshot().disconnectedAt).toBe(1500)
		})

		it('resets reconnect attempts on successful connection', () => {
			collector.recordReconnectAttempt()
			collector.recordReconnectAttempt()
			collector.recordReconnectAttempt()
			expect(collector.getSnapshot().reconnectAttempts).toBe(3)

			collector.recordConnected()
			expect(collector.getSnapshot().reconnectAttempts).toBe(0)
		})

		it('increments reconnect attempts', () => {
			collector.recordReconnectAttempt()
			expect(collector.getSnapshot().reconnectAttempts).toBe(1)
			collector.recordReconnectAttempt()
			expect(collector.getSnapshot().reconnectAttempts).toBe(2)
		})
	})

	describe('RTT percentile tracking', () => {
		it('tracks latest RTT', () => {
			collector.recordRtt(50)
			expect(collector.getSnapshot().rttMs).toBe(50)

			collector.recordRtt(120)
			expect(collector.getSnapshot().rttMs).toBe(120)
		})

		it('computes p50, p95, p99 from multiple samples', () => {
			// Add 100 samples: 1ms through 100ms
			for (let i = 1; i <= 100; i++) {
				collector.recordRtt(i)
			}

			const snapshot = collector.getSnapshot()
			expect(snapshot.rttP50Ms).toBe(50)
			expect(snapshot.rttP95Ms).toBe(95)
			expect(snapshot.rttP99Ms).toBe(99)
		})

		it('handles uniform RTT values', () => {
			for (let i = 0; i < 50; i++) {
				collector.recordRtt(42)
			}

			const snapshot = collector.getSnapshot()
			expect(snapshot.rttMs).toBe(42)
			expect(snapshot.rttP50Ms).toBe(42)
			expect(snapshot.rttP95Ms).toBe(42)
			expect(snapshot.rttP99Ms).toBe(42)
		})
	})

	describe('throughput tracking', () => {
		it('accumulates operations sent', () => {
			collector.recordSent(5, 500, 100)
			collector.recordSent(3, 300, 50)

			const snapshot = collector.getSnapshot()
			expect(snapshot.operationsSent).toBe(8)
			expect(snapshot.bytesSent).toBe(800)
		})

		it('accumulates operations received', () => {
			collector.recordReceived(10, 1000, 200)
			collector.recordReceived(7, 700, 150)

			const snapshot = collector.getSnapshot()
			expect(snapshot.operationsReceived).toBe(17)
			expect(snapshot.bytesReceived).toBe(1700)
		})

		it('emits bandwidth events on send', () => {
			collector.recordSent(5, 500, 100)
			time.advance(200)
			collector.recordSent(5, 500, 100)

			const bwEvents = emitter.events.filter((e) => e.type === 'sync:bandwidth')
			// First send doesn't emit (needs >= 2 samples), second does
			expect(bwEvents.length).toBe(1)
			expect((bwEvents[0] as KoraEventByType<'sync:bandwidth'>).direction).toBe('out')
		})

		it('emits bandwidth events on receive', () => {
			collector.recordReceived(5, 500, 100)
			time.advance(200)
			collector.recordReceived(5, 500, 100)

			const bwEvents = emitter.events.filter((e) => e.type === 'sync:bandwidth')
			expect(bwEvents.length).toBe(1)
			expect((bwEvents[0] as KoraEventByType<'sync:bandwidth'>).direction).toBe('in')
		})
	})

	describe('queue tracking', () => {
		it('updates pending operations and queue size', () => {
			collector.updateQueue(5, 2500)
			const snapshot = collector.getSnapshot()
			expect(snapshot.pendingOperations).toBe(5)
			expect(snapshot.outboundQueueSize).toBe(2500)
		})
	})

	describe('sync progress tracking', () => {
		it('tracks sync duration', () => {
			collector.recordSyncStarted()
			time.advance(350)
			collector.recordSyncCompleted()

			const snapshot = collector.getSnapshot()
			expect(snapshot.syncDuration).toBe(350)
			expect(snapshot.lastSyncedAt).toBe(1350)
		})

		it('marks initial sync as complete after first sync', () => {
			expect(collector.getSnapshot().initialSyncComplete).toBe(false)

			collector.recordSyncStarted()
			time.advance(1000)
			collector.recordSyncCompleted()

			expect(collector.getSnapshot().initialSyncComplete).toBe(true)
			expect(collector.getSnapshot().initialSyncProgress).toBe(1)
		})

		it('tracks initial sync progress with known total batches', () => {
			collector.updateInitialSyncProgress(2, 10)
			expect(collector.getSnapshot().initialSyncProgress).toBeCloseTo(0.2)

			collector.updateInitialSyncProgress(5, 10)
			expect(collector.getSnapshot().initialSyncProgress).toBeCloseTo(0.5)

			collector.updateInitialSyncProgress(10, 10)
			expect(collector.getSnapshot().initialSyncProgress).toBeCloseTo(1)
		})

		it('emits initial-sync-progress events', () => {
			collector.updateInitialSyncProgress(3, 10)

			const progressEvents = emitter.events.filter((e) => e.type === 'sync:initial-sync-progress')
			expect(progressEvents.length).toBe(1)

			const evt = progressEvents[0] as KoraEventByType<'sync:initial-sync-progress'>
			expect(evt.progress).toBeCloseTo(0.3)
			expect(evt.totalBatches).toBe(10)
			expect(evt.receivedBatches).toBe(3)
		})

		it('reports 0.5 progress when total batches unknown but some received', () => {
			collector.updateInitialSyncProgress(3, 0)
			expect(collector.getSnapshot().initialSyncProgress).toBe(0.5)
		})

		it('reports 0 progress when nothing received and total unknown', () => {
			collector.updateInitialSyncProgress(0, 0)
			expect(collector.getSnapshot().initialSyncProgress).toBe(0)
		})
	})

	describe('error tracking', () => {
		it('records errors with messages', () => {
			collector.recordError('Connection reset')
			const snapshot = collector.getSnapshot()
			expect(snapshot.lastError).toBe('Connection reset')
			expect(snapshot.errorCount).toBe(1)
		})

		it('accumulates error count', () => {
			collector.recordError('Error 1')
			collector.recordError('Error 2')
			collector.recordError('Error 3')

			const snapshot = collector.getSnapshot()
			expect(snapshot.lastError).toBe('Error 3')
			expect(snapshot.errorCount).toBe(3)
		})
	})

	describe('quality assessment', () => {
		it('returns offline when status is offline', () => {
			collector.updateStatus('offline')
			expect(collector.assessQuality()).toBe('offline')
		})

		it('returns excellent for low RTT and no errors', () => {
			collector.updateStatus('synced')
			for (let i = 0; i < 10; i++) {
				collector.recordRtt(30 + i)
			}
			expect(collector.assessQuality()).toBe('excellent')
		})

		it('returns good for moderate RTT', () => {
			collector.updateStatus('synced')
			for (let i = 0; i < 10; i++) {
				collector.recordRtt(150 + i)
			}
			expect(collector.assessQuality()).toBe('good')
		})

		it('returns fair for high RTT', () => {
			collector.updateStatus('synced')
			for (let i = 0; i < 10; i++) {
				collector.recordRtt(500 + i)
			}
			expect(collector.assessQuality()).toBe('fair')
		})

		it('returns poor for very high RTT', () => {
			collector.updateStatus('synced')
			for (let i = 0; i < 10; i++) {
				collector.recordRtt(2000 + i)
			}
			expect(collector.assessQuality()).toBe('poor')
		})

		it('returns poor when error count exceeds threshold', () => {
			collector.updateStatus('synced')
			for (let i = 0; i < 10; i++) {
				collector.recordRtt(30) // low RTT
			}
			// But many errors
			collector.recordError('e1')
			collector.recordError('e2')
			collector.recordError('e3')
			collector.recordError('e4')

			expect(collector.assessQuality()).toBe('poor')
		})

		it('degrades from excellent to good with a single error', () => {
			collector.updateStatus('synced')
			for (let i = 0; i < 10; i++) {
				collector.recordRtt(50)
			}
			expect(collector.assessQuality()).toBe('excellent')

			collector.recordError('transient')
			// p95 < 100 but errorCount > 0, so not excellent
			// p95 < 300 and errorCount <= 1, so good
			expect(collector.assessQuality()).toBe('good')
		})

		it('transitions excellent -> good -> fair -> poor', () => {
			collector.updateStatus('synced')

			// excellent
			for (let i = 0; i < 20; i++) collector.recordRtt(30)
			expect(collector.assessQuality()).toBe('excellent')

			// good: increase RTT past 100ms threshold
			collector = new SyncMetricsCollector({
				rttWindowSize: 100,
				timeSource: time,
			})
			collector.updateStatus('synced')
			for (let i = 0; i < 20; i++) collector.recordRtt(200)
			expect(collector.assessQuality()).toBe('good')

			// fair: increase RTT past 300ms threshold
			collector = new SyncMetricsCollector({
				rttWindowSize: 100,
				timeSource: time,
			})
			collector.updateStatus('synced')
			for (let i = 0; i < 20; i++) collector.recordRtt(500)
			expect(collector.assessQuality()).toBe('fair')

			// poor: increase RTT past 1000ms threshold
			collector = new SyncMetricsCollector({
				rttWindowSize: 100,
				timeSource: time,
			})
			collector.updateStatus('synced')
			for (let i = 0; i < 20; i++) collector.recordRtt(1500)
			expect(collector.assessQuality()).toBe('poor')
		})

		it('falls back to error-based assessment when no RTT samples', () => {
			collector.updateStatus('synced')
			expect(collector.assessQuality()).toBe('good') // no errors, no samples

			collector.recordError('e1')
			expect(collector.assessQuality()).toBe('fair')

			collector.recordError('e2')
			collector.recordError('e3')
			collector.recordError('e4')
			expect(collector.assessQuality()).toBe('poor')
		})
	})

	describe('effective bandwidth', () => {
		it('returns null when no bandwidth data', () => {
			expect(collector.getSnapshot().effectiveBandwidth).toBeNull()
		})

		it('returns bandwidth estimate when enough samples exist', () => {
			// Send data
			collector.recordSent(10, 1000, 100) // 10,000 B/s
			time.advance(200)
			collector.recordSent(10, 1000, 100)

			// Receive data
			collector.recordReceived(10, 2000, 100) // 20,000 B/s
			time.advance(200)
			collector.recordReceived(10, 2000, 100)

			const bw = collector.getSnapshot().effectiveBandwidth
			expect(bw).not.toBeNull()
			// Effective bandwidth is min(inbound, outbound) = min(20000, 10000) = 10000
			expect(bw).toBe(10000)
		})

		it('returns outbound only if no inbound data', () => {
			collector.recordSent(10, 1000, 100)
			time.advance(200)
			collector.recordSent(10, 1000, 100)

			const bw = collector.getSnapshot().effectiveBandwidth
			expect(bw).toBe(10000)
		})

		it('returns inbound only if no outbound data', () => {
			collector.recordReceived(10, 2000, 100)
			time.advance(200)
			collector.recordReceived(10, 2000, 100)

			const bw = collector.getSnapshot().effectiveBandwidth
			expect(bw).toBe(20000)
		})
	})

	describe('periodic emission', () => {
		it('emits diagnostics events at configured interval while connected', () => {
			collector.recordConnected()

			// No events emitted immediately
			const initialCount = emitter.events.filter((e) => e.type === 'sync:diagnostics').length
			expect(initialCount).toBe(0)

			// Advance timer past interval
			vi.advanceTimersByTime(5000)

			const afterCount = emitter.events.filter((e) => e.type === 'sync:diagnostics').length
			expect(afterCount).toBe(1)

			// Advance again
			vi.advanceTimersByTime(5000)

			const laterCount = emitter.events.filter((e) => e.type === 'sync:diagnostics').length
			expect(laterCount).toBe(2)
		})

		it('stops periodic emission on disconnect', () => {
			collector.recordConnected()
			vi.advanceTimersByTime(5000)

			collector.recordDisconnected()
			vi.advanceTimersByTime(15000)

			// Should have only 1 event from before disconnect
			const count = emitter.events.filter((e) => e.type === 'sync:diagnostics').length
			expect(count).toBe(1)
		})

		it('does not emit when no emitter is attached', () => {
			const noEmitterCollector = new SyncMetricsCollector({
				diagnosticsInterval: 5000,
				timeSource: time,
			})

			noEmitterCollector.recordConnected()
			vi.advanceTimersByTime(5000)

			// No crash, no emissions
			noEmitterCollector.dispose()
		})
	})

	describe('status updates', () => {
		it('reflects status changes in snapshot', () => {
			collector.updateStatus('syncing')
			expect(collector.getSnapshot().status).toBe('syncing')

			collector.updateStatus('synced')
			expect(collector.getSnapshot().status).toBe('synced')

			collector.updateStatus('error')
			expect(collector.getSnapshot().status).toBe('error')
		})
	})

	describe('quality updates', () => {
		it('reflects quality changes in snapshot', () => {
			collector.updateQuality('excellent')
			expect(collector.getSnapshot().quality).toBe('excellent')

			collector.updateQuality('poor')
			expect(collector.getSnapshot().quality).toBe('poor')
		})
	})

	describe('reset', () => {
		it('clears all metrics to initial state', () => {
			// Set up various metrics
			collector.recordConnected()
			collector.recordRtt(100)
			collector.recordSent(10, 1000, 100)
			collector.recordReceived(5, 500, 50)
			collector.updateQueue(3, 1500)
			collector.recordSyncStarted()
			time.advance(200)
			collector.recordSyncCompleted()
			collector.recordError('test error')
			collector.updateStatus('synced')
			collector.updateQuality('good')

			collector.reset()

			const snapshot = collector.getSnapshot()
			expect(snapshot.status).toBe('offline')
			expect(snapshot.connectedAt).toBeNull()
			expect(snapshot.disconnectedAt).toBeNull()
			expect(snapshot.reconnectAttempts).toBe(0)
			expect(snapshot.rttMs).toBe(0)
			expect(snapshot.rttP50Ms).toBe(0)
			expect(snapshot.operationsSent).toBe(0)
			expect(snapshot.operationsReceived).toBe(0)
			expect(snapshot.bytesSent).toBe(0)
			expect(snapshot.bytesReceived).toBe(0)
			expect(snapshot.pendingOperations).toBe(0)
			expect(snapshot.outboundQueueSize).toBe(0)
			expect(snapshot.lastSyncedAt).toBeNull()
			expect(snapshot.syncDuration).toBeNull()
			expect(snapshot.initialSyncComplete).toBe(false)
			expect(snapshot.lastError).toBeNull()
			expect(snapshot.errorCount).toBe(0)
			expect(snapshot.quality).toBe('offline')
			expect(snapshot.effectiveBandwidth).toBeNull()
		})
	})

	describe('dispose', () => {
		it('stops periodic emission and detaches emitter', () => {
			collector.recordConnected()
			collector.dispose()

			vi.advanceTimersByTime(10000)

			// No diagnostics events after dispose
			const count = emitter.events.filter((e) => e.type === 'sync:diagnostics').length
			expect(count).toBe(0)
		})
	})

	describe('bandwidth estimation accuracy with known payloads', () => {
		it('estimates accurately for consistent payload sizes', () => {
			// Simulate 10 transfers of 1KB each taking 10ms (100 KB/s = 102,400 B/s)
			for (let i = 0; i < 10; i++) {
				collector.recordSent(1, 1024, 10)
				time.advance(50)
			}

			const bw = collector.getSnapshot().effectiveBandwidth
			expect(bw).not.toBeNull()
			// Should be approximately 102,400 B/s (1024 / 0.01)
			expect(bw).toBeGreaterThan(95000)
			expect(bw).toBeLessThan(110000)
		})
	})
})
