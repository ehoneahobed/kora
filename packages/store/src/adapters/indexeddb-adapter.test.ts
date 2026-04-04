import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { StoreNotOpenError } from '../errors'
import { IndexedDbAdapter } from './indexeddb-adapter'
import { MockWorkerBridge } from './sqlite-wasm-mock-bridge'
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

		// Data should have been persisted to IndexedDB
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

	test('throws StoreNotOpenError before open', async () => {
		const fresh = new IndexedDbAdapter({ bridge: new MockWorkerBridge(), dbName: 'fresh-db' })
		await expect(fresh.execute('SELECT 1')).rejects.toThrow(StoreNotOpenError)
	})
})

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
