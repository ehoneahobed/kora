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
import type { MemoryTransport } from '../../src/transport/memory-transport'
import { createMemoryTransportPair } from '../../src/transport/memory-transport'
import { createMockSyncStore, createTestOperations } from '../fixtures/test-helpers'

const serializer = new JsonMessageSerializer()

/**
 * Simple sync hub that relays operations between multiple clients.
 * Each client connects to the hub via a memory transport pair.
 */
class SyncHub {
	private readonly store: ReturnType<typeof createMockSyncStore>
	private readonly clientTransports: Map<string, MemoryTransport> = new Map()

	constructor() {
		this.store = createMockSyncStore({ nodeId: 'hub' })
	}

	/**
	 * Create a transport pair and register the server side.
	 */
	createClientTransport(clientId: string): { client: MemoryTransport; server: MemoryTransport } {
		const { client, server } = createMemoryTransportPair()
		this.clientTransports.set(clientId, server)
		this.setupServerHandler(clientId, server)
		return { client, server }
	}

	getStore(): ReturnType<typeof createMockSyncStore> {
		return this.store
	}

	private setupServerHandler(clientId: string, server: MemoryTransport): void {
		server.onMessage((msg: SyncMessage) => {
			if (msg.type === 'handshake') {
				this.handleHandshake(msg, server)
			} else if (msg.type === 'operation-batch') {
				this.handleBatch(msg, clientId, server)
			}
		})
	}

	private async handleHandshake(msg: HandshakeMessage, server: MemoryTransport): Promise<void> {
		const response: HandshakeResponseMessage = {
			type: 'handshake-response',
			messageId: `resp-${msg.messageId}`,
			nodeId: 'hub',
			versionVector: Object.fromEntries(this.store.getVersionVector()),
			schemaVersion: msg.schemaVersion,
			accepted: true,
		}
		server.send(response)

		// Send hub's delta to this client
		const clientVector = new Map(
			Object.entries(msg.versionVector).map(([k, v]) => [k, v as number]),
		)
		const hubVector = this.store.getVersionVector()
		const missingOps = []

		for (const [nodeId, hubSeq] of hubVector) {
			const clientSeq = clientVector.get(nodeId) ?? 0
			if (hubSeq > clientSeq) {
				const ops = await this.store.getOperationRange(nodeId, clientSeq + 1, hubSeq)
				missingOps.push(...ops)
			}
		}

		const batch: OperationBatchMessage = {
			type: 'operation-batch',
			messageId: `delta-${Date.now()}-${Math.random()}`,
			operations: missingOps.map((op) => serializer.encodeOperation(op)),
			isFinal: true,
			batchIndex: 0,
		}
		server.send(batch)
	}

	private async handleBatch(
		msg: OperationBatchMessage,
		sourceClientId: string,
		server: MemoryTransport,
	): Promise<void> {
		const operations = msg.operations.map((s) => serializer.decodeOperation(s))
		const newOps = []

		for (const op of operations) {
			const result = await this.store.applyRemoteOperation(op)
			if (result === 'applied') {
				newOps.push(op)
			}
		}

		// Acknowledge
		const lastOp = operations[operations.length - 1]
		const ack: AcknowledgmentMessage = {
			type: 'acknowledgment',
			messageId: `ack-${msg.messageId}`,
			acknowledgedMessageId: msg.messageId,
			lastSequenceNumber: lastOp ? lastOp.sequenceNumber : 0,
		}
		server.send(ack)

		// Relay new operations to other connected clients
		if (newOps.length > 0) {
			for (const [cId, transport] of this.clientTransports) {
				if (cId !== sourceClientId && transport.isConnected()) {
					const relay: OperationBatchMessage = {
						type: 'operation-batch',
						messageId: `relay-${Date.now()}-${Math.random()}`,
						operations: newOps.map((op) => serializer.encodeOperation(op)),
						isFinal: true,
						batchIndex: 0,
					}
					transport.send(relay)
				}
			}
		}
	}
}

