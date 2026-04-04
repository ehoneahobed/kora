import { describe, expect, test, vi } from 'vitest'
import { createTestOperations, setupTestServer } from '../fixtures/test-helpers'

describe('Reconnection', () => {
	test('client disconnects, reconnects with new transport, resumes from version vector', async () => {
		const { store, connectClient } = setupTestServer()

		// Client A connects and pushes 3 ops
		const clientA1 = await connectClient('client-a')
		await clientA1.handshake()
		await clientA1.waitForStreaming()

		const ops = createTestOperations(3, 'client-a')
		clientA1.sendOps(ops)

		await vi.waitFor(async () => {
			expect(await store.getOperationCount()).toBe(3)
		})

		// Disconnect
		clientA1.disconnect()

		// Meanwhile, server receives ops from another source
		const otherOps = createTestOperations(2, 'node-b')
		for (const op of otherOps) {
			await store.applyRemoteOperation(op)
		}

		// Reconnect with version vector that knows about client-a's ops
		const clientA2 = await connectClient('client-a')
		await clientA2.handshake({ 'client-a': 3 })
		await clientA2.waitForStreaming()

		// Should receive only the 2 new ops from node-b
		const received = clientA2.getReceivedOperations()
		expect(received).toHaveLength(2)
		expect(received.every((op) => op.nodeId === 'node-b')).toBe(true)
	})

	test('client makes offline changes, reconnects, only new ops sync', async () => {
		const { store, connectClient } = setupTestServer()

		// Client connects, gets initial state
		const client1 = await connectClient('client-a')
		await client1.handshake()
		await client1.waitForStreaming()
		client1.disconnect()

		// Client creates ops "offline" and reconnects
		const offlineOps = createTestOperations(5, 'client-a')
		const client2 = await connectClient('client-a')
		await client2.handshake() // Empty version vector — new connection
		await client2.waitForStreaming()

		// Send offline ops
		client2.sendOps(offlineOps)

		await vi.waitFor(async () => {
			expect(await store.getOperationCount()).toBe(5)
		})

		// All 5 should be on server
		const serverOps = store.getAllOperations()
		expect(serverOps.map((o) => o.id).sort()).toEqual(offlineOps.map((o) => o.id).sort())
	})

	test('server gets ops from other clients while one disconnected; reconnecting client gets delta', async () => {
		const { store, connectClient } = setupTestServer()

		// Client A connects and goes to streaming
		const clientA = await connectClient('client-a')
		await clientA.handshake()
		await clientA.waitForStreaming()
		clientA.disconnect()

		// While A is disconnected, client B connects and pushes ops
		const clientB = await connectClient('client-b')
		await clientB.handshake()
		await clientB.waitForStreaming()

		const bOps = createTestOperations(4, 'client-b')
		clientB.sendOps(bOps)

		await vi.waitFor(async () => {
			expect(await store.getOperationCount()).toBe(4)
		})

		// Client A reconnects — should receive B's 4 ops in delta
		const clientA2 = await connectClient('client-a')
		await clientA2.handshake() // Empty vector — doesn't know about B's ops
		await clientA2.waitForStreaming()

		const received = clientA2.getReceivedOperations()
		expect(received).toHaveLength(4)
		expect(received.every((op) => op.nodeId === 'client-b')).toBe(true)
	})
})
