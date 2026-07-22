import { decryptSecret, defineSchema, revealSecret, t, verifySecretValue } from '@korajs/core'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { Store } from '../../src/store/store'

const schema = defineSchema({
	version: 1,
	collections: {
		accounts: {
			fields: {
				email: t.string(),
				password: t.secret().hashed(),
				apiKey: t.secret().encrypted(),
			},
		},
	},
})

const KEY = 'test-encryption-key'
let store: Store
let adapter: BetterSqlite3Adapter

beforeEach(async () => {
	adapter = new BetterSqlite3Adapter(':memory:')
	store = new Store({
		schema,
		adapter,
		nodeId: 'node-secret',
		secretKeyProvider: () => KEY,
	})
	await store.open()
})

afterEach(async () => {
	await store.close()
})

/** Read the raw stored value straight from the SQL row (bypassing deserialize). */
async function rawColumn(collection: string, id: string, column: string): Promise<unknown> {
	const rows = await adapter.query<Record<string, unknown>>(
		`SELECT ${column} FROM ${collection} WHERE id = ?`,
		[id],
	)
	return rows[0]?.[column]
}

/** Read the raw op-log data JSON for a record's latest operation. */
async function rawOpData(collection: string, recordId: string): Promise<string> {
	const rows = await adapter.query<{ data: string }>(
		`SELECT data FROM _kora_ops_${collection} WHERE record_id = ? ORDER BY sequence_number DESC LIMIT 1`,
		[recordId],
	)
	return rows[0]?.data ?? ''
}

describe('secret fields at rest', () => {
	test('an encrypted secret is ciphertext in the store and the op log, never plaintext', async () => {
		const rec = await store
			.collection('accounts')
			.insert({ email: 'a@b.com', password: 'hunter2', apiKey: 'sk_live_secret' })

		// Stored column is ciphertext, not the plaintext.
		const storedApiKey = (await rawColumn('accounts', rec.id, 'apiKey')) as string
		expect(storedApiKey).not.toContain('sk_live_secret')
		expect(await decryptSecret(storedApiKey, KEY)).toBe('sk_live_secret')

		// The operation log (what syncs to the server) also carries only ciphertext.
		const opData = await rawOpData('accounts', rec.id)
		expect(opData).not.toContain('sk_live_secret')
		expect(opData).not.toContain('hunter2')
	})

	test('a hashed secret is a one-way hash in the store, verifiable but not reversible', async () => {
		const rec = await store
			.collection('accounts')
			.insert({ email: 'a@b.com', password: 'hunter2', apiKey: 'k' })

		const storedPassword = (await rawColumn('accounts', rec.id, 'password')) as string
		expect(storedPassword).not.toContain('hunter2')
		expect(await verifySecretValue('hunter2', storedPassword)).toBe(true)
		expect(await verifySecretValue('wrong', storedPassword)).toBe(false)
	})

	test('reads return the at-rest form; revealSecret decrypts on demand', async () => {
		const rec = await store
			.collection('accounts')
			.insert({ email: 'a@b.com', password: 'pw', apiKey: 'token-abc' })

		const read = await store.collection('accounts').findById(rec.id)
		const stored = read?.apiKey as string
		expect(stored).not.toBe('token-abc') // still encrypted in memory
		expect(await revealSecret(stored, 'encrypted', () => KEY, 'apiKey')).toBe('token-abc')
	})

	test('updating an encrypted secret re-encrypts the new value', async () => {
		const rec = await store
			.collection('accounts')
			.insert({ email: 'a@b.com', password: 'pw', apiKey: 'old' })
		await store.collection('accounts').update(rec.id, { apiKey: 'new-token' })

		const stored = (await rawColumn('accounts', rec.id, 'apiKey')) as string
		expect(stored).not.toContain('new-token')
		expect(await decryptSecret(stored, KEY)).toBe('new-token')
	})
})
