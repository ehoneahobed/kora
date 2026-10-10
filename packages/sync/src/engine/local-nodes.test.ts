import type { KoraEvent, Operation, VersionVector } from '@korajs/core'
import { describe, expect, test, vi } from 'vitest'
import type { HandshakeMessage, OperationBatchMessage, SyncMessage } from '../protocol/messages'
import { type MemoryTransport, createMemoryTransportPair } from '../transport/memory-transport'
import type {
	AdoptionScheduleInfo,
	LocalNodeInfo,
	SyncStatePersistence,
	TerminalRejectionRecord,
} from '../types'
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
	let schedule: AdoptionScheduleInfo = { progress: 0, parked: {} }
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
		loadAdoptionSchedule: async () => JSON.parse(JSON.stringify(schedule)),
		saveAdoptionSchedule: async (next) => {
			schedule = JSON.parse(JSON.stringify(next))
		},
	}
	return { state, prefixes, watermarks, recorded, accepted, schedule: () => schedule }
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

	test('a persistently failing barrier degrades: the upload proceeds and the status says so (RT-49)', async () => {
		const log = [op(1)]
		let broken = true
		const barrier = vi.fn(async () => {
			if (broken) {
				const error = new Error('QuotaExceededError: snapshot not written')
				error.name = 'QuotaExceededError'
				throw error
			}
		})
		const store = fakeStore(log, { ensureDurable: barrier })
		const emitter = recorder()
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server)
		const engine = new SyncEngine({
			transport: client,
			store,
			config: { url: 'ws://t', outboundRetryBaseDelayMs: 5 },
			emitter: emitter as never,
		})
		await engine.start()
		await vi.waitFor(() => expect(srv.uploaded).toEqual([log[0]?.id]))
		// Bounded: exactly the threshold of failed attempts before uploading anyway.
		expect(barrier).toHaveBeenCalledTimes(3)
		expect(engine.getStatus().localDurability).toBe('degraded')
		const degraded = emitter.events.filter((e) => e.type === 'sync:durability-degraded')
		expect(degraded).toHaveLength(1)
		expect(degraded[0]).toMatchObject({ failedAttempts: 3 })
		await vi.waitFor(() => expect(engine.getStatus().pendingOperations).toBe(0))

		// Storage recovers: the next barrier succeeds and leaves degraded mode.
		broken = false
		log.push(op(2))
		store.vector.set(NODE, 2)
		await engine.pushOperation(op(2))
		await vi.waitFor(() => expect(srv.uploaded).toContain(op(2).id))
		expect(engine.getStatus().localDurability).toBe('durable')
		expect(emitter.events.some((e) => e.type === 'sync:durability-restored')).toBe(true)
		await engine.stop()
	})

	test('a transient barrier failure only postpones (stays durable)', async () => {
		const log = [op(1)]
		let failures = 1
		const store = fakeStore(log, {
			ensureDurable: vi.fn(async () => {
				if (failures-- > 0) throw new Error('busy')
			}),
		})
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server)
		const engine = new SyncEngine({
			transport: client,
			store,
			config: { url: 'ws://t', outboundRetryBaseDelayMs: 5 },
		})
		await engine.start()
		await vi.waitFor(() => expect(srv.uploaded).toEqual([log[0]?.id]))
		expect(engine.getStatus().localDurability).toBe('durable')
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
			return { operation: renumbered, dependents: [], idMapping: {} }
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
		expect(resequence).toHaveBeenCalledWith(original.id, NODE, 5, [])
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

function withDeps(base: Operation, deps: string[]): Operation {
	return { ...base, causalDeps: deps }
}

function nodeInfo(nodeId: string, extra: Partial<LocalNodeInfo> = {}): LocalNodeInfo {
	return { nodeId, accepted: true, held: false, refusedCycle: null, ...extra }
}

describe('RT-46: adoption never blocks the other nodes', () => {
	test('an adoption the server keeps deferring is parked; the others and the own node go on', async () => {
		const stuck = op(1, 'stuck')
		const other = op(1, 'other')
		const mine = op(1)
		const p = persistence({ nodes: [nodeInfo(NODE), nodeInfo('stuck'), nodeInfo('other')] })
		const emitter = recorder()
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server, {
			reject: (o) =>
				o.id === stuck.id ? { code: 'PARENT_NOT_YET_SYNCED', retriable: true } : null,
		})
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore([stuck, other, mine], { claimLocalNode: vi.fn(async () => () => {}) }),
			syncState: p.state,
			config: { url: 'ws://t', outboundRetryBaseDelayMs: 5 },
			emitter: emitter as never,
		})
		for (let i = 0; i < 4; i++) {
			await engine.start()
			await tick()
		}
		// stuck (parked), other (completes, progress), stuck again (retried after that
		// progress, parked again), then the own node: never blocked behind stuck.
		expect(srv.handshakes.map((h) => h.nodeId)).toEqual(['stuck', 'other', 'stuck', NODE])
		expect(srv.uploaded).toContain(other.id)
		expect(srv.uploaded).toContain(mine.id)
		expect(srv.uploaded.filter((id) => id === stuck.id)).toHaveLength(2)
		expect(p.schedule().parked.stuck).toMatchObject({ count: 2 })
		expect(
			emitter.events.filter((e) => e.type === 'sync:local-node' && e.action === 'adoption-parked'),
		).toHaveLength(2)
		// The parked write is still reported, never dropped.
		expect(engine.getStatus().pendingOperations).toBe(1)
		await engine.stop()
	})

	test("a node whose writes depend on another local node's unsynced parent goes after it", async () => {
		const parent = op(1, 'parent-node')
		const child = withDeps(op(1, 'child-node'), [parent.id])
		const p = persistence({
			// The child's node is older: registry order alone would adopt it first.
			nodes: [nodeInfo(NODE), nodeInfo('child-node'), nodeInfo('parent-node')],
		})
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server)
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore([parent, child], { claimLocalNode: vi.fn(async () => () => {}) }),
			syncState: p.state,
			config: { url: 'ws://t' },
		})
		for (let i = 0; i < 3; i++) {
			await engine.start()
			await tick()
		}
		expect(srv.handshakes.map((h) => h.nodeId)).toEqual(['parent-node', 'child-node', NODE])
		expect(srv.uploaded).toEqual([parent.id, child.id])
		await engine.stop()
	})

	test('the own session yields once its uploads unblock a node waiting for them', async () => {
		const mine = op(1)
		const waiting = withDeps(op(1, 'waiting'), [mine.id])
		const p = persistence({ nodes: [nodeInfo(NODE), nodeInfo('waiting')] })
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server)
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore([mine, waiting], { claimLocalNode: vi.fn(async () => () => {}) }),
			syncState: p.state,
			config: { url: 'ws://t' },
		})
		await engine.start()
		await tick()
		expect(srv.handshakes.map((h) => h.nodeId)).toEqual([NODE])
		expect(engine.getState()).toBe('disconnected')
		await engine.start()
		await tick()
		expect(srv.handshakes.map((h) => h.nodeId)).toEqual([NODE, 'waiting'])
		expect(srv.uploaded).toEqual([mine.id, waiting.id])
	})
})

