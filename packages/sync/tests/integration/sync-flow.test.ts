import { describe, expect, test } from 'vitest'
import { SyncEngine } from '../../src/engine/sync-engine'
import type {
	AcknowledgmentMessage,
	HandshakeMessage,
	HandshakeResponseMessage,
	OperationBatchMessage,
	SyncMessage,
} from '../../src/protocol/messages'
import { JsonMessageSerializer } from '../../src/protocol/serializer'
import { versionVectorToWire } from '../../src/protocol/serializer'
import { createMemoryTransportPair } from '../../src/transport/memory-transport'
import {
	createMockEmitter,
	createMockSyncStore,
	createTestOperations,
} from '../fixtures/test-helpers'

const serializer = new JsonMessageSerializer()

/**
 * Server simulator that handles the full sync protocol.
 */
function createServerHandler(
	serverStore: ReturnType<typeof createMockSyncStore>,
	server: ReturnType<typeof createMemoryTransportPair>['server'],
): void {
	server.onMessage((msg: SyncMessage) => {
		if (msg.type === 'handshake') {
			handleHandshake(msg, serverStore, server)
		} else if (msg.type === 'operation-batch') {
			handleOperationBatch(msg, serverStore, server)
		} else if (msg.type === 'acknowledgment') {
			// Server received ack from client — no action needed
		}
	})
}

async function handleHandshake(
	msg: HandshakeMessage,
	store: ReturnType<typeof createMockSyncStore>,
	server: ReturnType<typeof createMemoryTransportPair>['server'],
): Promise<void> {
	// Send handshake response
	const response: HandshakeResponseMessage = {
		type: 'handshake-response',
		messageId: `resp-${msg.messageId}`,
		nodeId: store.getNodeId(),
		versionVector: Object.fromEntries(store.getVersionVector()),
		schemaVersion: msg.schemaVersion,
		accepted: true,
	}
	server.send(response)

	// Compute and send server's delta
	const clientVector = new Map(Object.entries(msg.versionVector).map(([k, v]) => [k, v as number]))
	const serverVector = store.getVersionVector()
	const missingOps = []

	for (const [nodeId, serverSeq] of serverVector) {
		const clientSeq = clientVector.get(nodeId) ?? 0
		if (serverSeq > clientSeq) {
			const ops = await store.getOperationRange(nodeId, clientSeq + 1, serverSeq)
			missingOps.push(...ops)
		}
	}

	const batch: OperationBatchMessage = {
		type: 'operation-batch',
		messageId: `delta-${Date.now()}`,
		operations: missingOps.map((op) => serializer.encodeOperation(op)),
		isFinal: true,
		batchIndex: 0,
	}
	server.send(batch)
}

async function handleOperationBatch(
	msg: OperationBatchMessage,
	store: ReturnType<typeof createMockSyncStore>,
	server: ReturnType<typeof createMemoryTransportPair>['server'],
): Promise<void> {
	const operations = msg.operations.map((s) => serializer.decodeOperation(s))
	for (const op of operations) {
		await store.applyRemoteOperation(op)
	}

	const lastOp = operations[operations.length - 1]
	const ack: AcknowledgmentMessage = {
		type: 'acknowledgment',
		messageId: `ack-${msg.messageId}`,
		acknowledgedMessageId: msg.messageId,
		lastSequenceNumber: lastOp ? lastOp.sequenceNumber : 0,
	}
	server.send(ack)
}

