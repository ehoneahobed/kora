import { KoraError, type VersionVector } from '@korajs/core'
import { describe, expect, test, vi } from 'vitest'
import { createMemoryTransportPair } from '../transport/memory-transport'
import type { SyncStatePersistence } from '../types'
import { SyncEngine } from './sync-engine'
import type { SyncStore } from './sync-store'

/**
 * #150: `app.close()` destroys the sync engine and then closes the store. A `start()` already
 * in flight (`void app.sync?.connect()` in the templates) can be waiting on the store's sync
 * state when the store closes; the read rejects with a store-not-open error. The engine was
 * stopped on purpose, so its `start()` must settle quietly, not reject unhandled.
 */

function storeNotOpen(): KoraError {
	return new KoraError('Store is not open.', 'STORE_NOT_OPEN')
}

function fakeStore(): SyncStore {
	return {
		getVersionVector: () => new Map(),
		getNodeId: () => 'device-node',
		applyRemoteOperation: vi.fn(async () => 'applied' as const),
		getOperationRange: vi.fn(async () => []),
	}
}

/** Sync state whose first read waits for `release`, then fails as a closed store does. */
function closingState() {
	let release: () => void = () => {}
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})
	let reads = 0
	const state = {
		loadLastAckedServerVector: async (): Promise<VersionVector> => {
			reads++
			await gate
			throw storeNotOpen()
		},
		saveLastAckedServerVector: async () => {},
		mergeServerVectors: (a: VersionVector) => new Map(a),
		countUnsyncedOperations: async () => 0,
		getUnsyncedOperations: async () => [],
	} as unknown as SyncStatePersistence
	return { state, release, reads: () => reads }
}

describe('start() racing app close (#150)', () => {
	test('destroyed while reading sync state: start() settles quietly when the store closes under it', async () => {
		const { client } = createMemoryTransportPair()
		const s = closingState()
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore(),
			syncState: s.state,
			config: { url: 'ws://t' },
		})
		const started = engine.start()
		await vi.waitFor(() => expect(s.reads()).toBe(1))
		await engine.destroy()
		s.release()
		await expect(started).resolves.toBeUndefined()
	})

	test('stopped while reading sync state: start() settles quietly too', async () => {
		const { client } = createMemoryTransportPair()
		const s = closingState()
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore(),
			syncState: s.state,
			config: { url: 'ws://t' },
		})
		const started = engine.start()
		await vi.waitFor(() => expect(s.reads()).toBe(1))
		await engine.stop()
		s.release()
		await expect(started).resolves.toBeUndefined()
	})

	test('a failing read on a running engine still rejects start() (real errors stay visible)', async () => {
		const { client } = createMemoryTransportPair()
		const s = closingState()
		const engine = new SyncEngine({
			transport: client,
			store: fakeStore(),
			syncState: s.state,
			config: { url: 'ws://t' },
		})
		const started = engine.start()
		s.release()
		await expect(started).rejects.toMatchObject({ code: 'STORE_NOT_OPEN' })
		await engine.destroy()
	})
})