describe('RT-42: writes belong to the signed-in user', () => {
	test("another user's node is never adopted; its writes are reported as held", async () => {
		const p = persistence({
			nodes: [nodeInfo(NODE, { principal: 'bob' }), nodeInfo('alice-node', { principal: 'alice' })],
		})
		const bindPrincipal = vi.fn(async () => ({
			nodeId: NODE,
			previousNodeId: NODE,
			switched: false,
			conflict: false,
		}))
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server)
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore([op(1, 'alice-node')], {
				claimLocalNode: vi.fn(async () => () => {}),
				bindPrincipal,
			}),
			syncState: p.state,
			config: { url: 'ws://t', principal: async () => 'bob' },
		})
		await engine.start()
		await tick()
		expect(bindPrincipal).toHaveBeenCalledWith('bob')
		expect(srv.handshakes.map((h) => h.nodeId)).toEqual([NODE])
		expect(srv.uploaded).toEqual([])
		expect(engine.getStatus()).toMatchObject({ pendingOperations: 0, heldOperations: 1 })
		await engine.stop()
	})

	test('a user change ends the live session and binds before the next write', async () => {
		let user = 'alice'
		const bindPrincipal = vi.fn(async (principal: string) => ({
			nodeId: `${principal}-node`,
			previousNodeId: NODE,
			switched: principal !== 'alice',
			conflict: false,
		}))
		const emitter = recorder()
		const { client, server } = createMemoryTransportPair()
		scriptedServer(server)
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore([], { bindPrincipal }),
			config: { url: 'ws://t', principal: async () => user },
			emitter: emitter as never,
		})
		await engine.start()
		await tick()
		expect(engine.getState()).toBe('streaming')
		// A token refresh of the same user keeps the session.
		await engine.refreshPrincipal()
		expect(engine.getState()).toBe('streaming')
		user = 'bob'
		await engine.refreshPrincipal()
		expect(engine.getState()).toBe('disconnected')
		expect(bindPrincipal).toHaveBeenLastCalledWith('bob')
		expect(emitter.events).toContainEqual(
			expect.objectContaining({ type: 'sync:local-node', action: 'principal-switched' }),
		)
	})

	test('signing out stops stamping writes with the previous user', async () => {
		let user: string | null = 'alice'
		const clearSignedInUser = vi.fn()
		const bindPrincipal = vi.fn(async () => ({
			nodeId: NODE,
			previousNodeId: NODE,
			switched: false,
			conflict: false,
		}))
		const { client, server } = createMemoryTransportPair()
		scriptedServer(server)
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore([], { bindPrincipal, clearSignedInUser }),
			config: { url: 'ws://t', principal: async () => user },
		})
		await engine.start()
		await tick()
		expect(clearSignedInUser).not.toHaveBeenCalled()
		user = null
		await engine.bindSignedInUser()
		expect(clearSignedInUser).toHaveBeenCalledTimes(1)
		await engine.stop()
	})

	test('a pinned node of another user suspends sync instead of uploading it as this user', async () => {
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server)
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore([op(1)], {
				bindPrincipal: vi.fn(async () => ({
					nodeId: NODE,
					previousNodeId: NODE,
					switched: false,
					conflict: true,
				})),
			}),
			config: { url: 'ws://t', principal: async () => 'bob' },
		})
		await engine.start()
		await tick()
		expect(srv.handshakes).toEqual([])
		expect(engine.getStatus()).toMatchObject({
			status: 'auth-required',
			reason: 'node-owned-by-another-user',
		})
	})
})

