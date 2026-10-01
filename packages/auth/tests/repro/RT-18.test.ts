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
import { defineSchema, t } from '@korajs/core'
import { KoraSyncServer, MemoryServerStore } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { createKoraAuthServer } from '../../src/provider/built-in/quickstart-server'
import { InMemoryUserStore } from '../../src/provider/built-in/user-store'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), userId: t.string() }, scope: ['userId'] } },
})

const SECRET = 's'.repeat(64)

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
})
