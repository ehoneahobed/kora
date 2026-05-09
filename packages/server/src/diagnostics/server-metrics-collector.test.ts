import { describe, expect, it } from 'vitest'
import { ServerMetricsCollector } from './server-metrics-collector'

describe('ServerMetricsCollector', () => {
	it('starts with zero metrics', () => {
		const collector = new ServerMetricsCollector()
		const snapshot = collector.getSnapshot(0)

		expect(snapshot.connectedClients).toBe(0)
		expect(snapshot.peakConnections).toBe(0)
		expect(snapshot.connectionsTotal).toBe(0)
		expect(snapshot.operationsReceived).toBe(0)
		expect(snapshot.operationsSent).toBe(0)
		expect(snapshot.bytesReceived).toBe(0)
		expect(snapshot.bytesSent).toBe(0)
		expect(snapshot.errorCount).toBe(0)
		expect(snapshot.totalOperations).toBe(0)
		expect(snapshot.clients).toEqual([])
		expect(snapshot.connectedNodeIds).toEqual([])
	})

	it('tracks connection and disconnection', () => {
		const collector = new ServerMetricsCollector()

		collector.recordConnection('session-1')
		expect(collector.getSnapshot(0).connectedClients).toBe(1)
		expect(collector.getSnapshot(0).connectionsTotal).toBe(1)
		expect(collector.getSnapshot(0).peakConnections).toBe(1)

		collector.recordConnection('session-2')
		expect(collector.getSnapshot(0).connectedClients).toBe(2)
		expect(collector.getSnapshot(0).peakConnections).toBe(2)

		collector.recordDisconnection('session-1')
		expect(collector.getSnapshot(0).connectedClients).toBe(1)
		// Peak should remain 2
		expect(collector.getSnapshot(0).peakConnections).toBe(2)
		// Total should remain 2
		expect(collector.getSnapshot(0).connectionsTotal).toBe(2)
	})

	it('tracks handshake node IDs', () => {
		const collector = new ServerMetricsCollector()
		collector.recordConnection('session-1')
		collector.recordHandshake('session-1', 'node-a1b2')

		const snapshot = collector.getSnapshot(0)
		expect(snapshot.connectedNodeIds).toEqual(['node-a1b2'])
	})

	it('tracks operations received and sent', () => {
		const collector = new ServerMetricsCollector()
		collector.recordConnection('session-1')

		collector.recordReceived('session-1', 5, 1000)
		collector.recordReceived('session-1', 3, 500)

		let snapshot = collector.getSnapshot(0)
		expect(snapshot.operationsReceived).toBe(8)
		expect(snapshot.bytesReceived).toBe(1500)

		collector.recordSent('session-1', 2, 400)
		snapshot = collector.getSnapshot(0)
		expect(snapshot.operationsSent).toBe(2)
		expect(snapshot.bytesSent).toBe(400)
	})

	it('tracks per-client metrics', () => {
		const collector = new ServerMetricsCollector()
		collector.recordConnection('session-1')
		collector.recordHandshake('session-1', 'node-x')
		collector.recordReceived('session-1', 10, 2000)
		collector.recordSent('session-1', 5, 1000)

		const snapshot = collector.getSnapshot(0)
		const client = snapshot.clients.find((c) => c.sessionId === 'session-1')
		expect(client).not.toBeNull()
		expect(client!.nodeId).toBe('node-x')
		expect(client!.operationsReceived).toBe(10)
		expect(client!.operationsSent).toBe(5)
		expect(client!.state).toBe('connected')
	})

	it('updates session state', () => {
		const collector = new ServerMetricsCollector()
		collector.recordConnection('session-1')
		collector.updateSessionState('session-1', 'streaming')

		const snapshot = collector.getSnapshot(0)
		const client = snapshot.clients.find((c) => c.sessionId === 'session-1')
		expect(client!.state).toBe('streaming')
	})

	it('tracks errors', () => {
		const collector = new ServerMetricsCollector()
		collector.recordError()
		collector.recordError()
		collector.recordError()

		expect(collector.getSnapshot(0).errorCount).toBe(3)
	})

	it('tracks schema version', () => {
		const collector = new ServerMetricsCollector()
		collector.setSchemaVersion(3)
		expect(collector.getSnapshot(0).schemaVersion).toBe(3)
	})

	it('tracks uptime', () => {
		const collector = new ServerMetricsCollector()
		const snapshot = collector.getSnapshot(0)
		expect(snapshot.uptime).toBeGreaterThanOrEqual(0)
	})

	it('supports reset', () => {
		const collector = new ServerMetricsCollector()
		collector.recordConnection('session-1')
		collector.recordReceived('session-1', 10, 1000)
		collector.recordError()

		collector.reset()

		const snapshot = collector.getSnapshot(0)
		expect(snapshot.connectedClients).toBe(0)
		expect(snapshot.peakConnections).toBe(0)
		expect(snapshot.connectionsTotal).toBe(0)
		expect(snapshot.operationsReceived).toBe(0)
		expect(snapshot.errorCount).toBe(0)
	})
})
