/**
 * SEC-5 repro: Yjs doc relay, awareness relay and blob relay are wired at connection
 * time and never check authentication or scope. Asserts CORRECT behavior (fails today).
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
	collections: { notes: { fields: { body: t.richtext(), userId: t.string() } } },
})

async function setup(extra: { persistBlobChunk?: (h: string, b: Uint8Array) => void } = {}) {
	const store = new MemoryServerStore('server-1')
	await store.setSchema(schema)
	const auth = new TokenAuthProvider({
		validate: async (token) =>
			token === 'bob-token'
				? { userId: 'bob', scopes: { notes: { userId: 'bob' } } }
				: token === 'alice-token'
					? { userId: 'alice', scopes: { notes: { userId: 'alice' } } }
					: null,
	})
	const server = new KoraSyncServer({ store, auth, ...extra })
	function connect() {
		const { client, server: transport } = createServerTransportPair()
		const messages: SyncMessage[] = []
		client.onMessage((m) => messages.push(m))
		server.handleConnection(transport)
		return { client, messages }
	}
	async function login(token: string, nodeId: string) {
		const c = connect()
		c.client.send({
			type: 'handshake',
			messageId: `hs-${nodeId}`,
			nodeId,
			versionVector: {},
			schemaVersion: 1,
			authToken: token,
		})
		await vi.waitFor(() =>
			expect(c.messages.some((m) => m.type === 'handshake-response')).toBe(true),
		)
		return c
	}
	return { server, connect, login }
}

const tick = () => new Promise((r) => setTimeout(r, 50))

describe('SEC-5: side-channel relays bypass auth and scope', () => {
	test('unauthenticated connection cannot inject yjs-doc-update / awareness into an authenticated session', async () => {
		const { connect, login } = await setup()
		const bob = await login('bob-token', 'bob-node')
		// Bob publishes presence (registers with the awareness relay, as the real client does).
		bob.client.send({
			type: 'awareness-update',
			messageId: 'a0',
			clientId: 1,
			states: { '1': { user: { name: 'Bob', color: '#00f' } } as never },
		})
		await tick()
		const attacker = connect() // never handshakes
		attacker.client.send({
			type: 'yjs-doc-update',
			messageId: 'y1',
			collection: 'notes',
			recordId: 'bob-note',
			field: 'body',
			update: 'AAAA',
		})
		attacker.client.send({
			type: 'awareness-update',
			messageId: 'a1',
			clientId: 666,
			states: { '666': { user: { name: 'admin', color: '#f00' } } as never },
		})
		await tick()
		expect.soft(bob.messages.some((m) => m.type === 'yjs-doc-update')).toBe(false)
		expect(bob.messages.some((m) => m.type === 'awareness-update')).toBe(false)
	})

	test("unauthenticated listener and other-tenant session do not receive bob's yjs-doc-update", async () => {
		const { connect, login } = await setup()
		const eavesdropper = connect() // never handshakes
		const alice = await login('alice-token', 'alice-node')
		const bob = await login('bob-token', 'bob-node')
		bob.client.send({
			type: 'yjs-doc-update',
			messageId: 'y2',
			collection: 'notes',
			recordId: 'bob-note',
			field: 'body',
			update: 'U0VDUkVU',
		})
		await tick()
		expect.soft(eavesdropper.messages.some((m) => m.type === 'yjs-doc-update')).toBe(false)
		expect(alice.messages.some((m) => m.type === 'yjs-doc-update')).toBe(false)
	})

	test('unauthenticated blob-chunk-request is not forwarded to peers or tracked', async () => {
		const { server, connect, login } = await setup()
		const bob = await login('bob-token', 'bob-node')
		const attacker = connect()
		for (let i = 0; i < 1000; i++) {
			attacker.client.send({
				type: 'blob-chunk-request',
				messageId: `r${i}`,
				requestId: `req-${i}`,
				hash: 'a'.repeat(64),
			})
		}
		await tick()
		expect.soft(bob.messages.some((m) => m.type === 'blob-chunk-request')).toBe(false)
		const relay = (server as unknown as { blobChunkRelay: { getPendingCount(): number } })
			.blobChunkRelay
		expect(relay.getPendingCount()).toBe(0)
	})

	test('unauthenticated blob-chunk-push is not persisted', async () => {
		const persisted: string[] = []
		const { connect } = await setup({ persistBlobChunk: (h) => void persisted.push(h) })
		const attacker = connect()
		const bytes = new TextEncoder().encode('junk payload')
		const digest = await crypto.subtle.digest('SHA-256', bytes)
		const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
		attacker.client.send({
			type: 'blob-chunk-push',
			messageId: 'p1',
			hash,
			bytes: Buffer.from(bytes).toString('base64'),
		})
		await tick()
		expect(persisted).toHaveLength(0)
	})
})
