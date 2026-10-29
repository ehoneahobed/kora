import { computeOperationId } from '@korajs/core'
import type { KoraEvent, Operation, VersionVector } from '@korajs/core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { OperationBatchMessage, SerializedOperation } from '../protocol/messages'
import { JsonMessageSerializer } from '../protocol/serializer'
import { createMemoryTransportPair } from '../transport/memory-transport'
import type { QuarantinedOperation, SyncStatePersistence } from '../types'
import { SyncEngine } from './sync-engine'
import type { SyncStore, SyncStoreBatch } from './sync-store'

/**
 * C1.0(a): a delivery batch is decrypted and verified before its storage transaction opens,
 * every operation exactly once, and a failing id is handled exactly as before.
 */

const serializer = new JsonMessageSerializer()
const PEER = 'peer'
/** Digests already computed when each storage transaction opened. */
const digestsAtOpen: number[] = []
let digestSpy: { mock: { calls: unknown[] } } | null = null

async function hashed(seq: number, version: 1 | 2, tamper = false): Promise<Operation> {
	const base = {
		nodeId: PEER,
		type: 'insert' as const,
		collection: 'todos',
		recordId: `rec-${seq}`,
		data: { title: `t${seq}` },
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: seq, nodeId: PEER },
		sequenceNumber: seq,
		causalDeps: [] as string[],
		schemaVersion: 1,
	}
	const id = await computeOperationId(base, version)
	// A forged operation keeps its id but its content changed after the id was computed.
	return { id, ...base, ...(tamper ? { data: { title: 'forged' } } : {}), hashVersion: version }
}

function deliveryBatch(ops: Operation[], base = 0, max = ops.length): OperationBatchMessage {
	return {
		type: 'operation-batch',
		messageId: `batch-${base}-${max}`,
		operations: ops.map((op): SerializedOperation => serializer.encodeOperation(op)),
		isFinal: true,
		batchIndex: 0,
		baseDeliverySequence: base,
		maxDeliverySequence: max,
	}
}

interface Harness {
	engine: SyncEngine
	send(msg: OperationBatchMessage): void
	applied: string[]
	quarantine: Map<string, QuarantinedOperation>
	events: KoraEvent[]
	watermark(): number
	batchesOpened(): number
}

async function start(mode: 'transaction' | 'per-operation', applyThrows = false): Promise<Harness> {
	const applied: string[] = []
	const quarantine = new Map<string, QuarantinedOperation>()
	let watermark = 0
	let batchesOpened = 0
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
		saveQuarantine: async (entries, mark) => {
			for (const entry of entries) quarantine.set(entry.operation.id, entry)
			if (mark) watermark = mark.watermark
		},
		loadQuarantine: async () => [...quarantine.values()],
		removeQuarantine: async () => {},
		...(mode === 'transaction' ? { storageIdentity: () => identity } : {}),
	}
	const apply = async (op: Operation): Promise<'applied'> => {
		if (applyThrows) throw new Error('database is busy')
		applied.push(op.id)
		return 'applied'
	}
	const store: SyncStore = {
		getVersionVector: () => new Map(),
		getNodeId: () => 'me',
		applyRemoteOperation: apply,
		getOperationRange: async () => [],
		hasCollection: () => true,
		...(mode === 'transaction'
			? {
					storageIdentity: () => identity,
					applyDeliveryBatch: async <T>(fn: (batch: SyncStoreBatch) => Promise<T>) => {
						batchesOpened++
						digestsAtOpen.push(digestSpy?.mock.calls.length ?? -1)
						const value = await fn({
							applyRemoteOperation: apply,
							applyScopeRetraction: async () => {},
							saveQuarantine: (entries, mark) =>
								state.saveQuarantine?.(entries, mark) ?? Promise.resolve(),
							saveDeliveryWatermark: (signature, value, completion) =>
								state.saveDeliveryWatermark?.(signature, value, completion) ?? Promise.resolve(),
							afterCommit: () => {},
						})
						return { value }
					},
				}
			: {}),
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
	const events: KoraEvent[] = []
	const engine = new SyncEngine({
		transport: client,
		store,
		config: { url: 'ws://test' },
		syncState: state,
		emitter: {
			emit: (event: KoraEvent) => {
				events.push(event)
			},
			on: () => () => {},
			off: () => {},
		},
	})
	await engine.start()
	await vi.waitFor(() => expect(engine.getState()).toBe('syncing'))
	return {
		engine,
		send: (msg) => server.send(msg),
		applied,
		quarantine,
		events,
		watermark: () => watermark,
		batchesOpened: () => batchesOpened,
	}
}