describe('RT-44: a cloned database moves to a fresh node id', () => {
	test('a SEQUENCE_CONFLICT above the handshake entry rotates instead of renumbering', async () => {
		const first = op(1)
		const mine = op(2)
		const rotated: Operation = { ...mine, id: 'rotated-2', nodeId: 'fresh-node', sequenceNumber: 1 }
		const rotate = vi.fn(async () => ({ nodeId: 'fresh-node', operations: [rotated] }))
		const resequence = vi.fn(async () => null)
		const p = persistence()
		p.prefixes.set(NODE, 1)
		p.watermarks.set('', 9)
		const emitter = recorder()
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server, {
			ownSeq: 1,
			reject: (o) => (o.id === mine.id ? { code: 'SEQUENCE_CONFLICT', retriable: false } : null),
		})
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore([first, mine], { rotateNodeId: rotate, resequenceOperation: resequence }),
			syncState: p.state,
			config: { url: 'ws://t' },
			emitter: emitter as never,
		})
		await engine.start()
		await tick()
		expect(srv.uploaded).toEqual([mine.id])
		expect(rotate).toHaveBeenCalledWith([mine.id])
		expect(resequence).not.toHaveBeenCalled()
		expect(engine.getState()).toBe('disconnected')
		// The next session resyncs from 0 to fetch what the other copy wrote.
		expect(p.watermarks.get('')).toBe(0)
		const actions = emitter.events.flatMap((e) => (e.type === 'sync:local-node' ? [e.action] : []))
		expect(actions).toContain('clone-detected')
		expect(actions).not.toContain('history-behind')
		expect(await engine.getRejectedOperations()).toEqual([])
		expect(
			emitter.events.some((e) => e.type === 'sync:node-id-rotated' && e.nodeId === 'fresh-node'),
		).toBe(true)
	})
})

