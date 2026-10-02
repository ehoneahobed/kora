import type { KoraEvent, Operation, VersionVector } from '@korajs/core'
import { describe, expect, test, vi } from 'vitest'
import type { HandshakeMessage, OperationBatchMessage, SyncMessage } from '../protocol/messages'
import { type MemoryTransport, createMemoryTransportPair } from '../transport/memory-transport'
import type { LocalNodeInfo, SyncStatePersistence, TerminalRejectionRecord } from '../types'
import { SyncEngine } from './sync-engine'
import type { SyncStore } from './sync-store'

/**
 * Phase 2 client contracts: durability before upload and own-history recovery (RT-35),
 * durable terminal rejections (RT-36), node-bound uploads and held nodes (RT-38/RT-40).
 */
const NODE = 'device-node'

function op(seq: number, nodeId = NODE, id = `op-${nodeId}-${seq}`): Operation {
	return {
		id,
		nodeId,
		type: 'insert',
		collection: 'todos',
		recordId: `r-${id}`,
		data: { title: `t${seq}` },
		previousData: null,
		timestamp: { wallTime: 1000 + seq, logical: 0, nodeId },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
	}
}

interface FakeStore extends SyncStore {
	log: Operation[]
	vector: VersionVector
}

function fakeStore(log: Operation[], extra: Partial<SyncStore> = {}): FakeStore {
	const vector: VersionVector = new Map()
	for (const o of log) vector.set(o.nodeId, Math.max(vector.get(o.nodeId) ?? 0, o.sequenceNumber))
	const store: FakeStore = {
		log,
		vector,
		getVersionVector: () => new Map(vector),
		getNodeId: () => NODE,
		applyRemoteOperation: vi.fn(async () => 'applied' as const),
		getOperationRange: vi.fn(async (node: string, from: number, to: number) =>
			log.filter((o) => o.nodeId === node && o.sequenceNumber >= from && o.sequenceNumber <= to),
		),
		...extra,
	}
	return store
}

function persistence(options: { nodes?: LocalNodeInfo[]; terminal?: string[] } = {}) {
	let lastAcked: VersionVector = new Map()
	const prefixes = new Map<string, number>()
	const watermarks = new Map<string, number>()
	const terminal = new Set(options.terminal ?? [])
	const recorded: TerminalRejectionRecord[] = []
	const accepted: string[] = []
	const state: SyncStatePersistence = {
		loadLastAckedServerVector: async () => new Map(lastAcked),
		saveLastAckedServerVector: async (v) => {
			lastAcked = new Map(v)
		},
		mergeServerVectors: (a, b) => {
			const merged = new Map(a)
			for (const [k, v] of b) merged.set(k, Math.max(merged.get(k) ?? 0, v))
			return merged
		},
		countUnsyncedOperations: async () => 0,
		getUnsyncedOperations: async () => [],
		loadOwnAckedThrough: async (node) => prefixes.get(node) ?? null,
		saveOwnAckedThrough: async (node, seq) => {
			prefixes.set(node, seq)
		},
		loadDeliveryWatermark: async (sig) => watermarks.get(sig) ?? 0,
		saveDeliveryWatermark: async (sig, w) => {
			watermarks.set(sig, w)
		},
		loadAllDeliveryWatermarks: async () => Object.fromEntries(watermarks),
		recordTerminalRejections: async (entries) => {
			for (const entry of entries) {
				recorded.push(entry)
				terminal.add(entry.operationId)
			}
		},
		findTerminalRejections: async (ids) => new Set(ids.filter((id) => terminal.has(id))),
		listLocalNodes: async () => options.nodes ?? [],
		markLocalNodeAccepted: async (node) => {
			accepted.push(node)
		},
		markLocalNodeRefused: async () => {},
		loadAcceptedCycle: async () => 0,
	}
	return { state, prefixes, watermarks, recorded, accepted }
}

interface ServerScript {
	ownSeq?: number
	reject?: (op: { id: string }) => { code: string; retriable: boolean } | null
}

function scriptedServer(
	transport: MemoryTransport,
	script: ServerScript = {},
): { uploaded: string[]; handshakes: HandshakeMessage[] } {
	const uploaded: string[] = []
	const handshakes: HandshakeMessage[] = []
	transport.onMessage((msg: SyncMessage) => {
		if (msg.type === 'handshake') {
			handshakes.push(msg)
			transport.send({
				type: 'handshake-response',
				messageId: `resp-${handshakes.length}`,
				nodeId: 'server',
				versionVector: script.ownSeq !== undefined ? { [NODE]: script.ownSeq } : {},
				schemaVersion: 1,
				accepted: true,
			})
			transport.send({
				type: 'operation-batch',
				messageId: 'delta',
				operations: [],
				isFinal: true,
				batchIndex: 0,
			})
			return
		}
		if (msg.type === 'operation-batch') {
			const batch = msg as OperationBatchMessage
			let last = 0
			for (const o of batch.operations) {
				uploaded.push(o.id)
				const refusal = script.reject?.(o)
				if (refusal) {
					transport.send({
						type: 'operation-rejected',
						messageId: `rej-${o.id}`,
						operationId: o.id,
						collection: o.collection,
						recordId: o.recordId,
						code: refusal.code,
						message: refusal.code,
						retriable: refusal.retriable,
					})
					continue
				}
				last = o.sequenceNumber
			}
			transport.send({
				type: 'acknowledgment',
				messageId: `ack-${batch.messageId}`,
				acknowledgedMessageId: batch.messageId,
				lastSequenceNumber: last,
			})
		}
	})
	return { uploaded, handshakes }
}

