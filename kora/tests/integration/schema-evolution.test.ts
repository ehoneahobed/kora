import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, migrate, t } from '@korajs/core'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'

/**
 * RT-101: the value domain (enum membership, requiredness) is enforced by validation
 * only, so a schema can evolve it. Each case starts from a database whose tables have
 * the beta.12 shape (enum CHECK, NOT NULL on required fields), upgraded in place.
 *
 * Semantics:
 * - adding an enum value: the new value is stored everywhere;
 * - removing an enum value: existing rows keep (and read back) the old value, other
 *   fields of those rows stay writable, and NEW writes of the removed value are refused
 *   by validation; a backfill migration can rewrite the old rows;
 * - required -> optional: missing / null values are stored;
 * - optional -> required: existing nulls stay readable (and their other fields
 *   writable) until a backfill fills them; new writes need the field or get its default.
 */

let dir: string
let n = 0
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'kora-schema-evolution-'))
})
afterAll(() => {
	rmSync(dir, { recursive: true, force: true })
})

type Row = Record<string, unknown> & { id: string }
interface Todos {
	insert(data: Record<string, unknown>): Promise<Row>
	update(id: string, data: Record<string, unknown>): Promise<Row>
	findById(id: string): Promise<Row | null>
}

/**
 * Give `table` the beta.12 DDL shape: `NOT NULL` on `notNull` columns and
 * `CHECK (col IN (...))` on `checks` columns, keeping rows and indexes.
 */
function legacyize(
	file: string,
	table: string,
	shape: { notNull?: string[]; checks?: Record<string, string[]> },
): void {
	const db = new Database(file)
	try {
		const columns = db.prepare(`SELECT * FROM pragma_table_info('${table}')`).all() as Array<{
			name: string
			type: string
			notnull: number
			dflt_value: string | null
			pk: number
		}>
		const defs = columns.map((c) => {
			const parts = [`"${c.name}"`, c.type]
			if (c.pk) parts.push('PRIMARY KEY')
			if (c.notnull || shape.notNull?.includes(c.name)) parts.push('NOT NULL')
			if (c.dflt_value !== null) parts.push(`DEFAULT ${c.dflt_value}`)
			const values = shape.checks?.[c.name]
			if (values) parts.push(`CHECK ("${c.name}" IN (${values.map((v) => `'${v}'`).join(', ')}))`)
			return parts.join(' ')
		})
		const indexes = (
			db
				.prepare(
					`SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = '${table}' AND sql IS NOT NULL`,
				)
				.all() as Array<{ sql: string }>
		).map((r) => r.sql)
		const names = columns.map((c) => `"${c.name}"`).join(', ')
		db.exec('PRAGMA foreign_keys = OFF')
		db.exec('BEGIN')
		db.exec(`CREATE TABLE "_legacy" (${defs.join(', ')})`)
		db.exec(`INSERT INTO "_legacy" (${names}) SELECT ${names} FROM "${table}"`)
		db.exec(`DROP TABLE "${table}"`)
		db.exec(`ALTER TABLE "_legacy" RENAME TO "${table}"`)
		for (const sql of indexes) db.exec(sql)
		db.exec('COMMIT')
		const created = db
			.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${table}'`)
			.get() as { sql: string }
		if (shape.checks) expect(created.sql).toMatch(/CHECK/)
	} finally {
		db.close()
	}
}

async function open(schema: ReturnType<typeof defineSchema>, file: string) {
	const app = createApp({ schema, store: { adapter: 'better-sqlite3', name: file } })
	await app.ready
	return { app, todos: (app as unknown as { todos: Todos }).todos }
}

