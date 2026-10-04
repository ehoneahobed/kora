import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	HybridLogicalClock,
	type Operation,
	type SchemaDefinition,
	createOperation,
	defineSchema,
	t,
} from '@korajs/core'
import Database from 'better-sqlite3'
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3'
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { describe, expect, test } from 'vitest'
import { PostgresServerStore } from './postgres-server-store'
import { SqliteServerStore } from './sqlite-server-store'

/**
 * RT-101 on server stores: tables created by beta.12 carry an enum CHECK; a schema
 * upgrade relaxes them once at setSchema (SQLite table rebuild, Postgres DROP
 * CONSTRAINT / DROP NOT NULL), so a value the new schema accepts is stored, and rows
 * holding a value a later schema removed are kept.
 */
const v1 = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: { title: t.string(), priority: t.enum(['low', 'high']).default('low') },
			indexes: ['priority'],
		},
	},
}) as SchemaDefinition
const v2 = defineSchema({
	version: 2,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				priority: t.enum(['low', 'high', 'urgent']).default('low'),
			},
			indexes: ['priority'],
		},
	},
}) as SchemaDefinition
const v3 = defineSchema({
	version: 3,
	collections: {
		todos: {
			fields: { title: t.string(), priority: t.enum(['low', 'high']).default('low') },
			indexes: ['priority'],
		},
	},
}) as SchemaDefinition

let seq = 0
async function todo(data: Record<string, unknown>, schemaVersion: number): Promise<Operation> {
	seq += 1
	return createOperation(
		{
			nodeId: 'device-a',
			type: 'insert',
			collection: 'todos',
			recordId: `todo-${seq}`,
			data,
			previousData: null,
			sequenceNumber: seq,
			causalDeps: [],
			schemaVersion,
		},
		new HybridLogicalClock('device-a'),
	)
}

describe('server stores relax beta.12 value-domain constraints (RT-101)', () => {
	test('SQLite: legacy CHECK rebuilt once; added value stored; removed value kept', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'rt101-server-'))
		const file = join(dir, 'server.db')
		try {
			const sqlite1 = new Database(file)
			const first = new SqliteServerStore(drizzleSqlite(sqlite1), 'server-1')
			await first.setSchema(v1)
			const old = await todo({ title: 'old', priority: 'high' }, 1)
			await first.applyRemoteOperation(old)
			// Give the table the beta.12 shape: an enum CHECK on priority.
			sqlite1.exec(`BEGIN;
				CREATE TABLE "_legacy" (id TEXT PRIMARY KEY NOT NULL, "title" TEXT, "priority" TEXT DEFAULT 'low' CHECK ("priority" IN ('low', 'high')), _created_at INTEGER NOT NULL DEFAULT 0, _updated_at INTEGER NOT NULL DEFAULT 0, _deleted INTEGER NOT NULL DEFAULT 0);
				INSERT INTO "_legacy" SELECT id, title, priority, _created_at, _updated_at, _deleted FROM todos;
				DROP TABLE todos;
				ALTER TABLE "_legacy" RENAME TO todos;
				CREATE INDEX idx_todos_priority ON todos (priority);
				CREATE INDEX idx_todos__deleted ON todos (_deleted);
				COMMIT;`)
			await first.close()

			const sqlite2 = new Database(file)
			const upgraded = new SqliteServerStore(drizzleSqlite(sqlite2), 'server-1')
			await upgraded.setSchema(v2)
			const tableSql = () =>
				(
					sqlite2.prepare("SELECT sql FROM sqlite_master WHERE name = 'todos'").get() as {
						sql: string
					}
				).sql
			expect(tableSql()).not.toMatch(/CHECK/i)
			const relaxed = tableSql()
			const indexes = sqlite2
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'todos' AND sql IS NOT NULL ORDER BY name",
				)
				.all()
			expect(indexes).toEqual([{ name: 'idx_todos__deleted' }, { name: 'idx_todos_priority' }])
			const urgent = await todo({ title: 'new', priority: 'urgent' }, 2)
			expect(await upgraded.applyRemoteOperation(urgent)).toBe('applied')
			expect(await upgraded.findRecord('todos', urgent.recordId)).toMatchObject({
				priority: 'urgent',
			})
			expect(await upgraded.findRecord('todos', old.recordId)).toMatchObject({
				title: 'old',
				priority: 'high',
			})
			await upgraded.close()

			// v3 removes 'urgent': the stored row keeps it through the restart's re-fold.
			const sqlite3 = new Database(file)
			const removed = new SqliteServerStore(drizzleSqlite(sqlite3), 'server-1')
			await removed.setSchema(v3)
			expect(
				(
					sqlite3.prepare("SELECT sql FROM sqlite_master WHERE name = 'todos'").get() as {
						sql: string
					}
				).sql,
			).toBe(relaxed)
			expect(await removed.findRecord('todos', urgent.recordId)).toMatchObject({
				priority: 'urgent',
			})
			await removed.close()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test.skipIf(!process.env.KORA_PG_TEST_URL)(
		'Postgres: legacy enum CHECK and NOT NULL dropped once; hand checks kept',
		async () => {
			const schemaName = `kora_rt101_${process.pid}`
			const admin = postgres(process.env.KORA_PG_TEST_URL as string, {
				max: 1,
				onnotice: () => {},
			})
			await admin.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
			await admin.unsafe(`CREATE SCHEMA ${schemaName}`)
			const client = postgres(process.env.KORA_PG_TEST_URL as string, {
				max: 4,
				onnotice: () => {},
				connection: { search_path: schemaName },
			})
			try {
				const first = new PostgresServerStore(drizzlePg(client), 'server-1')
				await first.setSchema(v1)
				const old = await todo({ title: 'old', priority: 'high' }, 1)
				await first.applyRemoteOperation(old)
				// beta.12 shape: the column CHECK it generated, plus NOT NULL on a field, plus
				// a check the operator added by hand (must survive).
				await client.unsafe(`ALTER TABLE todos ADD CHECK ("priority" IN ('low', 'high'))`)
				await client.unsafe('ALTER TABLE todos ALTER COLUMN title SET NOT NULL')
				await client.unsafe(
					'ALTER TABLE todos ADD CONSTRAINT todos_title_hand CHECK (length(title) < 1000)',
				)

				const upgraded = new PostgresServerStore(drizzlePg(client), 'server-1')
				await upgraded.setSchema(v2)
				const checks = await client.unsafe(
					`SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid = 'todos'::regclass ORDER BY conname`,
				)
				expect(checks.map((row) => row.conname)).toEqual(['todos_title_hand'])
				const notNull = await client.unsafe(
					`SELECT attname FROM pg_attribute WHERE attrelid = 'todos'::regclass AND attnotnull AND attnum > 0 AND attname = 'title'`,
				)
				expect(notNull).toHaveLength(0)
				const urgent = await todo({ title: 'new', priority: 'urgent' }, 2)
				expect(await upgraded.applyRemoteOperation(urgent)).toBe('applied')
				expect(await upgraded.findRecord('todos', urgent.recordId)).toMatchObject({
					priority: 'urgent',
				})
				expect(await upgraded.findRecord('todos', old.recordId)).toMatchObject({
					priority: 'high',
				})
				// Idempotent: a further start changes nothing; v3 keeps the removed value's row.
				const removed = new PostgresServerStore(drizzlePg(client), 'server-1')
				await removed.setSchema(v3)
				expect(await removed.findRecord('todos', urgent.recordId)).toMatchObject({
					priority: 'urgent',
				})
			} finally {
				await client.end()
				await admin.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
				await admin.end()
			}
		},
	)
})
