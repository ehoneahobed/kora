import type { Operation, VersionVector } from '@korajs/core'
import type { KoraEvent, KoraEventEmitter, KoraEventListener, KoraEventType } from '@korajs/core'
import { APPLY_FAILURE_CODES, SyncError } from '@korajs/core'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { encodeDeltaCursor } from '../delta/delta-cursor'
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
				...(options?.rejectReason?.startsWith('SCHEMA_MISMATCH')
					? { supportedSchemaMin: 1, supportedSchemaMax: 1 }
					: {}),
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

	test('tolerates duplicate final delta batches without invalid transition', async () => {
		const { client, server } = createMemoryTransportPair()
		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test' },
		})

		server.onMessage((msg) => {
			if (msg.type !== 'handshake') {
				return
			}
			const handshake = msg as HandshakeMessage
			const response: HandshakeResponseMessage = {
				type: 'handshake-response',
				messageId: `resp-${handshake.messageId}`,
				nodeId: 'server-node',
				versionVector: {},
				schemaVersion: handshake.schemaVersion,
				accepted: true,
			}
			server.send(response)

			const finalBatch: OperationBatchMessage = {
				type: 'operation-batch',
				messageId: 'delta-final-1',
				operations: [],
				isFinal: true,
				batchIndex: 0,
				totalBatches: 1,
			}
			server.send(finalBatch)
			server.send({ ...finalBatch, messageId: 'delta-final-2' })
		})

		await expect(engine.start()).resolves.toBeUndefined()
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

	test('blocks sync on SCHEMA_MISMATCH handshake rejection', async () => {
		const { client, server } = createMemoryTransportPair()
		const emitter = createMockEmitter()
		setupServerResponder(server, {
			accept: false,
			rejectReason: 'SCHEMA_MISMATCH: client schema version 99 not in supported range [1, 1]',
		})

		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test', schemaVersion: 99 },
			emitter,
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 10))

		expect(engine.getState()).toBe('error')
		expect(engine.isSchemaBlocked()).toBe(true)
		expect(engine.getStatus().status).toBe('schema-mismatch')
		expect(emitter.events.some((e) => e.type === 'sync:schema-mismatch')).toBe(true)
		expect(emitter.events.some((e) => e.type === 'sync:disconnected')).toBe(false)

		engine.clearSchemaBlock()
		expect(engine.getState()).toBe('disconnected')
		expect(engine.isSchemaBlocked()).toBe(false)

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(engine.isSchemaBlocked()).toBe(true)
		expect(engine.getState()).toBe('error')
	})

	test('strictHandshake waits for delta batch ACKs before streaming', async () => {
		const { client, server } = createMemoryTransportPair()
		const store = createMockStore()
		const sentBatchIds: string[] = []

		server.onMessage((msg) => {
			if (msg.type === 'handshake') {
				const handshake = msg as HandshakeMessage
				server.send({
					type: 'handshake-response',
					messageId: `resp-${handshake.messageId}`,
					nodeId: 'server-node',
					versionVector: {},
					schemaVersion: 1,
					accepted: true,
				})
				server.send({
					type: 'operation-batch',
					messageId: 'server-delta',
					operations: [],
					isFinal: true,
					batchIndex: 0,
				})
			} else if (msg.type === 'operation-batch') {
				const batch = msg as OperationBatchMessage
				sentBatchIds.push(batch.messageId)
				server.send({
					type: 'acknowledgment',
					messageId: `ack-${batch.messageId}`,
					acknowledgedMessageId: batch.messageId,
					lastSequenceNumber: 0,
				})
			}
		})

		const engine = new SyncEngine({
			transport: client,
			store,
			config: { url: 'ws://test', strictHandshake: true },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 30))

		expect(engine.getState()).toBe('streaming')
		expect(sentBatchIds.length).toBeGreaterThan(0)
	})

	test('sendDelta removes reconciled ops from queue so flush does not resend', async () => {
		const localNodeId = 'test-node'
		const op1 = makeOp('op-1', 1, localNodeId)
		const op2 = makeOp('op-2', 2, localNodeId)
		const vector = new Map<string, number>([[localNodeId, 2]])

		const syncState = {
			loadLastAckedServerVector: async () => new Map<string, number>(),
			saveLastAckedServerVector: async () => {},
			mergeServerVectors: (a: VersionVector, b: VersionVector) => {
				const merged = new Map(a)
				for (const [nodeId, seq] of b) {
					merged.set(nodeId, Math.max(merged.get(nodeId) ?? 0, seq))
				}
				return merged
			},
			getUnsyncedOperations: async () => [op1, op2],
			countUnsyncedOperations: async () => 2,
			loadDeltaCursor: async () => null,
			saveDeltaCursor: async () => {},
		}

		const store = createMockStore({
			getNodeId: () => localNodeId,
			getVersionVector: () => vector,
			getOperationRange: async () => [op1, op2],
		})

		const { client, server } = createMemoryTransportPair()
		setupServerResponder(server)

		const engine = new SyncEngine({
			transport: client,
			store,
			syncState,
			config: { url: 'ws://test' },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 20))

		expect(engine.getState()).toBe('streaming')
		expect(engine.getOutboundQueue().totalPending).toBe(0)
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

describe('SyncEngine scope', () => {
	test('includes syncScope in handshake when scopeMap is configured', async () => {
		const { client, server } = createMemoryTransportPair()
		const store = createMockStore()
		const scopeMap = {
			sales: { orgId: 'org-123', storeId: 'store-456' },
			products: {},
		}

		let receivedHandshake: HandshakeMessage | null = null
		server.onMessage((msg) => {
			if (msg.type === 'handshake') {
				receivedHandshake = msg as HandshakeMessage
				// Respond to complete the flow
				server.send({
					type: 'handshake-response',
					messageId: 'resp-1',
					nodeId: 'server',
					versionVector: {},
					schemaVersion: 1,
					accepted: true,
				})
				server.send({
					type: 'operation-batch',
					messageId: 'delta-1',
					operations: [],
					isFinal: true,
					batchIndex: 0,
				})
			} else if (msg.type === 'operation-batch') {
				server.send({
					type: 'acknowledgment',
					messageId: 'ack-1',
					acknowledgedMessageId: msg.messageId,
					lastSequenceNumber: 0,
				})
			}
		})

		const engine = new SyncEngine({
			transport: client,
			store,
			config: { url: 'ws://test', scopeMap },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 10))

		expect(receivedHandshake).not.toBeNull()
		const handshake = receivedHandshake as unknown as HandshakeMessage
		expect(handshake.syncScope).toEqual(scopeMap)
	})

	test('does not include syncScope when scopeMap is not configured', async () => {
		const { client, server } = createMemoryTransportPair()
		const store = createMockStore()

		let receivedHandshake: HandshakeMessage | null = null
		server.onMessage((msg) => {
			if (msg.type === 'handshake') {
				receivedHandshake = msg as HandshakeMessage
				server.send({
					type: 'handshake-response',
					messageId: 'resp-1',
					nodeId: 'server',
					versionVector: {},
					schemaVersion: 1,
					accepted: true,
				})
				server.send({
					type: 'operation-batch',
					messageId: 'delta-1',
					operations: [],
					isFinal: true,
					batchIndex: 0,
				})
			} else if (msg.type === 'operation-batch') {
				server.send({
					type: 'acknowledgment',
					messageId: 'ack-1',
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
		await new Promise((resolve) => setTimeout(resolve, 10))

		expect(receivedHandshake).not.toBeNull()
		const handshake = receivedHandshake as unknown as HandshakeMessage
		expect(handshake.syncScope).toBeUndefined()
	})

	test('pushOperation skips out-of-scope operations', async () => {
		const { client, server } = createMemoryTransportPair()
		setupServerResponder(server)

		const scopeMap = { todos: { userId: 'user-1' } }
		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test', scopeMap },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(engine.getState()).toBe('streaming')

		client.clearSentMessages()

		// Push an out-of-scope op (data has no userId field => no match for userId scope)
		await engine.pushOperation(makeOp('out-of-scope', 10, 'node-1'))

		// Should NOT have been sent
		const sent = client.getSentMessages()
		const opBatch = sent.find((m) => m.type === 'operation-batch') as
			| OperationBatchMessage
			| undefined
		expect(opBatch).toBeUndefined()
	})

	test('pushOperation sends in-scope operations', async () => {
		const { client, server } = createMemoryTransportPair()
		setupServerResponder(server)

		const scopeMap = { todos: { userId: 'user-1' } }
		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test', scopeMap },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(engine.getState()).toBe('streaming')

		client.clearSentMessages()

		// Push an in-scope op
		const inScopeOp: Operation = {
			...makeOp('in-scope', 10),
			data: { userId: 'user-1', title: 'Test' },
		}
		await engine.pushOperation(inScopeOp)

		const sent = client.getSentMessages()
		const opBatch = sent.find((m) => m.type === 'operation-batch') as
			| OperationBatchMessage
			| undefined
		expect(opBatch).toBeDefined()
		expect(opBatch?.operations).toHaveLength(1)
	})

	test('incoming operations outside scope are filtered out (defense in depth)', async () => {
		const { client, server } = createMemoryTransportPair()
		const applyFn = vi.fn(async (_op: Operation) => 'applied' as const)
		const store = createMockStore({ applyRemoteOperation: applyFn })

		const scopeMap = { todos: { userId: 'user-1' } }

		// Server responds to handshake with the scope
		server.onMessage((msg) => {
			if (msg.type === 'handshake') {
				server.send({
					type: 'handshake-response',
					messageId: 'resp',
					nodeId: 'server',
					versionVector: {},
					schemaVersion: 1,
					accepted: true,
					acceptedScope: scopeMap,
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
			store,
			config: { url: 'ws://test', scopeMap },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(engine.getState()).toBe('streaming')

		const serializer = new JsonMessageSerializer()

		// Server sends ops: one in scope, one out of scope
		const inScopeOp: Operation = {
			...makeOp('in', 1, 'server-node'),
			data: { userId: 'user-1', title: 'Mine' },
		}
		const outOfScopeOp: Operation = {
			...makeOp('out', 2, 'server-node'),
			data: { userId: 'user-2', title: 'Not mine' },
		}

		server.send({
			type: 'operation-batch',
			messageId: 'stream-1',
			operations: [serializer.encodeOperation(inScopeOp), serializer.encodeOperation(outOfScopeOp)],
			isFinal: true,
			batchIndex: 0,
		})

		await new Promise((resolve) => setTimeout(resolve, 10))

		// Only the in-scope op should be applied
		const appliedOps = applyFn.mock.calls.map((call) => (call[0] as Operation).id)
		expect(appliedOps).toContain('in')
		expect(appliedOps).not.toContain('out')
	})

	test('accepted scope from handshake response overrides client scope', async () => {
		const { client, server } = createMemoryTransportPair()
		const store = createMockStore()

		// Client requests broad scope, server narrows it
		const clientScope = { todos: { orgId: 'org-1' } }
		const serverScope = { todos: { orgId: 'org-1', userId: 'user-1' } }

		server.onMessage((msg) => {
			if (msg.type === 'handshake') {
				server.send({
					type: 'handshake-response',
					messageId: 'resp',
					nodeId: 'server',
					versionVector: {},
					schemaVersion: 1,
					accepted: true,
					acceptedScope: serverScope,
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
			store,
			config: { url: 'ws://test', scopeMap: clientScope },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 50))

		// Active scope should now be the server's narrower scope
		expect(engine.getActiveScope()).toEqual(serverScope)
	})

	test('delta only sends in-scope operations', async () => {
		const { client, server } = createMemoryTransportPair()

		const scopeMap = { todos: { userId: 'user-1' } }

		// Store has ops from different users
		const inScopeOp: Operation = {
			...makeOp('in', 1),
			data: { userId: 'user-1', title: 'Mine' },
		}
		const outOfScopeOp: Operation = {
			...makeOp('out', 2),
			data: { userId: 'user-2', title: 'Not mine' },
		}

		const store = createMockStore({
			getVersionVector: () => new Map([['node-1', 2]]),
			getOperationRange: vi.fn(async () => [inScopeOp, outOfScopeOp]),
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
			config: { url: 'ws://test', scopeMap },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 50))

		// Only the in-scope op should have been sent
		const allSentOps = receivedBatches.flatMap((b) => b.operations)
		expect(allSentOps).toHaveLength(1)
		expect(allSentOps[0]?.id).toBe('in')
	})

	test('updateScope changes the active scope for future operations', () => {
		const { client } = createMemoryTransportPair()

		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test', scopeMap: { todos: { userId: 'user-1' } } },
		})

		expect(engine.getActiveScope()).toEqual({ todos: { userId: 'user-1' } })

		// Update scope
		engine.updateScope({ todos: { userId: 'user-2' } })
		expect(engine.getActiveScope()).toEqual({ todos: { userId: 'user-2' } })

		// Can also clear scope
		engine.updateScope(undefined)
		expect(engine.getActiveScope()).toBeUndefined()
	})

	test('pushOperation uses updated scope after updateScope', async () => {
		const { client, server } = createMemoryTransportPair()
		setupServerResponder(server)

		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test', scopeMap: { todos: { userId: 'user-1' } } },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(engine.getState()).toBe('streaming')

		// Op for user-2 should be skipped with current scope
		const user2Op: Operation = {
			...makeOp('user2-op', 10),
			data: { userId: 'user-2', title: 'Test' },
		}

		client.clearSentMessages()
		await engine.pushOperation(user2Op)
		let sent = client.getSentMessages()
		expect(sent.filter((m) => m.type === 'operation-batch')).toHaveLength(0)

		// Update scope to user-2
		engine.updateScope({ todos: { userId: 'user-2' } })

		// Now user-2 op should be sent
		await engine.pushOperation(user2Op)
		sent = client.getSentMessages()
		expect(sent.filter((m) => m.type === 'operation-batch')).toHaveLength(1)
	})

	test('no scope means all operations are in scope', async () => {
		const { client, server } = createMemoryTransportPair()
		setupServerResponder(server)

		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test' },
			// No scopeMap — all ops should pass through
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(engine.getState()).toBe('streaming')

		client.clearSentMessages()
		await engine.pushOperation(makeOp('any-op', 10))

		const sent = client.getSentMessages()
		const opBatch = sent.find((m) => m.type === 'operation-batch') as
			| OperationBatchMessage
			| undefined
		expect(opBatch).toBeDefined()
	})
})

describe('SyncEngine enhanced status', () => {
	test('getStatus includes new fields with defaults', () => {
		const { client } = createMemoryTransportPair()
		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test' },
		})

		const status = engine.getStatus()
		expect(status.lastSuccessfulPush).toBeNull()
		expect(status.lastSuccessfulPull).toBeNull()
		expect(status.conflicts).toBe(0)
	})

	test('lastSuccessfulPull updates when operations are received', async () => {
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

		// Before receiving any ops, lastSuccessfulPull should be null
		// (initial handshake may or may not have ops)
		const beforePull = engine.getStatus().lastSuccessfulPull

		// Server sends ops
		const serializer = new JsonMessageSerializer()
		server.send({
			type: 'operation-batch',
			messageId: 'pull-1',
			operations: [serializer.encodeOperation(makeOp('pull-op', 5, 'other'))],
			isFinal: true,
			batchIndex: 0,
		})

		await new Promise((resolve) => setTimeout(resolve, 10))

		const afterPull = engine.getStatus().lastSuccessfulPull
		expect(afterPull).not.toBeNull()
		expect(afterPull).toBeGreaterThanOrEqual(beforePull ?? 0)
	})

	test('lastSuccessfulPush updates when acknowledgment is received', async () => {
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

		// Push an op and wait for ack
		await engine.pushOperation(makeOp('push-op', 10))

		// Server acknowledges
		await new Promise((resolve) => setTimeout(resolve, 10))

		// The ack handler should update lastSuccessfulPush
		// (if server responder acknowledges operation batches)
		const status = engine.getStatus()
		// lastSuccessfulPush is set on ack - if no ack response comes it stays null
		// The setupServerResponder acknowledges operation batches, so this should be set
		expect(status.lastSuccessfulPush).not.toBeNull()
	})

	test('recordConflict increments conflict count', () => {
		const { client } = createMemoryTransportPair()
		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test' },
		})

		expect(engine.getStatus().conflicts).toBe(0)
		engine.recordConflict()
		expect(engine.getStatus().conflicts).toBe(1)
		engine.recordConflict()
		engine.recordConflict()
		expect(engine.getStatus().conflicts).toBe(3)
	})

	test('exportDiagnostics returns comprehensive snapshot', async () => {
		const { client, server } = createMemoryTransportPair()
		setupServerResponder(server)

		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test', schemaVersion: 2 },
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 50))

		const diag = engine.exportDiagnostics()
		expect(diag.state).toBe('streaming')
		expect(diag.status.status).toBe('synced')
		expect(diag.nodeId).toBe('test-node')
		expect(diag.url).toBe('ws://test')
		expect(diag.schemaVersion).toBe(2)
		expect(diag.timestamp).toBeGreaterThan(0)
		expect(diag.hasInFlightBatch).toBe(false)
		expect(diag.reconnecting).toBe(false)
		expect(typeof diag.pendingOperations).toBe('number')
		expect(typeof diag.conflicts).toBe('number')
	})

	test('retryNow starts engine when disconnected', async () => {
		const { client, server } = createMemoryTransportPair()
		setupServerResponder(server)

		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test' },
		})

		expect(engine.getState()).toBe('disconnected')

		await engine.retryNow()
		await new Promise((resolve) => setTimeout(resolve, 50))

		expect(engine.getState()).toBe('streaming')
	})

	test('retryNow is a no-op when already connected', async () => {
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

		// Should not throw
		await engine.retryNow()
		expect(engine.getState()).toBe('streaming')
	})
})

describe('SyncEngine query subsets', () => {
	test('pushOperation skips ops outside registered query subsets', async () => {
		const { client } = createMemoryTransportPair()
		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test' },
		})

		engine.registerQuerySubset({ collection: 'todos', where: { completed: false } })

		await engine.pushOperation({
			...makeOp('done', 1),
			type: 'update',
			data: { completed: true },
			previousData: { completed: false, title: 'Op done' },
		})

		expect(engine.getOutboundQueue().totalPending).toBe(0)

		await engine.pushOperation({
			...makeOp('active', 2),
			type: 'update',
			data: { completed: false },
			previousData: { completed: true, title: 'Op active' },
		})

		expect(engine.getOutboundQueue().totalPending).toBe(1)
	})

	test('handshake includes active syncQueries', async () => {
		const { client, server } = createMemoryTransportPair()
		setupServerResponder(server)

		let capturedHandshake: HandshakeMessage | null = null
		server.onMessage((msg) => {
			if (msg.type === 'handshake') {
				capturedHandshake = msg as HandshakeMessage
			}
		})

		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test' },
		})

		engine.registerQuerySubset({ collection: 'todos', where: { completed: false } })
		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 50))

		expect(capturedHandshake).not.toBeNull()
		const handshake = capturedHandshake as unknown as HandshakeMessage
		expect(handshake.syncQueries).toEqual([{ collection: 'todos', where: { completed: false } }])
	})
})

