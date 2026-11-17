import { describe, expect, test, vi } from 'vitest'
import { type SyncQuerySubset, querySubsetContains } from '../scopes/query-subset'
import { createMemoryTransportPair } from '../transport/memory-transport'
import { MAX_HANDSHAKE_QUERY_SUBSETS, SyncEngine } from './sync-engine'
import type { SyncStore } from './sync-store'

/**
 * A server refuses a handshake with more than `maxSyncQueries` query views (1,000 by default)
 * and does not retry it. A client that mounts many narrow reactive queries (a long list whose
 * rows each query their own records) must stay under that on its own: past
 * MAX_HANDSHAKE_QUERY_SUBSETS it collapses each collection to the whole collection, which
 * covers every view it had (it syncs more, never less).
 */
function store(): SyncStore {
	return {
		getVersionVector: () => new Map(),
		getNodeId: () => 'device-node',
		applyRemoteOperation: vi.fn(async () => 'applied' as const),
		getOperationRange: vi.fn(async () => []),
	}
}

describe('query views sent at handshake stay under the server cap', () => {
	test('many narrow views collapse to collection-wide ones that cover them all', () => {
		const engine = new SyncEngine({
			transport: createMemoryTransportPair().client,
			store: store(),
			config: { url: 'ws://t' },
		})
		const registered: SyncQuerySubset[] = []
		for (let i = 0; i < 1500; i++) {
			const subset = { collection: i % 3 === 0 ? 'notes' : 'comments', where: { postId: `p${i}` } }
			registered.push(subset)
			engine.seedQuerySubset(subset)
		}
		const sent = engine.getActiveQuerySubsets()
		expect(sent.length).toBeLessThanOrEqual(MAX_HANDSHAKE_QUERY_SUBSETS)
		expect(querySubsetContains(sent, registered)).toBe(true)
	})

	test('a list within the cap is sent as it is', () => {
		const engine = new SyncEngine({
			transport: createMemoryTransportPair().client,
			store: store(),
			config: { url: 'ws://t' },
		})
		for (let i = 0; i < 20; i++)
			engine.registerQuerySubset({ collection: 'notes', where: { postId: `p${i}` } })
		expect(engine.getActiveQuerySubsets()).toHaveLength(20)
	})
})
