import type { Operation, VersionVector } from '@korajs/core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type {
	HandshakeMessage,
	OperationBatchMessage,
	SerializedOperation,
	SyncMessage,
} from '../protocol/messages'
import { JsonMessageSerializer } from '../protocol/serializer'
import { createMemoryTransportPair } from '../transport/memory-transport'
import type { DeliveryAnchorRecord, SyncStatePersistence } from '../types'
import { SyncEngine } from './sync-engine'
import type { SyncStore } from './sync-store'

/**
 * Client side of delivery anchors: the engine keeps the anchor of the batch that took a
 * view's watermark to its value and reports it at the next handshake, only while it still
 * belongs to exactly that watermark. The server uses it to recognize a log rewound by a
 * restore (see the server's delivery-anchor tests).
 */

const serializer = new JsonMessageSerializer()
const flush = () => new Promise((resolve) => setTimeout(resolve, 15))

function makeOp(id: string, seq: number): Operation {
	return {
		id,
		nodeId: 'server',
		type: 'insert',
		collection: 'todos',
		recordId: `rec-${id}`,
		data: { title: id },
		previousData: null,
		timestamp: { wallTime: 1000 + seq, logical: 0, nodeId: 'server' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
	}
}

function batch(
	id: string,
	ops: Operation[],
	base: number,
	max: number,
	anchor?: string,
): OperationBatchMessage {
	return {
		type: 'operation-batch',
		messageId: id,
		operations: ops.map((o): SerializedOperation => serializer.encodeOperation(o)),
		isFinal: true,
		batchIndex: 0,
		baseDeliverySequence: base,
		maxDeliverySequence: max,
		...(anchor ? { deliveryAnchor: anchor } : {}),
	}
}

function store(): SyncStore {
	const versionVector: VersionVector = new Map()
	return {
		getVersionVector: () => versionVector,
		getNodeId: () => 'client-node',
		applyRemoteOperation: vi.fn(async () => 'applied' as const),
		getOperationRange: vi.fn(async () => []),
	}
}

function persistence(
	watermarks: Record<string, number> = {},
	anchors: Record<string, DeliveryAnchorRecord> = {},
) {
	const map = new Map(Object.entries(watermarks))
	const saved = new Map(Object.entries(anchors))
	const state: SyncStatePersistence & {
		mergeServerVectors: (a: VersionVector, b: VersionVector) => VersionVector
	} = {
		loadLastAckedServerVector: async () => new Map<string, number>(),
		saveLastAckedServerVector: async () => {},
		mergeServerVectors: (a: VersionVector, b: VersionVector) => new Map([...a, ...b]),
		countUnsyncedOperations: async () => 0,
		getUnsyncedOperations: async () => [],
		loadDeliveryWatermark: async (signature) => map.get(signature) ?? 0,
		saveDeliveryWatermark: async (signature, watermark) => {
			map.set(signature, watermark)
		},
		loadAllDeliveryWatermarks: async () => Object.fromEntries(map),
		loadDeliveryAnchors: async () => Object.fromEntries(saved),
		saveDeliveryAnchor: async (signature, record) => {
			saved.set(signature, record)
		},
	}
	return { state, saved }
}

let engine: SyncEngine | null = null
afterEach(async () => {
	await engine?.stop()
	engine = null
})

async function connect(state: SyncStatePersistence) {
	const { client, server } = createMemoryTransportPair()
	const handshakes: HandshakeMessage[] = []
	server.onMessage((msg: SyncMessage) => {
		if (msg.type !== 'handshake') return
		handshakes.push(msg as HandshakeMessage)
		server.send({
			type: 'handshake-response',
			messageId: `resp-${msg.messageId}`,
			nodeId: 'server-node',
			versionVector: {},
			schemaVersion: msg.schemaVersion,
			accepted: true,
			serverMaxDeliverySequence: 100,
		})
	})
	engine = new SyncEngine({
		transport: client,
		store: store(),
		config: { url: 'ws://test' },
		syncState: state,
	})
	await engine.start()
	await flush()
	return { server, handshakes }
}

describe('client delivery anchors', () => {
	test('keeps the anchor of the batch that set the watermark and reports it at the next handshake', async () => {
		const { state, saved } = persistence()
		const { server } = await connect(state)
		server.send(batch('b1', [makeOp('o1', 1), makeOp('o2', 2)], 0, 3, 'server-op-3'))
		await flush()
		expect(saved.get('')).toEqual({ watermark: 3, anchor: 'server-op-3' })
		await engine?.stop()

		const again = await connect(state)
		expect(again.handshakes[0]?.lastDeliverySequence).toBe(3)
		expect(again.handshakes[0]?.lastDeliveryAnchor).toBe('server-op-3')
	})

	test('an anchor that belongs to another watermark is never reported', async () => {
		const { state } = persistence({ '': 7 }, { '': { watermark: 5, anchor: 'older' } })
		const { handshakes } = await connect(state)
		expect(handshakes[0]?.lastDeliverySequence).toBe(7)
		expect(handshakes[0]?.lastDeliveryAnchor).toBeUndefined()
	})

	test('a server that sends no anchor leaves nothing to report', async () => {
		const { state, saved } = persistence()
		const { server } = await connect(state)
		server.send(batch('b1', [makeOp('o1', 1)], 0, 1))
		await flush()
		expect(saved.size).toBe(0)
	})

	test('persistence without anchors keeps the handshake as it was', async () => {
		const { state } = persistence({ '': 4 })
		const { loadDeliveryAnchors: _load, saveDeliveryAnchor: _save, ...withoutAnchors } = state
		const { server, handshakes } = await connect(withoutAnchors)
		expect(handshakes[0]?.lastDeliverySequence).toBe(4)
		expect(handshakes[0]?.lastDeliveryAnchor).toBeUndefined()
		server.send(batch('b1', [makeOp('o5', 5)], 4, 5, 'server-op-5'))
		await flush()
	})
})
