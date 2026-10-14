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
		expect(await manager.verify(token, id)).toEqual({
			ok: true,
			userId: id,
			email: 'ann@example.com',
		})
		expect((await users.findById(id))?.emailVerified).toBe(true)
		expect(await manager.verify(token, id)).toEqual({
			ok: false,
			code: 'VERIFICATION_TOKEN_INVALID',
		})
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
		expect(await manager.verify(tokenOf(sent[0]), id)).toEqual({
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
		expect(await manager.verify(tokenOf(sent[0]), id)).toEqual({
			ok: false,
			code: 'VERIFICATION_TOKEN_INVALID',
		})
		expect((await users.findById(id))?.emailVerified).toBe(false)
	})

	test('malformed and unknown tokens answer the same', async () => {
		const { manager } = setup()
		for (const bad of [undefined, 42, '', 'short', 'x'.repeat(500), 'A'.repeat(43)]) {
			expect(await manager.verify(bad, 'u1')).toEqual({
				ok: false,
				code: 'VERIFICATION_TOKEN_INVALID',
			})
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
		expect((await manager.verify(tokenOf(sent[1]), id)).ok).toBe(true)
		await users.setEmailVerified(id, false)
		expect(await manager.verify(tokenOf(sent[0]), id)).toEqual({
			ok: false,
			code: 'VERIFICATION_TOKEN_INVALID',
		})
	})
})

describe('EmailVerificationManager, adversarial', () => {
	test('a link verifies only the account it was sent for, and keeps working for it', async () => {
		const { users, sent, manager, tokenOf } = setup()
		const owner = await userWith(users, 'victim@example.com')
		const other = await userWith(users, 'other@example.com')
		await manager.send(owner, 'request')
		const token = tokenOf(sent[0])
		expect(await manager.verify(token, other)).toEqual({
			ok: false,
			code: 'VERIFICATION_WRONG_ACCOUNT',
		})
		expect((await users.findById(owner))?.emailVerified).toBe(false)
		expect((await manager.verify(token, owner)).ok).toBe(true)
	})

	test('an expired link says so, even after other users sent links', async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		const { users, sent, manager, tokenOf } = setup({ tokenTtlMs: 1000 })
		const ann = await userWith(users, 'ann@example.com')
		const bob = await userWith(users, 'bob@example.com')
		await manager.send(ann, 'request')
		vi.setSystemTime(Date.now() + 1500)
		await manager.send(bob, 'request')
		expect(await manager.verify(tokenOf(sent[0]), ann)).toEqual({
			ok: false,
			code: 'VERIFICATION_TOKEN_EXPIRED',
		})
	})

	test('concurrent sends cannot pass the hourly limit', async () => {
		const { users, sent, manager } = setup({ maxPerHour: 3 })
		const id = await userWith(users, 'a@example.com')
		const results = await Promise.all(Array.from({ length: 50 }, () => manager.send(id, 'request')))
		expect(results.filter((r) => r.ok)).toHaveLength(3)
		expect(sent).toHaveLength(3)
	})

	test('short-lived links do not reset the hourly limit', async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		const { users, sent, manager } = setup({ maxPerHour: 2, tokenTtlMs: 1 })
		const id = await userWith(users, 'a@example.com')
		for (let i = 0; i < 10; i++) {
			await manager.send(id, 'request')
			vi.setSystemTime(Date.now() + 10)
		}
		expect(sent).toHaveLength(2)
	})

	test('a link whose delivery failed does not work', async () => {
		const captured: string[] = []
		const { users, manager } = setup({
			send: ({ url }) => {
				captured.push(url.slice(url.indexOf('#') + 1))
				throw new Error('smtp down')
			},
		})
		vi.spyOn(console, 'error').mockImplementation(() => {})
		const id = await userWith(users, 'a@example.com')
		expect((await manager.send(id, 'request')).ok).toBe(false)
		expect(await manager.verify(captured[0], id)).toEqual({
			ok: false,
			code: 'VERIFICATION_TOKEN_INVALID',
		})
	})

	test('a user store without the atomic mark still checks the address', async () => {
		const users = new InMemoryUserStore()
		const plain = Object.assign(
			Object.create(Object.getPrototypeOf(users)),
			users,
		) as InMemoryUserStore
		;(plain as { markEmailVerifiedIfEmail?: unknown }).markEmailVerifiedIfEmail = undefined
		const sent: EmailVerificationMessage[] = []
		const manager = new EmailVerificationManager(plain, {
			url: (token) => `#${token}`,
			send: (message) => {
				sent.push(message)
			},
		})
		const id = await userWith(plain, 'old@example.com')
		await manager.send(id, 'request')
		const user = await plain.findById(id)
		if (!user) throw new Error('no user')
		await plain.update({ ...user, email: 'new@example.com' })
		expect(await manager.verify((sent[0]?.url ?? '').slice(1), id)).toEqual({
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

	test('a take for another user leaves the token; get reads without removing', async () => {
		const { store, close } = await create()
		try {
			await store.store(token('h3', 'owner'))
			expect(await store.take('h3', 'someone-else')).toBeNull()
			expect(await store.get('h3')).toEqual(token('h3', 'owner'))
			expect(await store.take('h3', 'owner')).toEqual(token('h3', 'owner'))
			expect(await store.get('h3')).toBeNull()
		} finally {
			await close()
		}
	})

	test('send counts: per user, atomic, per window, reset by deleteForUser; expiry and deletes', async () => {
		const { store, close } = await create()
		try {
			expect(await store.countSend('u1', 1000, 100)).toBe(1)
			expect(await store.countSend('u1', 1050, 100)).toBe(2)
			expect(await store.countSend('u2', 1050, 100)).toBe(1)
			// The window started at 1000 and lasts 100: at 1100 a new one starts.
			expect(await store.countSend('u1', 1100, 100)).toBe(1)
			const counts = await Promise.all(
				Array.from({ length: 10 }, () => store.countSend('u3', 5000, 100)),
			)
			expect([...counts].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
			await store.store(token('a', 'u1', 1000, 2000))
			await store.store(token('b', 'u1', 3000, 9000))
			await store.store(token('c', 'u2', 3000, 9000))
			expect(await store.deleteExpired(2500)).toBe(1)
			await store.deleteForUser('u1')
			expect(await store.take('b')).toBeNull()
			expect(await store.take('c')).not.toBeNull()
			expect(await store.countSend('u1', 1150, 100)).toBe(1)
		} finally {
			await close()
		}
	})
})
