import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { SqliteWasmAdapter } from '../../src/adapters/sqlite-wasm-adapter'
import { MockWorkerBridge } from '../../src/adapters/sqlite-wasm-mock-bridge'
import { AdapterError, StoreNotOpenError } from '../../src/errors'
import type { StorageAdapter } from '../../src/types'
import { minimalSchema } from '../fixtures/test-schema'

/**
 * Parameterized adapter contract test.
 * Proves behavioral equivalence between all StorageAdapter implementations.
 */
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
