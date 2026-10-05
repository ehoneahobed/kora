/**
 * RT-111 repro (Codex review of PR #4, core constraint-relaxation.ts): the one-time
 * SQLite value-domain relaxation (RT-101) treated ANY `CHECK (` in a collection table's
 * DDL as a beta.12 enum check and rebuilt the table from generated DDL that carries no
 * checks at all. The SQLite server store runs it on every `setSchema`, so the next restart
 * silently dropped constraints an operator added as storage safety nets, such as
 * `CHECK (price >= 0)` (the Postgres store only drops Kora's enum-shaped checks).
 *
 * Asserts the CORRECT behaviour: only Kora's own enum check (on an enum field of the
 * schema) is relaxed; every other check survives restarts, and a table holding only
 * foreign checks is not rebuilt at all.
 */
import { HybridLogicalClock, createOperation, defineSchema, t } from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { describe, expect, test } from 'vitest'
import { SqliteServerStore } from '../../src/store/sqlite-server-store'

const schema = defineSchema({
	version: 1,
	collections: {
		notes: {
			fields: {
				title: t.string(),
				price: t.number().optional(),
				kind: t.enum(['a', 'b']).default('a'),
				label: t.string().optional(),
			},
		},
	},
}) as unknown as SchemaDefinition

let sequence = 0
function note(data: Record<string, unknown>): Promise<Operation> {
	sequence++
	return createOperation(
		{
			nodeId: 'device-a',
			type: 'insert',
			collection: 'notes',
			recordId: `n${sequence}`,
			data,
			previousData: null,
			sequenceNumber: sequence,
			causalDeps: [],
			schemaVersion: 1,
		},
		new HybridLogicalClock('device-a'),
	)
}

/** Rebuild `notes` with extra table constraints appended to its current DDL. */
function addTableConstraints(sqlite: Database.Database, constraints: string[]): void {
	const row = sqlite
		.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notes'")
		.get() as { sql: string }
	const dependents = (
		sqlite
			.prepare(
				"SELECT sql FROM sqlite_master WHERE tbl_name = 'notes' AND type IN ('index', 'trigger') AND sql IS NOT NULL",
			)
			.all() as Array<{ sql: string }>
	).map((dependent) => dependent.sql)
	const created = row.sql
		.replace(/^CREATE TABLE\s+("?)notes\1/i, 'CREATE TABLE "notes_guarded"')
		.replace(/\)\s*$/, `, ${constraints.join(', ')})`)
	sqlite.exec('BEGIN')
	sqlite.exec(created)
	sqlite.exec('INSERT INTO notes_guarded SELECT * FROM notes')
	sqlite.exec('DROP TABLE notes')
	sqlite.exec('ALTER TABLE notes_guarded RENAME TO notes')
	for (const sql of dependents) sqlite.exec(sql)
	sqlite.exec('COMMIT')
}

function tableSql(sqlite: Database.Database): string {
	return (
		sqlite
			.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notes'")
			.get() as {
			sql: string
		}
	).sql
}

describe('RT-111: SQLite relaxation keeps checks that are not Kora enum checks', () => {
	test('server store: a hand-added CHECK survives a restart, and no rebuild runs', async () => {
		const sqlite = new Database(':memory:')
		await new SqliteServerStore(drizzle(sqlite), 'server-1').setSchema(schema)
		addTableConstraints(sqlite, [
			'CHECK ("price" >= 0)',
			'CONSTRAINT "label_domain" CHECK ("label" IN (\'x\', \'y\'))',
		])
		const guarded = tableSql(sqlite)

		// Restart on the same schema.
		const restarted = new SqliteServerStore(drizzle(sqlite), 'server-1')
		await restarted.setSchema(schema)

		expect(tableSql(sqlite)).toBe(guarded)
		await expect(
			restarted.applyRemoteOperation(await note({ title: 'neg', price: -1 })),
		).rejects.toThrow()
		await expect(
			restarted.applyRemoteOperation(await note({ title: 'lbl', label: 'z' })),
		).rejects.toThrow()
		expect(
			await restarted.applyRemoteOperation(await note({ title: 'ok', price: 1, label: 'x' })),
		).toBe('applied')
	})

	test('server store: a beta.12 enum CHECK is relaxed while a hand-added CHECK is kept', async () => {
		const sqlite = new Database(':memory:')
		await new SqliteServerStore(drizzle(sqlite), 'server-1').setSchema(schema)
		addTableConstraints(sqlite, ["CHECK (\"kind\" IN ('a', 'b'))", 'CHECK ("price" >= 0)'])

		const restarted = new SqliteServerStore(drizzle(sqlite), 'server-1')
		await restarted.setSchema(schema)

		const sql = tableSql(sqlite)
		expect(sql).not.toMatch(/"kind" IN/)
		expect(sql).toMatch(/CHECK \("price" >= 0\)/)
		await expect(
			restarted.applyRemoteOperation(await note({ title: 'neg', price: -1 })),
		).rejects.toThrow()
	})
})
