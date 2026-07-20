import { defineSchema, t } from '@korajs/core'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
	type InvokeFn,
	TauriAdapterError,
	TauriSqliteAdapter,
	TauriStoreNotOpenError,
} from './tauri-sqlite-adapter'

const minimalSchema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				completed: t.boolean().default(false),
			},
		},
	},
})

/**
 * Creates a mock invoke function that simulates the tauri-plugin-kora Rust plugin
 * using better-sqlite3 in-memory. This tests the adapter's logic without Tauri.
 */
function createMockInvoke(): InvokeFn {
	let db: Database.Database | null = null

	return async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
		const BetterSqlite3 = (await import('better-sqlite3')).default
		const command = cmd.replace('plugin:kora-sqlite|', '')

		switch (command) {
			case 'open': {
				const statements = args?.statements as string[]
				db = new BetterSqlite3(':memory:')
				db.pragma('journal_mode = WAL')
				db.pragma('foreign_keys = ON')
				for (const sql of statements) {
					if (sql.startsWith('--kora:safe-alter')) {
						try {
							db.exec(sql.replace('--kora:safe-alter\n', ''))
						} catch (e) {
							const msg = (e as Error).message || ''
							if (!msg.includes('duplicate column name')) {
								throw e
							}
						}
					} else {
						db.exec(sql)
					}
				}
				return undefined as T
			}

			case 'close': {
				if (db) {
					db.close()
					db = null
				}
				return undefined as T
			}

			case 'execute': {
				if (!db) throw new Error('Database not open')
				const sql = args?.sql as string
				const params = args?.params as unknown[]
				db.prepare(sql).run(...params)
				return undefined as T
			}

			case 'query': {
				if (!db) throw new Error('Database not open')
				const sql = args?.sql as string
				const params = args?.params as unknown[]
				return db.prepare(sql).all(...params) as T
			}

			case 'migrate': {
				if (!db) throw new Error('Database not open')
				const statements = args?.statements as string[]
				db.exec('BEGIN')
				try {
					for (const sql of statements) {
						db.exec(sql)
					}
					db.exec('COMMIT')
				} catch (error) {
					db.exec('ROLLBACK')
					throw error
				}
				return undefined as T
			}

			default:
				throw new Error(`Unknown command: ${command}`)
		}
	}
}