describe('RT-44: recovery full resyncs are rate-limited', () => {
	test('a second SEQUENCE_CONFLICT recovery within the interval renumbers without a resync', async () => {
		const log = [op(1), op(2), op(3)]
		const resequence = vi.fn(async (id: string) => {
			const index = log.findIndex((o) => o.id === id)
			const current = log[index]
			if (!current) return null
			const renumbered = { ...current, sequenceNumber: current.sequenceNumber + 10 }
			log[index] = renumbered
			return { operation: renumbered, dependents: [], idMapping: {} }
		})
		const p = persistence()
		p.prefixes.set(NODE, 1)
		p.watermarks.set('', 5)
		const conflicted = new Set<string>()
		const { client, server } = createMemoryTransportPair()
		scriptedServer(server, {
			ownSeq: 9,
			reject: (o) => {
				// Each of the two writes collides once (the device lost what held 2 and 3).
				if (conflicted.has(o.id) || (o as Operation).sequenceNumber > 9) return null
				conflicted.add(o.id)
				return { code: 'SEQUENCE_CONFLICT', retriable: false }
			},
		})
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore(log, { resequenceOperation: resequence }),
			syncState: p.state,
			config: { url: 'ws://t', batchSize: 1 },
		})
		await engine.start()
		await tick()
		expect(p.watermarks.get('')).toBe(0)
		// The resync session ran; the watermark moved on again.
		p.watermarks.set('', 7)
		await engine.start()
		await tick()
		expect(resequence).toHaveBeenCalledTimes(2)
		// Deferred: no second full resync inside the interval.
		expect(p.watermarks.get('')).toBe(7)
		await engine.stop()
	})
})

