import { FoldStateError } from '@korajs/core'
import type { Operation, VersionVector } from '@korajs/core'
import { describe, expect, test, vi } from 'vitest'
import type { OperationBatchMessage, SerializedOperation, SyncMessage } from '../protocol/messages'
import { JsonMessageSerializer } from '../protocol/serializer'
import { createMemoryTransportPair } from '../transport/memory-transport'
import type { QuarantinedOperation, SyncStatePersistence } from '../types'
import { SyncEngine } from './sync-engine'
import type { SyncStore } from './sync-store'

/**
 * RT-63, inbound path. A remote operation whose record state the store's fold cannot
 * take (`FoldStateError`, after the store's own one re-fold) is quarantined, and the
 * delivery stream goes on: later operations apply and the watermark advances. At
 * 827adc9 the engine treated any such apply error as transient and stalled the
 * stream (the watermark never passed the operation, so nothing after it applied);
 * this test fails there.
 */

const serializer = new JsonMessageSerializer()

function makeOp(id: string, seq: number): Operation {
	return {
		id,
		nodeId: 'server',
		type: 'update',
		collection: 'items',
		recordId: `rec-${id}`,
		data: { score: seq },
		previousData: { score: 0 },
		timestamp: { wallTime: 1000 + seq, logical: 0, nodeId: 'server' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
	}
}

function batch(
	ops: Operation[],
	base: number,
	max: number,
	isFinal: boolean,
): OperationBatchMessage {
	return {
		type: 'operation-batch',
		messageId: `b-${base}`,
		operations: ops.map((o): SerializedOperation => serializer.encodeOperation(o)),
		isFinal,
		batchIndex: 0,
		baseDeliverySequence: base,
		maxDeliverySequence: max,
	}
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 15))

describe('FoldStateError on inbound apply (RT-63)', () => {
	test('is quarantined; later operations apply and the watermark advances', async () => {
		const applied: string[] = []
		const settle = vi.fn(async () => 0)
		const store: SyncStore = {
			getVersionVector: () => new Map() as VersionVector,
			getNodeId: () => 'client-node',
			applyRemoteOperation: vi.fn(async (op: Operation) => {
				if (op.id === 'bad') {
					throw new FoldStateError('Field "score" is stored as fold kind "reg".', {
						field: 'score',
					})
				}
				applied.push(op.id)
				return 'applied' as const
			}),
			getOperationRange: vi.fn(async () => []),
			settleAfterCatchUp: settle,
		}
		let watermark = 0
		const quarantined: QuarantinedOperation[] = []
		const syncState: SyncStatePersistence = {
			loadLastAckedServerVector: async () => new Map<string, number>(),
			saveLastAckedServerVector: async () => {},
			mergeServerVectors: (a: VersionVector, b: VersionVector) => new Map([...a, ...b]),
			countUnsyncedOperations: async () => 0,
			getUnsyncedOperations: async () => [],
			loadDeliveryWatermark: async () => watermark,
			saveDeliveryWatermark: async (_signature: string, w: number) => {
				watermark = w
			},
			loadAllDeliveryWatermarks: async () => ({ '': watermark }),
			deleteDeliveryWatermark: async () => {},
			saveQuarantine: async (entries, advance) => {
				quarantined.push(...entries)
				if (advance) watermark = advance.watermark
			},
			loadQuarantine: async () => [...quarantined],
			removeQuarantine: async () => {},
		}
		const { client, server } = createMemoryTransportPair()
		const sent: SyncMessage[] = []
		server.onMessage((msg) => {
			sent.push(msg)
			if (msg.type === 'handshake') {
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
		const engine = new SyncEngine({
			transport: client,
			store,
			config: { url: 'ws://t' },
			syncState,
		})
		await engine.start()
		await flush()

		server.send(batch([makeOp('ok-1', 1), makeOp('bad', 2), makeOp('ok-3', 3)], 0, 3, false))
		await flush()
		server.send(batch([makeOp('ok-4', 4)], 3, 4, true))
		await flush()

		expect(applied).toEqual(['ok-1', 'ok-3', 'ok-4'])
		expect(quarantined.map((entry) => entry.operation.id)).toEqual(['bad'])
		expect(quarantined[0]?.code).toBe('FOLD_STATE_INVALID')
		expect(watermark).toBe(4)
		// The caught-up stream lets the store settle provisional effects / snapshots.
		expect(settle).toHaveBeenCalled()
		await engine.stop()
	})
})
