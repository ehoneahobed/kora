import type { Operation, VersionVector } from '@korajs/core'
import { describe, expect, test, vi } from 'vitest'
import type { HandshakeMessage, OperationBatchMessage, SyncMessage } from '../protocol/messages'
import { type MemoryTransport, createMemoryTransportPair } from '../transport/memory-transport'
import type { SyncStatePersistence } from '../types'
import { SyncEngine } from './sync-engine'
import type { SyncStore } from './sync-store'

const NODE = 'device-node'

function op(seq: number): Operation {
	return {
		id: `op-${seq}`,
		nodeId: NODE,
		type: 'insert',
		collection: 'todos',
		recordId: `r-${seq}`,
		data: { title: `t${seq}` },
		previousData: null,
		timestamp: { wallTime: 1000 + seq, logical: 0, nodeId: NODE },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
	}
}

function storeWith(ops: Operation[]): SyncStore {
	const versionVector: VersionVector = new Map([[NODE, ops.length]])
	return {
		getVersionVector: () => versionVector,
		getNodeId: () => NODE,
		applyRemoteOperation: vi.fn(async () => 'applied' as const),
		getOperationRange: vi.fn(async (_node: string, from: number, to: number) =>
			ops.filter((o) => o.sequenceNumber >= from && o.sequenceNumber <= to),
		),
	}
}

/** Op-log backed persistence with an acknowledged own sequence and a node token slot. */
function persistence(ops: Operation[], ackedOwn: number, token: string | null = null) {
	let lastAcked: VersionVector = new Map(ackedOwn > 0 ? [[NODE, ackedOwn]] : [])
	const saved: { token: string | null } = { token }
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
		countUnsyncedOperations: async (v) =>
			ops.filter((o) => o.sequenceNumber > (v.get(NODE) ?? 0)).length,
		getUnsyncedOperations: async (v) => ops.filter((o) => o.sequenceNumber > (v.get(NODE) ?? 0)),
		loadNodeToken: async () => saved.token,
		saveNodeToken: async (t) => {
			saved.token = t
		},
	}
	return { state, saved, lastAcked: () => lastAcked }
}

