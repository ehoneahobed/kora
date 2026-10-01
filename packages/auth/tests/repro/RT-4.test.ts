/**
 * RT-4 confirmation (red team, 2026-10-01; fixed by AUTH-11): live sync sessions
 * survived revocation and expiry, and `bindSyncServer` called a non-existent
 * `terminateSessions`. Covers the two paths the AUTH-11 repro does not: a wrapped
 * provider (no `onRevoke`) bound with `bindSyncServer`, and credential expiry.
 */
import { defineSchema, t } from '@korajs/core'
import { KoraSyncServer, MemoryServerStore } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncMessage } from '@korajs/sync'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createKoraAuthServer } from '../../src/provider/built-in/quickstart-server'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), userId: t.string() }, scope: ['userId'] } },
})

async function signIn(auth: ReturnType<typeof createKoraAuthServer>) {
	const res = (
		await auth.handleRequest({
			method: 'POST',
			path: '/auth/signup',
			body: { email: 'u@example.com', password: 'password-123', deviceId: 'laptop' },
		})
	).body as { data: { user: { id: string }; tokens: { accessToken: string } } }
	return { uid: res.data.user.id, token: res.data.tokens.accessToken }
}

async function open(server: KoraSyncServer, token: string, uid: string) {
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
		syncScope: { todos: { userId: uid } },
	} as SyncMessage)
	await vi.waitFor(() =>
		expect(messages.some((m) => m.type === 'handshake-response' && m.accepted)).toBe(true),
	)
	return messages
}

function errorCodes(messages: SyncMessage[]): string[] {
	return messages.flatMap((m) => (m.type === 'error' ? [m.code] : []))
}

afterEach(() => {
	vi.useRealTimers()
})

describe('RT-4: live sessions end on revocation and expiry', () => {
	test('bindSyncServer ends the session of a revoked device behind a wrapped provider', async () => {
		const auth = createKoraAuthServer({ jwtSecret: 'r'.repeat(64) })
		const { uid, token } = await signIn(auth)
		const store = new MemoryServerStore('server-1')
		await store.setSchema(schema)
		// A wrapper without onRevoke: only bindSyncServer can reach the server.
		const server = new KoraSyncServer({
			store,
			auth: { authenticate: (tok) => auth.auth.authenticate(tok) },
		})
		auth.bindSyncServer(server)
		const messages = await open(server, token, uid)
		const res = await auth.handleRequest({
			method: 'DELETE',
			path: '/auth/device/laptop',
			headers: { authorization: `Bearer ${token}` },
		})
		expect(res.status).toBe(200)
		await vi.waitFor(() => expect(errorCodes(messages)).toContain('AUTH_REVOKED'))
		expect(server.getConnectionCount()).toBe(0)
		await server.stop()
	})

	test('a session ends when its access token expires', async () => {
		vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
		const auth = createKoraAuthServer({ jwtSecret: 'e'.repeat(64) })
		const { uid, token } = await signIn(auth)
		const store = new MemoryServerStore('server-1')
		await store.setSchema(schema)
		const server = new KoraSyncServer({ store, auth: auth.auth, relayRetransmitIntervalMs: 0 })
		const messages = await open(server, token, uid)
		await vi.advanceTimersByTimeAsync(16 * 60_000)
		expect(errorCodes(messages)).toContain('AUTH_EXPIRED')
		expect(server.getConnectionCount()).toBe(0)
		await server.stop()
	})
})
