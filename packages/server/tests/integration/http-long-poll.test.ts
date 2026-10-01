/**
 * The real HttpLongPollingTransport (client) against KoraSyncServer.handleHttpRequest
 * (server), joined by a fetch shim: the server-issued session id and the per-request
 * bearer credential work end to end (RT-2).
 */
import { defineSchema, t } from '@korajs/core'
import { HttpLongPollingTransport, JsonMessageSerializer, type SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string(), userId: t.string() } } },
})

function fetchShim(server: KoraSyncServer, log: Array<{ method: string; status: number }>) {
	return (async (_url: RequestInfo | URL, init?: RequestInit) => {
		const headers = new Headers(init?.headers)
		const method = (init?.method ?? 'GET') as 'GET' | 'POST'
		const response = await server.handleHttpRequest({
			method,
			...(headers.get('authorization')
				? { authorization: headers.get('authorization') as string }
				: {}),
			...(headers.get('x-kora-session')
				? { sessionId: headers.get('x-kora-session') as string }
				: {}),
			...(headers.get('content-type')
				? { contentType: headers.get('content-type') as string }
				: {}),
			...(typeof init?.body === 'string' ? { body: init.body } : {}),
		})
		log.push({ method, status: response.status })
		return new Response(
			response.status === 204 || response.status === 304
				? null
				: ((response.body as string) ?? null),
			{ status: response.status, headers: response.headers },
		)
	}) as typeof fetch
}

describe('HTTP long-poll end to end', () => {
	test('handshake, server-issued session and authenticated polling', async () => {
		const store = new MemoryServerStore('server-1')
		await store.setSchema(schema)
		const server = new KoraSyncServer({
			store,
			serializer: new JsonMessageSerializer(),
			auth: new TokenAuthProvider({
				validate: async (token) =>
					token === 'alice-token'
						? { userId: 'alice', scopes: { notes: { userId: 'alice' } } }
						: null,
			}),
			relayRetransmitIntervalMs: 0,
			deliveryPollIntervalMs: 0,
		})
		const log: Array<{ method: string; status: number }> = []
		const transport = new HttpLongPollingTransport({
			fetchImpl: fetchShim(server, log),
			retryDelayMs: 5,
			preferWebSocket: false,
			serializer: new JsonMessageSerializer(),
		})
		const received: SyncMessage[] = []
		transport.onMessage((m) => received.push(m))
		await transport.connect('http://localhost/kora-sync', { authToken: 'alice-token' })
		transport.send({
			type: 'handshake',
			messageId: 'hs',
			nodeId: 'alice-node',
			versionVector: {},
			schemaVersion: 1,
			authToken: 'alice-token',
		})
		await vi.waitFor(() =>
			expect(received.some((m) => m.type === 'handshake-response' && m.accepted)).toBe(true),
		)
		await transport.disconnect()
		await server.stop()
		expect(log.every((entry) => entry.status !== 401 && entry.status !== 403)).toBe(true)
		expect(log.some((entry) => entry.method === 'GET' && entry.status === 200)).toBe(true)
	})
})
