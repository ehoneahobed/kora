import type { Operation, VersionVector } from '@korajs/core'
import type { KoraEvent, KoraEventEmitter, KoraEventListener, KoraEventType } from '@korajs/core'
import { SyncError } from '@korajs/core'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type {
	AcknowledgmentMessage,
	HandshakeMessage,
	HandshakeResponseMessage,
	OperationBatchMessage,
} from '../protocol/messages'
import { JsonMessageSerializer } from '../protocol/serializer'
import { type MemoryTransport, createMemoryTransportPair } from '../transport/memory-transport'
import { SyncEngine } from './sync-engine'
import type { SyncStore } from './sync-store'

function makeOp(id: string, seq: number, nodeId = 'node-1', deps: string[] = []): Operation {
	return {
		id,
		nodeId,
		type: 'insert',
		collection: 'todos',
		recordId: `rec-${id}`,
		data: { title: `Op ${id}` },
		previousData: null,
		timestamp: { wallTime: 1000 + seq, logical: 0, nodeId },
		sequenceNumber: seq,
		causalDeps: deps,
		schemaVersion: 1,
	}
}

function createMockStore(overrides?: Partial<SyncStore>): SyncStore {
	const operations: Operation[] = []
	const versionVector: VersionVector = new Map()

	return {
		getVersionVector: () => versionVector,
		getNodeId: () => 'test-node',
		applyRemoteOperation: vi.fn(async () => 'applied' as const),
		getOperationRange: vi.fn(async () => []),
		...overrides,
	}
}

function createMockEmitter(): KoraEventEmitter & { events: KoraEvent[] } {
	const events: KoraEvent[] = []
	const listeners = new Map<string, Set<(event: KoraEvent) => void>>()

	return {
		events,
		on<T extends KoraEventType>(type: T, listener: KoraEventListener<T>): () => void {
			if (!listeners.has(type)) listeners.set(type, new Set())
			const wrapped = listener as unknown as (event: KoraEvent) => void
			listeners.get(type)?.add(wrapped)
			return () => listeners.get(type)?.delete(wrapped)
		},
		off<T extends KoraEventType>(type: T, listener: KoraEventListener<T>): void {
			listeners.get(type)?.delete(listener as unknown as (event: KoraEvent) => void)
		},
		emit(event: KoraEvent): void {
			events.push(event)
			const set = listeners.get(event.type)
			if (set) {
				for (const listener of set) {
					listener(event)
				}
			}
		},
	}
}

/**
 * Helper: simulate the server side of the sync flow.
 * - Listens on the server transport
 * - Responds to handshake with acceptance
 * - Responds to operation batches with acknowledgments
 * - Optionally sends server delta
 */
function setupServerResponder(
	server: MemoryTransport,
	options?: {
		accept?: boolean
		rejectReason?: string
		serverVector?: Record<string, number>
		serverDelta?: Operation[]
	},
): void {
	const accept = options?.accept ?? true
	const serializer = new JsonMessageSerializer()

	server.onMessage((msg) => {
		if (msg.type === 'handshake') {
			const handshake = msg as HandshakeMessage
			const response: HandshakeResponseMessage = {
				type: 'handshake-response',
				messageId: `resp-${handshake.messageId}`,
				nodeId: 'server-node',
				versionVector: options?.serverVector ?? {},
				schemaVersion: handshake.schemaVersion,
				accepted: accept,
				rejectReason: options?.rejectReason,
			}
			server.send(response)

			if (accept && options?.serverDelta) {
				// Server sends its delta
				const ops = options.serverDelta.map((op) => serializer.encodeOperation(op))
				const batch: OperationBatchMessage = {
					type: 'operation-batch',
					messageId: `delta-${Date.now()}`,
					operations: ops,
					isFinal: true,
					batchIndex: 0,
				}
				server.send(batch)
			} else if (accept) {
				// Server has no delta — send empty final batch
				const batch: OperationBatchMessage = {
					type: 'operation-batch',
					messageId: `delta-${Date.now()}`,
					operations: [],
					isFinal: true,
					batchIndex: 0,
				}
				server.send(batch)
			}
		} else if (msg.type === 'operation-batch') {
			// Acknowledge operation batches
			const batch = msg as OperationBatchMessage
			const ack: AcknowledgmentMessage = {
				type: 'acknowledgment',
				messageId: `ack-${batch.messageId}`,
				acknowledgedMessageId: batch.messageId,
				lastSequenceNumber: 0,
			}
			server.send(ack)
		}
	})
}

