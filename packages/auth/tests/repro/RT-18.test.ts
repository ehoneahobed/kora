/**
 * RT-18 repro (red team round 2, 2026-10-01): revocation does not reach other server
 * instances.
 *
 * Revocations are persisted (shared user store and revocation cut-offs), but the
 * listener that ends live sync sessions is in-process: only the instance whose auth
 * routes handled the revocation terminates its sessions. A session held by another
 * instance keeps syncing with the revoked credential until the token expires.
 *
 * Two instances here share one user store (and therefore one revocation store), as
 * two processes would share a database. Asserts the CORRECT behaviour (fails before
 * the fix): every instance re-validates its live sessions against the persisted
 * revocations and ends the revoked ones.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { KoraSyncServer, MemoryServerStore } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncMessage } from '@korajs/sync'
import postgres from 'postgres'
import { describe, expect, test, vi } from 'vitest'
import { PostgresUserStore } from '../../src/provider/built-in/postgres-user-store'
import { createKoraAuthServer } from '../../src/provider/built-in/quickstart-server'
import { createSqliteUserStore } from '../../src/provider/built-in/sqlite-user-store'
import { InMemoryUserStore } from '../../src/provider/built-in/user-store'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), userId: t.string() }, scope: ['userId'] } },
})

const SECRET = 's'.repeat(64)
/** Set KORA_PG_TEST_URL to also run the two-instance test against a real Postgres. */
const PG_URL = process.env.KORA_PG_TEST_URL

async function open(server: KoraSyncServer, token: string): Promise<SyncMessage[]> {
	const { client, server: transport } = createServerTransportPair()
	const messages: SyncMessage[] = []
	client.onMessage((m) => messages.push(m))
	server.handleConnection(transport)
	client.send({
		type: 'handshake',
		messageId: 'hs',
		nodeId: 'laptop-node',
		versionVector: {},
		schemaVersion: 1,
		authToken: token,
	} as SyncMessage)
	await vi.waitFor(() =>
		expect(messages.some((m) => m.type === 'handshake-response' && m.accepted)).toBe(true),
	)
	return messages
}

function errorCodes(messages: SyncMessage[]): string[] {
	return messages.flatMap((m) => (m.type === 'error' ? [m.code] : []))
}

