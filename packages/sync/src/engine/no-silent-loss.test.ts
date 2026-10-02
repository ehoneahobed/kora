import type { Operation, VersionVector } from '@korajs/core'
import { describe, expect, test, vi } from 'vitest'
import type { SyncEncryptor } from '../encryption/sync-encryptor'
import type {
	HandshakeMessage,
	OperationBatchMessage,
	SerializedOperation,
	SyncMessage,
} from '../protocol/messages'
import { JsonMessageSerializer } from '../protocol/serializer'
import { scopeViewKey } from '../scopes/scope-view-key'
import { type MemoryTransport, createMemoryTransportPair } from '../transport/memory-transport'
import type { QuarantinedOperation, SyncStatePersistence } from '../types'
import { MemoryQueueStorage } from './memory-queue-storage'
import { SyncEngine } from './sync-engine'
import type { SyncStore } from './sync-store'

const NODE = 'me'
const serializer = new JsonMessageSerializer()
const flush = () => new Promise((resolve) => setTimeout(resolve, 15))

function own(seq: number, collection = 'todos'): Operation {
	return {
		id: `own-${seq}`,
		nodeId: NODE,
		type: 'insert',
		collection,
		recordId: `r-${seq}`,
		data: { title: `t${seq}` },
		previousData: null,
		timestamp: { wallTime: 1_000 + seq, logical: 0, nodeId: NODE },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
	}
}

