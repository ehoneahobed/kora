import type { Operation } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { createServerTransportPair } from '../transport/memory-server-transport'
import { KoraSyncServer } from './kora-sync-server'

function createTestOp(overrides: Partial<Operation> = {}): Operation {
	return {
		id: `op-${Math.random().toString(36).slice(2)}`,
		nodeId: 'client-1',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-1',
		data: { title: 'test' },
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'client-1' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

function collectClientMessages(
	client: ReturnType<typeof createServerTransportPair>['client'],
): SyncMessage[] {
	const messages: SyncMessage[] = []
	client.onMessage((msg) => messages.push(msg))
	return messages
}

function sendHandshake(
	client: ReturnType<typeof createServerTransportPair>['client'],
	nodeId = 'client-1',
	versionVector: Record<string, number> = {},
): void {
	client.send({
		type: 'handshake',
		messageId: `hs-${nodeId}`,
		nodeId,
		versionVector,
		schemaVersion: 1,
	})
}

describe('KoraSyncServer', () => {
	test('handleConnection creates a session and returns sessionId', () => {
		const store = new MemoryServerStore('server-1')
		const server = new KoraSyncServer({ store })
		const { server: transport } = createServerTransportPair()

		const sessionId = server.handleConnection(transport)
		expect(sessionId).toBeTruthy()
		expect(server.getConnectionCount()).toBe(1)
	})

	test('rejects when maxConnections reached', () => {
		const store = new MemoryServerStore('server-1')
		const server = new KoraSyncServer({ store, maxConnections: 1 })

		const { server: t1 } = createServerTransportPair()
		server.handleConnection(t1)

		const { server: t2 } = createServerTransportPair()
		expect(() => server.handleConnection(t2)).toThrow('Maximum connections reached')
		expect(server.getConnectionCount()).toBe(1)
	})

	test('getStatus returns correct status', async () => {
		const store = new MemoryServerStore('server-1')
		await store.applyRemoteOperation(createTestOp({ id: 'op-1' }))

		const server = new KoraSyncServer({ store, port: 3000 })
		const { server: transport } = createServerTransportPair()
		server.handleConnection(transport)

		const status = await server.getStatus()
		expect(status.running).toBe(false) // Not started in standalone mode
		expect(status.connectedClients).toBe(1)
		expect(status.port).toBe(3000)
		expect(status.totalOperations).toBe(1)
	})

	test('getConnectionCount reflects active sessions', () => {
		const store = new MemoryServerStore('server-1')
		const server = new KoraSyncServer({ store })

		expect(server.getConnectionCount()).toBe(0)

		const { server: t1 } = createServerTransportPair()
		server.handleConnection(t1)
		expect(server.getConnectionCount()).toBe(1)

		const { server: t2 } = createServerTransportPair()
		server.handleConnection(t2)
		expect(server.getConnectionCount()).toBe(2)
	})

	test('session close removes from sessions map', async () => {
		const store = new MemoryServerStore('server-1')
		const server = new KoraSyncServer({ store })

		const { client, server: transport } = createServerTransportPair()
		collectClientMessages(client)
		server.handleConnection(transport)
		expect(server.getConnectionCount()).toBe(1)

		// Disconnect client → triggers session close
		client.disconnect()
		expect(server.getConnectionCount()).toBe(0)
	})

	test('relay sends operations from session A to session B', async () => {
		const store = new MemoryServerStore('server-1')
		const server = new KoraSyncServer({ store })

		// Connect client A
		const pairA = createServerTransportPair()
		const messagesA = collectClientMessages(pairA.client)
		server.handleConnection(pairA.server)

		// Connect client B
		const pairB = createServerTransportPair()
		const messagesB = collectClientMessages(pairB.client)
		server.handleConnection(pairB.server)

		// Both clients handshake
		sendHandshake(pairA.client, 'client-a')
		sendHandshake(pairB.client, 'client-b')

		// Wait for both to be streaming
		await vi.waitFor(() => {
			const responseA = messagesA.find((m) => m.type === 'handshake-response')
			const responseB = messagesB.find((m) => m.type === 'handshake-response')
			expect(responseA).toBeDefined()
			expect(responseB).toBeDefined()
		})

		// Wait for streaming state (both should get delta batches)
		await vi.waitFor(() => {
			const batchesA = messagesA.filter((m) => m.type === 'operation-batch')
			const batchesB = messagesB.filter((m) => m.type === 'operation-batch')
			expect(batchesA.length).toBeGreaterThanOrEqual(1)
			expect(batchesB.length).toBeGreaterThanOrEqual(1)
		})

		// Client A sends an operation
		const op = createTestOp({ id: 'op-from-a', nodeId: 'client-a', sequenceNumber: 1 })
		pairA.client.send({
			type: 'operation-batch',
			messageId: 'batch-from-a',
			operations: [
				{
					...op,
					timestamp: { ...op.timestamp },
					causalDeps: [...op.causalDeps],
				},
			],
			isFinal: true,
			batchIndex: 0,
		})

		// Client B should receive the relayed operation
		await vi.waitFor(() => {
			const relayed = messagesB.filter(
				(m) => m.type === 'operation-batch' && m.operations.some((o) => o.id === 'op-from-a'),
			)
			expect(relayed.length).toBeGreaterThanOrEqual(1)
		})

		// Client A should NOT receive its own operation back
		const relayedToA = messagesA.filter(
			(m) => m.type === 'operation-batch' && m.operations.some((o) => o.id === 'op-from-a'),
		)
		expect(relayedToA).toHaveLength(0)
	})

	test('relay only sends to streaming sessions', async () => {
		const store = new MemoryServerStore('server-1')
		const server = new KoraSyncServer({ store })

		// Connect client A (will handshake)
		const pairA = createServerTransportPair()
		collectClientMessages(pairA.client)
		server.handleConnection(pairA.server)

		// Connect client B (will NOT handshake — stays in 'connected' state)
		const pairB = createServerTransportPair()
		const messagesB = collectClientMessages(pairB.client)
		server.handleConnection(pairB.server)

		// Only A handshakes
		sendHandshake(pairA.client, 'client-a')

		await vi.waitFor(() => {
			// Wait some time for A's handshake to complete
			return new Promise((r) => setTimeout(r, 100))
		})

		// A sends an op
		const op = createTestOp({ id: 'op-from-a', nodeId: 'client-a', sequenceNumber: 1 })
		pairA.client.send({
			type: 'operation-batch',
			messageId: 'batch-from-a',
			operations: [
				{
					...op,
					timestamp: { ...op.timestamp },
					causalDeps: [...op.causalDeps],
				},
			],
			isFinal: true,
			batchIndex: 0,
		})

		// B should NOT receive the operation (not streaming)
		await new Promise((r) => setTimeout(r, 100))
		const relayed = messagesB.filter(
			(m) => m.type === 'operation-batch' && m.operations.some((o) => o.id === 'op-from-a'),
		)
		expect(relayed).toHaveLength(0)
	})

	test('stop closes all sessions', async () => {
		const store = new MemoryServerStore('server-1')
		const server = new KoraSyncServer({ store })

		const { client: c1, server: t1 } = createServerTransportPair()
		const { client: c2, server: t2 } = createServerTransportPair()
		collectClientMessages(c1)
		collectClientMessages(c2)

		server.handleConnection(t1)
		server.handleConnection(t2)
		expect(server.getConnectionCount()).toBe(2)

		await server.stop()
		expect(server.getConnectionCount()).toBe(0)
	})
})
