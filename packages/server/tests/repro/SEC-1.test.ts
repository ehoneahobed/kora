/**
 * SEC-1 repro: an unauthenticated connection can upload operations by sending an
 * `operation-batch` before (or instead of) the handshake. Asserts the CORRECT
 * behavior (fails today).
 */
import type { Operation } from '@korajs/core'
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

function op(overrides: Partial<Operation>): Operation {
	return {
		id: 'evil-op-1',
		nodeId: 'attacker',
		type: 'insert',
		collection: 'todos',
		recordId: 'evil-rec',
		data: { title: 'pwned', userId: 'bob' },
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: 0, nodeId: 'attacker' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

async function setup() {
	const store = new MemoryServerStore('server-1')
	await store.setSchema(schema)
	const auth = new TokenAuthProvider({
		validate: async (token) =>
			token === 'bob-token'
				? { userId: 'bob', scopes: { todos: { userId: 'bob' } } }
				: token === 'alice-token'
					? { userId: 'alice', scopes: { todos: { userId: 'alice' } } }
					: null,
	})
	const server = new KoraSyncServer({ store, auth })
	return { store, server }
}

function connect(server: KoraSyncServer) {
	const { client, server: transport } = createServerTransportPair()
	const messages: SyncMessage[] = []
	client.onMessage((m) => messages.push(m))
	server.handleConnection(transport)
	return { client, messages }
}

describe('SEC-1: operation-batch before handshake', () => {
	test('server must not apply an operation-batch from a session that never authenticated', async () => {
		const { store, server } = await setup()

		// Victim bob is connected and streaming.
		const bob = connect(server)
		bob.client.send({
			type: 'handshake',
			messageId: 'hs-bob',
			nodeId: 'bob-node',
			versionVector: {},
			schemaVersion: 1,
			authToken: 'bob-token',
		})
		await vi.waitFor(() => expect(bob.messages.some((m) => m.type === 'handshake-response')).toBe(true))

		// Attacker: no token, no handshake, just upload.
		const attacker = connect(server)
		attacker.client.send({
			type: 'operation-batch',
			messageId: 'b-1',
			operations: [op({})],
			isFinal: true,
			batchIndex: 0,
		})
		await new Promise((r) => setTimeout(r, 100))

		// Correct behavior: nothing persisted, nothing relayed to bob.
		expect.soft(await store.getOperationCount()).toBe(0)
		const relayedToBob = bob.messages
			.filter((m) => m.type === 'operation-batch')
			.flatMap((m) => (m.type === 'operation-batch' ? m.operations : []))
		expect.soft(relayedToBob).toHaveLength(0)
		// And the attacker must not receive an acknowledgment.
		expect(attacker.messages.some((m) => m.type === 'acknowledgment')).toBe(false)
	})
})
