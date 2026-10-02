import 'fake-indexeddb/auto'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { PersistenceError, StoreNotOpenError } from '../errors'
import { IndexedDbAdapter } from './indexeddb-adapter'
import { MockWorkerBridge } from './sqlite-wasm-mock-bridge'
import * as persistence from './sqlite-wasm-persistence'
import {
	deleteFromIndexedDB,
	loadDumpFromIndexedDB,
	loadFromIndexedDB,
} from './sqlite-wasm-persistence'

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

	test('ensureDurable persists every committed write before it resolves (RT-35)', async () => {
		await adapter.execute(
			'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
			['rec-durable', 'Durable', 0, 1000, 1000],
		)
		// Inside the debounce window nothing is on disk yet; the barrier writes it now.
		expect(await loadFromIndexedDB(DB_NAME)).toBeNull()
		await adapter.ensureDurable()
		const reopened = new IndexedDbAdapter({ bridge: new MockWorkerBridge(), dbName: DB_NAME })
		await reopened.open(minimalSchema)
		const rows = await reopened.query<{ id: string }>('SELECT id FROM todos')
		expect(rows.map((row) => row.id)).toEqual(['rec-durable'])
		await reopened.close()
	})

	test('ensureDurable rejects when the snapshot cannot be written', async () => {
		const save = vi
			.spyOn(persistence, 'saveDumpToIndexedDB')
			.mockRejectedValueOnce(new Error('quota exceeded'))
		await adapter.execute(
			'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
			['rec-x', 'X', 0, 1000, 1000],
		)
		await expect(adapter.ensureDurable()).rejects.toThrow('quota exceeded')
		save.mockRestore()
		await expect(adapter.ensureDurable()).resolves.toBeUndefined()
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

	test('persists and restores from logical dump when browser worker export is unavailable', async () => {
		const exportlessDb = 'test-idb-exportless'
		await deleteFromIndexedDB(exportlessDb).catch(() => {})

		const emitter = new SimpleEventEmitter()
		const persistenceErrors: unknown[] = []
		emitter.on('store:persistence-error', (event) => persistenceErrors.push(event))

		const first = new IndexedDbAdapter({
			bridge: new NoExportWorkerBridge(),
			dbName: exportlessDb,
			emitter,
		})
		await first.open(minimalSchema)
		await first.execute(
			'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
			['rec-exportless', 'Exportless Restore', 0, 1000, 1000],
		)
		await first.close()

		expect(persistenceErrors).toHaveLength(0)
		await expect(loadFromIndexedDB(exportlessDb)).resolves.toBeNull()
		await expect(loadDumpFromIndexedDB(exportlessDb)).resolves.toMatchObject({
			tables: expect.any(Array),
		})

		const reopened = new IndexedDbAdapter({
			bridge: new MockWorkerBridge(),
			dbName: exportlessDb,
		})
		await reopened.open(minimalSchema)

		const rows = await reopened.query<{ id: string; title: string }>(
			'SELECT id, title FROM todos WHERE id = ?',
			['rec-exportless'],
		)
		expect(rows[0]?.title).toBe('Exportless Restore')

		await reopened.close()
		await deleteFromIndexedDB(exportlessDb).catch(() => {})
	})

	test('coalesces rapid executes into one debounced persist', async () => {
		const saveSpy = vi.spyOn(persistence, 'saveToIndexedDB')

		const coalesced = new IndexedDbAdapter({
			bridge: new MockWorkerBridge(),
			dbName: 'coalesce-db',
			persistenceDebounceMs: 500,
		})
		await coalesced.open(minimalSchema)
		saveSpy.mockClear()
		// The debounced flush writes one snapshot; count the flushes it starts.
		const flushes = vi.spyOn(
			coalesced as unknown as { writeSnapshot: () => Promise<void> },
			'writeSnapshot',
		)

		// Deterministic (CLAUDE.md anti-pattern 9, NEW-TEST-1): the debounce runs on a
		// fake clock, so a slow machine cannot fire it between two executes. Only the
		// timer functions are faked; fake-indexeddb keeps its own scheduling.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		try {
			for (let index = 0; index < 5; index++) {
				await coalesced.execute(
					'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
					[`rec-${index}`, `Todo ${index}`, 0, 1000, 1000],
				)
			}

			expect(flushes).not.toHaveBeenCalled()
			await vi.advanceTimersByTimeAsync(499)
			expect(flushes).not.toHaveBeenCalled()
			await vi.advanceTimersByTimeAsync(1)
			expect(flushes).toHaveBeenCalledTimes(1)
		} finally {
			vi.useRealTimers()
		}

		// Let the one coalesced write finish; it reached IndexedDB.
		await coalesced.flushPersistence()
		expect(saveSpy).toHaveBeenCalled()
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

class NoExportWorkerBridge extends MockWorkerBridge {
	override async send(
		request: import('./sqlite-wasm-channel').WorkerRequest,
	): Promise<import('./sqlite-wasm-channel').WorkerResponse> {
		if (request.type === 'export') {
			return {
				id: request.id,
				type: 'error',
				message: 'Export not yet supported in browser worker',
				code: 'EXPORT_NOT_SUPPORTED',
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

describe('IndexedDbAdapter snapshot restore ownership (STORE-6)', () => {
	const DB = 'test-idb-restore-owner'
	afterEach(async () => {
		await deleteFromIndexedDB(DB).catch(() => {})
	})

	/** One worker shared by two adapters, like a leader tab and a follower relaying to it. */
	class SharedWorker extends MockWorkerBridge {
		private opened = false
		override async send(
			request: Parameters<MockWorkerBridge['send']>[0],
		): ReturnType<MockWorkerBridge['send']> {
			if (request.type === 'open' && this.opened) return { id: request.id, type: 'success' }
			if (request.type === 'open') this.opened = true
			if (request.type === 'export') {
				return { id: request.id, type: 'error', message: 'no export', code: 'EXPORT_NOT_SUPPORTED' }
			}
			if (request.type === 'close') return { id: request.id, type: 'success' }
			return super.send(request)
		}
	}

	const insert = (a: IndexedDbAdapter, id: string) =>
		a.execute(
			'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
			[id, id, 0, 1, 1],
		)

	test('a second adapter on a live worker database never restores over it', async () => {
		const worker = new SharedWorker()
		const a = new IndexedDbAdapter({ bridge: worker, dbName: DB, persistenceDebounceMs: 60_000 })
		await a.open(minimalSchema)
		await insert(a, 'one')
		await a.flushPersistence()
		await insert(a, 'two')
		const b = new IndexedDbAdapter({ bridge: worker, dbName: DB, persistenceDebounceMs: 60_000 })
		await b.open(minimalSchema)
		const rows = await b.query<{ id: string }>('SELECT id FROM todos ORDER BY id')
		expect(rows.map((r) => r.id)).toEqual(['one', 'two'])
	})

	test('a fresh worker database is restored from the JSON dump, and the marker is not dumped', async () => {
		const first = new IndexedDbAdapter({ bridge: new SharedWorker(), dbName: DB })
		await first.open(minimalSchema)
		await insert(first, 'kept')
		await first.close()
		const dump = await loadDumpFromIndexedDB<{ tables: Array<{ name: string }> }>(DB)
		expect(dump?.tables.some((t) => t.name.includes('restored'))).toBe(false)

		const second = new IndexedDbAdapter({ bridge: new SharedWorker(), dbName: DB })
		await second.open(minimalSchema)
		const rows = await second.query<{ id: string }>('SELECT id FROM todos')
		expect(rows.map((r) => r.id)).toEqual(['kept'])
		await second.close()
	})

	test('a dump that cannot be restored fails the open instead of serving a partial database', async () => {
		const first = new IndexedDbAdapter({ bridge: new SharedWorker(), dbName: DB })
		await first.open(minimalSchema)
		await insert(first, 'kept')
		await first.close()
		const dump = await loadDumpFromIndexedDB<{
			tables: Array<{ name: string; columns: string[]; rows: Array<Record<string, unknown>> }>
		}>(DB)
		const todos = dump?.tables.find((t) => t.name === 'todos')
		// A row that violates NOT NULL: the restore fails after earlier statements ran.
		todos?.rows.push({ id: null, title: 'bad' })
		await persistence.saveDumpToIndexedDB(DB, dump)
		const second = new IndexedDbAdapter({ bridge: new SharedWorker(), dbName: DB })
		await expect(second.open(minimalSchema)).rejects.toThrow()
	})
})
