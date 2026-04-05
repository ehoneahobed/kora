import type { Operation, VersionVector } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { SyncEngine } from '../engine/sync-engine'
import type {
	AcknowledgmentMessage,
	HandshakeMessage,
	HandshakeResponseMessage,
	OperationBatchMessage,
	SyncMessage,
} from '../protocol/messages'
import { JsonMessageSerializer } from '../protocol/serializer'
import { createMemoryTransportPair } from '../transport/memory-transport'
import { createMockSyncStore, createTestOperations } from '../../tests/fixtures/test-helpers'

const REGRESSION_FACTOR = 1.1
const INITIAL_SYNC_LIMIT_MS = 5000 * REGRESSION_FACTOR
const INCREMENTAL_SYNC_LIMIT_MS = 200 * REGRESSION_FACTOR
const VERSION_VECTOR_DELTA_LIMIT_MS = 10 * REGRESSION_FACTOR

const serializer = new JsonMessageSerializer()

describe('Sync performance gates', () => {
	test('initial sync of 10,000 operations under target', async () => {
		const { client, server } = createMemoryTransportPair()
		const clientStore = createMockSyncStore({
			nodeId: 'client-node',
			initialOps: createTestOperations(10_000, 'client-node'),
		})
		const serverStore = createMockSyncStore({ nodeId: 'server-node' })
		createServerHandler(serverStore, server)

		const engine = new SyncEngine({
			transport: client,
			store: clientStore,
			config: { url: 'ws://bench' },
		})

		const startMs = Date.now()
		await engine.start()
		await waitFor(
			() => serverStore.getAllOperations().filter((operation) => operation.nodeId === 'client-node').length === 10_000,
			INITIAL_SYNC_LIMIT_MS,
		)
		const elapsedMs = Date.now() - startMs

		await engine.stop()
		expect(elapsedMs).toBeLessThan(INITIAL_SYNC_LIMIT_MS)
	}, 60_000)

	test('incremental sync of one operation under target', async () => {
		const { client, server } = createMemoryTransportPair()
		const clientStore = createMockSyncStore({ nodeId: 'client-node' })
		const serverStore = createMockSyncStore({ nodeId: 'server-node' })
		createServerHandler(serverStore, server)

		const engine = new SyncEngine({
			transport: client,
			store: clientStore,
			config: { url: 'ws://bench' },
		})

		await engine.start()
		await waitFor(() => engine.getState() === 'streaming', 2_000)

		const operation = createTestOperations(1, 'client-node')[0]
		if (!operation) {
			throw new Error('Expected one generated operation')
		}

		clientStore.addOperation(operation)
		const startMs = Date.now()
		await engine.pushOperation(operation)
		await waitFor(() => serverStore.getAllOperations().some((item) => item.id === operation.id), INCREMENTAL_SYNC_LIMIT_MS)
		const elapsedMs = Date.now() - startMs

		await engine.stop()
		expect(elapsedMs).toBeLessThan(INCREMENTAL_SYNC_LIMIT_MS)
	}, 20_000)

	test('version vector delta computation for 100 nodes under target', async () => {
		const operations: Operation[] = []
		for (let node = 0; node < 100; node++) {
			operations.push(...createTestOperations(10, `node-${node}`))
		}

		const store = createMockSyncStore({ nodeId: 'bench-node', initialOps: operations })
		const { client } = createMemoryTransportPair()
		const engine = new SyncEngine({ transport: client, store, config: { url: 'ws://bench' } })

		const localVector = store.getVersionVector()
		const remoteVector: VersionVector = new Map(
			Array.from(localVector.entries(), ([nodeId, sequence]) => [nodeId, sequence - 1]),
		)

		const startNs = process.hrtime.bigint()
		const missing = await collectDelta(engine, localVector, remoteVector)
		const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000

		expect(missing.length).toBe(100)
		expect(elapsedMs).toBeLessThan(VERSION_VECTOR_DELTA_LIMIT_MS)
	})
})

function createServerHandler(
	serverStore: ReturnType<typeof createMockSyncStore>,
	server: ReturnType<typeof createMemoryTransportPair>['server'],
): void {
	server.onMessage((message: SyncMessage) => {
		if (message.type === 'handshake') {
			void handleHandshake(message, serverStore, server)
			return
		}

		if (message.type === 'operation-batch') {
			void handleOperationBatch(message, serverStore, server)
		}
	})
}

async function handleHandshake(
	message: HandshakeMessage,
	store: ReturnType<typeof createMockSyncStore>,
	server: ReturnType<typeof createMemoryTransportPair>['server'],
): Promise<void> {
	const response: HandshakeResponseMessage = {
		type: 'handshake-response',
		messageId: `resp-${message.messageId}`,
		nodeId: store.getNodeId(),
		versionVector: Object.fromEntries(store.getVersionVector()),
		schemaVersion: message.schemaVersion,
		accepted: true,
	}
	server.send(response)

	const clientVector = new Map(Object.entries(message.versionVector).map(([nodeId, sequence]) => [nodeId, sequence as number]))
	const serverVector = store.getVersionVector()
	const missing: Operation[] = []

	for (const [nodeId, serverSequence] of serverVector) {
		const clientSequence = clientVector.get(nodeId) ?? 0
		if (serverSequence > clientSequence) {
			const operations = await store.getOperationRange(nodeId, clientSequence + 1, serverSequence)
			missing.push(...operations)
		}
	}

	const delta: OperationBatchMessage = {
		type: 'operation-batch',
		messageId: `delta-${Date.now()}`,
		operations: missing.map((operation) => serializer.encodeOperation(operation)),
		isFinal: true,
		batchIndex: 0,
	}
	server.send(delta)
}

async function handleOperationBatch(
	message: OperationBatchMessage,
	store: ReturnType<typeof createMockSyncStore>,
	server: ReturnType<typeof createMemoryTransportPair>['server'],
): Promise<void> {
	const operations = message.operations.map((operation) => serializer.decodeOperation(operation))
	for (const operation of operations) {
		await store.applyRemoteOperation(operation)
	}

	const lastOperation = operations[operations.length - 1]
	const acknowledgement: AcknowledgmentMessage = {
		type: 'acknowledgment',
		messageId: `ack-${message.messageId}`,
		acknowledgedMessageId: message.messageId,
		lastSequenceNumber: lastOperation ? lastOperation.sequenceNumber : 0,
	}
	server.send(acknowledgement)
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
	const startedAt = Date.now()

	while (!check()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error(`Condition not met within ${timeoutMs}ms`)
		}

		await new Promise((resolve) => setTimeout(resolve, 5))
	}
}

async function collectDelta(
	engine: SyncEngine,
	localVector: VersionVector,
	remoteVector: VersionVector,
): Promise<Operation[]> {
	const implementation = engine as unknown as {
		collectDelta(local: VersionVector, remote: VersionVector): Promise<Operation[]>
	}

	return implementation.collectDelta(localVector, remoteVector)
}