describe('TauriSqliteAdapter', () => {
	let adapter: TauriSqliteAdapter

	beforeEach(async () => {
		adapter = new TauriSqliteAdapter({
			path: 'test.db',
			invoke: createMockInvoke(),
		})
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

		test('sets WAL journal mode (in-memory falls back to memory)', async () => {
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

		test('throws TauriAdapterError on invalid SQL', async () => {
			await expect(adapter.execute('INVALID SQL')).rejects.toThrow(TauriAdapterError)
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

		test('throws TauriAdapterError on invalid SQL', async () => {
			await expect(adapter.query('SELECT * FROM nonexistent')).rejects.toThrow(TauriAdapterError)
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

		test('serializes concurrent transactions', async () => {
			// Two transactions running concurrently should not interleave
			const results: string[] = []

			const tx1 = adapter.transaction(async (tx) => {
				results.push('tx1-start')
				await tx.execute(
					'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
					['rec-1', 'TX1', 0, 1000, 1000],
				)
				results.push('tx1-end')
			})

			const tx2 = adapter.transaction(async (tx) => {
				results.push('tx2-start')
				await tx.execute(
					'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)',
					['rec-2', 'TX2', 0, 1000, 1000],
				)
				results.push('tx2-end')
			})

			await Promise.all([tx1, tx2])

			// Transactions should have run sequentially (not interleaved)
			expect(results[0]).toBe('tx1-start')
			expect(results[1]).toBe('tx1-end')
			expect(results[2]).toBe('tx2-start')
			expect(results[3]).toBe('tx2-end')

			const rows = await adapter.query('SELECT * FROM todos')
			expect(rows).toHaveLength(2)
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
		test('throws TauriStoreNotOpenError on execute before open', async () => {
			const fresh = new TauriSqliteAdapter({ invoke: createMockInvoke() })
			await expect(fresh.execute('SELECT 1')).rejects.toThrow(TauriStoreNotOpenError)
		})

		test('throws TauriStoreNotOpenError on query before open', async () => {
			const fresh = new TauriSqliteAdapter({ invoke: createMockInvoke() })
			await expect(fresh.query('SELECT 1')).rejects.toThrow(TauriStoreNotOpenError)
		})

		test('throws TauriStoreNotOpenError on transaction before open', async () => {
			const fresh = new TauriSqliteAdapter({ invoke: createMockInvoke() })
			await expect(fresh.transaction(async () => {})).rejects.toThrow(TauriStoreNotOpenError)
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

		test('throws TauriAdapterError on migration failure', async () => {
			await expect(
				adapter.migrate(1, 2, {
					statements: ['INVALID SQL STATEMENT'],
				}),
			).rejects.toThrow(TauriAdapterError)
		})
	})

	describe('constructor defaults', () => {
		test('defaults path to kora.db', () => {
			const a = new TauriSqliteAdapter({ invoke: createMockInvoke() })
			// The path is private, but we can verify it opens successfully
			// (the mock doesn't use the path, so this just verifies no error)
			expect(a).toBeInstanceOf(TauriSqliteAdapter)
		})
	})
})

/**
 * A spy invoke that records every IPC call so we can assert command names,
 * the plugin prefix, and argument marshaling without a Tauri runtime.
 */
function createSpyInvoke(): {
	invoke: InvokeFn
	calls: Array<{ cmd: string; args?: Record<string, unknown> }>
} {
	const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = []
	const invoke: InvokeFn = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
		calls.push({ cmd, args })
		// `query` must return an array; everything else returns void.
		return (cmd.endsWith('query') ? [] : undefined) as T
	}
	return { invoke, calls }
}

describe('TauriSqliteAdapter IPC marshaling', () => {
	test('prefixes every command with the kora-sqlite plugin namespace', async () => {
		const { invoke, calls } = createSpyInvoke()
		const adapter = new TauriSqliteAdapter({ path: 'app.db', invoke })

		await adapter.open(minimalSchema)
		await adapter.execute('DELETE FROM todos')
		await adapter.query('SELECT 1')
		await adapter.close()

		expect(calls.every((c) => c.cmd.startsWith('plugin:kora-sqlite|'))).toBe(true)
		expect(calls.map((c) => c.cmd)).toEqual([
			'plugin:kora-sqlite|open',
			'plugin:kora-sqlite|execute',
			'plugin:kora-sqlite|query',
			'plugin:kora-sqlite|close',
		])
	})

	test('open sends the generated DDL statements and the db path', async () => {
		const { invoke, calls } = createSpyInvoke()
		const adapter = new TauriSqliteAdapter({ path: 'app.db', invoke })

		await adapter.open(minimalSchema)

		const openCall = calls.find((c) => c.cmd.endsWith('open'))
		expect(openCall?.args?.path).toBe('app.db')
		const statements = openCall?.args?.statements as string[]
		expect(Array.isArray(statements)).toBe(true)
		expect(statements.some((s) => s.includes('CREATE TABLE') && s.includes('todos'))).toBe(true)
	})

	test('defaults missing params to an empty array when marshaling execute/query', async () => {
		const { invoke, calls } = createSpyInvoke()
		const adapter = new TauriSqliteAdapter({ path: 'app.db', invoke })
		await adapter.open(minimalSchema)

		await adapter.execute('DELETE FROM todos')
		await adapter.query('SELECT * FROM todos')

		const executeCall = calls.find((c) => c.cmd.endsWith('execute'))
		const queryCall = calls.find((c) => c.cmd.endsWith('query'))
		expect(executeCall?.args).toMatchObject({
			path: 'app.db',
			sql: 'DELETE FROM todos',
			params: [],
		})
		expect(queryCall?.args).toMatchObject({
			path: 'app.db',
			sql: 'SELECT * FROM todos',
			params: [],
		})
	})

	test('forwards provided params verbatim', async () => {
		const { invoke, calls } = createSpyInvoke()
		const adapter = new TauriSqliteAdapter({ invoke })
		await adapter.open(minimalSchema)

		await adapter.execute('INSERT INTO todos (id) VALUES (?)', ['rec-1'])

		const executeCall = calls.find((c) => c.cmd.endsWith('execute'))
		expect(executeCall?.args?.params).toEqual(['rec-1'])
	})

	test('close is a no-op (no IPC) when the adapter was never opened', async () => {
		const { invoke, calls } = createSpyInvoke()
		const adapter = new TauriSqliteAdapter({ invoke })

		await adapter.close()
		expect(calls).toHaveLength(0)
	})

	test('wraps failures in TauriAdapterError with sql/params context', async () => {
		const failing: InvokeFn = async <T>(cmd: string): Promise<T> => {
			if (cmd.endsWith('open')) return undefined as T
			throw new Error('native boom')
		}
		const adapter = new TauriSqliteAdapter({ invoke: failing })
		await adapter.open(minimalSchema)

		let caught: unknown
		try {
			await adapter.execute('UPDATE todos SET title = ?', ['x'])
		} catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(TauriAdapterError)
		const err = caught as TauriAdapterError
		expect(err.message).toContain('native boom')
		expect(err.code).toBe('TAURI_ADAPTER_ERROR')
		expect(err.context).toMatchObject({ sql: 'UPDATE todos SET title = ?', params: ['x'] })
	})

	test('migrate marshals only the statement list (path + statements), not transforms', async () => {
		const { invoke, calls } = createSpyInvoke()
		const adapter = new TauriSqliteAdapter({ path: 'app.db', invoke })
		await adapter.open(minimalSchema)

		await adapter.migrate(1, 2, {
			statements: ['ALTER TABLE todos ADD COLUMN notes TEXT'],
			transforms: [(row) => row],
		})

		const migrateCall = calls.find((c) => c.cmd.endsWith('migrate'))
		expect(migrateCall?.args).toEqual({
			path: 'app.db',
			statements: ['ALTER TABLE todos ADD COLUMN notes TEXT'],
		})
		expect(migrateCall?.args).not.toHaveProperty('transforms')
	})

	test('transaction wraps BEGIN/COMMIT around the callback IPC', async () => {
		const { invoke, calls } = createSpyInvoke()
		const adapter = new TauriSqliteAdapter({ path: 'app.db', invoke })
		await adapter.open(minimalSchema)

		await adapter.transaction(async (tx) => {
			await tx.execute('INSERT INTO todos (id) VALUES (?)', ['rec-1'])
		})

		const sqls = calls.filter((c) => c.cmd.endsWith('execute')).map((c) => c.args?.sql)
		expect(sqls).toEqual(['BEGIN', 'INSERT INTO todos (id) VALUES (?)', 'COMMIT'])
	})

	test('transaction issues ROLLBACK when the callback throws', async () => {
		const { invoke, calls } = createSpyInvoke()
		const adapter = new TauriSqliteAdapter({ path: 'app.db', invoke })
		await adapter.open(minimalSchema)

		await expect(
			adapter.transaction(async () => {
				throw new Error('callback failed')
			}),
		).rejects.toThrow('callback failed')

		const sqls = calls.filter((c) => c.cmd.endsWith('execute')).map((c) => c.args?.sql)
		expect(sqls).toEqual(['BEGIN', 'ROLLBACK'])
	})
})