function remote(id: string, overrides: Partial<Operation> = {}): Operation {
	return {
		id,
		nodeId: 'peer',
		type: 'insert',
		collection: 'todos',
		recordId: `rec-${id}`,
		data: { title: id },
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: 0, nodeId: 'peer' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

/** A store holding this device's own log; remote ops are applied through `apply`. */
function makeStore(
	log: Operation[],
	apply: SyncStore['applyRemoteOperation'] = vi.fn(async () => 'applied' as const),
	extra: Partial<SyncStore> = {},
): SyncStore {
	return {
		getVersionVector: (): VersionVector =>
			new Map([[NODE, log.reduce((max, op) => Math.max(max, op.sequenceNumber), 0)]]),
		getNodeId: () => NODE,
		applyRemoteOperation: apply,
		getOperationRange: vi.fn(async (_node: string, from: number, to: number) =>
			log.filter((op) => op.sequenceNumber >= from && op.sequenceNumber <= to),
		),
		hasCollection: (collection: string) => collection === 'todos',
		...extra,
	}
}

/** Persistence with the W3/W4 capabilities (prefix, quarantine). */
function makeState(options: { prefix?: number | null; watermark?: number } = {}) {
	let prefix: number | null = options.prefix === undefined ? 0 : options.prefix
	const quarantine = new Map<string, QuarantinedOperation>()
	const watermarks = new Map<string, number>(options.watermark ? [['', options.watermark]] : [])
	const quarantineCalls: Array<{ ids: string[]; watermark?: number }> = []
	const state: SyncStatePersistence = {
		loadLastAckedServerVector: async () => new Map(),
		saveLastAckedServerVector: async () => {},
		mergeServerVectors: (a, b) => new Map([...a, ...b]),
		countUnsyncedOperations: async () => 0,
		getUnsyncedOperations: async () => [],
		loadAllDeliveryWatermarks: async () => Object.fromEntries(watermarks),
		saveDeliveryWatermark: async (signature, value) => {
			watermarks.set(signature, value)
		},
		loadOwnAckedThrough: async () => prefix,
		saveOwnAckedThrough: async (_node, value) => {
			prefix = value
		},
		saveQuarantine: async (entries, watermark) => {
			for (const entry of entries) quarantine.set(entry.operation.id, entry)
			if (watermark) watermarks.set(watermark.signature, watermark.watermark)
			quarantineCalls.push({
				ids: entries.map((entry) => entry.operation.id),
				watermark: watermark?.watermark,
			})
		},
		loadQuarantine: async () => [...quarantine.values()],
		removeQuarantine: async (ids) => {
			for (const id of ids) quarantine.delete(id)
		},
	}
	return {
		state,
		quarantine,
		quarantineCalls,
		prefix: () => prefix,
		watermark: () => watermarks.get('') ?? 0,
	}
}

interface Server {
	transport: MemoryTransport
	batches: OperationBatchMessage[]
	/** Acknowledge a received upload batch through `lastSequenceNumber`. */
	ack(batch: OperationBatchMessage, lastSequenceNumber?: number): void
}

/** A server that accepts the handshake and leaves acks to the test (or auto-acks). */
function makeServer(
	transport: MemoryTransport,
	options: { autoAck?: boolean; vector?: Record<string, number> } = {},
): Server {
	const batches: OperationBatchMessage[] = []
	const server: Server = {
		transport,
		batches,
		ack(batch, lastSequenceNumber) {
			const last = batch.operations[batch.operations.length - 1]
			transport.send({
				type: 'acknowledgment',
				messageId: `ack-${batch.messageId}`,
				acknowledgedMessageId: batch.messageId,
				lastSequenceNumber: lastSequenceNumber ?? last?.sequenceNumber ?? 0,
			})
		},
	}
	transport.onMessage((msg: SyncMessage) => {
		if (msg.type === 'handshake') {
			const hs = msg as HandshakeMessage
			transport.send({
				type: 'handshake-response',
				messageId: `resp-${hs.messageId}`,
				nodeId: 'server',
				versionVector: options.vector ?? {},
				schemaVersion: hs.schemaVersion,
				accepted: true,
			})
			transport.send({
				type: 'operation-batch',
				messageId: 'server-delta',
				operations: [],
				isFinal: true,
				batchIndex: 0,
			})
			return
		}
		if (msg.type === 'operation-batch') {
			const batch = msg as OperationBatchMessage
			if (batch.operations.length === 0) return
			batches.push(batch)
			if (options.autoAck) server.ack(batch)
		}
	})
	return server
}

function deliveryBatch(
	messageId: string,
	ops: Operation[],
	base: number,
	max: number,
	isFinal = false,
): OperationBatchMessage {
	return {
		type: 'operation-batch',
		messageId,
		operations: ops.map((op): SerializedOperation => serializer.encodeOperation(op)),
		isFinal,
		batchIndex: 0,
		baseDeliverySequence: base,
		maxDeliverySequence: max,
	}
}

function uploadedIds(server: Server): string[] {
	return server.batches.flatMap((batch) => batch.operations.map((op) => op.id))
}

describe('upload: acks resolve only their batch, prefix is contiguous (W3)', () => {
	test('handshake-delta ops stay pending until the server acknowledges them (SYNC-4)', async () => {
		const log = [own(1), own(2)]
		const { client, server: serverSide } = createMemoryTransportPair()
		const server = makeServer(serverSide)
		const persisted = makeState()
		const engine = new SyncEngine({
			transport: client,
			store: makeStore(log),
			syncState: persisted.state,
			config: { url: 'ws://test' },
		})
		await engine.start()
		await flush()
		expect(engine.getState()).toBe('streaming')
		expect(uploadedIds(server)).toEqual(['own-1', 'own-2'])
		// No ack yet: still pending, and the prefix has not moved.
		expect(engine.getStatus().pendingOperations).toBe(2)
		expect(persisted.prefix()).toBe(0)

		const batch = server.batches[0]
		if (!batch) throw new Error('no batch')
		server.ack(batch)
		await flush()
		expect(engine.getStatus().pendingOperations).toBe(0)
		expect(persisted.prefix()).toBe(2)
		await engine.stop()
	})

	test('an ack names its batch: it never resolves another batch in flight', async () => {
		const log = [own(1), own(2), own(3)]
		const { client, server: serverSide } = createMemoryTransportPair()
		const server = makeServer(serverSide)
		const persisted = makeState()
		const engine = new SyncEngine({
			transport: client,
			store: makeStore(log),
			syncState: persisted.state,
			config: { url: 'ws://test', batchSize: 1 },
		})
		await engine.start()
		await flush()
		expect(server.batches).toHaveLength(3)
		const [first, second, third] = server.batches
		if (!first || !second || !third) throw new Error('batches')
		// Ack the LAST batch first: own-3 is stored, but 1 and 2 are not, so the
		// contiguous prefix must not move past the hole.
		server.ack(third)
		await flush()
		expect(persisted.prefix()).toBe(0)
		expect(engine.getStatus().pendingOperations).toBe(2)
		server.ack(first)
		await flush()
		expect(persisted.prefix()).toBe(1)
		server.ack(second)
		await flush()
		expect(persisted.prefix()).toBe(3)
		expect(engine.getStatus().pendingOperations).toBe(0)
		await engine.stop()
	})

	test('a partial ack returns the unprocessed suffix to the queue and retries it', async () => {
		const log = [own(1), own(2)]
		const { client, server: serverSide } = createMemoryTransportPair()
		const server = makeServer(serverSide)
		const persisted = makeState()
		const engine = new SyncEngine({
			transport: client,
			store: makeStore(log),
			syncState: persisted.state,
			config: { url: 'ws://test', outboundRetryBaseDelayMs: 1 },
		})
		await engine.start()
		await flush()
		const batch = server.batches[0]
		if (!batch) throw new Error('batch')
		serverSide.send({
			type: 'operation-rejected',
			messageId: 'rej',
			operationId: 'own-2',
			collection: 'todos',
			recordId: 'r-2',
			code: 'TRY_AGAIN',
			message: 'busy',
			retriable: true,
		})
		server.ack(batch, 1)
		await flush()
		await flush()
		expect(persisted.prefix()).toBe(1)
		// own-2 went back to the queue and was sent again.
		expect(uploadedIds(server).filter((id) => id === 'own-2')).toHaveLength(2)
		const retry = server.batches[1]
		if (!retry) throw new Error('retry batch')
		server.ack(retry)
		await flush()
		expect(persisted.prefix()).toBe(2)
		await engine.stop()
	})

	test('a terminal rejection is recorded and counts toward the prefix', async () => {
		const log = [own(1), own(2)]
		const { client, server: serverSide } = createMemoryTransportPair()
		const server = makeServer(serverSide)
		const persisted = makeState()
		const engine = new SyncEngine({
			transport: client,
			store: makeStore(log),
			syncState: persisted.state,
			config: { url: 'ws://test' },
		})
		await engine.start()
		await flush()
		const batch = server.batches[0]
		if (!batch) throw new Error('batch')
		serverSide.send({
			type: 'operation-rejected',
			messageId: 'rej',
			operationId: 'own-1',
			collection: 'todos',
			recordId: 'r-1',
			code: 'SCOPE_VIOLATION',
			message: 'no',
			retriable: false,
		})
		server.ack(batch)
		await flush()
		expect(persisted.prefix()).toBe(2)
		expect((await engine.getRejectedOperations()).map((r) => r.operationId)).toEqual(['own-1'])
		await engine.stop()
	})

	test('upgrade recovery: with no recorded prefix the device re-uploads its history once, in chunks, and resumes', async () => {
		const log = Array.from({ length: 4_500 }, (_, i) => own(i + 1))
		const persisted = makeState({ prefix: null })
		const store = makeStore(log)

		const first = createMemoryTransportPair()
		const server1 = makeServer(first.server)
		const engine = new SyncEngine({
			transport: first.client,
			store,
			syncState: persisted.state,
			config: { url: 'ws://test' },
		})
		await engine.start()
		await flush()
		// Only the first chunk was read into the queue and sent.
		expect(uploadedIds(server1)).toHaveLength(2_000)
		for (const batch of server1.batches.slice(0, 2)) server1.ack(batch)
		await flush()
		expect(persisted.prefix()).toBe(200)
		await engine.stop()

		// Restart: resumes above the persisted prefix, never from 0 again. The server
		// advertises what it stores (an absent own entry would mean it holds none, RT-45).
		const second = createMemoryTransportPair()
		const server2 = makeServer(second.server, { autoAck: true, vector: { [NODE]: 200 } })
		const restarted = new SyncEngine({
			transport: second.client,
			store,
			syncState: persisted.state,
			config: { url: 'ws://test' },
		})
		await restarted.start()
		await vi.waitFor(() => expect(persisted.prefix()).toBe(4_500), { timeout: 10_000 })
		const resent = uploadedIds(server2)
		expect(resent).not.toContain('own-1')
		expect(resent).toContain('own-201')
		expect(resent).toContain('own-4500')
		expect(restarted.getStatus().pendingOperations).toBe(0)
		await restarted.stop()
	}, 30_000)

	test('a clock rebase re-stamps only operations that were never sent (W3 step 4)', async () => {
		const future = Date.now() + 3_600_000
		const sent = { ...own(1), timestamp: { wallTime: future, logical: 0, nodeId: NODE } }
		const unsent = { ...own(2), timestamp: { wallTime: future, logical: 1, nodeId: NODE } }
		const queueStorage = new MemoryQueueStorage()
		await queueStorage.enqueue(sent)
		await queueStorage.enqueue(unsent)
		await queueStorage.markSent([sent])
		const rebase = vi.fn(async (ids: string[]) => ({
			operations: ids.map((id) => ({ ...unsent, id: `${id}-rebased` })),
			idMapping: Object.fromEntries(ids.map((id) => [id, `${id}-rebased`])),
			rebasedCount: ids.length,
		}))
		const { client, server: serverSide } = createMemoryTransportPair()
		serverSide.onMessage((msg) => {
			if (msg.type !== 'handshake') return
			serverSide.send({
				type: 'handshake-response',
				messageId: 'r',
				nodeId: 'server',
				versionVector: {},
				schemaVersion: 1,
				accepted: true,
				serverTime: Date.now(),
			})
		})
		const engine = new SyncEngine({
			transport: client,
			store: makeStore([sent, unsent], undefined, { rebaseUnsyncedOperations: rebase }),
			queueStorage,
			syncState: makeState().state,
			config: { url: 'ws://test' },
		})
		await engine.start()
		await flush()
		expect(rebase).toHaveBeenCalledTimes(1)
		expect(rebase.mock.calls[0]?.[0]).toEqual(['own-2'])
		await engine.stop()
	})
})

describe('download: apply what was delivered, quarantine what was not (W4)', () => {
	async function start(
		store: SyncStore,
		state: SyncStatePersistence,
		extra: { encryptor?: SyncEncryptor } = {},
	) {
		const { client, server } = createMemoryTransportPair()
		const sent: SyncMessage[] = []
		server.onMessage((msg) => {
			sent.push(msg)
			if (msg.type === 'handshake') {
				server.send({
					type: 'handshake-response',
					messageId: 'r',
					nodeId: 'server',
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
			}
		})
		const engine = new SyncEngine({
			transport: client,
			store,
			syncState: state,
			config: { url: 'ws://test' },
			...extra,
		})
		await engine.start()
		await flush()
		return { engine, server, sent }
	}

	test('an unknown-collection op is quarantined in the same write as the watermark advance (SYNC-3)', async () => {
		const apply = vi.fn(async (op: Operation) =>
			op.collection === 'todos' ? ('applied' as const) : ('skipped' as const),
		)
		const persisted = makeState()
		const { engine, server, sent } = await start(makeStore([], apply), persisted.state)
		server.send(
			deliveryBatch('b1', [remote('a'), remote('n', { collection: 'notes' }), remote('b')], 0, 3),
		)
		await flush()
		expect(persisted.quarantineCalls).toEqual([{ ids: ['n'], watermark: 3 }])
		expect(persisted.watermark()).toBe(3)
		expect(sent.some((m) => m.type === 'acknowledgment')).toBe(true)
		expect(engine.getStatus().blockedFailure).toBeNull()
		await engine.stop()
	})

	test('a far-future op is quarantined without being applied, and later ops flow (SYNC-7)', async () => {
		const apply = vi.fn(async (_op: Operation) => 'applied' as const)
		const persisted = makeState()
		const { engine, server } = await start(makeStore([], apply), persisted.state)
		const poison = remote('future', {
			timestamp: { wallTime: Date.now() + 86_400_000, logical: 0, nodeId: 'peer' },
		})
		server.send(deliveryBatch('b1', [poison, remote('ok')], 0, 2))
		await flush()
		expect(apply.mock.calls.map((call) => (call[0] as Operation).id)).toEqual(['ok'])
		expect(persisted.quarantine.get('future')?.code).toBe('REMOTE_CLOCK_DRIFT')
		expect(persisted.watermark()).toBe(2)
		await engine.stop()
	})

	test('an undecryptable op is quarantined; the session stays up (ENC-2)', async () => {
		const apply = vi.fn(async (_op: Operation) => 'applied' as const)
		const persisted = makeState()
		const encryptor = {
			decryptOperation: async (op: Operation) => {
				if (op.id === 'bad') throw new Error('Failed to decrypt operation data field')
				return op
			},
			encryptBatch: async (ops: Operation[]) => ops,
		} as unknown as SyncEncryptor
		const { engine, server } = await start(makeStore([], apply), persisted.state, { encryptor })
		server.send(deliveryBatch('b1', [remote('bad'), remote('good')], 0, 2))
		await flush()
		expect(engine.getState()).toBe('streaming')
		expect(persisted.quarantine.get('bad')?.code).toBe('DECRYPT_FAILED')
		expect(apply.mock.calls.map((call) => (call[0] as Operation).id)).toEqual(['good'])
		expect(persisted.watermark()).toBe(2)
		await engine.stop()
	})

	test('a transform that yields null quarantines the op', async () => {
		const apply = vi.fn(async (_op: Operation) => 'applied' as const)
		const persisted = makeState()
		const { client, server } = createMemoryTransportPair()
		makeServer(server)
		const engine = new SyncEngine({
			transport: client,
			store: makeStore([], apply),
			syncState: persisted.state,
			config: {
				url: 'ws://test',
				schemaVersion: 2,
				operationTransforms: [{ fromVersion: 1, toVersion: 2, transform: () => null }],
			},
		})
		await engine.start()
		await flush()
		server.send(deliveryBatch('b1', [remote('old')], 0, 1))
		await flush()
		expect(apply).not.toHaveBeenCalled()
		expect(persisted.quarantine.get('old')?.code).toBe('SCHEMA_TRANSFORM_UNAVAILABLE')
		expect(persisted.watermark()).toBe(1)
		await engine.stop()
	})

	test('the quarantine is replayed on start; applied ops leave it', async () => {
		const persisted = makeState()
		await persisted.state.saveQuarantine?.([
			{
				operation: remote('n', { collection: 'notes' }),
				deliverySequence: 1,
				code: 'APPLY_SKIPPED',
				message: 'unknown collection',
				quarantinedAt: 0,
			},
		])
		const apply = vi.fn(async (_op: Operation) => 'applied' as const)
		const { engine } = await start(makeStore([], apply), persisted.state)
		expect(apply).toHaveBeenCalledTimes(1)
		expect(persisted.quarantine.size).toBe(0)
		await engine.stop()
	})

	test('a batch straddling the watermark is applied and advances to its max (NEW-SYNC-1)', async () => {
		const apply = vi.fn(async (_op: Operation) => 'applied' as const)
		const persisted = makeState({ watermark: 2 })
		const { engine, server } = await start(makeStore([], apply), persisted.state)
		server.send(deliveryBatch('b1', [remote('a'), remote('b'), remote('c')], 0, 5))
		await flush()
		expect(persisted.watermark()).toBe(5)
		// The next chained batch (base 5) applies instead of being taken for a gap.
		server.send(deliveryBatch('b2', [remote('d')], 5, 6))
		await flush()
		expect(persisted.watermark()).toBe(6)
		await engine.stop()
	})
})

describe('delivery view across handshakes (SYNC-11)', () => {
	test('each handshake reports the requested view; a different accepted scope switches views', async () => {
		const accepted = { todos: { orgId: 'o1' } }
		const handshakes: HandshakeMessage[] = []
		const { client, server } = createMemoryTransportPair()
		server.onMessage((msg) => {
			if (msg.type !== 'handshake') return
			handshakes.push(msg as HandshakeMessage)
			server.send({
				type: 'handshake-response',
				messageId: `r${handshakes.length}`,
				nodeId: 'server',
				versionVector: {},
				schemaVersion: 1,
				accepted: true,
				acceptedDownlinkScopes: accepted,
			})
			// The server serves another scope than requested, so it restarts from 0.
			server.send(
				deliveryBatch(`d${handshakes.length}`, [remote(`x${handshakes.length}`)], 0, 4, true),
			)
		})
		const persisted = makeState()
		const engine = new SyncEngine({
			transport: client,
			store: makeStore([]),
			syncState: persisted.state,
			config: { url: 'ws://t' },
		})
		await engine.start()
		await flush()
		expect(engine.getState()).toBe('streaming')
		// The accepted view advanced; the requested (default) view did not.
		expect(engine.getStatus().deliveryWatermark).toBe(4)
		expect(persisted.watermark()).toBe(0)

		await engine.reconnect()
		await flush()
		expect(handshakes).toHaveLength(2)
		// The second handshake reports the REQUESTED view's watermark, never the accepted
		// view's: a server that now served the requested scope would resume from it.
		expect(handshakes[1]?.lastDeliverySequence).toBe(0)
		// Next to it, the accepted view it last streamed under and that view's own
		// watermark (SYNC-11 server half), so a server resolving the same scope resumes.
		// The accepted scope is never sent as the requested one.
		expect(handshakes[0]?.acceptedScopeKey).toBeUndefined()
		expect(handshakes[1]?.acceptedScopeKey).toBe(scopeViewKey(accepted))
		expect(handshakes[1]?.acceptedScopeWatermark).toBe(4)
		expect(handshakes[1]?.syncScope).toBeUndefined()
		// The restarted stream is a duplicate of the accepted view: no wedge.
		expect(engine.getState()).toBe('streaming')
		expect(engine.getStatus().deliveryWatermark).toBe(4)
		await engine.stop()
	})
})

describe('lifecycle (SYNC-5, SYNC-10) and status notifications (RT-28)', () => {
	test('stop() on an engine the server already disconnected still closes the transport and clears timers', async () => {
		const { client, server: serverSide } = createMemoryTransportPair()
		makeServer(serverSide)
		const engine = new SyncEngine({
			transport: client,
			store: makeStore([]),
			config: { url: 'ws://t' },
		})
		await engine.start()
		await flush()
		serverSide.simulateDisconnect('server went away')
		client.simulateDisconnect('server went away')
		await flush()
		expect(engine.getState()).toBe('disconnected')
		const disconnect = vi.spyOn(client, 'disconnect')
		await engine.destroy()
		expect(disconnect).toHaveBeenCalled()
		const internals = engine as unknown as {
			outboundAckTimer: unknown
			querySubsetReconnectTimer: unknown
		}
		expect(internals.outboundAckTimer).toBeNull()
		expect(internals.querySubsetReconnectTimer).toBeNull()
		// A destroyed engine never connects again.
		await engine.start()
		expect(engine.getState()).toBe('disconnected')
	})

	test('a message the engine cannot process closes the transport before reconnecting (SYNC-5)', async () => {
		const { client, server: serverSide } = createMemoryTransportPair()
		makeServer(serverSide)
		const store = makeStore([], async () => {
			throw new Error('unexpected')
		})
		const engine = new SyncEngine({ transport: client, store, config: { url: 'ws://t' } })
		await engine.start()
		await flush()
		const disconnect = vi.spyOn(client, 'disconnect')
		// A batch whose operations cannot even be decoded rejects the message handler.
		serverSide.send({
			type: 'operation-batch',
			messageId: 'broken',
			operations: [null as unknown as SerializedOperation],
			isFinal: true,
			batchIndex: 0,
		})
		await flush()
		expect(engine.getState()).toBe('disconnected')
		expect(disconnect).toHaveBeenCalled()
	})

	test('onStatusChange fires when an upload ack clears the pending count', async () => {
		const { client, server: serverSide } = createMemoryTransportPair()
		makeServer(serverSide, { autoAck: true })
		const log: Operation[] = []
		const engine = new SyncEngine({
			transport: client,
			store: makeStore(log),
			syncState: makeState().state,
			config: { url: 'ws://t' },
		})
		await engine.start()
		await flush()
		const statuses: number[] = []
		engine.onStatusChange(() => statuses.push(engine.getStatus().pendingOperations))
		const op = own(1)
		log.push(op)
		await engine.pushOperation(op)
		await flush()
		expect(statuses).toContain(0)
		expect(engine.getStatus().pendingOperations).toBe(0)
		await engine.stop()
	})
})
