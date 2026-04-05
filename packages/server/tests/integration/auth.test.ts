import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createServerTransportPair } from '../../src/transport/memory-server-transport'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import type { AuthContext } from '../../src/types'

function collectMessages(client: ReturnType<typeof createServerTransportPair>['client']): SyncMessage[] {
	const messages: SyncMessage[] = []
	client.onMessage((msg) => messages.push(msg))
	return messages
}

describe('Authentication', () => {
	test('valid token accepted, client syncs normally', async () => {
		const store = new MemoryServerStore('server-1')
		const auth = new TokenAuthProvider({
			validate: async (token) =>
				token === 'valid' ? { userId: 'user-1' } : null,
		})
		const server = new KoraSyncServer({ store, auth })

		const { client, server: transport } = createServerTransportPair()
		const messages = collectMessages(client)
		server.handleConnection(transport)

		client.send({
			type: 'handshake',
			messageId: 'hs-1',
			nodeId: 'client-1',
			versionVector: {},
			schemaVersion: 1,
			authToken: 'valid',
		})

		await vi.waitFor(() => {
			const response = messages.find((m) => m.type === 'handshake-response')
			expect(response).toBeDefined()
			if (response?.type === 'handshake-response') {
				expect(response.accepted).toBe(true)
			}
		})
	})

	test('invalid token rejected with ErrorMessage and connection closed', async () => {
		const store = new MemoryServerStore('server-1')
		const auth = new TokenAuthProvider({
			validate: async () => null,
		})
		const server = new KoraSyncServer({ store, auth })

		const { client, server: transport } = createServerTransportPair()
		const messages = collectMessages(client)
		server.handleConnection(transport)

		client.send({
			type: 'handshake',
			messageId: 'hs-1',
			nodeId: 'client-1',
			versionVector: {},
			schemaVersion: 1,
			authToken: 'bad-token',
		})

		await vi.waitFor(() => {
			const error = messages.find((m) => m.type === 'error')
			expect(error).toBeDefined()
			if (error?.type === 'error') {
				expect(error.code).toBe('AUTH_FAILED')
			}
		})

		// No handshake-response should be sent
		const response = messages.find((m) => m.type === 'handshake-response')
		expect(response).toBeUndefined()

		// Session should be cleaned up
		expect(server.getConnectionCount()).toBe(0)
	})

	test('no auth provider: all connections accepted', async () => {
		const store = new MemoryServerStore('server-1')
		const server = new KoraSyncServer({ store }) // No auth

		const { client, server: transport } = createServerTransportPair()
		const messages = collectMessages(client)
		server.handleConnection(transport)

		client.send({
			type: 'handshake',
			messageId: 'hs-1',
			nodeId: 'client-1',
			versionVector: {},
			schemaVersion: 1,
			// No authToken
		})

		await vi.waitFor(() => {
			const response = messages.find((m) => m.type === 'handshake-response')
			expect(response).toBeDefined()
			if (response?.type === 'handshake-response') {
				expect(response.accepted).toBe(true)
			}
		})
	})

	test('missing token with auth provider: rejection', async () => {
		const store = new MemoryServerStore('server-1')
		const auth = new TokenAuthProvider({
			validate: async (token) => (token ? { userId: 'user-1' } : null),
		})
		const server = new KoraSyncServer({ store, auth })

		const { client, server: transport } = createServerTransportPair()
		const messages = collectMessages(client)
		server.handleConnection(transport)

		// Handshake without authToken
		client.send({
			type: 'handshake',
			messageId: 'hs-1',
			nodeId: 'client-1',
			versionVector: {},
			schemaVersion: 1,
			// No authToken — will pass empty string
		})

		await vi.waitFor(() => {
			const error = messages.find((m) => m.type === 'error')
			expect(error).toBeDefined()
			if (error?.type === 'error') {
				expect(error.code).toBe('AUTH_FAILED')
			}
		})
	})
})
