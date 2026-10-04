import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { PostgresServerStore } from './postgres-server-store'
import { restoreBackupKeyRecords } from './server-backup'

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

	test('key ids of a principal encrypted history (RT-104)', async () => {
		expect(await store.claimNode('alice-phone', 'alice')).toBe(true)
		expect(await store.claimNode('bob-phone', 'bob')).toBe(true)
		const sealed = (nodeId: string, seq: number, keyId: string): Operation => ({
			id: `op-${nodeId}-${seq}`,
			nodeId,
			type: 'insert',
			collection: 'notes',
			recordId: `rec-${nodeId}-${seq}`,
			data: null,
			previousData: null,
			timestamp: { wallTime: 1_700_000_000_000 + seq, logical: 0, nodeId },
			sequenceNumber: seq,
			causalDeps: [],
			schemaVersion: 1,
			encrypted: {
				v: 2,
				alg: 'aes-256-gcm',
				keyId,
				keyVersion: 1,
				data: { iv: 'aXY=', ct: 'Y3Q=' },
				previousData: { iv: 'aXY=', ct: 'bnVsbA==' },
			},
		})
		expect(await store.getEncryptedKeyIds('alice', 16)).toEqual([])
		await store.applyRemoteOperation(sealed('alice-phone', 1, `k2-${'a'.repeat(32)}`))
		await store.applyRemoteOperation(sealed('bob-phone', 1, `k2-${'b'.repeat(32)}`))
		expect(await store.getEncryptedKeyIds('alice', 16)).toEqual([`k2-${'a'.repeat(32)}`])
		expect((await store.getEncryptedKeyIds(null, 16)).sort()).toEqual([
			`k2-${'a'.repeat(32)}`,
			`k2-${'b'.repeat(32)}`,
		])
	})

	test('records are listed for the backup and restored only where missing (RT-104)', async () => {
		await store.putEncryptionKeyRecord('u:bob', 'default', '{"n":"b"}', 2, 0)
		await store.putEncryptionKeyRecord('u:alice', 'default', '{"n":"a"}', 5, 0)
		const rows = await store.listEncryptionKeyRecords()
		expect(rows).toEqual([
			{ owner: 'u:alice', keyring: 'default', revision: 5, record: '{"n":"a"}' },
			{ owner: 'u:bob', keyring: 'default', revision: 2, record: '{"n":"b"}' },
		])
		const restored = await restoreBackupKeyRecords(store, [
			{ owner: 'u:alice', keyring: 'default', revision: 4, record: '{"n":"old"}' },
			{ owner: 'u:carol', keyring: 'default', revision: 1, record: '{"n":"c"}' },
		])
		expect(restored).toBe(1)
		expect(await store.getEncryptionKeyRecord('u:alice', 'default')).toBe('{"n":"a"}')
		expect(await store.getEncryptionKeyRecord('u:carol', 'default')).toBe('{"n":"c"}')
	})
})
