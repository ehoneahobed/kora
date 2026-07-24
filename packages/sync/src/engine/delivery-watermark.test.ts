import { APPLY_FAILURE_CODES } from '@korajs/core'
import type { Operation, VersionVector } from '@korajs/core'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type {
	AcknowledgmentMessage,
	HandshakeMessage,
	OperationBatchMessage,
	SerializedOperation,
	SyncMessage,
} from '../protocol/messages'
import { JsonMessageSerializer } from '../protocol/serializer'
import { type MemoryTransport, createMemoryTransportPair } from '../transport/memory-transport'
import type { SyncStatePersistence } from '../types'
import { SyncEngine } from './sync-engine'
import type { SyncStore } from './sync-store'

/**
 * Client-side delivery-watermark chain logic. These tests drive the engine directly
 * over a memory transport, asserting that the watermark:
 *   - is reported at handshake and resumes from the persisted value,
 *   - advances (and persists) only for an in-order, fully-applied delivery batch,
 *   - does not advance past a retriable apply failure (the resume-cursor-skip fix),
 *   - skips a gap batch (base above the watermark) without acknowledging it,
 *   - re-acknowledges a duplicate batch (base below the watermark) without re-applying.
 */

const serializer = new JsonMessageSerializer()

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
		operations: ops.map((o): SerializedOperation => serializer.encodeOperation(o)),
		isFinal,
		batchIndex: 0,
		baseDeliverySequence: base,
		maxDeliverySequence: max,
	}
}

function createStore(applyImpl?: SyncStore['applyRemoteOperation']): SyncStore {
	const versionVector: VersionVector = new Map()
	return {
		getVersionVector: () => versionVector,
		getNodeId: () => 'client-node',
		applyRemoteOperation: applyImpl ?? vi.fn(async () => 'applied' as const),
		getOperationRange: vi.fn(async () => []),
	}
}

function createSyncState(initialWatermark: number): SyncStatePersistence & {
	map: Map<string, number>
	saves: Array<[string, number]>
	deletes: string[]
	readonly watermark: number
	readonly saved: number[]
} {
	const map = new Map<string, number>()
	if (initialWatermark > 0) map.set('', initialWatermark)
	const saves: Array<[string, number]> = []
	const deletes: string[] = []
	return {
		map,
		saves,
		deletes,
		// The default view ('') watermark and its save history, for assertions on tests
		// that never change scope.
		get watermark() {
			return map.get('') ?? 0
		},
		get saved() {
			return saves.filter(([sig]) => sig === '').map(([, w]) => w)
		},
		loadLastAckedServerVector: async () => new Map<string, number>(),
		saveLastAckedServerVector: async () => {},
		mergeServerVectors: (a: VersionVector, b: VersionVector) => new Map([...a, ...b]),
		countUnsyncedOperations: async () => 0,
		getUnsyncedOperations: async () => [],
		loadDeliveryWatermark: async (signature: string) => map.get(signature) ?? 0,
		saveDeliveryWatermark: async (signature: string, w: number) => {
			map.set(signature, w)
			saves.push([signature, w])
		},
		loadAllDeliveryWatermarks: async () => Object.fromEntries(map),
		deleteDeliveryWatermark: async (signature: string) => {
			map.delete(signature)
			deletes.push(signature)
		},
	}
}

/** Drive handshake acceptance and collect everything the client sends back. */
function acceptHandshake(server: MemoryTransport, sent: SyncMessage[]): HandshakeMessage[] {
	const handshakes: HandshakeMessage[] = []
	server.onMessage((msg) => {
		sent.push(msg)
		if (msg.type === 'handshake') {
			handshakes.push(msg as HandshakeMessage)
			server.send({
				type: 'handshake-response',
				messageId: `resp-${msg.messageId}`,
				nodeId: 'server-node',
				versionVector: {},
				schemaVersion: msg.schemaVersion,
				accepted: true,
			})
		}
	})
	return handshakes
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 15))

