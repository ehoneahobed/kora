import 'fake-indexeddb/auto'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { PersistenceError, StoreNotOpenError } from '../errors'
import { IndexedDbAdapter } from './indexeddb-adapter'
import { MockWorkerBridge } from './sqlite-wasm-mock-bridge'
import * as persistence from './sqlite-wasm-persistence'
import { deleteFromIndexedDB, loadFromIndexedDB } from './sqlite-wasm-persistence'

describe('IndexedDbAdapter', () => {
	const DB_NAME = 'test-idb-adapter'
	let adapter: IndexedDbAdapter

	beforeEach(async () => {
		await deleteFromIndexedDB(DB_NAME).catch(() => {})
		adapter = new IndexedDbAdapter({ bridge: new MockWorkerBridge(), dbName: DB_NAME })
		await adapter.open(minimalSchema)
	})

	afterEach(async () => {
		await adapter.close()
		await deleteFromIndexedDB(DB_NAME).catch(() => {})
	})

	test('basic CRUD works like SqliteWasmAdapter', async () => {
		await adapter.execute(
			'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
			['rec-1', 'Test', 0, 1000, 1000],
		)
		const rows = await adapter.query<{ id: string; title: string }>('SELECT id, title FROM todos')
		expect(rows).toHaveLength(1)
		expect(rows[0]?.title).toBe('Test')
	})

	test('transaction commits and persists to IndexedDB', async () => {
		await adapter.transaction(async (tx) => {
			await tx.execute(
				'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
				['rec-1', 'A', 0, 1000, 1000],
			)
		})

		await adapter.flushPersistence()
		const data = await loadFromIndexedDB(DB_NAME)
		expect(data).toBeInstanceOf(Uint8Array)
		expect(data?.length).toBeGreaterThan(0)
	})

	test('close persists to IndexedDB', async () => {
		await adapter.execute(
			'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
			['rec-1', 'Persisted', 0, 1000, 1000],
		)

		await adapter.close()

		const data = await loadFromIndexedDB(DB_NAME)
		expect(data).toBeInstanceOf(Uint8Array)
		expect(data?.length).toBeGreaterThan(0)
	})

	test('reopens from persisted snapshot', async () => {
		await adapter.execute(
			'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
			['rec-restore', 'Restored', 0, 1000, 1000],
		)

		await adapter.close()

		const reopened = new IndexedDbAdapter({ bridge: new MockWorkerBridge(), dbName: DB_NAME })
		await reopened.open(minimalSchema)

		const rows = await reopened.query<{ id: string; title: string }>('SELECT id, title FROM todos')
		expect(rows.some((row) => row.id === 'rec-restore' && row.title === 'Restored')).toBe(true)

		await reopened.close()
	})

	test('restores from logical dump when binary import is unavailable', async () => {
		const first = new IndexedDbAdapter({ bridge: new MockWorkerBridge(), dbName: DB_NAME })
		await first.open(minimalSchema)
		await first.execute(
			'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
			['rec-dump', 'Dump Restore', 0, 1000, 1000],
		)
		await first.close()

		const bridgeWithoutImport = new NoImportWorkerBridge()
		const reopened = new IndexedDbAdapter({ bridge: bridgeWithoutImport, dbName: DB_NAME })
		await reopened.open(minimalSchema)

		const rows = await reopened.query<{ id: string; title: string }>(
			'SELECT id, title FROM todos WHERE id = ?',
			['rec-dump'],
		)
		expect(rows[0]?.title).toBe('Dump Restore')

		await reopened.close()
	})

	test('coalesces rapid executes into one debounced persist', async () => {
		const saveSpy = vi.spyOn(persistence, 'saveToIndexedDB')

		const coalesced = new IndexedDbAdapter({
			bridge: new MockWorkerBridge(),
			dbName: 'coalesce-db',
			persistenceDebounceMs: 500,
		})
		await coalesced.open(minimalSchema)

		for (let index = 0; index < 5; index++) {
			await coalesced.execute(
				'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
				[`rec-${index}`, `Todo ${index}`, 0, 1000, 1000],
			)
		}

		expect(saveSpy).not.toHaveBeenCalled()
		await new Promise<void>((resolve) => setTimeout(resolve, 550))
		expect(saveSpy.mock.calls.length).toBeGreaterThanOrEqual(1)

		saveSpy.mockRestore()
		await coalesced.close()
		await deleteFromIndexedDB('coalesce-db').catch(() => {})
	})

	test('emits persistence-error and quota-exceeded on save failure', async () => {
		const emitter = new SimpleEventEmitter()
		const persistenceErrors: unknown[] = []
		const quotaEvents: unknown[] = []
		emitter.on('store:persistence-error', (event) => persistenceErrors.push(event))
		emitter.on('store:quota-exceeded', (event) => quotaEvents.push(event))

		const failing = new IndexedDbAdapter({
			bridge: new MockWorkerBridge(),
			dbName: 'fail-db',
			persistenceDebounceMs: 10,
			emitter,
		})
		await failing.open(minimalSchema)

		const quotaError = new DOMException('quota', 'QuotaExceededError')
		vi.spyOn(persistence, 'saveToIndexedDB').mockRejectedValue(
			new PersistenceError('quota', {
				dbName: 'fail-db',
				quotaExceeded: true,
				cause: quotaError.message,
			}),
		)

		await failing.execute(
			'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
			['rec-q', 'Q', 0, 1000, 1000],
		)
		await failing.close()

		expect(persistenceErrors.length).toBeGreaterThanOrEqual(1)
		expect(quotaEvents.length).toBeGreaterThanOrEqual(1)

		vi.restoreAllMocks()
		await deleteFromIndexedDB('fail-db').catch(() => {})
	})

	test('throws StoreNotOpenError before open', async () => {
		const fresh = new IndexedDbAdapter({ bridge: new MockWorkerBridge(), dbName: 'fresh-db' })
		await expect(fresh.execute('SELECT 1')).rejects.toThrow(StoreNotOpenError)
	})
})

class NoImportWorkerBridge extends MockWorkerBridge {
	override async send(
		request: import('./sqlite-wasm-channel').WorkerRequest,
	): Promise<import('./sqlite-wasm-channel').WorkerResponse> {
		if (request.type === 'import') {
			return {
				id: request.id,
				type: 'error',
				message: 'Import intentionally unsupported in this bridge',
				code: 'IMPORT_NOT_SUPPORTED',
			}
		}

		return await super.send(request)
	}
}

describe('IDB persistence helpers', () => {
	const KEY = 'test-persistence-helper'

	afterEach(async () => {
		await deleteFromIndexedDB(KEY).catch(() => {})
	})

	test('loadFromIndexedDB returns null for non-existent key', async () => {
		const data = await loadFromIndexedDB('nonexistent-key')
		expect(data).toBeNull()
	})

	test('saveToIndexedDB + loadFromIndexedDB round-trips data', async () => {
		const original = new Uint8Array([1, 2, 3, 4, 5])
		await import('./sqlite-wasm-persistence').then((m) => m.saveToIndexedDB(KEY, original))
		const loaded = await loadFromIndexedDB(KEY)
		expect(loaded).toEqual(original)
	})

	test('deleteFromIndexedDB removes data', async () => {
		const { saveToIndexedDB: save } = await import('./sqlite-wasm-persistence')
		await save(KEY, new Uint8Array([1, 2, 3]))
		await deleteFromIndexedDB(KEY)
		const loaded = await loadFromIndexedDB(KEY)
		expect(loaded).toBeNull()
	})
})
