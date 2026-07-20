import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { IndexedDbAdapter } from '../../src/adapters/indexeddb-adapter'
import { SqliteWasmAdapter } from '../../src/adapters/sqlite-wasm-adapter'
import { MockWorkerBridge } from '../../src/adapters/sqlite-wasm-mock-bridge'
import { AdapterError, StoreNotOpenError } from '../../src/errors'
import type { StorageAdapter } from '../../src/types'
import { minimalSchema } from '../fixtures/test-schema'

/**
 * Parameterized adapter contract test.
 * Proves behavioral equivalence between all StorageAdapter implementations.
 */
let idbCounter = 0
const adapters: Array<{
	name: string
	factory: () => StorageAdapter
	freshFactory: () => StorageAdapter
}> = [
	{
		name: 'BetterSqlite3Adapter',
		factory: () => new BetterSqlite3Adapter(':memory:'),
		freshFactory: () => new BetterSqlite3Adapter(':memory:'),
	},
	{
		name: 'SqliteWasmAdapter (MockBridge)',
		factory: () => new SqliteWasmAdapter({ bridge: new MockWorkerBridge() }),
		freshFactory: () => new SqliteWasmAdapter({ bridge: new MockWorkerBridge() }),
	},
	{
		name: 'IndexedDbAdapter (MockBridge + fake-indexeddb)',
		factory: () =>
			new IndexedDbAdapter({
				bridge: new MockWorkerBridge(),
				dbName: `contract-idb-${++idbCounter}`,
			}),
		freshFactory: () =>
			new IndexedDbAdapter({
				bridge: new MockWorkerBridge(),
				dbName: `contract-idb-fresh-${++idbCounter}`,
			}),
	},
]

for (const { name, factory, freshFactory } of adapters) {
	describe(`Adapter contract: ${name}`, () => {
		let adapter: StorageAdapter

		beforeEach(async () => {
			adapter = factory()
			await adapter.open(minimalSchema)
		})

		afterEach(async () => {
			await adapter.close()
		})

		test('creates expected tables', async () => {
			const tables = await adapter.query<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
			)
			const names = tables.map((t) => t.name)
			expect(names).toContain('_kora_meta')
			expect(names).toContain('_kora_version_vector')
			expect(names).toContain('_kora_audit_traces')
			expect(names).toContain('todos')
			expect(names).toContain('_kora_ops_todos')
		})

		test('insert and query', async () => {
			await adapter.execute(
				'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
				['rec-1', 'Test', 0, 1000, 1000],
			)
			const rows = await adapter.query<{ id: string; title: string }>('SELECT id, title FROM todos')
			expect(rows).toHaveLength(1)
			expect(rows[0]?.title).toBe('Test')
		})

		test('invalid SQL throws AdapterError', async () => {
			await expect(adapter.execute('INVALID SQL')).rejects.toThrow(AdapterError)
			await expect(adapter.query('SELECT * FROM nonexistent')).rejects.toThrow(AdapterError)
		})

		test('transaction commits on success', async () => {
			await adapter.transaction(async (tx) => {
				await tx.execute(
					'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
					['rec-1', 'A', 0, 1000, 1000],
				)
			})
			const rows = await adapter.query('SELECT * FROM todos')
			expect(rows).toHaveLength(1)
		})

		test('transaction rolls back on error', async () => {
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

		test('migrate applies statements', async () => {
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

		test('CONCURRENT transactions serialize: interleaved async work never nests BEGIN or loses a write', async () => {
			// This is the exact shape of the shipped op-drop bug: two async
			// transactions interleaving at their await points. The adapter MUST
			// serialize them — a nested BEGIN either throws (stranding the op) or
			// silently folds two logical transactions into one commit scope.
			const yieldTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

			const t1 = adapter.transaction(async (tx) => {
				await tx.execute(
					'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
					['rec-t1-a', 'T1-A', 0, 1000, 1000],
				)
				await yieldTick() // force interleaving opportunity mid-transaction
				await tx.execute(
					'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
					['rec-t1-b', 'T1-B', 0, 1000, 1000],
				)
			})
			const t2 = adapter.transaction(async (tx) => {
				await tx.execute(
					'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
					['rec-t2-a', 'T2-A', 0, 1000, 1000],
				)
				await yieldTick()
				await tx.execute(
					'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
					['rec-t2-b', 'T2-B', 0, 1000, 1000],
				)
			})

			await Promise.all([t1, t2])

			const rows = await adapter.query<{ id: string }>('SELECT id FROM todos ORDER BY id')
			expect(rows.map((r) => r.id)).toEqual(['rec-t1-a', 'rec-t1-b', 'rec-t2-a', 'rec-t2-b'])
		})

		test('CONCURRENT rollback stays isolated: a failing transaction never takes a concurrent commit down', async () => {
			const yieldTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

			const failing = adapter
				.transaction(async (tx) => {
					await tx.execute(
						'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
						['rec-fail', 'doomed', 0, 1000, 1000],
					)
					await yieldTick()
					throw new Error('Intentional failure')
				})
				.catch((error: unknown) => error)

			const committing = adapter.transaction(async (tx) => {
				await tx.execute(
					'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
					['rec-ok', 'survives', 0, 1000, 1000],
				)
				await yieldTick()
			})

			const [failure] = await Promise.all([failing, committing])
			expect(failure).toBeInstanceOf(Error)

			const rows = await adapter.query<{ id: string }>('SELECT id FROM todos ORDER BY id')
			// The failed transaction's row rolled back; the concurrent commit survived.
			expect(rows.map((r) => r.id)).toEqual(['rec-ok'])
		})

		test('guards: operations before open throw StoreNotOpenError', async () => {
			const fresh = freshFactory()
			await expect(fresh.execute('SELECT 1')).rejects.toThrow(StoreNotOpenError)
			await expect(fresh.query('SELECT 1')).rejects.toThrow(StoreNotOpenError)
			await expect(fresh.transaction(async () => {})).rejects.toThrow(StoreNotOpenError)
		})

		test('close is idempotent', async () => {
			await adapter.close()
			await adapter.close()
		})
	})
}
