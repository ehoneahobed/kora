import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { AdapterError, StoreNotOpenError } from '../errors'
import { SqliteWasmAdapter } from './sqlite-wasm-adapter'
import { Mutex } from './sqlite-wasm-channel'
import { MockWorkerBridge } from './sqlite-wasm-mock-bridge'

describe('SqliteWasmAdapter', () => {
	let adapter: SqliteWasmAdapter

	beforeEach(async () => {
		adapter = new SqliteWasmAdapter({ bridge: new MockWorkerBridge() })
		await adapter.open(minimalSchema)
	})

	afterEach(async () => {
		await adapter.close()
	})

	describe('open', () => {
		test('creates metadata and collection tables', async () => {
			const tables = await adapter.query<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
			)
			const names = tables.map((t) => t.name)
			expect(names).toContain('_kora_meta')
			expect(names).toContain('_kora_version_vector')
			expect(names).toContain('todos')
			expect(names).toContain('_kora_ops_todos')
		})

		test('sets WAL journal mode (falls back to memory for in-memory DBs)', async () => {
			const result = await adapter.query<{ journal_mode: string }>('PRAGMA journal_mode')
			// In-memory databases cannot use WAL, they report 'memory'
			expect(['wal', 'memory']).toContain(result[0]?.journal_mode)
		})
	})

	describe('execute', () => {
		test('inserts a record', async () => {
			await adapter.execute(
				'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
				['rec-1', 'Test', 0, 1000, 1000],
			)
			const rows = await adapter.query<{ id: string; title: string }>('SELECT id, title FROM todos')
			expect(rows).toHaveLength(1)
			expect(rows[0]?.title).toBe('Test')
		})

		test('throws AdapterError on invalid SQL', async () => {
			await expect(adapter.execute('INVALID SQL')).rejects.toThrow(AdapterError)
		})
	})

	describe('query', () => {
		test('returns matching rows', async () => {
			await adapter.execute(
				'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
				['rec-1', 'A', 0, 1000, 1000],
			)
			await adapter.execute(
				'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
				['rec-2', 'B', 1, 1000, 1000],
			)

			const rows = await adapter.query<{ id: string; completed: number }>(
				'SELECT id, completed FROM todos WHERE completed = ?',
				[0],
			)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.id).toBe('rec-1')
		})

		test('returns empty array for no matches', async () => {
			const rows = await adapter.query('SELECT * FROM todos')
			expect(rows).toEqual([])
		})

		test('throws AdapterError on invalid SQL', async () => {
			await expect(adapter.query('SELECT * FROM nonexistent')).rejects.toThrow(AdapterError)
		})
	})

	describe('transaction', () => {
		test('commits on success', async () => {
			await adapter.transaction(async (tx) => {
				await tx.execute(
					'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
					['rec-1', 'A', 0, 1000, 1000],
				)
				await tx.execute(
					'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
					['rec-2', 'B', 0, 1000, 1000],
				)
			})

			const rows = await adapter.query('SELECT * FROM todos')
			expect(rows).toHaveLength(2)
		})

		test('rolls back on error', async () => {
			await expect(
				adapter.transaction(async (tx) => {
					await tx.execute(
						'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
						['rec-1', 'A', 0, 1000, 1000],
					)
					throw new Error('Intentional failure')
				}),
			).rejects.toThrow('Intentional failure')

			const rows = await adapter.query('SELECT * FROM todos')
			expect(rows).toHaveLength(0)
		})

		test('supports queries within transaction', async () => {
			await adapter.execute(
				'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
				['rec-1', 'Existing', 0, 1000, 1000],
			)

			await adapter.transaction(async (tx) => {
				const rows = await tx.query<{ id: string }>('SELECT id FROM todos')
				expect(rows).toHaveLength(1)
			})
		})
	})

	describe('close', () => {
		test('can close and is safe to close twice', async () => {
			await adapter.close()
			// Second close is a no-op
			await adapter.close()
		})
	})

	describe('guard: operations before open', () => {
		test('throws StoreNotOpenError on execute before open', async () => {
			const fresh = new SqliteWasmAdapter({ bridge: new MockWorkerBridge() })
			await expect(fresh.execute('SELECT 1')).rejects.toThrow(StoreNotOpenError)
		})

		test('throws StoreNotOpenError on query before open', async () => {
			const fresh = new SqliteWasmAdapter({ bridge: new MockWorkerBridge() })
			await expect(fresh.query('SELECT 1')).rejects.toThrow(StoreNotOpenError)
		})

		test('throws StoreNotOpenError on transaction before open', async () => {
			const fresh = new SqliteWasmAdapter({ bridge: new MockWorkerBridge() })
			await expect(fresh.transaction(async () => {})).rejects.toThrow(StoreNotOpenError)
		})
	})

	describe('migrate', () => {
		test('applies migration statements', async () => {
			await adapter.migrate(1, 2, {
				statements: ['ALTER TABLE todos ADD COLUMN notes TEXT'],
			})

			await adapter.execute(
				'INSERT INTO todos (id, title, completed, notes, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?, ?)',
				['rec-1', 'Test', 0, 'Some notes', 1000, 1000],
			)
			const rows = await adapter.query<{ notes: string }>('SELECT notes FROM todos WHERE id = ?', [
				'rec-1',
			])
			expect(rows[0]?.notes).toBe('Some notes')
		})

		test('rolls back on migration failure', async () => {
			await expect(
				adapter.migrate(1, 2, {
					statements: ['INVALID SQL STATEMENT'],
				}),
			).rejects.toThrow(AdapterError)
		})
	})

	describe('constructor', () => {
		test('throws AdapterError when no bridge or workerUrl provided', async () => {
			const noBridge = new SqliteWasmAdapter()
			await expect(noBridge.open(minimalSchema)).rejects.toThrow(AdapterError)
		})
	})
})

describe('Mutex', () => {
	test('allows sequential access', async () => {
		const mutex = new Mutex()
		const order: number[] = []

		const release = await mutex.acquire()
		order.push(1)
		release()

		const release2 = await mutex.acquire()
		order.push(2)
		release2()

		expect(order).toEqual([1, 2])
	})

	test('queues concurrent acquirers', async () => {
		const mutex = new Mutex()
		const order: number[] = []

		const release1 = await mutex.acquire()

		// These will queue
		const p2 = mutex.acquire().then((release) => {
			order.push(2)
			release()
		})
		const p3 = mutex.acquire().then((release) => {
			order.push(3)
			release()
		})

		order.push(1)
		release1()

		await p2
		await p3

		expect(order).toEqual([1, 2, 3])
	})

	test('release is idempotent', async () => {
		const mutex = new Mutex()
		const release = await mutex.acquire()
		release()
		release() // Should be a no-op

		// Should be acquirable again
		const release2 = await mutex.acquire()
		release2()
	})
})