afterEach(() => {
	digestSpy = null
	digestsAtOpen.length = 0
	vi.restoreAllMocks()
})

describe.each(['transaction', 'per-operation'] as const)('batch verification (%s path)', (mode) => {
	test('every operation is verified exactly once, in order, hash versions 1 and 2 mixed', async () => {
		const ops: Operation[] = []
		for (let i = 1; i <= 150; i++) ops.push(await hashed(i, i % 2 === 0 ? 2 : 1))
		const digest = vi.spyOn(globalThis.crypto.subtle, 'digest')
		digestSpy = digest
		const h = await start(mode)
		digest.mockClear()
		h.send(deliveryBatch(ops))
		await vi.waitFor(() => expect(h.watermark()).toBe(ops.length))
		expect(digest).toHaveBeenCalledTimes(ops.length)
		expect(h.applied).toEqual(ops.map((op) => op.id))
		expect(h.quarantine.size).toBe(0)
		if (mode === 'transaction') {
			expect(h.batchesOpened()).toBe(1)
			// The whole batch was verified before its transaction opened.
			expect(digestsAtOpen).toEqual([ops.length])
		}
		await h.engine.stop()
	})

	test('one forged id is quarantined as before while the rest apply, in order', async () => {
		const ops = [
			await hashed(1, 2),
			await hashed(2, 1),
			await hashed(3, 2, true),
			await hashed(4, 1),
			await hashed(5, 2),
		]
		const h = await start(mode)
		h.send(deliveryBatch(ops))
		await vi.waitFor(() => expect(h.watermark()).toBe(5))
		expect(h.applied).toEqual([ops[0]?.id, ops[1]?.id, ops[3]?.id, ops[4]?.id])
		const entry = h.quarantine.get(ops[2]?.id ?? '')
		expect(entry?.code).toBe('INVALID_OPERATION_ID')
		expect(entry?.deliverySequence).toBe(5)
		expect(h.quarantine.size).toBe(1)
		await h.engine.stop()
	})

	test('an empty batch verifies nothing and still settles', async () => {
		const digest = vi.spyOn(globalThis.crypto.subtle, 'digest')
		const h = await start(mode)
		digest.mockClear()
		h.send(deliveryBatch([], 0, 3))
		await vi.waitFor(() => expect(h.watermark()).toBe(3))
		expect(digest).not.toHaveBeenCalled()
		await h.engine.stop()
	})
})

describe('batch verification: fallback does not verify again', () => {
	test('a batch that falls back to the per-operation path is still verified once per operation', async () => {
		const ops: Operation[] = []
		for (let i = 1; i <= 20; i++) ops.push(await hashed(i, 2))
		const digest = vi.spyOn(globalThis.crypto.subtle, 'digest')
		const h = await start('transaction', true)
		digest.mockClear()
		h.send(deliveryBatch(ops))
		await vi.waitFor(() => expect(digest).toHaveBeenCalled())
		await new Promise((resolve) => setTimeout(resolve, 100))
		// The transaction attempt rolled back (the store throws), the per-operation path
		// stalled at the first operation: nothing was verified a second time.
		expect(digest.mock.calls.length).toBe(ops.length)
		expect(h.watermark()).toBe(0)
		await h.engine.stop()
	})
})