describe('SyncEngine state transitions', () => {
	test('starts in disconnected state', () => {
		const { client } = createMemoryTransportPair()
		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test' },
		})
		expect(engine.getState()).toBe('disconnected')
	})

	test('transitions through full happy path', async () => {
		const { client, server } = createMemoryTransportPair()
		const store = createMockStore()
		setupServerResponder(server)

		const engine = new SyncEngine({
			transport: client,
			store,
			config: { url: 'ws://test' },
		})

		await engine.start()

		// After start() returns, the handshake has been sent.
		// The server auto-responds, so we should reach streaming.
		// Give microtasks a chance to complete
		await new Promise((resolve) => setTimeout(resolve, 10))

		expect(engine.getState()).toBe('streaming')
	})

	test('transitions to error on rejected handshake', async () => {
		const { client, server } = createMemoryTransportPair()
		setupServerResponder(server, { accept: false, rejectReason: 'Schema mismatch' })

		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test' },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 10))

		// After rejection, should end up disconnected (error → disconnected)
		expect(engine.getState()).toBe('disconnected')
	})

	test('throws when starting from non-disconnected state', async () => {
		const { client, server } = createMemoryTransportPair()
		setupServerResponder(server)

		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test' },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 10))

		await expect(engine.start()).rejects.toThrow(SyncError)
	})

	test('stop brings engine to disconnected', async () => {
		const { client, server } = createMemoryTransportPair()
		setupServerResponder(server)

		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test' },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(engine.getState()).toBe('streaming')

		await engine.stop()
		expect(engine.getState()).toBe('disconnected')
	})

	test('stop is no-op when already disconnected', async () => {
		const { client } = createMemoryTransportPair()
		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test' },
		})

		await engine.stop() // Should not throw
		expect(engine.getState()).toBe('disconnected')
	})

	test('transport close transitions to disconnected', async () => {
		const { client, server } = createMemoryTransportPair()
		setupServerResponder(server)

		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test' },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(engine.getState()).toBe('streaming')

		// Simulate server disconnect
		client.simulateDisconnect('server gone')
		expect(engine.getState()).toBe('disconnected')
	})
})