describe('Sync Flow Integration', () => {
	test('full handshake → delta exchange → streaming', async () => {
		const { client, server } = createMemoryTransportPair()

		// Client has some operations
		const clientOps = createTestOperations(5, 'client-node')
		const clientStore = createMockSyncStore({ nodeId: 'client-node', initialOps: clientOps })

		// Server has some different operations
		const serverOps = createTestOperations(3, 'server-node')
		const serverStore = createMockSyncStore({ nodeId: 'server-node', initialOps: serverOps })

		createServerHandler(serverStore, server)

		const emitter = createMockEmitter()
		const engine = new SyncEngine({
			transport: client,
			store: clientStore,
			config: { url: 'ws://test' },
			emitter,
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 100))

		expect(engine.getState()).toBe('streaming')

		// Client should have received server's 3 ops
		const clientAllOps = clientStore.getAllOperations()
		const serverNodeOps = clientAllOps.filter((op) => op.nodeId === 'server-node')
		expect(serverNodeOps).toHaveLength(3)

		// Server should have received client's 5 ops
		const serverAllOps = serverStore.getAllOperations()
		const clientNodeOps = serverAllOps.filter((op) => op.nodeId === 'client-node')
		expect(clientNodeOps).toHaveLength(5)

		// Events should have been emitted
		expect(emitter.events.some((e) => e.type === 'sync:connected')).toBe(true)
		expect(emitter.events.some((e) => e.type === 'sync:sent')).toBe(true)
		expect(emitter.events.some((e) => e.type === 'sync:received')).toBe(true)

		await engine.stop()
	})

	test('reconnection after disconnect resumes from version vector', async () => {
		const { client: client1, server: server1 } = createMemoryTransportPair()

		const clientOps = createTestOperations(3, 'client-node')
		const clientStore = createMockSyncStore({ nodeId: 'client-node', initialOps: clientOps })
		const serverStore = createMockSyncStore({ nodeId: 'server-node' })

		createServerHandler(serverStore, server1)

		const engine1 = new SyncEngine({
			transport: client1,
			store: clientStore,
			config: { url: 'ws://test' },
		})

		await engine1.start()
		await new Promise((resolve) => setTimeout(resolve, 100))

		// Server now has the 3 ops
		expect(serverStore.getAllOperations()).toHaveLength(3)

		await engine1.stop()

		// Add more operations while disconnected
		const newOps = createTestOperations(2, 'client-node').map((op, i) => ({
			...op,
			id: `client-node-op-${4 + i}`,
			sequenceNumber: 4 + i,
			recordId: `client-node-rec-${4 + i}`,
			timestamp: { wallTime: 2000 + i, logical: 0, nodeId: 'client-node' },
			causalDeps: [`client-node-op-${3 + i}`],
		}))
		for (const op of newOps) {
			clientStore.addOperation(op)
		}

		// Reconnect with a new transport pair
		const { client: client2, server: server2 } = createMemoryTransportPair()
		createServerHandler(serverStore, server2)

		const engine2 = new SyncEngine({
			transport: client2,
			store: clientStore,
			config: { url: 'ws://test' },
		})

		await engine2.start()
		await new Promise((resolve) => setTimeout(resolve, 100))

		// Server should now have 5 ops total (3 from first sync + 2 new)
		expect(serverStore.getAllOperations()).toHaveLength(5)

		await engine2.stop()
	})

	test('duplicate operations are ignored', async () => {
		const { client, server } = createMemoryTransportPair()

		const clientOps = createTestOperations(2, 'client-node')
		const clientStore = createMockSyncStore({ nodeId: 'client-node', initialOps: clientOps })
		const firstOp = clientOps[0]
		if (!firstOp) throw new Error('Expected at least one operation')
		const serverStore = createMockSyncStore({
			nodeId: 'server-node',
			initialOps: [firstOp], // Server already has op 1
		})

		createServerHandler(serverStore, server)

		const engine = new SyncEngine({
			transport: client,
			store: clientStore,
			config: { url: 'ws://test' },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 100))

		// Server should have exactly 2 ops (1 was a duplicate)
		expect(serverStore.getAllOperations()).toHaveLength(2)

		await engine.stop()
	})

	test('empty sync when both sides are up to date', async () => {
		const { client, server } = createMemoryTransportPair()

		const clientStore = createMockSyncStore({ nodeId: 'client-node' })
		const serverStore = createMockSyncStore({ nodeId: 'server-node' })

		createServerHandler(serverStore, server)

		const engine = new SyncEngine({
			transport: client,
			store: clientStore,
			config: { url: 'ws://test' },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 50))

		expect(engine.getState()).toBe('streaming')
		expect(engine.getStatus().status).toBe('synced')

		await engine.stop()
	})

	test('streaming: client pushes new operation after sync', async () => {
		const { client, server } = createMemoryTransportPair()
		const clientStore = createMockSyncStore({ nodeId: 'client-node' })
		const serverStore = createMockSyncStore({ nodeId: 'server-node' })

		createServerHandler(serverStore, server)

		const engine = new SyncEngine({
			transport: client,
			store: clientStore,
			config: { url: 'ws://test' },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 50))

		// Push a new operation during streaming
		const ops = createTestOperations(1, 'client-node')
		const newOp = ops[0]
		if (!newOp) throw new Error('Expected at least one operation')
		await engine.pushOperation(newOp)
		await new Promise((resolve) => setTimeout(resolve, 50))

		// Server should have received it
		const serverOps = serverStore.getAllOperations()
		expect(serverOps.some((op) => op.id === newOp.id)).toBe(true)

		await engine.stop()
	})
})
