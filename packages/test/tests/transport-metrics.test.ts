import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { createTransportMetrics } from '../src/transport-metrics'

describe('createTransportMetrics', () => {
	test('counts connections, messages, and bytes in both directions', async () => {
		const base = createServerTransportPair()
		const instrumentation = createTransportMetrics()
		const pair = instrumentation.wrapTransport({
			client: base.client as unknown as SyncTransport,
			serverTransport: base.server,
		})
		pair.serverTransport.onMessage(() => {})
		pair.client.onMessage(() => {})
		await pair.client.connect('ws://test')

		const message = {
			type: 'acknowledgment',
			messageId: 'm1',
			acknowledgedMessageId: 'm0',
			lastSequenceNumber: 1,
		} satisfies SyncMessage
		pair.client.send(message)
		pair.serverTransport.send(message)

		expect(instrumentation.metrics.connectionAttempts).toBe(1)
		expect(instrumentation.metrics.clientMessages).toBe(1)
		expect(instrumentation.metrics.serverMessages).toBe(1)
		expect(instrumentation.metrics.clientBytes).toBeGreaterThan(0)
		expect(instrumentation.metrics.serverBytes).toBeGreaterThan(0)
	})
})
