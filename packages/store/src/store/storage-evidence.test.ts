import 'fake-indexeddb/auto'
import type { KoraEvent } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { IndexedDbAdapter } from '../adapters/indexeddb-adapter'
import { deleteLocalDatabase } from '../adapters/local-databases'
import { MockWorkerBridge } from '../adapters/sqlite-wasm-mock-bridge'
import { deleteFromIndexedDB } from '../adapters/sqlite-wasm-persistence'
import {
	StorageEvidence,
	readStorageMarker,
	storageMarkerKey,
	writeStorageMarker,
} from '../adapters/storage-evidence'
import {
	deleteManifestRecord,
	patchManifestRecord,
	readManifestRecord,
} from '../adapters/storage-manifest'
import { Store } from './store'

// deleteLocalDatabase talks to a real worker in a browser; the tests run it against the
// in-process SQLite bridge.
vi.mock('../adapters/sqlite-wasm-channel', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../adapters/sqlite-wasm-channel')>()
	const { MockWorkerBridge: Bridge } = await import('../adapters/sqlite-wasm-mock-bridge')
	return { ...actual, WebWorkerBridge: class extends Bridge {} }
})

/** A `localStorage` the tests can wipe, like "clear site data" does. */
function installLocalStorage(): Map<string, string> {
	const data = new Map<string, string>()
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
		removeItem: (key: string) => void data.delete(key),
	})
	return data
}