interface EventRecorder {
	emit(e: KoraEvent): void
	on(): () => void
	events: KoraEvent[]
}

function recorder(): EventRecorder {
	const events: KoraEvent[] = []
	return {
		events,
		emit: (e: KoraEvent) => {
			events.push(e)
		},
		on: () => () => {},
	}
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

describe('RT-35: durability before upload', () => {
	test('nothing reaches the wire before the store durability barrier resolves', async () => {
		const log = [op(1)]
		const uploadedAtBarrier: number[] = []
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server)
		const store = fakeStore(log, {
			ensureDurable: vi.fn(async () => {
				uploadedAtBarrier.push(srv.uploaded.length)
			}),
		})
		const engine = new SyncEngine({ transport: client, store, config: { url: 'ws://t' } })
		await engine.start()
		await tick()
		// Every barrier ran before anything was uploaded.
		expect(uploadedAtBarrier.length).toBeGreaterThan(0)
		expect(uploadedAtBarrier.every((uploaded) => uploaded === 0)).toBe(true)
		expect(srv.uploaded).toEqual([log[0]?.id])
		await engine.stop()
	})

	test('a failing barrier postpones the upload and reports it; the op stays pending', async () => {
		const log = [op(1)]
		const store = fakeStore(log, {
			ensureDurable: vi.fn(async () => {
				throw new Error('quota')
			}),
		})
		const emitter = recorder()
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server)
		const engine = new SyncEngine({
			transport: client,
			store,
			config: { url: 'ws://t', outboundRetryBaseDelayMs: 10_000 },
			emitter: emitter as never,
		})
		await engine.start()
		await tick()
		expect(srv.uploaded).toEqual([])
		expect(engine.getStatus().pendingOperations).toBe(1)
		expect(
			emitter.events.some(
				(e) => e.type === 'store:persistence-error' && e.code === 'UPLOAD_NOT_DURABLE',
			),
		).toBe(true)
		await engine.stop()
	})

	test('the handshake advertises sequenceReservation', async () => {
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server)
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore([]),
			config: { url: 'ws://t' },
		})
		await engine.start()
		await tick()
		expect(srv.handshakes[0]?.sequenceReservation).toBe(true)
		await engine.stop()
	})
})

describe('RT-35: own history behind the server', () => {
	test('raises the counter, resets delivery to a full resync and ends the session', async () => {
		const raise = vi.fn(async () => true)
		const store = fakeStore([op(1)], { raiseSequenceFloor: raise })
		const p = persistence()
		p.watermarks.set('', 42)
		const emitter = recorder()
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server, { ownSeq: 3 })
		const engine = new SyncEngine({
			transport: client,
			store,
			syncState: p.state,
			config: { url: 'ws://t' },
			emitter: emitter as never,
		})
		await engine.start()
		await tick()
		expect(srv.handshakes[0]?.lastDeliverySequence).toBe(42)
		expect(raise).toHaveBeenCalledWith(NODE, 3)
		expect(p.watermarks.get('')).toBe(0)
		expect(engine.getState()).toBe('disconnected')
		expect(emitter.events).toContainEqual(
			expect.objectContaining({
				type: 'sync:local-node',
				action: 'history-behind',
				localSequence: 1,
				serverSequence: 3,
			}),
		)
	})

	test('no recovery when the persisted counter already covers the server entry', async () => {
		const raise = vi.fn(async () => false)
		const store = fakeStore([op(1)], { raiseSequenceFloor: raise })
		const { client, server } = createMemoryTransportPair()
		scriptedServer(server, { ownSeq: 3 })
		const engine = new SyncEngine({ transport: client, store, config: { url: 'ws://t' } })
		await engine.start()
		await tick()
		expect(raise).toHaveBeenCalledTimes(1)
		expect(engine.getState()).toBe('streaming')
		await engine.stop()
	})

	test('SEQUENCE_CONFLICT renumbers the write (same id), never records a rejection, and resyncs', async () => {
		const original = op(2)
		const log = [op(1), original]
		const renumbered: Operation = { ...original, sequenceNumber: 6 }
		const resequence = vi.fn(async () => {
			log[1] = renumbered
			return renumbered
		})
		const store = fakeStore(log, { resequenceOperation: resequence })
		const p = persistence()
		p.prefixes.set(NODE, 1)
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server, {
			ownSeq: 5,
			reject: (o) =>
				(o as Operation).sequenceNumber === 2
					? { code: 'SEQUENCE_CONFLICT', retriable: false }
					: null,
		})
		const engine = new SyncEngine({
			transport: client,
			store,
			syncState: p.state,
			config: { url: 'ws://t' },
		})
		await engine.start()
		await tick()
		expect(resequence).toHaveBeenCalledWith(original.id, NODE, 5)
		expect(await engine.getRejectedOperations()).toEqual([])
		expect(p.recorded).toEqual([])
		// The session ended to resync from 0; the next one uploads the renumbered write.
		expect(engine.getState()).toBe('disconnected')
		await engine.start()
		await tick()
		expect(srv.handshakes[1]?.lastDeliverySequence).toBe(0)
		expect(srv.uploaded.filter((id) => id === original.id)).toHaveLength(2)
		expect(engine.getStatus().pendingOperations).toBe(0)
		await engine.stop()
	})
})

