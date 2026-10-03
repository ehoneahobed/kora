import { defineSchema, t } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { PostgresServerStore } from './postgres-server-store'

/**
 * Real-Postgres key-record contract (ENC-1): compare-and-set on the revision has
 * exactly one winner across concurrent writers. Set KORA_PG_TEST_URL to run.
 */
const PG_URL = process.env.KORA_PG_TEST_URL

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string() } } },
})

describe.skipIf(!PG_URL)('Postgres encryption key records (ENC-1)', () => {
	let client: ReturnType<typeof postgres>
	let store: PostgresServerStore
	const PG_SCHEMA = 'kora_test_encryption_keys'

	beforeAll(async () => {
		client = postgres(PG_URL as string, { max: 4, connection: { search_path: PG_SCHEMA } })
		await client.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}`)
	})

	afterAll(async () => {
		await store.close()
		await client.end()
	})

	beforeEach(async () => {
		await client.unsafe(
			'DROP TABLE IF EXISTS notes, operations, sync_state, node_claims, kora_encryption_keys CASCADE',
		)
		store = new PostgresServerStore(drizzle(client), 'server-pg')
		await store.setSchema(schema)
	})

	test('concurrent first writes have one winner; updates are compare-and-set', async () => {
		const results = await Promise.all(
			Array.from({ length: 6 }, (_, i) =>
				store.putEncryptionKeyRecord('u:alice', 'default', `{"n":${i}}`, 1, 0),
			),
		)
		expect(results.filter(Boolean)).toHaveLength(1)
		expect(await store.putEncryptionKeyRecord('u:alice', 'default', '{"n":"x"}', 3, 2)).toBe(false)
		expect(await store.putEncryptionKeyRecord('u:alice', 'default', '{"n":"y"}', 2, 1)).toBe(true)
		expect(await store.getEncryptionKeyRecord('u:alice', 'default')).toBe('{"n":"y"}')
		expect(await store.getEncryptionKeyRecord('u:bob', 'default')).toBeNull()
	})
})
