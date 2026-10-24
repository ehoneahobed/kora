import type { KoraEvent, Operation, VersionVector } from '@korajs/core'
import { describe, expect, test, vi } from 'vitest'
import type { HandshakeMessage, OperationBatchMessage, SyncMessage } from '../protocol/messages'
import { MAX_PROBE_OPERATION_IDS } from '../protocol/messages'
import { type MemoryTransport, createMemoryTransportPair } from '../transport/memory-transport'
import type { LocalNodeInfo, SyncStatePersistence } from '../types'
import { SyncEngine } from './sync-engine'
import type { SyncStore } from './sync-store'

/**
 * A retired local node (shared-browser repair): the database's pinned node moved off it,
 * and it may be another user's database's node too. The engine never runs a session as
 * it; at a handshake of its own node it asks the server which of the retired node's
 * operations it stores, and has the store re-author the others under its own node.
 */
const NODE = 'kofi-device'
const RETIRED = 'shared-browser-device'

function op(seq: number, nodeId: string, id = `op-${nodeId}-${seq}`): Operation {
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

function fakeStore(log: Operation[]): SyncStore & { reauthored: string[][] } {
	const vector: VersionVector = new Map()
	const bump = (o: Operation): void => {
		vector.set(o.nodeId, Math.max(vector.get(o.nodeId) ?? 0, o.sequenceNumber))
	}
	for (const o of log) bump(o)
	const reauthored: string[][] = []
	return {
		reauthored,
		getVersionVector: () => new Map(vector),
		getNodeId: () => NODE,
		applyRemoteOperation: vi.fn(async () => 'applied' as const),
		getOperationRange: vi.fn(async (node: string, from: number, to: number) =>
			log.filter((o) => o.nodeId === node && o.sequenceNumber >= from && o.sequenceNumber <= to),
		),
		claimLocalNode: vi.fn(async () => () => {}),
		reauthorIntoOwnNode: vi.fn(async (from: string, ids: string[]) => {
			reauthored.push([...ids])
			const idMapping: Record<string, string> = {}
			const operations: Operation[] = []
			for (const id of ids) {
				const index = log.findIndex((o) => o.id === id && o.nodeId === from)
				const old = log[index]
				if (!old) throw new Error(`unknown ${id}`)
				log.splice(index, 1)
				const moved = op((vector.get(NODE) ?? 0) + 1, NODE, `re-${id}`)
				log.push(moved)
				bump(moved)
				idMapping[id] = moved.id
				operations.push(moved)
			}
			return { nodeId: NODE, operations, idMapping }
		}),
	}
}

function persistence(nodes: LocalNodeInfo[], terminal: string[] = []) {
	const markers = [...terminal]
	const prefixes = new Map<string, number>()
	const state: SyncStatePersistence = {
		loadLastAckedServerVector: async () => new Map([[RETIRED, 99]]),
		saveLastAckedServerVector: async () => {},
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
		loadDeliveryWatermark: async () => 0,
		saveDeliveryWatermark: async () => {},
		findTerminalRejections: async (ids) => new Set(ids.filter((id) => markers.includes(id))),
		recordTerminalRejections: async (entries) => {
			for (const entry of entries) markers.push(entry.operationId)
		},
		listLocalNodes: async () => nodes,
		markLocalNodeAccepted: async () => {},
		markLocalNodeRefused: async () => {},
		loadAcceptedCycle: async () => 0,
	}
	return { state, prefixes, markers }
}

function scriptedServer(
	transport: MemoryTransport,
	answer: ((asked: string[]) => string[]) | null,
): { uploaded: string[]; handshakes: HandshakeMessage[] } {
	const uploaded: string[] = []
	const handshakes: HandshakeMessage[] = []
	transport.onMessage((msg: SyncMessage) => {
		if (msg.type === 'handshake') {
			handshakes.push(msg)
			const asked = msg.probeOperationIds
			transport.send({
				type: 'handshake-response',
				messageId: `resp-${handshakes.length}`,
				nodeId: 'server',
				versionVector: {},
				schemaVersion: 1,
				accepted: true,
				...(answer && asked ? { operationProbe: { stored: answer(asked) } } : {}),
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

function nodeInfo(nodeId: string, extra: Partial<LocalNodeInfo> = {}): LocalNodeInfo {
	return { nodeId, accepted: false, held: false, refusedCycle: null, ...extra }
}

/**
 * Runs the engine's sessions the way the connection layer does: whenever the engine ended a
 * session to ask the server about more retired-node writes, connect again (same engine, so
 * its progress through the chain is kept). Returns when a session ends for another reason.
 */
async function runChain(
	engine: SyncEngine,
	emitter: { list: KoraEvent[] },
	maxSessions = 8,
): Promise<number> {
	let sessions = 0
	while (sessions < maxSessions) {
		sessions++
		await engine.start()
		await tick()
		const last = [...emitter.list].reverse().find((e) => e.type === 'sync:disconnected')
		if (!last || !/Checking more writes/.test((last as { reason: string }).reason)) break
		emitter.list.length = 0
	}
	return sessions
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

function events() {
	const list: KoraEvent[] = []
	return { list, emit: (e: KoraEvent) => list.push(e), on: () => () => {} }
}

describe('a retired local node', () => {
	test('is never a session node; the server is asked by id and the missing writes are re-authored', async () => {
		const log = [op(1, RETIRED), op(2, RETIRED), op(3, RETIRED), op(4, RETIRED)]
		const store = fakeStore(log)
		const p = persistence(
			[
				nodeInfo(NODE, { principal: 'kofi', binding: 'fresh' }),
				nodeInfo(RETIRED, { principal: 'kofi', binding: 'database', retired: true }),
			],
			['op-shared-browser-device-4'],
		)
		const emitter = events()
		const { client, server } = createMemoryTransportPair()
		// The server holds op 1 (beta.12 stored it); 2 and 3 never reached it; 4 it refused.
		const srv = scriptedServer(server, (asked) => asked.filter((id) => id.endsWith('-1')))
		const engine = new SyncEngine({
			transport: client,
			store,
			syncState: p.state,
			config: { url: 'ws://t', principal: async () => 'kofi' },
			emitter: emitter as never,
		})
		await engine.start()
		await tick()
		expect(srv.handshakes.map((h) => h.nodeId)).toEqual([NODE])
		// The persisted (shared) vector entry 99 "covers" every one of them: never trusted.
		expect(srv.handshakes[0]?.probeOperationIds).toEqual([
			'op-shared-browser-device-1',
			'op-shared-browser-device-2',
			'op-shared-browser-device-3',
		])
		expect(store.reauthored).toEqual([['op-shared-browser-device-2', 'op-shared-browser-device-3']])
		expect(srv.uploaded).toEqual(['re-op-shared-browser-device-2', 're-op-shared-browser-device-3'])
		expect(p.prefixes.get(RETIRED)).toBe(4)
		expect(engine.getStatus()).toMatchObject({ pendingOperations: 0, heldOperations: 0 })
		expect(emitter.list).toContainEqual(
			expect.objectContaining({
				type: 'sync:operations-rewritten',
				reason: 'node-rotation',
				idMapping: {
					'op-shared-browser-device-2': 're-op-shared-browser-device-2',
					'op-shared-browser-device-3': 're-op-shared-browser-device-3',
				},
			}),
		)
		expect(emitter.list).toContainEqual(
			expect.objectContaining({
				type: 'sync:local-node',
				nodeId: RETIRED,
				action: 'retired-repaired',
				operationCount: 3,
				storedCount: 1,
				reauthoredUnder: NODE,
			}),
		)
		await engine.stop()
	})

	test('without an answer nothing is re-authored or uploaded; the writes stay pending', async () => {
		const store = fakeStore([op(1, RETIRED), op(2, RETIRED)])
		const p = persistence([
			nodeInfo(NODE, { principal: 'kofi', binding: 'fresh' }),
			nodeInfo(RETIRED, { principal: 'kofi', binding: 'database', retired: true }),
		])
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server, null)
		const engine = new SyncEngine({
			transport: client,
			store,
			syncState: p.state,
			config: { url: 'ws://t', principal: async () => 'kofi' },
		})
		await engine.start()
		await tick()
		expect(srv.handshakes).toHaveLength(1)
		expect(store.reauthored).toEqual([])
		expect(srv.uploaded).toEqual([])
		expect(engine.getStatus().pendingOperations).toBe(2)
		expect(p.prefixes.has(RETIRED)).toBe(false)
		await engine.stop()
	})

	test('one bound to another user is held, never asked about', async () => {
		const store = fakeStore([op(1, RETIRED)])
		const p = persistence([
			nodeInfo(NODE, { principal: 'kofi', binding: 'fresh' }),
			nodeInfo(RETIRED, { principal: 'ama', binding: 'server', retired: true }),
		])
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server, (asked) => asked)
		const engine = new SyncEngine({
			transport: client,
			store,
			syncState: p.state,
			config: { url: 'ws://t', principal: async () => 'kofi' },
		})
		await engine.start()
		await tick()
		expect(srv.handshakes[0]?.probeOperationIds).toBeUndefined()
		expect(engine.getStatus()).toMatchObject({
			pendingOperations: 0,
			heldOperations: 1,
			heldNodes: [{ nodeId: RETIRED, reason: 'other-user', principal: 'ama' }],
		})
		await engine.stop()
	})

	test(`asks about at most ${MAX_PROBE_OPERATION_IDS} per handshake, oldest first`, async () => {
		const log = Array.from({ length: MAX_PROBE_OPERATION_IDS + 3 }, (_, i) => op(i + 1, RETIRED))
		const store = fakeStore(log)
		const p = persistence([
			nodeInfo(NODE, { principal: 'kofi', binding: 'fresh' }),
			nodeInfo(RETIRED, { principal: 'kofi', binding: 'database', retired: true }),
		])
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server, (asked) => asked)
		const engine = new SyncEngine({
			transport: client,
			store,
			syncState: p.state,
			config: { url: 'ws://t', principal: async () => 'kofi' },
		})
		await engine.start()
		await tick()
		const asked = srv.handshakes[0]?.probeOperationIds ?? []
		expect(asked).toHaveLength(MAX_PROBE_OPERATION_IDS)
		expect(asked[0]).toBe('op-shared-browser-device-1')
		// Every asked one is stored: nothing re-authored, the settled prefix is the last asked.
		expect(store.reauthored).toEqual([])
		expect(p.prefixes.get(RETIRED)).toBe(MAX_PROBE_OPERATION_IDS)
		await engine.stop()
	})
	test('is not asked about while a tab still holds it (live under that node)', async () => {
		const store = fakeStore([op(1, RETIRED), op(2, RETIRED)])
		let live = true
		store.claimLocalNode = vi.fn(async () => (live ? null : () => {}))
		const p = persistence([
			nodeInfo(NODE, { principal: 'kofi', binding: 'fresh' }),
			nodeInfo(RETIRED, { principal: 'kofi', binding: 'database', retired: true }),
		])
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server, () => [])
		const engine = new SyncEngine({
			transport: client,
			store,
			syncState: p.state,
			config: { url: 'ws://t', principal: async () => 'kofi' },
		})
		await engine.start()
		await tick()
		// The open tab may upload these itself: nothing is asked or re-authored under it.
		expect(srv.handshakes[0]?.probeOperationIds).toBeUndefined()
		expect(store.reauthored).toEqual([])
		expect(engine.getStatus().pendingOperations).toBe(2)
		await engine.stop()

		// The tab is gone: the next handshake asks.
		live = false
		const pair = createMemoryTransportPair()
		const next = scriptedServer(pair.server, () => [])
		const again = new SyncEngine({
			transport: pair.client,
			store,
			syncState: p.state,
			config: { url: 'ws://t', principal: async () => 'kofi' },
		})
		await again.start()
		await tick()
		expect(next.handshakes[0]?.probeOperationIds).toEqual([
			'op-shared-browser-device-1',
			'op-shared-browser-device-2',
		])
		expect(store.reauthored).toEqual([['op-shared-browser-device-1', 'op-shared-browser-device-2']])
		await again.stop()
	})

	test('holds the node lock from the question until the repair is done', async () => {
		const store = fakeStore([op(1, RETIRED)])
		const held: string[] = []
		store.claimLocalNode = vi.fn(async (nodeId: string) => {
			held.push(`claim ${nodeId}`)
			return () => held.push(`release ${nodeId}`)
		})
		const reauthor = store.reauthorIntoOwnNode
		store.reauthorIntoOwnNode = vi.fn(async (from: string, ids: string[]) => {
			held.push('reauthor')
			if (!reauthor) throw new Error('no reauthor')
			return reauthor(from, ids)
		})
		const p = persistence([
			nodeInfo(NODE, { principal: 'kofi', binding: 'fresh' }),
			nodeInfo(RETIRED, { principal: 'kofi', binding: 'database', retired: true }),
		])
		const { client, server } = createMemoryTransportPair()
		scriptedServer(server, () => [])
		const engine = new SyncEngine({
			transport: client,
			store,
			syncState: p.state,
			config: { url: 'ws://t', principal: async () => 'kofi' },
		})
		await engine.start()
		await tick()
		expect(held).toEqual([`claim ${RETIRED}`, 'reauthor', `release ${RETIRED}`])
		await engine.stop()
	})

	test('only re-authors the writes this database made, never ones it received under the node', async () => {
		// Ops 1 and 3 are this database's; 2 is another database's write it received under
		// the shared node (the server no longer holds it, say).
		const store = fakeStore([op(1, RETIRED), op(2, RETIRED), op(3, RETIRED)])
		const p = persistence([
			nodeInfo(NODE, { principal: 'kofi', binding: 'fresh' }),
			nodeInfo(RETIRED, { principal: 'kofi', binding: 'database', retired: true }),
		])
		p.state.findAuthoredHere = vi.fn(
			async (_node: string, ops: ReadonlyArray<{ id: string; sequenceNumber: number }>) =>
				new Set(ops.filter((o) => o.sequenceNumber !== 2).map((o) => o.id)),
		)
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server, () => [])
		const engine = new SyncEngine({
			transport: client,
			store,
			syncState: p.state,
			config: { url: 'ws://t', principal: async () => 'kofi' },
		})
		await engine.start()
		await tick()
		expect(srv.handshakes[0]?.probeOperationIds).toEqual([
			'op-shared-browser-device-1',
			'op-shared-browser-device-3',
		])
		expect(store.reauthored).toEqual([['op-shared-browser-device-1', 'op-shared-browser-device-3']])
		expect(srv.uploaded).not.toContain('re-op-shared-browser-device-2')
		expect(p.prefixes.get(RETIRED)).toBe(3)
		expect(engine.getStatus()).toMatchObject({ pendingOperations: 0, heldOperations: 0 })
		await engine.stop()
	})
	test('stop() waits for a repair in progress, so no stopped engine re-authors beside the next', async () => {
		const store = fakeStore([op(1, RETIRED), op(2, RETIRED)])
		let release: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let entered = false
		const reauthor = store.reauthorIntoOwnNode
		store.reauthorIntoOwnNode = vi.fn(async (from: string, ids: string[]) => {
			entered = true
			await gate
			if (!reauthor) throw new Error('no reauthor')
			return reauthor(from, ids)
		})
		const p = persistence([
			nodeInfo(NODE, { principal: 'kofi', binding: 'fresh' }),
			nodeInfo(RETIRED, { principal: 'kofi', binding: 'database', retired: true }),
		])
		const { client, server } = createMemoryTransportPair()
		scriptedServer(server, () => [])
		const engine = new SyncEngine({
			transport: client,
			store,
			syncState: p.state,
			config: { url: 'ws://t', principal: async () => 'kofi' },
		})
		await engine.start()
		await vi.waitFor(() => expect(entered).toBe(true))
		let stopped = false
		const stopping = engine.stop().then(() => {
			stopped = true
		})
		await tick()
		expect(stopped).toBe(false)
		release()
		await stopping
		// Everything the repair commits is in place when stop() resolves.
		expect(store.reauthored).toEqual([['op-shared-browser-device-1', 'op-shared-browser-device-2']])
		expect(p.prefixes.get(RETIRED)).toBe(2)
	})
	test('a node known only from queue entries: the stored operations are settled, the rest stay held', async () => {
		const QUEUED = 'other-device'
		const store = fakeStore([op(1, QUEUED), op(2, QUEUED), op(3, QUEUED)])
		const p = persistence([
			nodeInfo(NODE, { principal: 'kofi', binding: 'fresh' }),
			nodeInfo(QUEUED, { principal: null, fromQueue: true }),
		])
		// The server stores 1 and 3, not 2: only 1 is settled (2 stops the prefix).
		const { client, server } = createMemoryTransportPair()
		let storedNow = ['op-other-device-1', 'op-other-device-3']
		const srv = scriptedServer(server, (asked) => asked.filter((id) => storedNow.includes(id)))
		const engine = new SyncEngine({
			transport: client,
			store,
			syncState: p.state,
			config: { url: 'ws://t', principal: async () => 'kofi' },
		})
		await engine.start()
		await tick()
		expect(srv.handshakes[0]?.probeOperationIds).toEqual([
			'op-other-device-1',
			'op-other-device-2',
			'op-other-device-3',
		])
		expect(store.reauthored).toEqual([])
		expect(srv.uploaded).toEqual([])
		expect(p.prefixes.get(QUEUED)).toBe(1)
		expect(engine.getStatus()).toMatchObject({
			heldOperations: expect.any(Number),
			heldNodes: [
				// Op 3 is stored on the server too (after the gap at 2): settled, not held.
				expect.objectContaining({ nodeId: QUEUED, reason: 'unassigned', operationCount: 1 }),
			],
		})
		await engine.stop()

		// Later the server has them all: settled, nothing held.
		storedNow = ['op-other-device-1', 'op-other-device-2', 'op-other-device-3']
		const pair = createMemoryTransportPair()
		scriptedServer(pair.server, (asked) => asked.filter((id) => storedNow.includes(id)))
		const again = new SyncEngine({
			transport: pair.client,
			store,
			syncState: p.state,
			config: { url: 'ws://t', principal: async () => 'kofi' },
		})
		await again.start()
		await tick()
		expect(p.prefixes.get(QUEUED)).toBe(3)
		expect(again.getStatus()).toMatchObject({ heldOperations: 0, heldNodes: [] })
		await again.stop()
	})

	test('several queue-only nodes: a node with a write the server lacks does not starve the later ones', async () => {
		const FIRST = 'a-device'
		const SECOND = 'b-device'
		const store = fakeStore([op(1, FIRST), op(2, FIRST), op(1, SECOND), op(2, SECOND)])
		const p = persistence([
			nodeInfo(NODE, { principal: 'kofi', binding: 'fresh' }),
			nodeInfo(FIRST, { principal: null, fromQueue: true }),
			nodeInfo(SECOND, { principal: null, fromQueue: true }),
		])
		const emitter = events()
		const { client, server } = createMemoryTransportPair()
		// The server stores everything of SECOND, and only op 1 of FIRST.
		const srv = scriptedServer(server, (asked) =>
			asked.filter((id) => id.startsWith(`op-${SECOND}`) || id === `op-${FIRST}-1`),
		)
		const engine = new SyncEngine({
			transport: client,
			store,
			syncState: p.state,
			config: { url: 'ws://t', principal: async () => 'kofi' },
			emitter: emitter as never,
		})
		await runChain(engine, emitter)
		expect(p.prefixes.get(SECOND)).toBe(2)
		expect(p.prefixes.get(FIRST)).toBe(1)
		await tick()
		// FIRST's unsent write stays held; SECOND is settled and no longer reported.
		expect(engine.getStatus()).toMatchObject({
			heldNodes: [expect.objectContaining({ nodeId: FIRST, operationCount: 1 })],
		})
		// Each node was asked about once in the chain, not the first one again and again.
		const asked = srv.handshakes.map((h) => h.probeOperationIds ?? [])
		expect(asked.filter((ids) => ids.some((id) => id.startsWith(`op-${FIRST}`))).length).toBe(1)
		await engine.stop()
	})

	test('a refused write at the start of a queue-only node does not block the rest of it', async () => {
		const QUEUED = 'other-device'
		const total = MAX_PROBE_OPERATION_IDS + 2
		const log = Array.from({ length: total }, (_, i) => op(i + 1, QUEUED))
		const store = fakeStore(log)
		const p = persistence(
			[
				nodeInfo(NODE, { principal: 'kofi', binding: 'fresh' }),
				nodeInfo(QUEUED, { principal: null, fromQueue: true }),
			],
			['op-other-device-1'],
		)
		const emitter = events()
		const { client, server } = createMemoryTransportPair()
		// The server refused op 1 for good: it does not store it.
		scriptedServer(server, (asked) => asked.filter((id) => id !== 'op-other-device-1'))
		const engine = new SyncEngine({
			transport: client,
			store,
			syncState: p.state,
			config: { url: 'ws://t', principal: async () => 'kofi' },
			emitter: emitter as never,
		})
		await runChain(engine, emitter)
		expect(p.prefixes.get(QUEUED)).toBe(total)
		expect(engine.getStatus()).toMatchObject({ heldOperations: 0, heldNodes: [] })
		await engine.stop()
	})

	test('several retired nodes of the user are all repaired, not only the first', async () => {
		const R1 = 'retired-one'
		const R2 = 'retired-two'
		const store = fakeStore([op(1, R1), op(2, R1), op(1, R2)])
		const p = persistence([
			nodeInfo(NODE, { principal: 'kofi', binding: 'fresh' }),
			nodeInfo(R1, { principal: 'kofi', binding: 'database', retired: true }),
			nodeInfo(R2, { principal: 'kofi', binding: 'database', retired: true }),
		])
		const emitter = events()
		const { client, server } = createMemoryTransportPair()
		scriptedServer(server, () => [])
		const engine = new SyncEngine({
			transport: client,
			store,
			syncState: p.state,
			config: { url: 'ws://t', principal: async () => 'kofi' },
			emitter: emitter as never,
		})
		await runChain(engine, emitter)
		expect(p.prefixes.get(R2)).toBe(1)
		expect(p.prefixes.get(R1)).toBe(2)
		expect(store.reauthored.flat().sort()).toEqual(
			[`op-${R1}-1`, `op-${R1}-2`, `op-${R2}-1`].sort(),
		)
		await engine.stop()
	})

	test('writes re-authored under a fresh node (timestamp taken) are adopted by another session', async () => {
		const store = fakeStore([op(1, RETIRED), op(2, RETIRED)])
		const FRESH = 'fresh-node'
		const nodes = [
			nodeInfo(NODE, { principal: 'kofi', binding: 'fresh' }),
			nodeInfo(RETIRED, { principal: 'kofi', binding: 'database', retired: true }),
		]
		const p = persistence(nodes)
		const log: Operation[] = []
		store.reauthorIntoOwnNode = vi.fn(async (_from: string, ids: string[]) => {
			const operations = ids.map((id, i) => op(i + 1, FRESH, `re-${id}`))
			log.push(...operations)
			nodes.push(nodeInfo(FRESH, { principal: 'kofi', binding: 'fresh' }))
			store.getVersionVector().set(FRESH, operations.length)
			const idMapping: Record<string, string> = {}
			ids.forEach((id, i) => {
				idMapping[id] = `re-${id}`
				void i
			})
			return { nodeId: FRESH, operations, idMapping }
		})
		const original = store.getVersionVector
		store.getVersionVector = () => {
			const vector = original()
			if (log.length > 0) vector.set(FRESH, log.length)
			return vector
		}
		const read = store.getOperationRange
		store.getOperationRange = vi.fn(async (node: string, from: number, to: number) =>
			node === FRESH
				? log.filter((o) => o.sequenceNumber >= from && o.sequenceNumber <= to)
				: read(node, from, to),
		)
		const emitter = events()
		const { client, server } = createMemoryTransportPair()
		const srv = scriptedServer(server, () => [])
		const engine = new SyncEngine({
			transport: client,
			store,
			syncState: p.state,
			config: { url: 'ws://t', principal: async () => 'kofi' },
			emitter: emitter as never,
		})
		await runChain(engine, emitter)
		// Without a further session the re-authored writes would sit in the queue until an
		// unrelated reconnect: the engine ends the session itself so the fresh node is adopted.
		await vi.waitFor(() => expect(srv.handshakes.length).toBeGreaterThanOrEqual(2))
		await vi.waitFor(() =>
			expect(srv.uploaded.sort()).toEqual([
				're-op-shared-browser-device-1',
				're-op-shared-browser-device-2',
			]),
		)
		await engine.stop()
	})
})
