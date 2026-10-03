import { defineSchema, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { Store } from '../../src/store/store'

/** Round-trip insert + read for a collection/field name, returning ok or the error. */
async function roundTrip(collection: string, field: string): Promise<void> {
	const schema = defineSchema({
		version: 1,
		collections: { [collection]: { fields: { [field]: t.string() } } },
	})
	const store = new Store({
		schema,
		adapter: new BetterSqlite3Adapter(':memory:'),
		nodeId: 'node-ids',
	})
	await store.open()
	try {
		const rec = await store.collection(collection).insert({ [field]: 'hello' })
		const got = await store.collection(collection).findById(rec.id)
		expect((got as Record<string, unknown>)?.[field]).toBe('hello')
	} finally {
		await store.close()
	}
}

describe('SQL identifier safety', () => {
	test('a camelCase collection and field round-trip through create/insert/query', async () => {
		await roundTrip('formResponses', 'answerText')
	})

	test('a collection name that is a SQL reserved word works', async () => {
		await roundTrip('order', 'select')
	})

	test('mixed-case names preserve their exact casing end to end', async () => {
		await roundTrip('UserProfiles', 'firstName')
	})
})

describe('SQL literal safety in DDL (SEC-9b)', () => {
	test('quoted defaults and enum values open, apply and enforce on real SQLite', async () => {
		const schema = defineSchema({
			version: 1,
			collections: {
				notes: {
					fields: {
						title: t.string(),
						status: t.string().default("don't know"),
						mood: t.enum(["it's fine", 'ok']).default("it's fine"),
						tags: t.array(t.string()).default(["o'k"]),
					},
				},
			},
		})
		const adapter = new BetterSqlite3Adapter(':memory:')
		const store = new Store({ schema, adapter, nodeId: 'node-lit' })
		await store.open()
		try {
			const rec = await store.collection('notes').insert({ title: 'a' })
			expect(rec.status).toBe("don't know")
			expect(rec.mood).toBe("it's fine")
			// The DB-level defaults are the declared values too (rows written by SQL).
			await adapter.execute(
				`INSERT INTO notes (id, title, _created_at, _updated_at) VALUES ('raw', 'r', 0, 0)`,
			)
			const rows = await adapter.query<Record<string, unknown>>(
				`SELECT status, mood, tags FROM notes WHERE id = 'raw'`,
			)
			expect(rows[0]).toEqual({ status: "don't know", mood: "it's fine", tags: '["o\'k"]' })
			// The enum CHECK still rejects values outside the declared set.
			await expect(
				adapter.execute(
					`INSERT INTO notes (id, title, mood, _created_at, _updated_at) VALUES ('bad', 'b', 'its fine', 0, 0)`,
				),
			).rejects.toThrow()
		} finally {
			await store.close()
		}
	})
})
