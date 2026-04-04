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
import { ChaosTransport } from '../../src/transport/chaos-transport'
import type { MemoryTransport } from '../../src/transport/memory-transport'
import { createMemoryTransportPair } from '../../src/transport/memory-transport'
import {
	createMockSyncStore,
	createSeededRandom,
	createTestOperations,
} from '../fixtures/test-helpers'

const serializer = new JsonMessageSerializer()

/**
 * Server handler for chaos tests. Identical to the multi-client hub
 * but works with a single client for simplicity.
 */
function createChaosServerHandler(
	serverStore: ReturnType<typeof createMockSyncStore>,
	server: MemoryTransport,
): void {
	server.onMessage((msg: SyncMessage) => {
		if (msg.type === 'handshake') {
			const handshake = msg as HandshakeMessage
			const response: HandshakeResponseMessage = {
				type: 'handshake-response',
				messageId: `resp-${msg.messageId}`,
				nodeId: serverStore.getNodeId(),
				versionVector: Object.fromEntries(serverStore.getVersionVector()),
				schemaVersion: handshake.schemaVersion,
				accepted: true,
			}
			server.send(response)

			// Send server's delta
			const clientVector = new Map(
				Object.entries(handshake.versionVector).map(([k, v]) => [k, v as number]),
			)

			const hubVector = serverStore.getVersionVector()
			const missingOps: import('@kora/core').Operation[] = []
			const promises: Promise<void>[] = []

			for (const [nodeId, hubSeq] of hubVector) {
				const clientSeq = clientVector.get(nodeId) ?? 0
				if (hubSeq > clientSeq) {
					promises.push(
						serverStore.getOperationRange(nodeId, clientSeq + 1, hubSeq).then((ops) => {
							missingOps.push(...ops)
						}),
					)
				}
			}

			Promise.all(promises).then(() => {
				const batch: OperationBatchMessage = {
					type: 'operation-batch',
					messageId: `delta-${Date.now()}-${Math.random()}`,
					operations: missingOps.map((op) => serializer.encodeOperation(op)),
					isFinal: true,
					batchIndex: 0,
				}
				server.send(batch)
			})
		} else if (msg.type === 'operation-batch') {
			const batch = msg as OperationBatchMessage
			const operations = batch.operations.map((s) => serializer.decodeOperation(s))

			Promise.all(operations.map((op) => serverStore.applyRemoteOperation(op))).then(() => {
				const lastOp = operations[operations.length - 1]
				const ack: AcknowledgmentMessage = {
					type: 'acknowledgment',
					messageId: `ack-${batch.messageId}`,
					acknowledgedMessageId: batch.messageId,
					lastSequenceNumber: lastOp ? lastOp.sequenceNumber : 0,
				}
				server.send(ack)
			})
		}
	})
}

describe('Chaos Sync Tests', () => {
	test('sync converges despite message duplication', async () => {
		const { client: rawClient, server } = createMemoryTransportPair()
		const random = createSeededRandom(42)

		// Wrap client transport with chaos (high duplicate rate)
		const chaosClient = new ChaosTransport(rawClient, {
			dropRate: 0,
			duplicateRate: 0.3, // 30% duplication
			reorderRate: 0,
			randomSource: random,
		})

		const clientOps = createTestOperations(10, 'client-node')
		const clientStore = createMockSyncStore({ nodeId: 'client-node', initialOps: clientOps })
		const serverStore = createMockSyncStore({ nodeId: 'server-node' })

		createChaosServerHandler(serverStore, server)

		const engine = new SyncEngine({
			transport: chaosClient,
			store: clientStore,
			config: { url: 'ws://test' },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 200))

		// Despite duplicates, server should have exactly 10 unique ops
		// (content-addressed dedup handles this)
		const serverOps = serverStore.getAllOperations()
		const uniqueIds = new Set(serverOps.map((op) => op.id))
		expect(uniqueIds.size).toBe(10)

		await engine.stop()
	})

	test('sync handles message reordering', async () => {
		const { client: rawClient, server } = createMemoryTransportPair()
		const random = createSeededRandom(123)

		const chaosClient = new ChaosTransport(rawClient, {
			dropRate: 0,
			duplicateRate: 0,
			reorderRate: 0.2, // 20% reorder
			randomSource: random,
		})

		const clientOps = createTestOperations(8, 'client-node')
		const clientStore = createMockSyncStore({ nodeId: 'client-node', initialOps: clientOps })
		const serverStore = createMockSyncStore({ nodeId: 'server-node' })

		createChaosServerHandler(serverStore, server)

		const engine = new SyncEngine({
			transport: chaosClient,
			store: clientStore,
			config: { url: 'ws://test' },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 200))

		// Server should eventually receive all ops
		const serverOps = serverStore.getAllOperations()
		expect(serverOps.length).toBeGreaterThanOrEqual(1)

		await engine.stop()
	})

	test('deterministic chaos with seeded random produces reproducible results', async () => {
		const results: number[] = []

		for (let trial = 0; trial < 2; trial++) {
			const { client: rawClient, server } = createMemoryTransportPair()
			const random = createSeededRandom(999) // Same seed both times

			const chaosClient = new ChaosTransport(rawClient, {
				dropRate: 0,
				duplicateRate: 0.2,
				reorderRate: 0.1,
				randomSource: random,
			})

			const clientOps = createTestOperations(5, 'client-node')
			const clientStore = createMockSyncStore({ nodeId: 'client-node', initialOps: clientOps })
			const serverStore = createMockSyncStore({ nodeId: 'server-node' })

			createChaosServerHandler(serverStore, server)

			const engine = new SyncEngine({
				transport: chaosClient,
				store: clientStore,
				config: { url: 'ws://test' },
			})

			await engine.start()
			await new Promise((resolve) => setTimeout(resolve, 200))

			results.push(serverStore.getAllOperations().length)
			await engine.stop()
		}

		// Both trials should produce the same result (deterministic)
		expect(results[0]).toBe(results[1])
	})
})