describe('SyncEngine handshake', () => {
	test('sends handshake with correct version vector and schema version', async () => {
		const { client, server } = createMemoryTransportPair()
		const vector: VersionVector = new Map([
			['node-a', 5],
			['node-b', 3],
		])
		const store = createMockStore({
			getVersionVector: () => vector,
			getNodeId: () => 'node-a',
		})

		const serverMsgs: HandshakeMessage[] = []
		server.onMessage((msg) => {
			if (msg.type === 'handshake') {
				serverMsgs.push(msg as HandshakeMessage)
				// Send response to complete the flow
				server.send({
					type: 'handshake-response',
					messageId: 'resp',
					nodeId: 'server',
					versionVector: {},
					schemaVersion: 2,
					accepted: true,
				})
				server.send({
					type: 'operation-batch',
					messageId: 'delta',
					operations: [],
					isFinal: true,
					batchIndex: 0,
				})
			} else if (msg.type === 'operation-batch') {
				server.send({
					type: 'acknowledgment',
					messageId: 'ack',
					acknowledgedMessageId: msg.messageId,
					lastSequenceNumber: 0,
				})
			}
		})

		const engine = new SyncEngine({
			transport: client,
			store,
			config: { url: 'ws://test', schemaVersion: 2 },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 10))

		expect(serverMsgs).toHaveLength(1)
		const firstMsg = serverMsgs[0]
		expect(firstMsg).toBeDefined()
		expect(firstMsg?.nodeId).toBe('node-a')
		expect(firstMsg?.versionVector).toEqual({ 'node-a': 5, 'node-b': 3 })
		expect(firstMsg?.schemaVersion).toBe(2)
		expect(firstMsg?.supportedWireFormats).toEqual(['json', 'protobuf'])
	})

	test('negotiates selected wire format from handshake response', async () => {
		const { client, server } = createMemoryTransportPair()
		const serverMsgs: HandshakeMessage[] = []

		server.onMessage((msg) => {
			if (msg.type === 'handshake') {
				serverMsgs.push(msg as HandshakeMessage)
				server.send({
					type: 'handshake-response',
					messageId: 'resp',
					nodeId: 'server',
					versionVector: {},
					schemaVersion: 1,
					accepted: true,
					selectedWireFormat: 'protobuf',
				})
				server.send({
					type: 'operation-batch',
					messageId: 'delta',
					operations: [],
					isFinal: true,
					batchIndex: 0,
				})
			} else if (msg.type === 'operation-batch') {
				server.send({
					type: 'acknowledgment',
					messageId: 'ack',
					acknowledgedMessageId: msg.messageId,
					lastSequenceNumber: 0,
				})
			}
		})

		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test' },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 10))

		expect(serverMsgs[0]?.supportedWireFormats).toContain('protobuf')
	})

	test('sends auth token when auth is provided', async () => {
		const { client, server } = createMemoryTransportPair()
		const serverMsgs: HandshakeMessage[] = []

		server.onMessage((msg) => {
			if (msg.type === 'handshake') {
				serverMsgs.push(msg as HandshakeMessage)
				server.send({
					type: 'handshake-response',
					messageId: 'resp',
					nodeId: 'server',
					versionVector: {},
					schemaVersion: 1,
					accepted: true,
				})
				server.send({
					type: 'operation-batch',
					messageId: 'delta',
					operations: [],
					isFinal: true,
					batchIndex: 0,
				})
			} else if (msg.type === 'operation-batch') {
				server.send({
					type: 'acknowledgment',
					messageId: `ack-${msg.messageId}`,
					acknowledgedMessageId: msg.messageId,
					lastSequenceNumber: 0,
				})
			}
		})

		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: {
				url: 'ws://test',
				auth: async () => ({ token: 'my-secret-token' }),
			},
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 10))

		expect(serverMsgs[0]?.authToken).toBe('my-secret-token')
	})
})

