import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test } from 'vitest'
import { IndexedDbAdapter } from '../../src/adapters/indexeddb-adapter'
import type {
	WorkerBridge,
	WorkerRequest,
	WorkerResponse,
} from '../../src/adapters/sqlite-wasm-channel'
import { MockWorkerBridge } from '../../src/adapters/sqlite-wasm-mock-bridge'
import { deleteFromIndexedDB } from '../../src/adapters/sqlite-wasm-persistence'
import { minimalSchema } from '../fixtures/test-schema'

/**
 * Models the browser runtime faithfully:
 *  - ONE sqlite worker (owned by the leader tab) holds the live DB;
 *  - the real worker's `open` is idempotent on an existing handle
 *    (sqlite-wasm-worker-core.ts open(): `if (db) { applyDdl; return }`);
 *  - the real worker rejects `export` with EXPORT_NOT_SUPPORTED, so the
 *    IndexedDB adapter persists only the JSON dump;
 *  - a follower tab's FollowerBroadcastBridge relays every request verbatim
 *    to the leader's worker (tab-storage.ts startLeaderRpcRelay).
 */
class BrowserWorkerSim implements WorkerBridge {
	private readonly inner = new MockWorkerBridge()
	private opened = false
	async send(request: WorkerRequest): Promise<WorkerResponse> {
		if (request.type === 'open') {
			if (this.opened) return { id: request.id, type: 'success' }
			this.opened = true
		}
		if (request.type === 'export') {
			return {
				id: request.id,
				type: 'error',
				message: 'Export not yet supported in browser worker',
				code: 'EXPORT_NOT_SUPPORTED',
			}
		}
		if (request.type === 'close') return { id: request.id, type: 'success' }
		return this.inner.send(request)
	}
	terminate(): void {}
}

const DB = 'store-6-repro'
const insert = (a: IndexedDbAdapter, id: string) =>
	a.execute(
		'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
		[id, id, 0, 1, 1],
	)

describe('STORE-6 IndexedDB follower open must not rewrite the leader live DB', () => {
	afterEach(async () => {
		await deleteFromIndexedDB(DB).catch(() => {})
	})

	test('a second tab opening does not roll back unflushed leader writes', async () => {
		const worker = new BrowserWorkerSim()
		// Large debounce so the second write is deterministically NOT yet flushed.
		const leader = new IndexedDbAdapter({
			bridge: worker,
			dbName: DB,
			persistenceDebounceMs: 60_000,
		})
		await leader.open(minimalSchema)
		await insert(leader, 'flushed')
		await leader.flushPersistence()
		await insert(leader, 'unflushed')

		const follower = new IndexedDbAdapter({
			bridge: worker,
			dbName: DB,
			persistenceDebounceMs: 60_000,
		})
		await follower.open(minimalSchema)

		const rows = await leader.query<{ id: string }>('SELECT id FROM todos ORDER BY id')
		expect(rows.map((r) => r.id)).toEqual(['flushed', 'unflushed'])
	})
})