describe('SyncEngine delta cursor', () => {
	test('persists cursor during initial sync and clears on completion', async () => {
		const { client, server } = createMemoryTransportPair()
		const saved: Array<{ lastOperationId: string; batchIndex: number } | null> = []
		const serializer = new JsonMessageSerializer()

		server.onMessage((msg) => {
			if (msg.type === 'handshake') {
				const handshake = msg as HandshakeMessage
				server.send({
					type: 'handshake-response',
					messageId: 'resp-1',
					nodeId: 'server-node',
					versionVector: {},
					schemaVersion: handshake.schemaVersion,
					accepted: true,
				})

				server.send({
					type: 'operation-batch',
					messageId: 'delta-paginated',
					operations: [serializer.encodeOperation(makeOp('remote-1', 1, 'server-node'))],
					isFinal: true,
					batchIndex: 0,
					totalBatches: 1,
					cursor: encodeDeltaCursor({ lastOperationId: 'remote-1', batchIndex: 0 }),
				})
			} else if (msg.type === 'operation-batch') {
				server.send({
					type: 'acknowledgment',
					messageId: 'ack-1',
					acknowledgedMessageId: msg.messageId,
					lastSequenceNumber: 0,
				})
			}
		})

		const mockSyncState = {
			loadLastAckedServerVector: vi.fn(async () => new Map()),
			saveLastAckedServerVector: vi.fn(async () => {}),
			mergeServerVectors: vi.fn((a: VersionVector, b: VersionVector) => new Map([...a, ...b])),
			countUnsyncedOperations: vi.fn(async () => 0),
			getUnsyncedOperations: vi.fn(async () => []),
			loadDeltaCursor: vi.fn(async () => null),
			saveDeltaCursor: vi.fn(async (cursor) => {
				saved.push(cursor)
			}),
		}

		const engine = new SyncEngine({
			transport: client,
			store: createMockStore(),
			config: { url: 'ws://test' },
			syncState: mockSyncState,
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 50))

		expect(saved.some((cursor) => cursor?.lastOperationId === 'remote-1')).toBe(true)
		expect(saved[saved.length - 1]).toBeNull()
	})
})

describe('apply failure observability', () => {
	test('emits sync:apply-failed when store returns rejected', async () => {
		const emitter = createMockEmitter()
		const remoteOp = makeOp('reject-op', 1, 'remote-node')
		const { client, server } = createMemoryTransportPair()
		setupServerResponder(server, { serverDelta: [remoteOp] })

		const store = createMockStore({
			applyRemoteOperation: vi.fn(async () => 'rejected' as const),
		})

		const engine = new SyncEngine({
			transport: client,
			store,
			config: { url: 'ws://test' },
			emitter,
		})

		await engine.start()
		await new Promise((resolve) => setTimeout(resolve, 50))

		const failures = emitter.events.filter((event) => event.type === 'sync:apply-failed')
		expect(failures).toHaveLength(1)
		expect(failures[0]).toMatchObject({
			operationId: remoteOp.id,
			code: APPLY_FAILURE_CODES.APPLY_REJECTED,
		})
	})
})