describe('storage-loss detection (offline readiness A1)', () => {
	const DB = 'evidence-db'
	let local: Map<string, string>
	let stores: Store[]

	beforeEach(async () => {
		local = installLocalStorage()
		stores = []
		await deleteFromIndexedDB(DB).catch(() => {})
		await deleteManifestRecord(DB)
	})

	afterEach(async () => {
		for (const store of stores) await store.close().catch(() => {})
		vi.unstubAllGlobals()
	})

	async function open(): Promise<{ store: Store; events: KoraEvent[] }> {
		const emitter = new SimpleEventEmitter()
		const events: KoraEvent[] = []
		emitter.on('store:storage-evicted', (event) => events.push(event))
		const adapter = new IndexedDbAdapter({
			bridge: new MockWorkerBridge(),
			dbName: DB,
			storageEvidence: true,
		})
		const store = new Store({ schema: minimalSchema, adapter, nodeId: 'n1', emitter, dbName: DB })
		await store.open()
		stores.push(store)
		return { store, events }
	}

	async function closeAll(): Promise<void> {
		for (const store of stores.splice(0)) await store.close()
	}

	/** What a browser deleting the database's storage leaves: the IndexedDB copy is gone. */
	async function deleteDatabaseCopies(): Promise<void> {
		await deleteFromIndexedDB(DB)
	}

	test('the first open reports nothing and records the epoch in both places', async () => {
		const { store, events } = await open()
		expect(events).toEqual([])
		expect(store.getStorageEviction()).toBeNull()
		const manifest = await readManifestRecord(DB)
		const marker = readStorageMarker(DB)
		expect(manifest?.epoch).toBeTruthy()
		expect(marker).toEqual({ v: 1, epoch: manifest?.epoch, backend: 'indexeddb' })
	})

	test('reopening a database that kept its data reports nothing', async () => {
		const first = await open()
		await first.store.collection('todos').insert({ title: 'a' })
		await closeAll()
		const second = await open()
		expect(second.events).toEqual([])
		expect(second.store.getStorageEviction()).toBeNull()
	})

	test('copies deleted but manifest and marker kept: reported with the lost write count', async () => {
		const first = await open()
		await first.store.collection('todos').insert({ title: 'a' })
		await first.store.collection('todos').insert({ title: 'b' })
		await first.store.recordUnsyncedWrites(2, true)
		const epochBefore = (await readManifestRecord(DB))?.epoch
		await closeAll()
		await deleteDatabaseCopies()

		const second = await open()
		expect(second.events).toHaveLength(1)
		const event = second.events[0]
		expect(event).toMatchObject({
			type: 'store:storage-evicted',
			dbName: DB,
			evidence: ['manifest', 'localStorage'],
			lostWrites: { count: 2, certain: true },
		})
		expect(second.store.getStorageEviction()).toMatchObject({
			dbName: DB,
			lostWrites: { count: 2, certain: true },
		})
		// The database starts a new life: a new epoch, and nothing unsynced.
		const manifest = await readManifestRecord(DB)
		expect(manifest?.epoch).not.toBe(epochBefore)
		expect(manifest?.unsynced).toBe(0)
		expect(await second.store.collection('todos').where({}).count()).toBe(0)
	})

	test('a stale count is reported as not certain', async () => {
		const first = await open()
		await first.store.recordUnsyncedWrites(1, false)
		await closeAll()
		await deleteDatabaseCopies()
		const second = await open()
		expect(second.store.getStorageEviction()?.lostWrites).toEqual({ count: 1, certain: false })
	})

	test('the report survives a reload until the app acknowledges it', async () => {
		await (await open()).store.recordUnsyncedWrites(4, true)
		await closeAll()
		await deleteDatabaseCopies()
		const second = await open()
		expect(second.store.getStorageEviction()?.lostWrites.count).toBe(4)
		await closeAll()
		const third = await open()
		// No new event (nothing was lost this time), but the unacknowledged loss is still there.
		expect(third.events).toEqual([])
		expect(third.store.getStorageEviction()?.lostWrites.count).toBe(4)
		await third.store.acknowledgeStorageEviction()
		expect(third.store.getStorageEviction()).toBeNull()
		await closeAll()
		expect((await open()).store.getStorageEviction()).toBeNull()
	})

	test('the localStorage marker alone (manifest cleared) reports for the same backend', async () => {
		await open()
		await closeAll()
		await deleteDatabaseCopies()
		await deleteManifestRecord(DB)
		const second = await open()
		expect(second.store.getStorageEviction()).toMatchObject({
			evidence: ['localStorage'],
			lastOpenedAt: null,
			lostWrites: { count: 0, certain: false },
		})
	})

	test('the manifest alone (marker cleared) reports too', async () => {
		await open()
		await closeAll()
		await deleteDatabaseCopies()
		local.clear()
		const second = await open()
		expect(second.store.getStorageEviction()?.evidence).toEqual(['manifest'])
	})

	test('a marker for another backend is not evidence (OPFS/IndexedDB moves have their own path)', async () => {
		await open()
		await closeAll()
		await deleteDatabaseCopies()
		await deleteManifestRecord(DB)
		writeStorageMarker(DB, { v: 1, epoch: 'e', backend: 'opfs' })
		const second = await open()
		expect(second.events).toEqual([])
		expect(second.store.getStorageEviction()).toBeNull()
	})

	test('a manifest for another backend is not evidence', async () => {
		await open()
		await closeAll()
		await deleteDatabaseCopies()
		local.clear()
		await patchManifestRecord(DB, 'opfs', {})
		const manifest = await readManifestRecord(DB)
		expect(manifest?.backend).toBe('indexeddb')
		// Rewrite the record as an OPFS one, as a session on the other backend leaves it.
		await deleteManifestRecord(DB)
		await patchManifestRecord(DB, 'opfs', { epoch: 'other' })
		const second = await open()
		expect(second.events).toEqual([])
	})

	test('a marker without a backend is ignored, never reported', async () => {
		local.set(storageMarkerKey(DB), JSON.stringify({ v: 1, epoch: 'e' }))
		expect((await open()).events).toEqual([])
		await closeAll()
		await deleteDatabaseCopies()
		await deleteManifestRecord(DB)
		local.set(storageMarkerKey(DB), JSON.stringify({ v: 2, epoch: 'e', backend: 'indexeddb' }))
		expect((await open()).events).toEqual([])
		local.set(storageMarkerKey(DB), 'not json')
		expect(readStorageMarker(DB)).toBeNull()
	})

	test('clearing all site data leaves no evidence: a fresh device', async () => {
		await open()
		await closeAll()
		await deleteDatabaseCopies()
		await deleteManifestRecord(DB)
		local.clear()
		const second = await open()
		expect(second.events).toEqual([])
		expect(second.store.getStorageEviction()).toBeNull()
	})

	test('deleteDatabase() removes the evidence first: an explicit deletion is not an eviction', async () => {
		const first = await open()
		await first.store.collection('todos').insert({ title: 'a' })
		await closeAll()
		expect(readStorageMarker(DB)).not.toBeNull()
		const deleted = await deleteLocalDatabase(DB, { workerUrl: 'worker.js', force: true })
		expect(deleted).toBe(true)
		expect(readStorageMarker(DB)).toBeNull()
		expect(await readManifestRecord(DB)).toBeNull()
		const second = await open()
		expect(second.events).toEqual([])
		expect(second.store.getStorageEviction()).toBeNull()
	})

	test('another database name has its own evidence (store.name change, namespaceByAuthUser)', async () => {
		await open()
		await closeAll()
		await deleteDatabaseCopies()
		const emitter = new SimpleEventEmitter()
		const events: KoraEvent[] = []
		emitter.on('store:storage-evicted', (event) => events.push(event))
		const other = new Store({
			schema: minimalSchema,
			adapter: new IndexedDbAdapter({
				bridge: new MockWorkerBridge(),
				dbName: 'evidence-db__user_2',
				storageEvidence: true,
			}),
			nodeId: 'n2',
			emitter,
			dbName: 'evidence-db__user_2',
		})
		await other.open()
		stores.push(other)
		expect(events).toEqual([])
		await deleteFromIndexedDB('evidence-db__user_2')
		await deleteManifestRecord('evidence-db__user_2')
		local.delete(storageMarkerKey('evidence-db__user_2'))
	})

	test('a creation that never finished leaves no evidence', async () => {
		// The manifest record a first open writes before the store finished (no epoch yet),
		// and no marker: the next open of the still-empty database is not a loss.
		await patchManifestRecord(DB, 'indexeddb', {})
		const { store, events } = await open()
		expect(events).toEqual([])
		expect(store.getStorageEviction()).toBeNull()
	})

	test('adapters that keep no evidence leave the store untouched', async () => {
		const adapter = new IndexedDbAdapter({ bridge: new MockWorkerBridge(), dbName: DB })
		const store = new Store({ schema: minimalSchema, adapter, nodeId: 'n1' })
		await store.open()
		stores.push(store)
		expect(store.getStorageEviction()).toBeNull()
		expect(readStorageMarker(DB)).toBeNull()
		await store.recordUnsyncedWrites(3, true)
	})
})

