import { describe, expect, test, vi } from 'vitest'
import { createTestOperations, setupTestServer } from '../fixtures/test-helpers'

describe('Multi-client sync', () => {
	test('two clients converge after exchanging different ops', async () => {
		const { store, connectClient } = setupTestServer()

		// Client A has its own ops
		const opsA = createTestOperations(3, 'client-a')
		const clientA = await connectClient('client-a', opsA)

		// Client B has its own ops
		const opsB = createTestOperations(3, 'client-b')
		const clientB = await connectClient('client-b', opsB)

		// Both handshake
		await clientA.handshake()
		await clientA.waitForStreaming()

		await clientB.handshake()
		await clientB.waitForStreaming()

		// Both send their ops to server
		clientA.sendOps(opsA)
		clientB.sendOps(opsB)

		await vi.waitFor(async () => {
			// Server should have all 6 ops
			expect(await store.getOperationCount()).toBe(6)
		})

		// Wait for relay to deliver
		await vi.waitFor(() => {
			// A should receive B's ops via relay
			const aReceived = clientA.getReceivedOperations()
			const bOpsInA = aReceived.filter((op) => op.nodeId === 'client-b')
			expect(bOpsInA.length).toBe(3)
		})

		await vi.waitFor(() => {
			// B should receive A's ops via relay
			const bReceived = clientB.getReceivedOperations()
			const aOpsInB = bReceived.filter((op) => op.nodeId === 'client-a')
			expect(aOpsInB.length).toBe(3)
		})
	})

	test('three clients converge', async () => {
		const { store, connectClient } = setupTestServer()

		const clientA = await connectClient('client-a')
		const clientB = await connectClient('client-b')
		const clientC = await connectClient('client-c')

		await clientA.handshake()
		await clientA.waitForStreaming()
		await clientB.handshake()
		await clientB.waitForStreaming()
		await clientC.handshake()
		await clientC.waitForStreaming()

		// A sends 2 ops
		const opsA = createTestOperations(2, 'client-a')
		clientA.sendOps(opsA)

		await vi.waitFor(async () => {
			expect(await store.getOperationCount()).toBe(2)
		})

		// B and C should both receive A's ops
		await vi.waitFor(() => {
			const bReceived = clientB.getReceivedOperations().filter((op) => op.nodeId === 'client-a')
			expect(bReceived.length).toBe(2)
		})

		await vi.waitFor(() => {
			const cReceived = clientC.getReceivedOperations().filter((op) => op.nodeId === 'client-a')
			expect(cReceived.length).toBe(2)
		})
	})

	test('client A streaming op relayed to client B in real-time', async () => {
		const { connectClient } = setupTestServer()

		const clientA = await connectClient('client-a')
		const clientB = await connectClient('client-b')

		await clientA.handshake()
		await clientA.waitForStreaming()
		await clientB.handshake()
		await clientB.waitForStreaming()

		// A sends an op — B should get it immediately (via relay)
		const ops = createTestOperations(1, 'client-a')
		clientA.sendOps(ops)

		await vi.waitFor(() => {
			const bOps = clientB.getReceivedOperations().filter((op) => op.id === 'client-a-op-1')
			expect(bOps.length).toBe(1)
		})
	})

	test('new client joining receives all previous operations', async () => {
		const { store, connectClient } = setupTestServer()

		// Client A connects and pushes ops
		const clientA = await connectClient('client-a')
		await clientA.handshake()
		await clientA.waitForStreaming()

		const ops = createTestOperations(5, 'client-a')
		clientA.sendOps(ops)

		await vi.waitFor(async () => {
			expect(await store.getOperationCount()).toBe(5)
		})

		// Client B connects after — should receive all 5 ops in delta
		const clientB = await connectClient('client-b')
		await clientB.handshake()
		await clientB.waitForStreaming()

		const received = clientB.getReceivedOperations()
		expect(received).toHaveLength(5)
	})

	test('sequential connect/disconnect/reconnect: data persists', async () => {
		const { store, connectClient } = setupTestServer()

		// Client A connects, sends ops, disconnects
		const clientA1 = await connectClient('client-a')
		await clientA1.handshake()
		await clientA1.waitForStreaming()

		const ops = createTestOperations(3, 'client-a')
		clientA1.sendOps(ops)

		await vi.waitFor(async () => {
			expect(await store.getOperationCount()).toBe(3)
		})

		clientA1.disconnect()

		// Client A reconnects with version vector showing it has its own ops
		const clientA2 = await connectClient('client-a')
		await clientA2.handshake({ 'client-a': 3 })
		await clientA2.waitForStreaming()

		// Should get empty delta (already has everything)
		const received = clientA2.getReceivedOperations()
		expect(received).toHaveLength(0)

		// Send more ops
		const moreOps = createTestOperations(2, 'client-a').map((op, i) => ({
			...op,
			id: `client-a-op-${4 + i}`,
			sequenceNumber: 4 + i,
			timestamp: { wallTime: 2000 + i, logical: 0, nodeId: 'client-a' },
			causalDeps: [i === 0 ? 'client-a-op-3' : `client-a-op-${3 + i}`],
		}))
		clientA2.sendOps(moreOps)

		await vi.waitFor(async () => {
			expect(await store.getOperationCount()).toBe(5)
		})
	})
})