describe('RT-36: durable terminal rejections', () => {
	test('a non-retriable refusal is recorded durably; SEQUENCE_CONFLICT-free codes only', async () => {
		const log = [op(1)]
		const p = persistence()
		const { client, server } = createMemoryTransportPair()
		scriptedServer(server, { reject: () => ({ code: 'INSUFFICIENT_FUNDS', retriable: false }) })
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore(log),
			syncState: p.state,
			config: { url: 'ws://t' },
		})
		await engine.start()
		await tick()
		expect(p.recorded).toEqual([
			expect.objectContaining({
				operationId: log[0]?.id,
				nodeId: NODE,
				sequenceNumber: 1,
				code: 'INSUFFICIENT_FUNDS',
			}),
		])
		// Clearing the app's list does not clear the marker.
		await engine.clearRejectedOperations([log[0]?.id ?? ''])
		expect(p.recorded).toHaveLength(1)
		await engine.stop()
	})

	test('a rescan of the own log from 0 skips operations with a terminal marker', async () => {
		const log = [op(1), op(2)]
		const p = persistence({ terminal: [log[0]?.id ?? ''] })
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server)
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore(log),
			syncState: p.state,
			config: { url: 'ws://t' },
		})
		await engine.start()
		await tick()
		expect(srv.uploaded).toEqual([log[1]?.id])
		expect(p.prefixes.get(NODE)).toBe(2)
		expect(engine.getStatus().pendingOperations).toBe(0)
		await engine.stop()
	})
})

describe('RT-38 / RT-40: uploads are bound to the session node', () => {
	test("another node's queued operations are never uploaded on this node's session", async () => {
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server)
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore([]),
			config: { url: 'ws://t' },
		})
		await engine.start()
		await tick()
		await engine.pushOperation(op(1, 'other-node'))
		await engine.pushOperation(op(1))
		await tick()
		expect(srv.uploaded).toEqual([`op-${NODE}-1`])
		// The other node's write is still pending (reported), not dropped.
		expect(engine.getStatus().pendingOperations).toBe(1)
		await engine.stop()
	})

	test("a held node's unsynced writes are reported as held, not pending", async () => {
		const held = op(1, 'alice-node')
		const p = persistence({
			nodes: [
				{ nodeId: NODE, accepted: true, held: false, refusedCycle: null },
				{ nodeId: 'alice-node', accepted: true, held: true, refusedCycle: 0 },
			],
		})
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server)
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore([held]),
			syncState: p.state,
			config: { url: 'ws://t' },
		})
		await engine.start()
		await tick()
		expect(srv.handshakes[0]?.nodeId).toBe(NODE)
		expect(srv.uploaded).toEqual([])
		expect(engine.getStatus()).toMatchObject({ pendingOperations: 0, heldOperations: 1 })
		await engine.stop()
	})

	test('an orphaned node is adopted when its lock is free, then the session ends', async () => {
		const orphan = op(1, 'closed-tab')
		const release = vi.fn()
		const p = persistence({
			nodes: [
				{ nodeId: NODE, accepted: true, held: false, refusedCycle: null },
				{ nodeId: 'closed-tab', accepted: true, held: false, refusedCycle: null },
			],
		})
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server)
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore([orphan], { claimLocalNode: vi.fn(async () => release) }),
			syncState: p.state,
			config: { url: 'ws://t' },
		})
		await engine.start()
		await tick()
		expect(srv.handshakes[0]?.nodeId).toBe('closed-tab')
		expect(srv.uploaded).toEqual([orphan.id])
		expect(p.prefixes.get('closed-tab')).toBe(1)
		expect(release).toHaveBeenCalled()
		expect(engine.getState()).toBe('disconnected')
	})

	test('a node held by a live tab is not adopted, and its writes count as pending', async () => {
		const p = persistence({
			nodes: [
				{ nodeId: NODE, accepted: true, held: false, refusedCycle: null },
				{ nodeId: 'live-tab', accepted: true, held: false, refusedCycle: null },
			],
		})
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server)
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore([op(1, 'live-tab')], { claimLocalNode: vi.fn(async () => null) }),
			syncState: p.state,
			config: { url: 'ws://t' },
		})
		await engine.start()
		await tick()
		expect(srv.handshakes[0]?.nodeId).toBe(NODE)
		expect(engine.getStatus().pendingOperations).toBe(1)
		await engine.stop()
	})
})
