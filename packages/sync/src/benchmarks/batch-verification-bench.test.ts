import { computeOperationId } from '@korajs/core'
import type { Operation, VersionVector } from '@korajs/core'
import { describe, expect, test, vi } from 'vitest'
import { SyncEngine } from '../engine/sync-engine'
import type { SyncStore, SyncStoreBatch } from '../engine/sync-store'
import type { OperationBatchMessage, SerializedOperation } from '../protocol/messages'
import { JsonMessageSerializer } from '../protocol/serializer'
import { createMemoryTransportPair } from '../transport/memory-transport'
import type { SyncStatePersistence } from '../types'

/**
 * C1.0(a) benchmark: device-side apply time per operation of one 5,000-operation delivery
 * batch whose operations carry real content-addressed ids (half version 1, half version 2),
 * applied through the one-transaction path into a no-op store. The store costs nothing here,
 * so the figure is the engine's own per-operation work, dominated by content-id
 * verification. Run it on the commit before and after the change to compare
 * (docs/design/fast-first-sync.md, "C1.0(a) result").
 *
 * Gated generously (hosts vary); the number is printed, not tightly asserted.
 */

const BATCH_OPERATIONS = 5_000
/** Generous: 1 ms per operation, an order of magnitude over what a dev host measures. */
const PER_OPERATION_LIMIT_MS = 1
const serializer = new JsonMessageSerializer()

async function hashed(seq: number, version: 1 | 2): Promise<Operation> {
	const base = {
		nodeId: 'peer',
		type: 'insert' as const,
		collection: 'todos',
		recordId: `rec-${seq}`,
		data: { title: `t${seq}`, done: false, tags: ['a', 'b'] },
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: seq, nodeId: 'peer' },
		sequenceNumber: seq,
		causalDeps: [] as string[],
		schemaVersion: 1,
	}
	return { id: await computeOperationId(base, version), ...base, hashVersion: version }
}

async function applyBatch(message: OperationBatchMessage, count: number): Promise<number> {
	let applied = 0
	let watermark = 0
	const identity = {}
	const state: SyncStatePersistence = {
		loadLastAckedServerVector: async () => new Map(),
		saveLastAckedServerVector: async () => {},
		mergeServerVectors: (a: VersionVector, b: VersionVector) => new Map([...a, ...b]),
		countUnsyncedOperations: async () => 0,
		getUnsyncedOperations: async () => [],
		loadAllDeliveryWatermarks: async () => ({}),
		saveDeliveryWatermark: async (_signature, value) => {
			watermark = value
		},
		saveQuarantine: async (_entries, mark) => {
			if (mark) watermark = mark.watermark
		},
		loadQuarantine: async () => [],
		removeQuarantine: async () => {},
		storageIdentity: () => identity,
	}
	const store: SyncStore = {
		getVersionVector: () => new Map(),
		getNodeId: () => 'me',
		applyRemoteOperation: async () => 'applied',
		getOperationRange: async () => [],
		hasCollection: () => true,
		storageIdentity: () => identity,
		applyDeliveryBatch: async <T>(fn: (batch: SyncStoreBatch) => Promise<T>) => ({
			value: await fn({
				applyRemoteOperation: async () => {
					applied++
					return 'applied'
				},
				applyScopeRetraction: async () => {},
				saveQuarantine: (entries, mark) =>
					state.saveQuarantine?.(entries, mark) ?? Promise.resolve(),
				saveDeliveryWatermark: (signature, value, completion) =>
					state.saveDeliveryWatermark?.(signature, value, completion) ?? Promise.resolve(),
				afterCommit: () => {},
			}),
		}),
	}
	const { client, server } = createMemoryTransportPair()
	server.onMessage((msg) => {
		if (msg.type === 'handshake') {
			server.send({
				type: 'handshake-response',
				messageId: 'resp',
				nodeId: 'server',
				versionVector: {},
				schemaVersion: msg.schemaVersion,
				accepted: true,
			})
		}
	})
	const engine = new SyncEngine({
		transport: client,
		store,
		config: { url: 'ws://bench' },
		syncState: state,
	})
	await engine.start()
	await vi.waitFor(() => expect(engine.getState()).toBe('syncing'))
	const startedAt = performance.now()
	server.send(message)
	await vi.waitFor(() => expect(watermark).toBe(count), { timeout: 60_000, interval: 5 })
	const elapsed = performance.now() - startedAt
	expect(applied).toBe(count)
	await engine.stop()
	return elapsed
}

describe('C1.0(a) batch verification benchmark', () => {
	test('5,000-operation delivery batch: per-operation apply time', async () => {
		const ops: Operation[] = []
		for (let i = 1; i <= BATCH_OPERATIONS; i++) ops.push(await hashed(i, i % 2 === 0 ? 2 : 1))
		const message: OperationBatchMessage = {
			type: 'operation-batch',
			messageId: 'bench',
			operations: ops.map((op): SerializedOperation => serializer.encodeOperation(op)),
			isFinal: true,
			batchIndex: 0,
			baseDeliverySequence: 0,
			maxDeliverySequence: ops.length,
		}
		const runs: number[] = []
		for (let run = 0; run < 5; run++) runs.push(await applyBatch(message, ops.length))
		const best = Math.min(...runs)
		console.log(
			`[C1.0(a)] ${BATCH_OPERATIONS} ops: runs ${runs.map((r) => r.toFixed(0)).join(', ')} ms; best ${((best / BATCH_OPERATIONS) * 1000).toFixed(1)} us per operation`,
		)
		expect(best / BATCH_OPERATIONS).toBeLessThan(PER_OPERATION_LIMIT_MS)
	}, 180_000)
})