describe('schema evolution of the value domain (RT-101)', () => {
	test('adding an enum value', async () => {
		const file = join(dir, `t${++n}.db`)
		const v1 = defineSchema({
			version: 1,
			collections: {
				todos: { fields: { title: t.string(), priority: t.enum(['low', 'high']).default('low') } },
			},
		})
		const v2 = defineSchema({
			version: 2,
			collections: {
				todos: {
					fields: { title: t.string(), priority: t.enum(['low', 'high', 'urgent']).default('low') },
				},
			},
		})
		const before = await open(v1, file)
		const old = await before.todos.insert({ title: 'old', priority: 'high' })
		await before.app.close()
		legacyize(file, 'todos', { notNull: ['title'], checks: { priority: ['low', 'high'] } })

		const after = await open(v2, file)
		const urgent = await after.todos.insert({ title: 'new', priority: 'urgent' })
		expect((await after.todos.findById(urgent.id))?.priority).toBe('urgent')
		await after.todos.update(old.id, { priority: 'urgent' })
		expect((await after.todos.findById(old.id))?.priority).toBe('urgent')
		await after.app.close()
	}, 20000)

	test('removing an enum value: old rows keep it, new writes of it are refused', async () => {
		const file = join(dir, `t${++n}.db`)
		const v1 = defineSchema({
			version: 1,
			collections: {
				todos: {
					fields: { title: t.string(), priority: t.enum(['low', 'high', 'urgent']).default('low') },
				},
			},
		})
		const v2 = defineSchema({
			version: 2,
			collections: {
				todos: { fields: { title: t.string(), priority: t.enum(['low', 'high']).default('low') } },
			},
		})
		const before = await open(v1, file)
		const old = await before.todos.insert({ title: 'old', priority: 'urgent' })
		await before.app.close()
		legacyize(file, 'todos', {
			notNull: ['title'],
			checks: { priority: ['low', 'high', 'urgent'] },
		})

		const after = await open(v2, file)
		// The stored value is kept and read back as written.
		expect((await after.todos.findById(old.id))?.priority).toBe('urgent')
		// Other fields of that row stay writable; the old value is not rewritten.
		await after.todos.update(old.id, { title: 'renamed' })
		expect(await after.todos.findById(old.id)).toMatchObject({
			title: 'renamed',
			priority: 'urgent',
		})
		// New writes of the removed value are refused by validation.
		await expect(after.todos.insert({ title: 'x', priority: 'urgent' })).rejects.toThrow(
			/priority/,
		)
		await expect(after.todos.update(old.id, { priority: 'urgent' })).rejects.toThrow(/priority/)
		await after.app.close()

		// A backfill migration can move the old rows to a current value.
		const v3 = defineSchema({
			version: 3,
			collections: {
				todos: { fields: { title: t.string(), priority: t.enum(['low', 'high']).default('low') } },
			},
			migrations: {
				3: migrate().backfill('todos', (record) =>
					record.priority === 'urgent' ? { priority: 'high' } : {},
				),
			},
		})
		const migrated = await open(v3, file)
		expect((await migrated.todos.findById(old.id))?.priority).toBe('high')
		await migrated.app.close()
	}, 20000)

	test('required -> optional', async () => {
		const file = join(dir, `t${++n}.db`)
		const v1 = defineSchema({
			version: 1,
			collections: { todos: { fields: { title: t.string(), note: t.string() } } },
		})
		const v2 = defineSchema({
			version: 2,
			collections: { todos: { fields: { title: t.string(), note: t.string().optional() } } },
		})
		const before = await open(v1, file)
		const old = await before.todos.insert({ title: 'old', note: 'kept' })
		await before.app.close()
		legacyize(file, 'todos', { notNull: ['title', 'note'] })

		const after = await open(v2, file)
		const row = await after.todos.insert({ title: 'no note' })
		expect((await after.todos.findById(row.id))?.note ?? null).toBeNull()
		await after.todos.update(old.id, { note: null })
		expect((await after.todos.findById(old.id))?.note ?? null).toBeNull()
		await after.app.close()
	}, 20000)

	test('optional -> required: default for new writes, backfill for old rows', async () => {
		const file = join(dir, `t${++n}.db`)
		const v1 = defineSchema({
			version: 1,
			collections: { todos: { fields: { title: t.string(), note: t.string().optional() } } },
		})
		const v2 = defineSchema({
			version: 2,
			collections: { todos: { fields: { title: t.string(), note: t.string().default('n/a') } } },
		})
		const before = await open(v1, file)
		const old = await before.todos.insert({ title: 'old' })
		await before.app.close()
		legacyize(file, 'todos', { notNull: ['title'] })

		const after = await open(v2, file)
		// Without a backfill the old null stays readable and the row stays writable.
		expect((await after.todos.findById(old.id))?.note ?? null).toBeNull()
		await after.todos.update(old.id, { title: 'renamed' })
		// New writes get the default, and an explicit null is refused.
		const fresh = await after.todos.insert({ title: 'fresh' })
		expect((await after.todos.findById(fresh.id))?.note).toBe('n/a')
		await expect(after.todos.insert({ title: 'x', note: null })).rejects.toThrow(/note/)
		await after.app.close()

		const v3 = defineSchema({
			version: 3,
			collections: { todos: { fields: { title: t.string(), note: t.string().default('n/a') } } },
			migrations: {
				3: migrate().backfill('todos', (record) =>
					record.note === null || record.note === undefined ? { note: 'n/a' } : {},
				),
			},
		})
		const migrated = await open(v3, file)
		expect((await migrated.todos.findById(old.id))?.note).toBe('n/a')
		await migrated.app.close()
	}, 20000)
})
