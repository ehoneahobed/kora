import type { Operation, VersionVector } from '@korajs/core'
import { describe, expect, test, vi } from 'vitest'
import { createMemoryTransportPair } from '../transport/memory-transport'
import type { SyncStatePersistence } from '../types'
import { MemoryQueueStorage } from './memory-queue-storage'
import { SyncEngine } from './sync-engine'
import type { SyncStore } from './sync-store'

const NODE = 'device-node'

function store(): SyncStore {
	const versionVector: VersionVector = new Map()
	return {
		getVersionVector: () => versionVector,
		getNodeId: () => NODE,
		applyRemoteOperation: vi.fn(async () => 'applied' as const),
		getOperationRange: vi.fn(async () => [] as Operation[]),
	}
}

describe('SyncEngine: stop() while start() is still preparing', () => {
	test('the start does not read persisted sync state after the stop returned', async () => {
		let release: () => void = () => undefined
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let reached: () => void = () => undefined
		const inQueue = new Promise<void>((resolve) => {
			reached = resolve
		})
		const loadAcked = vi.fn(async () => new Map() as VersionVector)
		const state: SyncStatePersistence = {
			loadLastAckedServerVector: loadAcked,
			saveLastAckedServerVector: async () => undefined,
			mergeServerVectors: (a) => a,
			countUnsyncedOperations: async () => 0,
			getUnsyncedOperations: async () => [],
		}
		// The outbound queue loads its stored operations while the engine prepares.
		const queueStorage = new MemoryQueueStorage()
		const load = queueStorage.load.bind(queueStorage)
		queueStorage.load = async () => {
			reached()
			await gate
			return load()
		}
		const { client } = createMemoryTransportPair()
		const engine = new SyncEngine({
			transport: client,
			store: store(),
			queueStorage,
			syncState: state,
			config: { url: 'ws://test' },
		})
		const started = engine.start()
		await inQueue
		await engine.stop()
		release()
		await started
		// The owner may close the store right after stop(): a late read would throw there.
		expect(loadAcked).not.toHaveBeenCalled()
		expect(engine.getState()).toBe('disconnected')
	})
})
