import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'
import type { KoraApp } from '../../src/types'

// STORE-4: secret fields written through app.transaction / app.mutation must be
// transformed (hashed/encrypted) exactly like app.<collection>.insert/update.
const schema = defineSchema({
	version: 1,
	collections: {
		accounts: { fields: { email: t.string(), password: t.secret().hashed() } },
	},
})

async function rawEverywhere(app: KoraApp): Promise<string> {
	const adapter = (app.getStore() as unknown as { adapter: any }).adapter
	const rows = await adapter.query('SELECT * FROM accounts')
	const ops = await adapter.query('SELECT data FROM _kora_ops_accounts')
	return JSON.stringify([rows, ops])
}

describe('STORE-4 secret fields in transactions', () => {
	let app: KoraApp
	afterEach(async () => {
		if (app) await app.close()
	})

	test('control: app.accounts.insert never stores plaintext', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready
		await (app as unknown as Record<string, any>).accounts.insert({ email: 'a@b.c', password: 'hunter2' })
		expect(await rawEverywhere(app)).not.toContain('hunter2')
	})

	test('app.transaction insert never stores or logs plaintext', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready
		await app.transaction(async (tx) => {
			await tx.accounts!.insert({ email: 'a@b.c', password: 'hunter2' })
		})
		expect(await rawEverywhere(app)).not.toContain('hunter2')
	})

	test('app.mutation update never stores or logs plaintext', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready
		const rec = await (app as unknown as Record<string, any>).accounts.insert({ email: 'a@b.c', password: 'x' })
		await app.mutation('changePassword', async (tx) => {
			await tx.accounts!.update(rec.id, { password: 'correct-horse' })
		})
		expect(await rawEverywhere(app)).not.toContain('correct-horse')
	})
})