describe('RT-50: the owner of an unbound node is learned from the server', () => {
	function bindAs(nodeId: string) {
		return vi.fn(async () => ({ nodeId, previousNodeId: nodeId, switched: false, conflict: false }))
	}

	test('a never-synced unbound node is held as unassigned, never adopted', async () => {
		const p = persistence({
			nodes: [
				nodeInfo(NODE, { principal: 'bob' }),
				nodeInfo('orphan', { accepted: false, principal: null }),
			],
		})
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server)
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore([op(1, 'orphan')], {
				claimLocalNode: vi.fn(async () => () => {}),
				bindPrincipal: bindAs(NODE),
			}),
			syncState: p.state,
			config: { url: 'ws://t', principal: async () => 'bob' },
		})
		await engine.start()
		await tick()
		expect(srv.handshakes.map((h) => h.nodeId)).toEqual([NODE])
		expect(engine.getStatus()).toMatchObject({
			pendingOperations: 0,
			heldOperations: 1,
			heldNodes: [{ nodeId: 'orphan', operationCount: 1, reason: 'unassigned', principal: null }],
		})
		await engine.stop()
	})

	test('an unbound node accepted before is tried, and an accepted handshake binds it', async () => {
		const confirmed: Array<[string, string]> = []
		const p = persistence({
			nodes: [nodeInfo(NODE, { principal: 'bob' }), nodeInfo('legacy', { principal: null })],
		})
		p.state.confirmLocalNodePrincipal = async (nodeId, principal) => {
			confirmed.push([nodeId, principal])
		}
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server)
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore([op(1, 'legacy')], {
				claimLocalNode: vi.fn(async () => () => {}),
				bindPrincipal: bindAs(NODE),
			}),
			syncState: p.state,
			config: { url: 'ws://t', principal: async () => 'bob' },
		})
		await engine.start()
		await tick()
		expect(srv.handshakes.map((h) => h.nodeId)).toEqual(['legacy'])
		expect(confirmed).toEqual([['legacy', 'bob']])
		expect(srv.uploaded).toEqual([op(1, 'legacy').id])
		await engine.stop()
	})

	test('an unbound node the server refused for this user is held for its owner', async () => {
		const p = persistence({
			nodes: [
				nodeInfo(NODE, { principal: 'bob' }),
				nodeInfo('legacy', { principal: null, refusedPrincipals: ['bob'] }),
			],
		})
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server)
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore([op(1, 'legacy')], {
				claimLocalNode: vi.fn(async () => () => {}),
				bindPrincipal: bindAs(NODE),
			}),
			syncState: p.state,
			config: { url: 'ws://t', principal: async () => 'bob' },
		})
		await engine.start()
		await tick()
		expect(srv.handshakes.map((h) => h.nodeId)).toEqual([NODE])
		expect(engine.getStatus().heldNodes).toEqual([
			{ nodeId: 'legacy', operationCount: 1, reason: 'other-user', principal: null },
		])
		await engine.stop()
	})

	test('NODE_ID_CLAIMED for an adopted unbound node rules this user out, not held for good', async () => {
		const refusedFor: Array<[string, string]> = []
		const marked: Array<[string, boolean]> = []
		const p = persistence({
			nodes: [nodeInfo(NODE, { principal: 'bob' }), nodeInfo('legacy', { principal: null })],
		})
		p.state.recordLocalNodeRefusedFor = async (nodeId, principal) => {
			refusedFor.push([nodeId, principal])
		}
		p.state.markLocalNodeRefused = async (nodeId, held) => {
			marked.push([nodeId, held])
		}
		const { client, server } = createMemoryTransportPair()
		server.onMessage((msg: SyncMessage) => {
			if (msg.type !== 'handshake') return
			server.send({
				type: 'error',
				messageId: 'claimed',
				code: 'NODE_ID_CLAIMED',
				message: 'another user owns this node',
				retriable: false,
			} as SyncMessage)
		})
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore([op(1, 'legacy')], {
				claimLocalNode: vi.fn(async () => () => {}),
				bindPrincipal: bindAs(NODE),
			}),
			syncState: p.state,
			config: { url: 'ws://t', principal: async () => 'bob' },
		})
		await engine.start().catch(() => {})
		await tick()
		await tick()
		expect(refusedFor).toEqual([['legacy', 'bob']])
		expect(marked).toEqual([['legacy', false]])
		await engine.stop()
	})
})

describe('RT-52: the signed-in user changes while a session is connecting', () => {
	test('the handshake never pairs the previous user node with the next credential', async () => {
		let user = 'alice'
		const bindPrincipal = vi.fn(async (principal: string) => ({
			nodeId: `${principal}-node`,
			previousNodeId: NODE,
			switched: false,
			conflict: false,
		}))
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server)
		const gate: { release: (() => void) | null } = { release: null }
		let slow = true
		const connect = client.connect.bind(client)
		client.connect = async (url, options) => {
			if (slow) {
				slow = false
				await new Promise<void>((resolve) => {
					gate.release = resolve
				})
			}
			return connect(url, options)
		}
		const confirmed: string[] = []
		const p = persistence()
		p.state.confirmLocalNodePrincipal = async (_nodeId, principal) => {
			confirmed.push(principal)
		}
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore([], { bindPrincipal }),
			syncState: p.state,
			config: {
				url: 'ws://t',
				principal: async () => user,
				auth: async () => ({ token: user }),
			},
		})
		const started = engine.start()
		await tick()
		// Bob signs in while the transport is still connecting with Alice's credential.
		user = 'bob'
		await engine.bindSignedInUser()
		expect(bindPrincipal).toHaveBeenLastCalledWith('bob')
		gate.release?.()
		await started
		await tick()
		expect(srv.handshakes.map((h) => h.authToken)).toEqual(['bob'])
		expect(confirmed).toEqual(['bob'])
		await engine.stop()
	})
})

