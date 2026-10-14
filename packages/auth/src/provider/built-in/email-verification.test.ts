import { createRequire } from 'node:module'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
	EmailVerificationManager,
	type EmailVerificationMessage,
	type EmailVerificationStore,
	InMemoryEmailVerificationStore,
} from './email-verification'
import { PostgresEmailVerificationStore } from './postgres-email-verification-store'
import { SqliteEmailVerificationStore } from './sqlite-email-verification-store'
import { InMemoryUserStore } from './user-store'

const require = createRequire(import.meta.url)
const PG_URL = process.env.KORA_PG_TEST_URL

async function userWith(store: InMemoryUserStore, email: string): Promise<string> {
	const user = await store.createUser({ email, passwordHash: 'h', salt: 's', name: 'U' })
	return user.id
}

function setup(overrides: Partial<ConstructorParameters<typeof EmailVerificationManager>[1]> = {}) {
	const users = new InMemoryUserStore()
	const sent: EmailVerificationMessage[] = []
	const manager = new EmailVerificationManager(users, {
		url: (token) => `https://app.test/verify-email#${token}`,
		send: (message) => {
			sent.push(message)
		},
		...overrides,
	})
	const tokenOf = (message: EmailVerificationMessage | undefined): string =>
		message ? message.url.slice(message.url.indexOf('#') + 1) : ''
	return { users, sent, manager, tokenOf }
}

afterEach(() => {
	vi.useRealTimers()
})

describe('EmailVerificationManager', () => {
	test('a link verifies the address it was sent to, once', async () => {
		const { users, sent, manager, tokenOf } = setup()
		const id = await userWith(users, 'Ann@Example.com')
		expect(await manager.send(id, 'request')).toEqual({ ok: true, alreadyVerified: false })
		expect(sent[0]).toMatchObject({ to: 'ann@example.com', userId: id, reason: 'request' })
		const token = tokenOf(sent[0])
		expect(await manager.verify(token)).toEqual({ ok: true, userId: id, email: 'ann@example.com' })
		expect((await users.findById(id))?.emailVerified).toBe(true)
		expect(await manager.verify(token)).toEqual({ ok: false, code: 'VERIFICATION_TOKEN_INVALID' })
		// Verified: nothing more is sent.
		expect(await manager.send(id, 'request')).toEqual({ ok: true, alreadyVerified: true })
		expect(sent).toHaveLength(1)
	})

	test('only the token hash is stored', async () => {
		const store = new InMemoryEmailVerificationStore()
		const spy = vi.spyOn(store, 'store')
		const { users, sent, manager, tokenOf } = setup({ store })
		await manager.send(await userWith(users, 'a@example.com'), 'request')
		const stored = spy.mock.calls[0]?.[0]
		expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
		expect(JSON.stringify(stored)).not.toContain(tokenOf(sent[0]))
	})

	test('an expired link does not verify', async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		const { users, sent, manager, tokenOf } = setup({ tokenTtlMs: 1000 })
		const id = await userWith(users, 'a@example.com')
		await manager.send(id, 'request')
		vi.setSystemTime(Date.now() + 1000)
		expect(await manager.verify(tokenOf(sent[0]))).toEqual({
			ok: false,
			code: 'VERIFICATION_TOKEN_EXPIRED',
		})
		expect((await users.findById(id))?.emailVerified).toBe(false)
	})

	test('a link sent to a previous address verifies nothing', async () => {
		const { users, sent, manager, tokenOf } = setup()
		const id = await userWith(users, 'old@example.com')
		await manager.send(id, 'request')
		const user = await users.findById(id)
		if (!user) throw new Error('no user')
		await users.update({ ...user, email: 'new@example.com' })
		expect(await manager.verify(tokenOf(sent[0]))).toEqual({
			ok: false,
			code: 'VERIFICATION_TOKEN_INVALID',
		})
		expect((await users.findById(id))?.emailVerified).toBe(false)
	})

	test('malformed and unknown tokens answer the same', async () => {
		const { manager } = setup()
		for (const bad of [undefined, 42, '', 'short', 'x'.repeat(500), 'A'.repeat(43)]) {
			expect(await manager.verify(bad)).toEqual({ ok: false, code: 'VERIFICATION_TOKEN_INVALID' })
		}
	})

	test('sending is rate-limited per user, and delivery failures are reported', async () => {
		const { users, manager } = setup({ maxPerHour: 2 })
		const id = await userWith(users, 'a@example.com')
		expect((await manager.send(id, 'request')).ok).toBe(true)
		expect((await manager.send(id, 'request')).ok).toBe(true)
		expect(await manager.send(id, 'request')).toEqual({
			ok: false,
			code: 'VERIFICATION_RATE_LIMITED',
		})

		const failing = setup({
			send: () => {
				throw new Error('smtp down')
			},
		})
		const other = await userWith(failing.users, 'b@example.com')
		vi.spyOn(console, 'error').mockImplementation(() => {})
		expect(await failing.manager.send(other, 'request')).toEqual({
			ok: false,
			code: 'EMAIL_DELIVERY_FAILED',
		})
	})

	test('verifying one link ends the user’s other links', async () => {
		const { users, sent, manager, tokenOf } = setup()
		const id = await userWith(users, 'a@example.com')
		await manager.send(id, 'request')
		await manager.send(id, 'request')
		expect((await manager.verify(tokenOf(sent[1]))).ok).toBe(true)
		await users.setEmailVerified(id, false)
		expect(await manager.verify(tokenOf(sent[0]))).toEqual({
			ok: false,
			code: 'VERIFICATION_TOKEN_INVALID',
		})
	})
})

