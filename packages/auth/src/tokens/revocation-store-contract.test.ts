import { createRequire } from 'node:module'
import { afterAll, describe, expect, it } from 'vitest'
import { PostgresTokenRevocationStore } from './postgres-token-revocation-store'
import {
	type SqliteRevocationDatabase,
	SqliteTokenRevocationStore,
} from './sqlite-token-revocation-store'
import {
	InMemoryTokenRevocationStore,
	TokenManager,
	type TokenRevocationStore,
} from './token-manager'

/**
 * One contract, every shipped TokenRevocationStore (AUTH-6, AUTH-12). The Postgres
 * suite needs a running server: set KORA_PG_TEST_URL (for example
 * `postgres://postgres@127.0.0.1:5547/postgres`); it is skipped otherwise.
 */
const PG_URL = process.env.KORA_PG_TEST_URL
const require = createRequire(import.meta.url)

type Factory = () => Promise<TokenRevocationStore>

function contract(name: string, create: Factory): void {
	describe(`${name} TokenRevocationStore contract`, () => {
		it('revoke / isRevoked', async () => {
			const store = await create()
			expect(await store.isRevoked('a')).toBe(false)
			await store.revoke('a', Math.floor(Date.now() / 1000) + 60)
			await store.revoke('a', Math.floor(Date.now() / 1000) + 60) // idempotent
			expect(await store.isRevoked('a')).toBe(true)
		})

		it('consume is an atomic test-and-set under concurrency', async () => {
			const store = await create()
			const exp = Math.floor(Date.now() / 1000) + 60
			const results = await Promise.all(
				Array.from({ length: 20 }, () => store.consume('jti-1', exp)),
			)
			expect(results.filter((r) => r.firstUse)).toHaveLength(1)
			const consumedAt = results.find((r) => r.firstUse)?.consumedAt
			for (const r of results) expect(r.consumedAt).toBe(consumedAt)
			expect(await store.isConsumed('jti-1')).toBe(true)
			expect(await store.isConsumed('jti-2')).toBe(false)
		})

		it('device and user cut-offs are monotonic', async () => {
			const store = await create()
			expect(await store.getDeviceRevokedBefore('d')).toBeNull()
			await store.revokeAllForDevice('d', 2_000)
			await store.revokeAllForDevice('d', 1_000)
			expect(await store.getDeviceRevokedBefore('d')).toBe(2_000)
			expect(await store.getUserRevokedBefore('u')).toBeNull()
			await store.revokeAllForUser('u', 5_000)
			await store.revokeAllForUser('u', 3_000)
			expect(await store.getUserRevokedBefore('u')).toBe(5_000)
		})

		it('two TokenManagers sharing the store see each other’s rotations and sign-outs', async () => {
			const store = await create()
			const secret = 's'.repeat(48)
			const a = new TokenManager({ secret, revocationStore: store, refreshReuseGraceMs: 0 })
			const b = new TokenManager({ secret, revocationStore: store, refreshReuseGraceMs: 0 })
			const tokens = a.issueTokens(`user-${Math.random()}`, `dev-${Math.random()}`)
			const [x, y] = await Promise.all([
				a.rotateRefreshToken(tokens.refreshToken),
				b.rotateRefreshToken(tokens.refreshToken),
			])
			expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1)
		})
	})
}

contract('InMemory', async () => new InMemoryTokenRevocationStore())

contract('SQLite', async () => {
	const Database = require('better-sqlite3') as new (filename: string) => SqliteRevocationDatabase
	return new SqliteTokenRevocationStore(new Database(':memory:'))
})

describe.skipIf(!PG_URL)('Postgres', () => {
	const clients: Array<{ end(): Promise<void> }> = []
	afterAll(async () => {
		for (const c of clients) await c.end()
	})
	contract('Postgres', async () => {
		const postgres = require('postgres') as (url: string, opts?: Record<string, unknown>) => unknown
		const schema = `kora_auth_rev_${Math.random().toString(36).slice(2, 10)}`
		const admin = postgres(PG_URL as string) as {
			unsafe(q: string): Promise<unknown>
			end(): Promise<void>
		}
		await admin.unsafe(`CREATE SCHEMA ${schema}`)
		clients.push(admin)
		const sql = postgres(PG_URL as string, { max: 8, connection: { search_path: schema } }) as {
			end(): Promise<void>
		}
		clients.push(sql)
		return new PostgresTokenRevocationStore(
			sql as unknown as ConstructorParameters<typeof PostgresTokenRevocationStore>[0],
		)
	})
})
