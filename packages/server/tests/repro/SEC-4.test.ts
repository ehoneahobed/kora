/**
 * SEC-4 repro: the handshake response returns the full server version vector, leaking
 * every node id (and its write count) across tenants. Asserts CORRECT behavior.
 */
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createServerTransportPair } from '../../src/transport/memory-server-transport'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), userId: t.string() } } },
})

describe('SEC-4: handshake leaks server version vector', () => {
	test("scoped tenant's handshake-response does not reveal other tenants' node ids", async () => {
		const store = new MemoryServerStore('server-1')
		await store.setSchema(schema)
		await store.applyRemoteOperation({
			id: 'bob-op',
			nodeId: 'bob-device-node-id',
			type: 'insert',
			collection: 'todos',
			recordId: 'bob-rec',
			data: { title: 'x', userId: 'bob' },
			previousData: null,
			timestamp: { wallTime: Date.now(), logical: 0, nodeId: 'bob-device-node-id' },
			sequenceNumber: 42,
			causalDeps: [],
			schemaVersion: 1,
		})
		const auth = new TokenAuthProvider({
			validate: async (tok) =>
				tok === 'alice' ? { userId: 'alice', scopes: { todos: { userId: 'alice' } } } : null,
		})
		const server = new KoraSyncServer({ store, auth })
		const { client, server: transport } = createServerTransportPair()
		const messages: SyncMessage[] = []
		client.onMessage((m) => messages.push(m))
		server.handleConnection(transport)
		client.send({
			type: 'handshake',
			messageId: 'hs',
			nodeId: 'alice-node',
			versionVector: {},
			schemaVersion: 1,
			authToken: 'alice',
		})
		await vi.waitFor(() =>
			expect(messages.some((m) => m.type === 'handshake-response')).toBe(true),
		)
		const resp = messages.find((m) => m.type === 'handshake-response')
		if (resp?.type !== 'handshake-response') throw new Error('no response')
		expect(Object.keys(resp.versionVector)).not.toContain('bob-device-node-id')
	})
})
