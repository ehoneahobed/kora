import { createRequire } from 'node:module'
import { describe, expect, test } from 'vitest'
import { PostgresUserStore } from './postgres-user-store'
import { SqliteUserStore } from './sqlite-user-store'
import { InMemoryUserStore, type UserStore } from './user-store'

// Passwords change only through updatePassword (and its conditional form), on every store:
// a profile update written from an earlier copy never brings an old password back.

const require = createRequire(import.meta.url)
const PG_URL = process.env.KORA_PG_TEST_URL

type Factory = () => Promise<{ store: UserStore; close(): Promise<void> }>

const factories: Array<[string, Factory]> = [
	['memory', async () => ({ store: new InMemoryUserStore(), close: async () => {} })],
	[
		'sqlite',
		async () => {
			const Database = require('better-sqlite3')
			const db = new Database(':memory:')
			return { store: new SqliteUserStore(db), close: async () => db.close() }
		},
	],
]
if (PG_URL) {
	factories.push([
		'postgres',
		async () => {
			const postgres = require('postgres')
			const admin = postgres(PG_URL, { max: 1, onnotice: () => {} })
			const database = `kora_auth_pw_${Math.random().toString(16).slice(2, 10)}`
			await admin.unsafe(`CREATE DATABASE ${database}`)
			const url = new URL(PG_URL)
			url.pathname = `/${database}`
			const sql = postgres(url.toString(), { max: 4, onnotice: () => {} })
			return {
				store: new PostgresUserStore(sql),
				close: async () => {
					await sql.end()
					await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
					await admin.end()
				},
			}
		},
	])
}

describe.each(factories)('passwords on the %s user store', (_name, create) => {
	test('updatePasswordIf writes only while the hash, or the email, is still the expected one', async () => {
		const { store, close } = await create()
		try {
			const { id } = await store.createUser({
				email: 'a@example.com',
				passwordHash: 'h1',
				salt: 's1',
				name: 'A',
			})
			expect(await store.updatePasswordIf?.(id, { passwordHash: 'stale' }, 'h2', 's2')).toBe(false)
			expect((await store.findById(id))?.passwordHash).toBe('h1')
			expect(await store.updatePasswordIf?.(id, { passwordHash: 'h1' }, 'h2', 's2')).toBe(true)
			expect(await store.findById(id)).toMatchObject({ passwordHash: 'h2', salt: 's2' })
			expect(await store.updatePasswordIf?.('missing', { passwordHash: 'h2' }, 'h3', 's3')).toBe(
				false,
			)
			expect(await store.updatePasswordIf?.(id, { email: 'other@example.com' }, 'h3', 's3')).toBe(
				false,
			)
			expect(await store.updatePasswordIf?.(id, { email: 'A@Example.com' }, 'h3', 's3')).toBe(true)
			expect((await store.findById(id))?.passwordHash).toBe('h3')
		} finally {
			await close()
		}
	})

	test('update changes the profile and leaves the password', async () => {
		const { store, close } = await create()
		try {
			const { id } = await store.createUser({
				email: 'b@example.com',
				passwordHash: 'h1',
				salt: 's1',
				name: 'B',
			})
			const copy = await store.findById(id)
			if (!copy) throw new Error('no user')
			await store.updatePassword(id, 'h2', 's2')
			await store.update({ ...copy, name: 'Renamed', email: 'b2@example.com' })
			expect(await store.findById(id)).toMatchObject({
				name: 'Renamed',
				email: 'b2@example.com',
				passwordHash: 'h2',
				salt: 's2',
			})
			expect(await store.findByEmail('b2@example.com')).toMatchObject({ passwordHash: 'h2' })
		} finally {
			await close()
		}
	})

	test('deleting the account removes its pending reset links', async () => {
		const { store, close } = await create()
		try {
			const { id } = await store.createUser({
				email: 'c@example.com',
				passwordHash: 'h',
				salt: 's',
				name: 'C',
			})
			const resets = store.getPasswordResetStore?.()
			if (!resets) throw new Error('no reset store')
			await resets.store({
				tokenHash: 't',
				userId: id,
				email: 'c@example.com',
				createdAt: 1,
				expiresAt: Date.now() + 60_000,
			})
			await store.delete(id)
			expect(await resets.get('t')).toBeNull()
		} finally {
			await close()
		}
	})
})