describe('Multi-Client Sync', () => {
	test('two clients make offline changes and converge through hub', async () => {
		const hub = new SyncHub()

		// Client A has 3 operations
		const opsA = createTestOperations(3, 'node-a')
		const storeA = createMockSyncStore({ nodeId: 'node-a', initialOps: opsA })
		const { client: transportA } = hub.createClientTransport('client-a')

		// Client B has 2 operations
		const opsB = createTestOperations(2, 'node-b')
		const storeB = createMockSyncStore({ nodeId: 'node-b', initialOps: opsB })
		const { client: transportB } = hub.createClientTransport('client-b')

		// Connect client A
		const engineA = new SyncEngine({
			transport: transportA,
			store: storeA,
			config: { url: 'ws://test' },
		})
		await engineA.start()
		await new Promise((resolve) => setTimeout(resolve, 100))

		// Connect client B
		const engineB = new SyncEngine({
			transport: transportB,
			store: storeB,
			config: { url: 'ws://test' },
		})
		await engineB.start()
		await new Promise((resolve) => setTimeout(resolve, 100))

		// Wait for relay to propagate
		await new Promise((resolve) => setTimeout(resolve, 100))

		// All three (hub, A, B) should have all 5 operations
		const hubOps = hub.getStore().getAllOperations()
		const allAOps = storeA.getAllOperations()
		const allBOps = storeB.getAllOperations()

		expect(hubOps).toHaveLength(5)
		expect(allAOps).toHaveLength(5)
		expect(allBOps).toHaveLength(5)

		// Verify all operation IDs match
		const hubIds = new Set(hubOps.map((op) => op.id))
		const aIds = new Set(allAOps.map((op) => op.id))
		const bIds = new Set(allBOps.map((op) => op.id))

		expect(aIds).toEqual(hubIds)
		expect(bIds).toEqual(hubIds)

		await engineA.stop()
		await engineB.stop()
	})

	test('three clients converge through hub', async () => {
		const hub = new SyncHub()

		// Three clients with different operations
		const opsA = createTestOperations(2, 'node-a')
		const opsB = createTestOperations(3, 'node-b')
		const opsC = createTestOperations(1, 'node-c')

		const storeA = createMockSyncStore({ nodeId: 'node-a', initialOps: opsA })
		const storeB = createMockSyncStore({ nodeId: 'node-b', initialOps: opsB })
		const storeC = createMockSyncStore({ nodeId: 'node-c', initialOps: opsC })

		const { client: tA } = hub.createClientTransport('a')
		const { client: tB } = hub.createClientTransport('b')
		const { client: tC } = hub.createClientTransport('c')

		const engineA = new SyncEngine({ transport: tA, store: storeA, config: { url: 'ws://test' } })
		const engineB = new SyncEngine({ transport: tB, store: storeB, config: { url: 'ws://test' } })
		const engineC = new SyncEngine({ transport: tC, store: storeC, config: { url: 'ws://test' } })

		// Connect all three sequentially
		await engineA.start()
		await new Promise((resolve) => setTimeout(resolve, 100))

		await engineB.start()
		await new Promise((resolve) => setTimeout(resolve, 100))

		await engineC.start()
		await new Promise((resolve) => setTimeout(resolve, 100))

		// All should have 6 operations total (2 + 3 + 1)
		const total = 6
		expect(hub.getStore().getAllOperations()).toHaveLength(total)
		expect(storeA.getAllOperations()).toHaveLength(total)
		expect(storeB.getAllOperations()).toHaveLength(total)
		expect(storeC.getAllOperations()).toHaveLength(total)

		// Verify convergence: all stores have the same operation IDs
		const hubIds = new Set(
			hub
				.getStore()
				.getAllOperations()
				.map((op) => op.id),
		)
		expect(new Set(storeA.getAllOperations().map((op) => op.id))).toEqual(hubIds)
		expect(new Set(storeB.getAllOperations().map((op) => op.id))).toEqual(hubIds)
		expect(new Set(storeC.getAllOperations().map((op) => op.id))).toEqual(hubIds)

		await engineA.stop()
		await engineB.stop()
		await engineC.stop()
	})

	test('new operation during streaming is relayed to other clients', async () => {
		const hub = new SyncHub()

		const storeA = createMockSyncStore({ nodeId: 'node-a' })
		const storeB = createMockSyncStore({ nodeId: 'node-b' })

		const { client: tA } = hub.createClientTransport('a')
		const { client: tB } = hub.createClientTransport('b')

		const engineA = new SyncEngine({ transport: tA, store: storeA, config: { url: 'ws://test' } })
		const engineB = new SyncEngine({ transport: tB, store: storeB, config: { url: 'ws://test' } })

		await engineA.start()
		await engineB.start()
		await new Promise((resolve) => setTimeout(resolve, 100))

		// Client A pushes a new operation during streaming
		const ops = createTestOperations(1, 'node-a')
		const newOp = ops[0]
		if (!newOp) throw new Error('Expected at least one operation')
		await engineA.pushOperation(newOp)
		await new Promise((resolve) => setTimeout(resolve, 100))

		// Client B should have received it via the hub
		const bOps = storeB.getAllOperations()
		expect(bOps.some((op) => op.id === newOp.id)).toBe(true)

		await engineA.stop()
		await engineB.stop()
	})
})