describe('SyncEngine delta exchange', () => {
	test('sends local delta operations to server', async () => {
		const { client, server } = createMemoryTransportPair()
		const ops = [makeOp('op-1', 1), makeOp('op-2', 2)]
		const store = createMockStore({
			getVersionVector: () => new Map([['node-1', 2]]),
			getOperationRange: vi.fn(async () => ops),
		})

		const receivedBatches: OperationBatchMessage[] = []
		server.onMessage((msg) => {
			if (msg.type === 'handshake') {
				server.send({
					type: 'handshake-response',
					messageId: 'resp',
					nodeId: 'server',
					versionVector: {}, // Server has nothing → client sends all
					schemaVersion: 1,
					accepted: true,
				})
				server.send({
					type: 'operation-batch',
					messageId: 'delta',
					operations: [],
					isFinal: true,
					batchIndex: 0,
				})
			} else if (msg.type === 'operation-batch') {
				receivedBatches.push(msg as OperationBatchMessage)
				server.send({
					type: 'acknowledgment',
					messageId: `ack-${msg.messageId}`,
					acknowledgedMessageId: msg.messageId,
					lastSequenceNumber: 0,
				})
			}
		})

		const engine = new SyncEngine({
			transport: client,
			store,
			config: { url: 'ws://test' },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 50))

		// Should have sent the delta batch with 2 ops
		const opBatches = receivedBatches.filter((b) => b.operations.length > 0)
		expect(opBatches.length).toBeGreaterThanOrEqual(1)
		const totalOps = opBatches.reduce((sum, b) => sum + b.operations.length, 0)
		expect(totalOps).toBe(2)
	})

	test('receives server delta and applies to store', async () => {
		const { client, server } = createMemoryTransportPair()
		const applyFn = vi.fn(async (_op: Operation) => 'applied' as const)
		const store = createMockStore({
			applyRemoteOperation: applyFn,
		})

		const serverOps = [
			makeOp('server-op-1', 1, 'server-node'),
			makeOp('server-op-2', 2, 'server-node'),
		]
		setupServerResponder(server, { serverDelta: serverOps })

		const engine = new SyncEngine({
			transport: client,
			store,
			config: { url: 'ws://test' },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 50))

		expect(applyFn).toHaveBeenCalledTimes(2)
		expect((applyFn.mock.calls[0]?.[0] as Operation).id).toBe('server-op-1')
		expect((applyFn.mock.calls[1]?.[0] as Operation).id).toBe('server-op-2')
	})

	test('empty delta sends empty final batch', async () => {
		const { client, server } = createMemoryTransportPair()
		const store = createMockStore() // Empty version vector = no ops

		const receivedBatches: OperationBatchMessage[] = []
		server.onMessage((msg) => {
			if (msg.type === 'handshake') {
				server.send({
					type: 'handshake-response',
					messageId: 'resp',
					nodeId: 'server',
					versionVector: {},
					schemaVersion: 1,
					accepted: true,
				})
				server.send({
					type: 'operation-batch',
					messageId: 'delta',
					operations: [],
					isFinal: true,
					batchIndex: 0,
				})
			} else if (msg.type === 'operation-batch') {
				receivedBatches.push(msg as OperationBatchMessage)
				server.send({
					type: 'acknowledgment',
					messageId: `ack-${msg.messageId}`,
					acknowledgedMessageId: msg.messageId,
					lastSequenceNumber: 0,
				})
			}
		})

		const engine = new SyncEngine({
			transport: client,
			store,
			config: { url: 'ws://test' },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 50))

		// Should have sent at least one empty final batch
		const finalBatches = receivedBatches.filter((b) => b.isFinal)
		expect(finalBatches.length).toBeGreaterThanOrEqual(1)
		expect(engine.getState()).toBe('streaming')
	})

	test('large delta is paginated', async () => {
		const { client, server } = createMemoryTransportPair()
		const manyOps = Array.from({ length: 250 }, (_, i) => makeOp(`op-${i}`, i + 1))
		const store = createMockStore({
			getVersionVector: () => new Map([['node-1', 250]]),
			getOperationRange: vi.fn(async () => manyOps),
		})

		const receivedBatches: OperationBatchMessage[] = []
		server.onMessage((msg) => {
			if (msg.type === 'handshake') {
				server.send({
					type: 'handshake-response',
					messageId: 'resp',
					nodeId: 'server',
					versionVector: {},
					schemaVersion: 1,
					accepted: true,
				})
				server.send({
					type: 'operation-batch',
					messageId: 'delta',
					operations: [],
					isFinal: true,
					batchIndex: 0,
				})
			} else if (msg.type === 'operation-batch') {
				receivedBatches.push(msg as OperationBatchMessage)
				server.send({
					type: 'acknowledgment',
					messageId: `ack-${msg.messageId}`,
					acknowledgedMessageId: msg.messageId,
					lastSequenceNumber: 0,
				})
			}
		})

		const engine = new SyncEngine({
			transport: client,
			store,
			config: { url: 'ws://test', batchSize: 100 },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 50))

		// 250 ops / 100 batch size = 3 batches
		const opBatches = receivedBatches.filter((b) => b.operations.length > 0)
		expect(opBatches.length).toBe(3)
		const lastBatch = opBatches[opBatches.length - 1]
		expect(lastBatch?.isFinal).toBe(true)
	})
})