describe('RT-53: a parked adoption is retried when its backoff runs out', () => {
	test('an idle own-node session hands over to the parked node once, at the expiry', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true })
		try {
			const p = persistence({ nodes: [nodeInfo(NODE), nodeInfo('closed')] })
			const now = Date.now()
			await p.state.saveAdoptionSchedule?.({
				progress: 0,
				parked: {
					closed: { progressMark: 0, untilMs: now + 30_000, count: 1, parkedAtMs: now },
				},
			})
			const { client, server } = createMemoryTransportPair()
			const srv = scriptedServer(server)
			const engine = new SyncEngine({
				transport: client,
				store: fakeStore([op(1, 'closed')], { claimLocalNode: vi.fn(async () => () => {}) }),
				syncState: p.state,
				config: { url: 'ws://t' },
			})
			await engine.start()
			await vi.advanceTimersByTimeAsync(100)
			expect(srv.handshakes.map((h) => h.nodeId)).toEqual([NODE])
			// Not before the backoff ends, and nothing written meanwhile.
			await vi.advanceTimersByTimeAsync(20_000)
			expect(srv.handshakes.map((h) => h.nodeId)).toEqual([NODE])
			await vi.advanceTimersByTimeAsync(10_000)
			await vi.waitFor(() => expect(srv.uploaded).toEqual([op(1, 'closed').id]))
			expect(srv.handshakes.map((h) => h.nodeId).slice(0, 2)).toEqual([NODE, 'closed'])
			await engine.stop()
		} finally {
			vi.useRealTimers()
		}
	})

	test('no timer when nothing is parked, and none outlives the session', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true })
		try {
			const p = persistence({ nodes: [nodeInfo(NODE), nodeInfo('closed')] })
			const now = Date.now()
			await p.state.saveAdoptionSchedule?.({
				progress: 0,
				parked: {
					closed: { progressMark: 0, untilMs: now + 30_000, count: 1, parkedAtMs: now },
				},
			})
			const { client, server } = createMemoryTransportPair()
			const srv = scriptedServer(server)
			const engine = new SyncEngine({
				transport: client,
				store: fakeStore([op(1, 'closed')], { claimLocalNode: vi.fn(async () => () => {}) }),
				syncState: p.state,
				config: { url: 'ws://t' },
			})
			await engine.start()
			await vi.advanceTimersByTimeAsync(100)
			await engine.stop()
			await vi.advanceTimersByTimeAsync(40_000)
			// The session ended before the expiry: its timer went with it.
			expect(srv.handshakes.map((h) => h.nodeId)).toEqual([NODE])
		} finally {
			vi.useRealTimers()
		}
	})
})

describe('RT-92: a node only a beta.12 server acknowledged', () => {
	test('NODE_ID_CLAIMED re-authors only what that server never acknowledged', async () => {
		// A beta.12 database: the server acknowledged through 2 (persisted vector entry),
		// no acknowledged prefix under this release's contract, op 3 written offline.
		const log = [op(1), op(2), op(3)]
		const rotated: Operation = {
			...op(3),
			id: 'rotated-3',
			nodeId: 'fresh-node',
			sequenceNumber: 1,
		}
		const rotate = vi.fn(async () => ({ nodeId: 'fresh-node', operations: [rotated] }))
		const p = persistence({
			nodes: [{ nodeId: NODE, accepted: false, held: false, refusedCycle: null }],
		})
		await p.state.saveLastAckedServerVector(new Map([[NODE, 2]]))
		const emitter = recorder()
		const { client, server } = createMemoryTransportPair()
		server.onMessage((msg: SyncMessage) => {
			if (msg.type !== 'handshake') return
			server.send({
				type: 'error',
				messageId: 'claimed',
				code: 'NODE_ID_CLAIMED',
				message: 'history with no recorded owner',
				retriable: false,
			} as SyncMessage)
		})
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore(log, { rotateNodeId: rotate }),
			syncState: p.state,
			config: { url: 'ws://t' },
			emitter: emitter as never,
		})
		await engine.start().catch(() => {})
		await tick()
		await tick()
		// Ops 1 and 2 are stored on the server under the old node: a copy under the new
		// node would apply them twice.
		expect(rotate).toHaveBeenCalledWith([op(3).id])
		expect(p.prefixes.get(NODE)).toBe(2)
		await engine.stop()
	})
})
