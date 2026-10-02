/**
 * NEW-SYNC-1 repro: during initial sync ('syncing'), a delivery batch whose base is
 * BELOW the client's watermark takes the "duplicate" early return in
 * handleOperationBatch, which re-acks but skips the `state === 'syncing'` bookkeeping.
 * If that batch is the final one (isFinal), deltaReceiveComplete is never set and the
 * engine is wedged in 'syncing' forever: the outbound queue never flushes while the
 * connection looks healthy. The server legitimately restarts a client's stream from 0
 * whenever the resolved scope differs from the handshake scope (client-session.ts
 * ~817), so this is hit on every reconnect against any auth-scoped server (SYNC-11).
 * Asserts CORRECT behavior.
 */
import type { Operation, VersionVector } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { SyncEngine } from '../../src/engine/sync-engine'
import type { SyncStore } from '../../src/engine/sync-store'
import type { HandshakeMessage, SyncMessage } from '../../src/protocol/messages'
import { createMemoryTransportPair } from '../../src/transport/memory-transport'
import type { SyncStatePersistence } from '../../src/types'

const store: SyncStore = {
	getVersionVector: (): VersionVector => new Map(),
	getNodeId: () => 'client-1',
	applyRemoteOperation: async () => 'duplicate',
	getOperationRange: async (): Promise<Operation[]> => [],
}

const syncState: SyncStatePersistence = {
	loadLastAckedServerVector: async () => new Map(),
	saveLastAckedServerVector: async () => {},
	mergeServerVectors: (a, b) => new Map([...a, ...b]),
	countUnsyncedOperations: async () => 0,
	getUnsyncedOperations: async () => [],
	// The client already synced this view through delivery sequence 5.
	loadAllDeliveryWatermarks: async () => ({ '': 5 }),
	saveDeliveryWatermark: async () => {},
}

describe('NEW-SYNC-1: duplicate final delivery batch wedges initial sync', () => {
	test('engine reaches streaming when the server restarts the stream from 0', async () => {
		const { client, server } = createMemoryTransportPair()
		server.onMessage((msg: SyncMessage) => {
			if (msg.type !== 'handshake') return
			const hs = msg as HandshakeMessage
			server.send({
				type: 'handshake-response',
				messageId: 'r1',
				nodeId: 'server',
				versionVector: {},
				schemaVersion: hs.schemaVersion,
				accepted: true,
				serverTime: Date.now(),
				serverMaxDeliverySequence: 5,
			} as SyncMessage)
			// Server-side full resync of the view (operations the client already holds).
			server.send({
				type: 'operation-batch',
				messageId: 'b1',
				operations: [],
				isFinal: true,
				batchIndex: 0,
				totalBatches: 1,
				baseDeliverySequence: 0,
				maxDeliverySequence: 5,
			} as SyncMessage)
		})
		const engine = new SyncEngine({
			transport: client,
			store,
			syncState,
			config: { url: 'ws://test' },
		})
		await engine.start()
		for (let i = 0; i < 50 && engine.getState() !== 'streaming'; i++) {
			await new Promise((r) => setTimeout(r, 10))
		}
		expect(engine.getState()).toBe('streaming')
	})
})