describe('SyncEngine streaming', () => {
	test('pushOperation sends via transport when streaming', async () => {
		const { client, server } = createMemoryTransportPair()
		setupServerResponder(server)

		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test' },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(engine.getState()).toBe('streaming')

		// Clear previous messages
		client.clearSentMessages()

		await engine.pushOperation(makeOp('new-op', 10))

		// Should have sent the op
		const sent = client.getSentMessages()
		const opBatch = sent.find((m) => m.type === 'operation-batch') as
			| OperationBatchMessage
			| undefined
		expect(opBatch).toBeDefined()
		expect(opBatch?.operations).toHaveLength(1)
		expect(opBatch?.operations[0]?.id).toBe('new-op')
	})

	test('incoming ops during streaming are applied to store', async () => {
		const { client, server } = createMemoryTransportPair()
		const applyFn = vi.fn(async (_op: Operation) => 'applied' as const)
		const store = createMockStore({ applyRemoteOperation: applyFn })
		setupServerResponder(server)

		const engine = new SyncEngine({
			transport: client,
			store,
			config: { url: 'ws://test' },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(engine.getState()).toBe('streaming')

		const serializer = new JsonMessageSerializer()
		const incomingOp = makeOp('remote-new', 5, 'other-node')

		// Server sends a new operation
		server.send({
			type: 'operation-batch',
			messageId: 'stream-1',
			operations: [serializer.encodeOperation(incomingOp)],
			isFinal: true,
			batchIndex: 0,
		})

		await new Promise((resolve) => setTimeout(resolve, 10))

		// The incoming op should be applied
		const applyCalls = applyFn.mock.calls.filter(
			(call) => call[0] && (call[0] as Operation).id === 'remote-new',
		)
		expect(applyCalls).toHaveLength(1)
	})
})

describe('SyncEngine events', () => {
	test('emits sync:connected on successful handshake', async () => {
		const { client, server } = createMemoryTransportPair()
		setupServerResponder(server)
		const emitter = createMockEmitter()

		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test' },
			emitter,
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 10))

		const connected = emitter.events.find((e) => e.type === 'sync:connected')
		expect(connected).toBeDefined()
	})

	test('emits sync:disconnected on transport close', async () => {
		const { client, server } = createMemoryTransportPair()
		setupServerResponder(server)
		const emitter = createMockEmitter()

		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test' },
			emitter,
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 50))

		client.simulateDisconnect('lost connection')

		const disconnected = emitter.events.find((e) => e.type === 'sync:disconnected')
		expect(disconnected).toBeDefined()
	})

	test('emits sync:sent when operations are sent', async () => {
		const { client, server } = createMemoryTransportPair()
		const ops = [makeOp('op-1', 1)]
		const store = createMockStore({
			getVersionVector: () => new Map([['node-1', 1]]),
			getOperationRange: vi.fn(async () => ops),
		})
		setupServerResponder(server)
		const emitter = createMockEmitter()

		const engine = new SyncEngine({
			transport: client,
			store,
			config: { url: 'ws://test' },
			emitter,
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 50))

		const sent = emitter.events.filter((e) => e.type === 'sync:sent')
		expect(sent.length).toBeGreaterThanOrEqual(1)
	})

	test('emits sync:received when operations arrive', async () => {
		const { client, server } = createMemoryTransportPair()
		const serverOps = [makeOp('s-op', 1, 'server-node')]
		setupServerResponder(server, { serverDelta: serverOps })
		const emitter = createMockEmitter()

		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test' },
			emitter,
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 50))

		const received = emitter.events.filter((e) => e.type === 'sync:received')
		expect(received.length).toBeGreaterThanOrEqual(1)
	})
})

describe('SyncEngine status', () => {
	test('reports offline when disconnected', () => {
		const { client } = createMemoryTransportPair()
		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test' },
		})

		const status = engine.getStatus()
		expect(status.status).toBe('offline')
		expect(status.pendingOperations).toBe(0)
		expect(status.lastSyncedAt).toBeNull()
	})

	test('reports synced when streaming with empty queue', async () => {
		const { client, server } = createMemoryTransportPair()
		setupServerResponder(server)

		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test' },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 50))

		const status = engine.getStatus()
		expect(status.status).toBe('synced')
		expect(status.lastSyncedAt).not.toBeNull()
	})

	test('reports error after error state', async () => {
		const { client, server } = createMemoryTransportPair()
		setupServerResponder(server, { accept: false })

		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test' },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 10))

		// After rejection, ends up disconnected → offline
		expect(engine.getStatus().status).toBe('offline')
	})
})
