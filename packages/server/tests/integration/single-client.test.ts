import { describe, expect, test, vi } from 'vitest'
import { createTestOperations, setupTestServer } from '../fixtures/test-helpers'

describe('Single client sync', () => {
	test('client connects and completes handshake to streaming', async () => {
		const { connectClient } = setupTestServer()
		const client = await connectClient('client-1')

		await client.handshake()
		await client.waitForStreaming()

		const response = client.messages.find((m) => m.type === 'handshake-response')
		expect(response).toBeDefined()
		if (response?.type === 'handshake-response') {
			expect(response.accepted).toBe(true)
		}
	})

	test('client operations sync to empty server', async () => {
		const { store, connectClient } = setupTestServer()
		const ops = createTestOperations(3, 'client-1')
		const client = await connectClient('client-1', ops)

		await client.handshake()
		await client.waitForStreaming()

		// Client sends its operations
		client.sendOps(ops)

		await vi.waitFor(async () => {
			expect(await store.getOperationCount()).toBe(3)
		})

		const serverOps = store.getAllOperations()
		expect(serverOps.map((o) => o.id)).toEqual(ops.map((o) => o.id))
	})

	test('server operations sync to empty client', async () => {
		const { store, connectClient } = setupTestServer()

		// Pre-populate server
		const serverOps = createTestOperations(3, 'node-a')
		for (const op of serverOps) {
			await store.applyRemoteOperation(op)
		}

		const client = await connectClient('client-1')
		await client.handshake()
		await client.waitForStreaming()

		// Client should receive the server's operations in delta
		const received = client.getReceivedOperations()
		expect(received).toHaveLength(3)
		expect(received.map((o) => o.id).sort()).toEqual(serverOps.map((o) => o.id).sort())
	})

	test('bidirectional delta: both have different ops', async () => {
		const { store, connectClient } = setupTestServer()

		// Server has ops from node-a
		const serverOps = createTestOperations(2, 'node-a')
		for (const op of serverOps) {
			await store.applyRemoteOperation(op)
		}

		// Client has ops from client-1
		const clientOps = createTestOperations(2, 'client-1')
		const client = await connectClient('client-1', clientOps)

		await client.handshake()
		await client.waitForStreaming()

		// Client should receive server's ops
		const received = client.getReceivedOperations()
		expect(received).toHaveLength(2)

		// Now client sends its ops to server
		client.sendOps(clientOps)

		await vi.waitFor(async () => {
			// Server should have all 4 ops
			expect(await store.getOperationCount()).toBe(4)
		})
	})

	test('duplicate operations are deduplicated', async () => {
		const { store, connectClient } = setupTestServer()

		const ops = createTestOperations(2, 'client-1')
		const client = await connectClient('client-1')

		await client.handshake()
		await client.waitForStreaming()

		// Send same ops twice
		client.sendOps(ops)

		await vi.waitFor(async () => {
			expect(await store.getOperationCount()).toBe(2)
		})

		client.sendOps(ops)

		// Wait a bit and verify count doesn't change
		await new Promise((r) => setTimeout(r, 100))
		expect(await store.getOperationCount()).toBe(2)
	})

	test('empty sync when both up-to-date', async () => {
		const { store, connectClient } = setupTestServer()

		// Both server and client have the same ops
		const ops = createTestOperations(2, 'node-a')
		for (const op of ops) {
			await store.applyRemoteOperation(op)
		}

		const client = await connectClient('client-1')
		// Client claims it already has all node-a ops
		await client.handshake({ 'node-a': 2 })
		await client.waitForStreaming()

		// Client should receive empty delta (just the final batch marker)
		const batches = client.messages.filter((m) => m.type === 'operation-batch')
		expect(batches).toHaveLength(1)
		if (batches[0]?.type === 'operation-batch') {
			expect(batches[0].operations).toHaveLength(0)
			expect(batches[0].isFinal).toBe(true)
		}
	})

	test('streaming: client pushes new op after initial sync', async () => {
		const { store, connectClient } = setupTestServer()
		const client = await connectClient('client-1')

		await client.handshake()
		await client.waitForStreaming()

		// Send new op during streaming phase
		const op = createTestOperations(1, 'client-1')[0]
		if (op) {
			client.sendOps([op])

			await vi.waitFor(async () => {
				expect(await store.getOperationCount()).toBe(1)
			})

			// Should receive acknowledgment
			const acks = client.messages.filter((m) => m.type === 'acknowledgment')
			expect(acks.length).toBeGreaterThanOrEqual(1)
		}
	})

	test('client disconnect cleans up session', async () => {
		const { server, connectClient } = setupTestServer()
		const client = await connectClient('client-1')

		await client.handshake()
		await client.waitForStreaming()

		expect(server.getConnectionCount()).toBe(1)

		client.disconnect()
		expect(server.getConnectionCount()).toBe(0)
	})
})