// ─── Store contract: every store, the same behaviour ─────────────────────────

type StoreFactory = () => Promise<{ store: EmailVerificationStore; close(): Promise<void> }>

const factories: Array<[string, StoreFactory]> = [
	['memory', async () => ({ store: new InMemoryEmailVerificationStore(), close: async () => {} })],
	[
		'sqlite',
		async () => {
			const Database = require('better-sqlite3')
			const db = new Database(':memory:')
			return { store: new SqliteEmailVerificationStore(db), close: async () => db.close() }
		},
	],
]
if (PG_URL) {
	factories.push([
		'postgres',
		async () => {
			const postgres = require('postgres')
			const admin = postgres(PG_URL, { max: 1, onnotice: () => {} })
			const database = `kora_auth_ev_${Math.random().toString(16).slice(2, 10)}`
			await admin.unsafe(`CREATE DATABASE ${database}`)
			const url = new URL(PG_URL)
			url.pathname = `/${database}`
			const sql = postgres(url.toString(), { max: 4, onnotice: () => {} })
			return {
				store: new PostgresEmailVerificationStore(sql),
				close: async () => {
					await sql.end()
					await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
					await admin.end()
				},
			}
		},
	])
}

describe.each(factories)('EmailVerificationStore on %s', (_name, create) => {
	const token = (tokenHash: string, userId = 'u1', createdAt = 1000, expiresAt = 5000) => ({
		tokenHash,
		userId,
		email: 'a@example.com',
		createdAt,
		expiresAt,
	})

	test('take returns a token once, and concurrent takes give it to one caller', async () => {
		const { store, close } = await create()
		try {
			await store.store(token('h1'))
			expect(await store.take('h1')).toEqual(token('h1'))
			expect(await store.take('h1')).toBeNull()
			await store.store(token('h2'))
			const results = await Promise.all(Array.from({ length: 8 }, () => store.take('h2')))
			expect(results.filter((r) => r !== null)).toHaveLength(1)
		} finally {
			await close()
		}
	})

	test('counts, per-user deletes and expiry', async () => {
		const { store, close } = await create()
		try {
			await store.store(token('a', 'u1', 1000, 2000))
			await store.store(token('b', 'u1', 3000, 9000))
			await store.store(token('c', 'u2', 3000, 9000))
			expect(await store.countSince('u1', 0)).toBe(2)
			expect(await store.countSince('u1', 2000)).toBe(1)
			expect(await store.deleteExpired(2500)).toBe(1)
			await store.deleteForUser('u1')
			expect(await store.take('b')).toBeNull()
			expect(await store.take('c')).not.toBeNull()
		} finally {
			await close()
		}
	})
})