/** A server that advertises `ownSeq` for the device and records the uploaded op ids. */
function server(
	transport: MemoryTransport,
	ownSeq: number | null,
	issue?: string,
): { uploaded: string[]; handshakes: HandshakeMessage[] } {
	const uploaded: string[] = []
	const handshakes: HandshakeMessage[] = []
	transport.onMessage((msg: SyncMessage) => {
		if (msg.type === 'handshake') {
			handshakes.push(msg)
			transport.send({
				type: 'handshake-response',
				messageId: 'resp',
				nodeId: 'server',
				// null: the server names no entry for the node (it holds none of its ops).
				versionVector: ownSeq === null ? { peer: 4 } : { [NODE]: ownSeq },
				schemaVersion: 1,
				accepted: true,
				...(issue ? { nodeToken: issue } : {}),
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
			for (const o of batch.operations) uploaded.push(o.id)
			const last = batch.operations[batch.operations.length - 1]
			transport.send({
				type: 'acknowledgment',
				messageId: `ack-${batch.messageId}`,
				acknowledgedMessageId: batch.messageId,
				lastSequenceNumber: last?.sequenceNumber ?? 0,
			})
		}
	})
	return { uploaded, handshakes }
}

describe('SyncEngine: the server-advertised entry for the own node (RT-12)', () => {
	test('a value above the acknowledged sequence does not skip unsynced writes', async () => {
		const ops = [op(1), op(2), op(3)]
		const { client, server: transport } = createMemoryTransportPair()
		const srv = server(transport, 1_000_000)
		const p = persistence(ops, 1)
		const engine = new SyncEngine({
			transport: client,
			store: storeWith(ops),
			syncState: p.state,
			config: { url: 'ws://test' },
		})
		await engine.start()
		await vi.waitFor(() => expect(engine.getState()).toBe('streaming'))
		await vi.waitFor(() => expect(srv.uploaded).toEqual(expect.arrayContaining(['op-2', 'op-3'])))
		expect(srv.uploaded).not.toContain('op-1')
		// The forged value never lands in the persisted acknowledgment.
		expect(p.lastAcked().get(NODE) ?? 0).toBeLessThan(1_000_000)
		await engine.stop()
	})

	test('a lower server value (restored backup) makes the device re-upload', async () => {
		const ops = [op(1), op(2), op(3)]
		const { client, server: transport } = createMemoryTransportPair()
		const srv = server(transport, 1)
		const engine = new SyncEngine({
			transport: client,
			store: storeWith(ops),
			syncState: persistence(ops, 3).state,
			config: { url: 'ws://test' },
		})
		await engine.start()
		await vi.waitFor(() => expect(srv.uploaded).toEqual(expect.arrayContaining(['op-2', 'op-3'])))
		await engine.stop()
	})

	test('an own entry of 0 (server restored without this node) re-uploads everything (RT-45)', async () => {
		const ops = [op(1), op(2), op(3)]
		const { client, server: transport } = createMemoryTransportPair()
		const srv = server(transport, 0)
		const p = persistence(ops, 3)
		const events: string[] = []
		const emitter = {
			emit: (e: { type: string; action?: string }) => {
				if (e.type === 'sync:local-node' && e.action) events.push(e.action)
			},
			on: () => () => {},
			off: () => {},
		}
		const engine = new SyncEngine({
			transport: client,
			store: storeWith(ops),
			syncState: p.state,
			config: { url: 'ws://test' },
			emitter: emitter as never,
		})
		await engine.start()
		await vi.waitFor(() => expect([...srv.uploaded].sort()).toEqual(['op-1', 'op-2', 'op-3']))
		await vi.waitFor(() => expect(engine.getStatus().pendingOperations).toBe(0))
		expect(events).toContain('server-behind')
		expect(p.lastAcked().get(NODE)).toBe(3)
		await engine.stop()
	})

	test('an ABSENT own entry is read as 0, not as "no information" (RT-45)', async () => {
		const ops = [op(1), op(2), op(3)]
		const { client, server: transport } = createMemoryTransportPair()
		const srv = server(transport, null)
		const engine = new SyncEngine({
			transport: client,
			store: storeWith(ops),
			syncState: persistence(ops, 3).state,
			config: { url: 'ws://test' },
		})
		await engine.start()
		await vi.waitFor(() => expect([...srv.uploaded].sort()).toEqual(['op-1', 'op-2', 'op-3']))
		await engine.stop()
	})

	test('a fresh device (nothing acknowledged) is not disturbed by an absent entry', async () => {
		const ops = [op(1)]
		const { client, server: transport } = createMemoryTransportPair()
		const srv = server(transport, null)
		const engine = new SyncEngine({
			transport: client,
			store: storeWith(ops),
			syncState: persistence(ops, 0).state,
			config: { url: 'ws://test' },
		})
		await engine.start()
		await vi.waitFor(() => expect(srv.uploaded).toEqual(['op-1']))
		await vi.waitFor(() => expect(engine.getStatus().pendingOperations).toBe(0))
		await engine.stop()
	})

	test('an issued node token is persisted and presented on the next handshake', async () => {
		const ops: Operation[] = []
		const p = persistence(ops, 0)
		const first = createMemoryTransportPair()
		server(first.server, 0, 'issued-secret')
		const engine = new SyncEngine({
			transport: first.client,
			store: storeWith(ops),
			syncState: p.state,
			config: { url: 'ws://test' },
		})
		await engine.start()
		await vi.waitFor(() => expect(p.saved.token).toBe('issued-secret'))
		await engine.stop()

		const second = createMemoryTransportPair()
		const srv = server(second.server, 0)
		const restarted = new SyncEngine({
			transport: second.client,
			store: storeWith(ops),
			syncState: p.state,
			config: { url: 'ws://test' },
		})
		await restarted.start()
		await vi.waitFor(() => expect(srv.handshakes).toHaveLength(1))
		expect(srv.handshakes[0]?.nodeToken).toBe('issued-secret')
		await restarted.stop()
	})
})
