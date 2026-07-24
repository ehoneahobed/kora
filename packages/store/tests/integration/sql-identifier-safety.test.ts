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
