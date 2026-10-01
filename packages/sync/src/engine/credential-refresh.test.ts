import type { VersionVector } from '@korajs/core'
import { describe, expect, test, vi } from 'vitest'
import type { HandshakeMessage, SyncMessage } from '../protocol/messages'
import { type MemoryTransport, createMemoryTransportPair } from '../transport/memory-transport'
import type { SyncAuthRequest } from '../types'
import { SyncEngine } from './sync-engine'
import type { SyncStore } from './sync-store'

function createStore(): SyncStore {
	const versionVector: VersionVector = new Map()
	return {
		getVersionVector: () => versionVector,
		getNodeId: () => 'test-node',
		applyRemoteOperation: vi.fn(async () => 'applied' as const),
		getOperationRange: vi.fn(async () => []),
	}
}

/** Accepts every handshake and records the tokens it was offered. */
function acceptingServer(server: MemoryTransport, tokens: Array<string | undefined>): void {
	server.onMessage((msg) => {
		if (msg.type !== 'handshake') return
		const handshake = msg as HandshakeMessage
		tokens.push(handshake.authToken)
		server.send({
			type: 'handshake-response',
			messageId: `resp-${handshake.messageId}`,
			nodeId: 'server-node',
			versionVector: {},
			schemaVersion: handshake.schemaVersion,
			accepted: true,
		})
		server.send({
			type: 'operation-batch',
			messageId: `delta-${handshake.messageId}`,
			operations: [],
			isFinal: true,
			batchIndex: 0,
		})
	})
}

function serverError(code: string, retriable: boolean): SyncMessage {
	return { type: 'error', messageId: `err-${code}`, code, message: code, retriable }
}

describe('SyncEngine after the server ends a session (AUTH-11)', () => {
	for (const code of ['AUTH_EXPIRED', 'AUTH_REVOKED'] as const) {
		test(`${code} is not fatal: the next connect forces a token refresh`, async () => {
			const { client, server } = createMemoryTransportPair()
			const tokens: Array<string | undefined> = []
			acceptingServer(server, tokens)
			const requests: Array<SyncAuthRequest | undefined> = []
			let issued = 0
			const auth = vi.fn(async (request?: SyncAuthRequest) => {
				requests.push(request)
				issued++
				return { token: `token-${issued}` }
			})
			const engine = new SyncEngine({
				transport: client,
				store: createStore(),
				config: { url: 'ws://test', auth },
			})

			await engine.start()
			await vi.waitFor(() => expect(engine.getState()).toBe('streaming'))
			expect(requests).toEqual([undefined])

			server.send(serverError(code, true))
			await vi.waitFor(() => expect(engine.getState()).toBe('disconnected'))
			// Not an auth rejection: sync is not suspended and nobody is signed out.
			expect(engine.getStatus().status).not.toBe('auth-required')

			await engine.start()
			await vi.waitFor(() => expect(engine.getState()).toBe('streaming'))
			expect(requests).toEqual([undefined, { forceRefresh: true }])
			expect(tokens).toEqual(['token-1', 'token-2'])

			// An accepted handshake clears the flag: later reconnects use the cache.
			await engine.stop()
			await engine.start()
			await vi.waitFor(() => expect(engine.getState()).toBe('streaming'))
			expect(requests[2]).toBeUndefined()
			await engine.stop()
		})
	}

	test('records the refresh even when the server closes right after the error', async () => {
		const { client, server } = createMemoryTransportPair()
		const tokens: Array<string | undefined> = []
		acceptingServer(server, tokens)
		const requests: Array<SyncAuthRequest | undefined> = []
		const engine = new SyncEngine({
			transport: client,
			store: createStore(),
			config: {
				url: 'ws://test',
				auth: async (request) => {
					requests.push(request)
					return { token: `t-${requests.length}` }
				},
			},
		})
		await engine.start()
		await vi.waitFor(() => expect(engine.getState()).toBe('streaming'))

		server.send(serverError('AUTH_REVOKED', true))
		await server.disconnect()
		await vi.waitFor(() => expect(engine.getState()).toBe('disconnected'))

		await engine.start()
		await vi.waitFor(() => expect(engine.getState()).toBe('streaming'))
		expect(requests).toEqual([undefined, { forceRefresh: true }])
		await engine.stop()
	})

	test('does not handshake with an empty token while the refresh is pending', async () => {
		const { client, server } = createMemoryTransportPair()
		const tokens: Array<string | undefined> = []
		acceptingServer(server, tokens)
		let refreshed: string | null = null
		const engine = new SyncEngine({
			transport: client,
			store: createStore(),
			config: {
				url: 'ws://test',
				auth: async (request) => ({
					token: request?.forceRefresh ? (refreshed ?? '') : 'cached',
				}),
			},
		})
		await engine.start()
		await vi.waitFor(() => expect(engine.getState()).toBe('streaming'))
		server.send(serverError('AUTH_EXPIRED', true))
		await vi.waitFor(() => expect(engine.getState()).toBe('disconnected'))

		// Auth server unreachable: the attempt fails (so reconnection retries) and
		// no handshake is sent with an empty or stale token.
		await expect(engine.start()).rejects.toMatchObject({
			context: expect.objectContaining({ code: 'AUTH_REFRESH_PENDING' }),
		})
		expect(engine.getState()).toBe('disconnected')
		expect(tokens).toEqual(['cached'])

		refreshed = 'fresh'
		await engine.start()
		await vi.waitFor(() => expect(engine.getState()).toBe('streaming'))
		expect(tokens).toEqual(['cached', 'fresh'])
		await engine.stop()
	})

	test('AUTH_FAILED stays a permanent auth rejection', async () => {
		const { client, server } = createMemoryTransportPair()
		acceptingServer(server, [])
		const auth = vi.fn(async () => ({ token: 't' }))
		const engine = new SyncEngine({
			transport: client,
			store: createStore(),
			config: { url: 'ws://test', auth },
		})
		await engine.start()
		await vi.waitFor(() => expect(engine.getState()).toBe('streaming'))
		server.send(serverError('AUTH_FAILED', false))
		await vi.waitFor(() => expect(engine.getState()).toBe('disconnected'))
		await engine.start()
		expect(auth).toHaveBeenCalledTimes(1)
	})
})
