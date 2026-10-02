import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { BetterSqlite3Adapter } from './better-sqlite3-adapter'
import { exportDump, restoreDumpStatements } from './database-dump'

const insert =
	'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)'

describe('database dump (explicit backend migration)', () => {
	let source: BetterSqlite3Adapter
	let target: BetterSqlite3Adapter

	beforeEach(async () => {
		source = new BetterSqlite3Adapter(':memory:')
		target = new BetterSqlite3Adapter(':memory:')
		await source.open(minimalSchema)
		await target.open(minimalSchema)
	})

	afterEach(async () => {
		await source.close()
		await target.close()
	})

	test('a dump restored into another database replaces its rows', async () => {
		await source.execute(insert, ['a', 'from-source', 0, 1, 1])
		await target.execute(insert, ['stale', 'older-copy', 0, 1, 1])
		const dump = await exportDump((sql, params) => source.query(sql, params))
		await target.transaction(async (tx) => {
			for (const statement of restoreDumpStatements(dump)) {
				await tx.execute(statement.sql, statement.params)
			}
		})
		const rows = await target.query<{ id: string }>('SELECT id FROM todos')
		expect(rows.map((r) => r.id)).toEqual(['a'])
	})

	test('restore can build untyped tables for a schema-less scratch database', async () => {
		await source.execute(insert, ['a', 't', 0, 1, 1])
		const dump = await exportDump((sql, params) => source.query(sql, params))
		const scratch = new BetterSqlite3Adapter(':memory:')
		await scratch.open({ ...minimalSchema, collections: {} })
		for (const statement of restoreDumpStatements(dump, true)) {
			await scratch.execute(statement.sql, statement.params)
		}
		const rows = await scratch.query<{ n: number }>('SELECT COUNT(*) AS n FROM todos')
		expect(rows[0]?.n).toBe(1)
		await scratch.close()
	})

	test('unsafe identifiers in a dump are rejected', () => {
		expect(() =>
			restoreDumpStatements({ tables: [{ name: 'x; DROP TABLE y', columns: [], rows: [] }] }),
		).toThrow(/Unsafe SQL identifier/)
	})
})