describe('client delivery watermark', () => {
	let engine: SyncEngine

	beforeEach(() => {
		engine = undefined as unknown as SyncEngine
	})

	async function startEngine(
		store: SyncStore,
		syncState: SyncStatePersistence,
	): Promise<{
		server: MemoryTransport
		sent: SyncMessage[]
	}> {
		const { client, server } = createMemoryTransportPair()
		const sent: SyncMessage[] = []
		acceptHandshake(server, sent)
		engine = new SyncEngine({
			transport: client,
			store,
			config: { url: 'ws://test' },
			syncState,
		})
		await engine.start()
		await flush()
		return { server, sent }
	}

	function acksFor(sent: SyncMessage[]): AcknowledgmentMessage[] {
		return sent.filter((m): m is AcknowledgmentMessage => m.type === 'acknowledgment')
	}

	test('reports the persisted watermark in the handshake', async () => {
		const syncState = createSyncState(42)
		const { sent } = await startEngine(createStore(), syncState)
		const handshake = sent.find((m): m is HandshakeMessage => m.type === 'handshake')
		expect(handshake?.lastDeliverySequence).toBe(42)
		await engine.stop()
	})

	test('resets the watermark to 0 when the server frontier is behind it (rollback)', async () => {
		// The client persisted watermark 500, but the server reports a max of 10 (its log
		// was rolled back). The client must reset to 0 so the resync-from-zero stream that
		// follows applies instead of being treated as duplicates.
		const { client, server } = createMemoryTransportPair()
		server.onMessage((msg) => {
			if (msg.type === 'handshake') {
				server.send({
					type: 'handshake-response',
					messageId: `resp-${msg.messageId}`,
					nodeId: 'server-node',
					versionVector: {},
					schemaVersion: msg.schemaVersion,
					accepted: true,
					serverMaxDeliverySequence: 10,
				})
			}
		})
		const syncState = createSyncState(500)
		engine = new SyncEngine({
			transport: client,
			store: createStore(),
			config: { url: 'ws://test' },
			syncState,
		})
		await engine.start()
		await flush()

		expect(syncState.watermark).toBe(0)
		expect(syncState.saved).toContain(0)
		await engine.stop()
	})

	test('advances and persists the watermark for an in-order, fully-applied batch', async () => {
		const apply = vi.fn(async () => 'applied' as const)
		const syncState = createSyncState(0)
		const { server, sent } = await startEngine(createStore(apply), syncState)

		server.send(deliveryBatch('b1', [makeOp('o1', 1), makeOp('o2', 2)], 0, 2))
		await flush()
		server.send(deliveryBatch('b2', [makeOp('o3', 3)], 2, 5, true)) // max 5 skips an out-of-scope tail
		await flush()

		expect(apply).toHaveBeenCalledTimes(3)
		expect(syncState.watermark).toBe(5)
		expect(syncState.saved).toEqual([2, 5])
		const acks = acksFor(sent)
		expect(acks.map((a) => a.deliverySequence)).toEqual([2, 5])
		await engine.stop()
	})

	test('does not advance the watermark when an operation fails retriably', async () => {
		// First op applies, second throws a retriable error, so the batch is not fully
		// applied and the watermark must stay at 0 for the next handshake to re-fetch it.
		let call = 0
		const apply = vi.fn(async () => {
			call++
			if (call === 2) {
				throw new Error('transient apply failure')
			}
			return 'applied' as const
		})
		const syncState = createSyncState(0)
		const { server, sent } = await startEngine(createStore(apply), syncState)

		server.send(deliveryBatch('b1', [makeOp('o1', 1), makeOp('o2', 2)], 0, 2))
		await flush()

		expect(syncState.watermark).toBe(0)
		expect(syncState.saved).toEqual([])
		// A failed delivery batch is NOT acknowledged, so the server keeps re-sending it
		// from the client's last acknowledged position rather than releasing it.
		expect(acksFor(sent)).toHaveLength(0)
		await engine.stop()
	})

	test('skips a gap batch (base above the watermark) without acknowledging it', async () => {
		const apply = vi.fn(async () => 'applied' as const)
		const syncState = createSyncState(0)
		const { server, sent } = await startEngine(createStore(apply), syncState)

		// Base 5 but our watermark is 0: an earlier batch is missing. Must not apply.
		server.send(deliveryBatch('gap', [makeOp('o9', 9)], 5, 9))
		await flush()

		expect(apply).not.toHaveBeenCalled()
		expect(syncState.watermark).toBe(0)
		expect(acksFor(sent)).toHaveLength(0)
		await engine.stop()
	})

	test('re-acknowledges a duplicate batch (base below the watermark) without re-applying', async () => {
		const apply = vi.fn(async () => 'applied' as const)
		const syncState = createSyncState(0)
		const { server, sent } = await startEngine(createStore(apply), syncState)

		server.send(deliveryBatch('b1', [makeOp('o1', 1)], 0, 3))
		await flush()
		expect(syncState.watermark).toBe(3)
		expect(apply).toHaveBeenCalledTimes(1)

		// A retransmit of the already-applied batch (base 0 < watermark 3).
		server.send(deliveryBatch('b1-retransmit', [makeOp('o1', 1)], 0, 3))
		await flush()

		expect(apply).toHaveBeenCalledTimes(1) // not re-applied
		expect(syncState.watermark).toBe(3) // not moved backward
		const acks = acksFor(sent)
		expect(acks.length).toBeGreaterThanOrEqual(2) // the duplicate is still acknowledged
		await engine.stop()
	})

	test('does not advance the watermark on a terminal (non-retriable) apply failure', async () => {
		// A terminal failure on an inbound delivery op must NOT silently advance the
		// watermark: inbound ops are authoritative and are not diverted anywhere, so
		// advancing would lose the op. The watermark stalls and the batch is not acked, so
		// the server keeps re-sending it (a visible, recoverable stall, not silent loss).
		const apply = vi.fn(async () => {
			const err = new Error('missing parent') as Error & { code: string }
			err.code = APPLY_FAILURE_CODES.REFERENTIAL_INTEGRITY
			throw err
		})
		const syncState = createSyncState(0)
		const { server, sent } = await startEngine(createStore(apply), syncState)

		server.send(deliveryBatch('b1', [makeOp('o1', 1)], 0, 5))
		await flush()

		expect(syncState.watermark).toBe(0) // did not advance past the failed op
		expect(acksFor(sent)).toHaveLength(0) // not acked, so the server re-sends it
		await engine.stop()
	})

	test('keys the watermark per view: switching scope resyncs the new view but resumes the old', async () => {
		const syncState = createSyncState(0)
		const { server } = await startEngine(createStore(), syncState)

		// Default view syncs to 7.
		server.send(deliveryBatch('b1', [makeOp('o1', 1)], 0, 7))
		await flush()
		expect(syncState.map.get('')).toBe(7)

		// Switch to a scoped view: the old view is preserved, the new view starts fresh.
		engine.updateScope({ todos: { userId: 'a' } })
		await flush()
		expect(syncState.map.get('')).toBe(7) // old view retained
		// The new view is unsynced (chain from 0). Sync it to 4.
		server.send(deliveryBatch('b2', [makeOp('o2', 2)], 0, 4))
		await flush()
		const scopedSig = [...syncState.map.keys()].find((k) => k !== '')
		expect(syncState.map.get(scopedSig ?? 'x')).toBe(4)

		// Switch back to the default view: it must RESUME from 7 (not resync). A batch that
		// chains from 7 applies, which proves the watermark was restored to 7, not reset.
		engine.updateScope(undefined)
		await flush()
		server.send(deliveryBatch('b3', [makeOp('o3', 3)], 7, 9))
		await flush()
		expect(syncState.map.get('')).toBe(9) // resumed from 7, advanced to 9

		// And switching back to the scoped view resumes from 4.
		engine.updateScope({ todos: { userId: 'a' } })
		await flush()
		server.send(deliveryBatch('b4', [makeOp('o4', 4)], 4, 6))
		await flush()
		expect(syncState.map.get(scopedSig ?? 'x')).toBe(6)
		await engine.stop()
	})

	test('a never-seen view starts at 0 (one-time resync); a query subscription is its own view', async () => {
		const syncState = createSyncState(0)
		const { server } = await startEngine(createStore(), syncState)
		server.send(deliveryBatch('b1', [makeOp('o1', 1)], 0, 4))
		await flush()
		expect(syncState.map.get('')).toBe(4)

		// Registering a subset switches to a new (unsynced) view: a batch that chains from 0
		// applies, proving the view starts fresh rather than at the default view's 4.
		engine.registerQuerySubset({ collection: 'todos', where: { completed: true } })
		await flush()
		server.send(deliveryBatch('b2', [makeOp('o2', 2)], 0, 3))
		await flush()
		const subsetSig = [...syncState.map.keys()].find((k) => k !== '')
		expect(syncState.map.get(subsetSig ?? 'x')).toBe(3)
		// The default view's watermark is untouched.
		expect(syncState.map.get('')).toBe(4)
		await engine.stop()
	})

	test('bounds the number of retained view watermarks, evicting the coldest views', async () => {
		const syncState = createSyncState(0)
		const { server } = await startEngine(createStore(), syncState)

		// Sync the default view so it holds a real position, then churn through many distinct
		// scoped views (as a per-keystroke search subscription would). Each switch persists the
		// outgoing view, so the persisted set would grow without bound absent the cap.
		server.send(deliveryBatch('b0', [makeOp('o0', 1)], 0, 5))
		await flush()
		expect(syncState.map.get('')).toBe(5)

		for (let i = 0; i < 200; i++) {
			engine.updateScope({ todos: { userId: `user-${i}` } })
		}
		await flush()

		// The persisted set is bounded (cap is 64; the live view is not yet written, so at most
		// the cap remains), the default view survived eviction, and cold views were deleted.
		expect(syncState.map.size).toBeLessThanOrEqual(64)
		expect(syncState.map.has('')).toBe(true)
		expect(syncState.map.get('')).toBe(5)
		expect(syncState.deletes.length).toBeGreaterThan(0)
		// A never-evicted default view still resumes from its position (chain from 5 applies).
		engine.updateScope(undefined)
		await flush()
		server.send(deliveryBatch('b-final', [makeOp('of', 2)], 5, 8))
		await flush()
		expect(syncState.map.get('')).toBe(8)
		await engine.stop()
	})
})