describe('StorageEvidence.detectEviction', () => {
	const manifest = (over: Record<string, unknown> = {}) => ({
		dbName: 'd',
		backend: 'opfs' as const,
		createdAt: 100,
		lastOpenedAt: 100,
		...over,
	})

	test('a record without an epoch counts only after a second open', () => {
		const single = new StorageEvidence({
			dbName: 'd',
			backend: 'opfs',
			found: { manifest: manifest(), marker: null },
		})
		expect(single.detectEviction()).toBeNull()
		const reopened = new StorageEvidence({
			dbName: 'd',
			backend: 'opfs',
			found: { manifest: manifest({ lastOpenedAt: 200 }), marker: null },
		})
		expect(reopened.detectEviction(5)).toMatchObject({
			evidence: ['manifest'],
			lastOpenedAt: 200,
			detectedAt: 5,
			lostWrites: { count: 0, certain: false },
		})
	})

	test('a marker alone is evidence for its backend only', () => {
		const found = {
			manifest: null,
			marker: { v: 1 as const, epoch: 'e', backend: 'opfs' as const },
		}
		expect(new StorageEvidence({ dbName: 'd', backend: 'opfs', found }).detectEviction()).not.toBe(
			null,
		)
		expect(
			new StorageEvidence({ dbName: 'd', backend: 'indexeddb', found }).detectEviction(),
		).toBeNull()
	})

	test('nothing found is no eviction', () => {
		expect(
			new StorageEvidence({
				dbName: 'd',
				backend: 'opfs',
				found: { manifest: null, marker: null },
			}).detectEviction(),
		).toBeNull()
	})
})