describe('RT-18: cross-instance revocation', () => {
	test('a device revoked on instance A loses its live session on instance B', async () => {
		const userStore = new InMemoryUserStore()
		const authA = createKoraAuthServer({ jwtSecret: SECRET, userStore })
		const authB = createKoraAuthServer({ jwtSecret: SECRET, userStore })

		const signup = (
			await authA.handleRequest({
				method: 'POST',
				path: '/auth/signup',
				body: { email: 'u@example.com', password: 'password-123', deviceId: 'laptop' },
			})
		).body as { data: { tokens: { accessToken: string } } }
		const token = signup.data.tokens.accessToken

		const store = new MemoryServerStore('shared')
		await store.setSchema(schema)
		const serverB = new KoraSyncServer({
			store,
			auth: authB.auth,
			relayRetransmitIntervalMs: 0,
			deliveryPollIntervalMs: 0,
			sessionRevalidationIntervalMs: 50,
		} as ConstructorParameters<typeof KoraSyncServer>[0])
		const messages = await open(serverB, token)

		// The revocation is handled by instance A's routes.
		const res = await authA.handleRequest({
			method: 'DELETE',
			path: '/auth/device/laptop',
			headers: { authorization: `Bearer ${token}` },
		})
		expect(res.status).toBe(200)

		await vi.waitFor(() => expect(errorCodes(messages)).toContain('AUTH_REVOKED'), {
			timeout: 2000,
		})
		expect(serverB.getConnectionCount()).toBe(0)
		await serverB.stop()
	})

	test('two instances on one SQLite auth database: a user-wide revocation on A ends B', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'kora-rt18-'))
		const filename = join(dir, 'auth.db')
		// Two independent handles on one database file, as two processes would hold.
		const authA = createKoraAuthServer({
			jwtSecret: SECRET,
			userStore: await createSqliteUserStore({ filename }),
		})
		const authB = createKoraAuthServer({
			jwtSecret: SECRET,
			userStore: await createSqliteUserStore({ filename }),
		})
		const signup = (
			await authA.handleRequest({
				method: 'POST',
				path: '/auth/signup',
				body: { email: 'v@example.com', password: 'password-123', deviceId: 'phone' },
			})
		).body as { data: { user: { id: string }; tokens: { accessToken: string } } }

		const store = new MemoryServerStore('shared')
		await store.setSchema(schema)
		const serverB = new KoraSyncServer({
			store,
			auth: authB.auth,
			relayRetransmitIntervalMs: 0,
			deliveryPollIntervalMs: 0,
			sessionRevalidationIntervalMs: 0,
		} as ConstructorParameters<typeof KoraSyncServer>[0])
		const messages = await open(serverB, signup.data.tokens.accessToken)

		await authA.revokeAllForUser(signup.data.user.id)
		// Deterministic: run one re-validation pass instead of waiting for the timer.
		const pass = serverB as unknown as { revalidateSessions?: () => Promise<number> }
		expect(typeof pass.revalidateSessions).toBe('function')
		expect(await pass.revalidateSessions?.()).toBe(1)
		expect(errorCodes(messages)).toContain('AUTH_REVOKED')
		expect(serverB.getConnectionCount()).toBe(0)
		await serverB.stop()
		rmSync(dir, { recursive: true, force: true })
	})

	test.skipIf(!PG_URL)(
		'two instances on one Postgres auth database: a device revocation on A ends B',
		async () => {
			const admin = postgres(PG_URL as string, { max: 1 })
			const database = `kora_rt18_${Date.now()}`
			await admin.unsafe(`CREATE DATABASE ${database}`)
			const url = new URL(PG_URL as string)
			url.pathname = `/${database}`
			try {
				// Two independent connection pools on one database, as two processes would hold.
				const poolA = postgres(url.toString(), { max: 2 })
				const poolB = postgres(url.toString(), { max: 2 })
				type Client = ConstructorParameters<typeof PostgresUserStore>[0]
				const storeA = new PostgresUserStore(poolA as unknown as Client)
				const authA = createKoraAuthServer({ jwtSecret: SECRET, userStore: storeA })
				const signup = (
					await authA.handleRequest({
						method: 'POST',
						path: '/auth/signup',
						body: { email: 'pg@example.com', password: 'password-123', deviceId: 'tablet' },
					})
				).body as { data: { tokens: { accessToken: string } } }
				const token = signup.data.tokens.accessToken
				// Instance B starts after A created the tables (a concurrent first start is
				// covered by src/postgres/ensure-schema.test.ts).
				const storeB = new PostgresUserStore(poolB as unknown as Client)
				const authB = createKoraAuthServer({ jwtSecret: SECRET, userStore: storeB })

				const store = new MemoryServerStore('shared')
				await store.setSchema(schema)
				const serverB = new KoraSyncServer({
					store,
					auth: authB.auth,
					relayRetransmitIntervalMs: 0,
					deliveryPollIntervalMs: 0,
					sessionRevalidationIntervalMs: 0,
				} as ConstructorParameters<typeof KoraSyncServer>[0])
				const messages = await open(serverB, token)

				const res = await authA.handleRequest({
					method: 'DELETE',
					path: '/auth/device/tablet',
					headers: { authorization: `Bearer ${token}` },
				})
				expect(res.status).toBe(200)
				const pass = serverB as unknown as { revalidateSessions?: () => Promise<number> }
				expect(await pass.revalidateSessions?.()).toBe(1)
				expect(errorCodes(messages)).toContain('AUTH_REVOKED')
				await serverB.stop()
				await poolA.end()
				await poolB.end()
			} finally {
				await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
				await admin.end()
			}
		},
	)
})
