import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { PostgresUserStore } from '../provider/built-in/postgres-user-store'
import {
	PostgresLinkedIdentityStore,
	PostgresOAuthStateStore,
} from '../provider/oauth/postgres-oauth-store'
import { ensurePostgresSchema } from './ensure-schema'

/**
 * Several server instances starting against one EMPTY database at the same time must
 * all come up: concurrent `CREATE TABLE IF NOT EXISTS` otherwise fails the loser with
 * "type ... already exists" (23505). Needs KORA_PG_TEST_URL; skipped otherwise.
 */
const PG_URL = process.env.KORA_PG_TEST_URL
const require = createRequire(import.meta.url)

type Sql = ((template: TemplateStringsArray, ...args: unknown[]) => Promise<unknown>) & {
	unsafe: (query: string) => Promise<unknown>
	end: () => Promise<void>
}
type Client = ConstructorParameters<typeof PostgresUserStore>[0]

describe('ensurePostgresSchema', () => {
	it('retries an idempotent DDL that lost a creation race (client without begin)', async () => {
		let calls = 0
		const raced = Object.assign(new Error('duplicate key value'), { code: '23505' })
		const sql = (async () => {
			calls += 1
			if (calls === 1) throw raced
			return []
		}) as unknown as Parameters<typeof ensurePostgresSchema>[0]
		await ensurePostgresSchema(sql, async (client) => {
			await client`CREATE TABLE IF NOT EXISTS t (id TEXT)`
		})
		expect(calls).toBe(2)
		const broken = Object.assign(new Error('syntax'), { code: '42601' })
		await expect(
			ensurePostgresSchema(
				(async () => {
					throw broken
				}) as unknown as Parameters<typeof ensurePostgresSchema>[0],
				async (client) => {
					await client`CREATE TABLE`
				},
			),
		).rejects.toBe(broken)
	})

	it.skipIf(!PG_URL)(
		'eight instances starting together on an empty database all come up',
		async () => {
			const postgres = require('postgres') as (url: string, options?: object) => Sql
			const admin = postgres(PG_URL as string, { max: 1 })
			const schema = `kora_auth_ddl_${process.pid}_${Date.now()}`
			await admin.unsafe(`CREATE SCHEMA ${schema}`)
			const pools = Array.from({ length: 8 }, () =>
				postgres(PG_URL as string, { max: 2, connection: { search_path: schema } }),
			)
			try {
				const stores = pools.map((pool) => new PostgresUserStore(pool as unknown as Client))
				const oauth = pools.map(
					(pool) =>
						new PostgresOAuthStateStore(
							pool as unknown as ConstructorParameters<typeof PostgresOAuthStateStore>[0],
						),
				)
				const linked = pools.map(
					(pool) =>
						new PostgresLinkedIdentityStore(
							pool as unknown as ConstructorParameters<typeof PostgresLinkedIdentityStore>[0],
						),
				)
				const results = await Promise.allSettled([
					...stores.map((s) => s.findByEmail('nobody@example.com')),
					...stores.map((s) => s.getTokenRevocationStore().isRevoked('jti')),
					...oauth.map((s) => s.consume('missing-state')),
					...linked.map((s) => s.findByUser('nobody')),
				])
				expect(results.filter((r) => r.status === 'rejected')).toEqual([])
				const user = await stores[0]?.createUser({
					email: 'a@example.com',
					passwordHash: 'h',
					salt: 's',
					name: 'A',
				})
				expect((await stores[7]?.findById(user?.id ?? ''))?.email).toBe('a@example.com')
			} finally {
				for (const pool of pools) await pool.end()
				await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`)
				await admin.end()
			}
		},
		60_000,
	)
})
