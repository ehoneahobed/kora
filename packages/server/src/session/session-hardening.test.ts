import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../auth/token-auth'
import { KoraSyncServer } from '../server/kora-sync-server'
import { MemoryServerStore } from '../store/memory-server-store'
import { createServerTransportPair } from '../transport/memory-server-transport'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { body: t.richtext(), title: t.string(), userId: t.string() } } },
})

let seq = 0
function op(nodeId: string, overrides: Partial<Operation> = {}): Operation {
	seq += 1
	return {
		id: `op-${seq}`,
		nodeId,
		type: 'insert',
		collection: 'notes',
		recordId: `rec-${seq}`,
		data: { title: 't', userId: 'bob' },
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: 0, nodeId },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

async function setup(
	extra: Partial<ConstructorParameters<typeof KoraSyncServer>[0]> = {},
): Promise<{
	store: MemoryServerStore
	server: KoraSyncServer
	connect: () => {
		client: ReturnType<typeof createServerTransportPair>['client']
		messages: SyncMessage[]
	}
	login: (
		token: string,
		nodeId: string,
	) => Promise<{
		client: ReturnType<typeof createServerTransportPair>['client']
		messages: SyncMessage[]
	}>
}> {
	const store = new MemoryServerStore('server-1')
	await store.setSchema(schema)
	const auth = new TokenAuthProvider({
		validate: async (token) =>
			token.startsWith('bob')
				? { userId: 'bob', scopes: { notes: { userId: 'bob' } } }
				: token.startsWith('alice')
					? { userId: 'alice', scopes: { notes: { userId: 'alice' } } }
					: null,
	})
	const server = new KoraSyncServer({ store, auth, ...extra })
	const connect = () => {
		const { client, server: transport } = createServerTransportPair()
		const messages: SyncMessage[] = []
		client.onMessage((m) => messages.push(m))
		server.handleConnection(transport)
		return { client, messages }
	}
	const login = async (token: string, nodeId: string) => {
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
			expect(c.messages.some((m) => m.type === 'handshake-response' || m.type === 'error')).toBe(
				true,
			),
		)
		return c
	}
	return { store, server, connect, login }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

function batch(ops: Operation[], messageId = `b-${seq}`): SyncMessage {
	return { type: 'operation-batch', messageId, operations: ops, isFinal: true, batchIndex: 0 }
}

describe('ClientSession handshake gate (SEC-1)', () => {
	test('a message before the handshake is refused with HANDSHAKE_REQUIRED and the session closes', async () => {
		const { connect, server } = await setup()
		const c = connect()
		c.client.send({
			type: 'acknowledgment',
			messageId: 'a',
			acknowledgedMessageId: 'x',
			lastSequenceNumber: 0,
		})
		await tick()
		const error = c.messages.find((m) => m.type === 'error')
		expect(error?.type === 'error' ? error.code : null).toBe('HANDSHAKE_REQUIRED')
		expect(error?.type === 'error' ? error.retriable : null).toBe(false)
		expect(server.getConnectionCount()).toBe(0)
	})

	test('a failed authentication does not open the session to later messages', async () => {
		const { login, store } = await setup()
		const c = await login('nobody', 'n-1')
		try {
			c.client.send(batch([op('n-1')]))
		} catch {
			// The server already closed the connection; either way nothing may be applied.
		}
		await tick()
		expect(await store.getOperationCount()).toBe(0)
		expect(c.messages.some((m) => m.type === 'acknowledgment')).toBe(false)
	})
})

describe('ClientSession node binding (SEC-3, server half)', () => {
	test('an op claiming another nodeId is rejected with NODE_ID_MISMATCH and not stored', async () => {
		const { login, store } = await setup()
		const c = await login('bob', 'bob-node')
		const forged = op('victim-node')
		c.client.send(batch([forged]))
		await vi.waitFor(() => expect(c.messages.some((m) => m.type === 'acknowledgment')).toBe(true))
		const rejected = c.messages.find((m) => m.type === 'operation-rejected')
		expect(rejected?.type === 'operation-rejected' ? rejected.code : null).toBe('NODE_ID_MISMATCH')
		expect(rejected?.type === 'operation-rejected' ? rejected.retriable : null).toBe(false)
		expect(await store.getOperationCount()).toBe(0)
		expect(store.getVersionVector().has('victim-node')).toBe(false)
	})

	test('echoing back another device op the server already stores is a harmless duplicate', async () => {
		const { login, store } = await setup()
		const stored = op('other-device')
		await store.applyRemoteOperation(stored)
		const c = await login('bob', 'bob-node')
		c.client.send(batch([stored], 'echo'))
		await vi.waitFor(() => expect(c.messages.some((m) => m.type === 'acknowledgment')).toBe(true))
		expect(c.messages.some((m) => m.type === 'operation-rejected')).toBe(false)
		expect(await store.getOperationCount()).toBe(1)
	})

	test('a forged op reusing a stored id under another sequence is still rejected', async () => {
		const { login, store } = await setup()
		const stored = op('other-device')
		await store.applyRemoteOperation(stored)
		const c = await login('bob', 'bob-node')
		c.client.send(batch([{ ...stored, sequenceNumber: 1_000_000 }], 'forged-echo'))
		await vi.waitFor(() =>
			expect(c.messages.some((m) => m.type === 'operation-rejected')).toBe(true),
		)
		expect(store.getVersionVector().get('other-device')).toBe(stored.sequenceNumber)
	})

	test('an op whose timestamp names another node is rejected', async () => {
		const { login, store } = await setup()
		const c = await login('bob', 'bob-node')
		const forged = op('bob-node', { timestamp: { wallTime: Date.now(), logical: 0, nodeId: 'x' } })
		c.client.send(batch([forged]))
		await vi.waitFor(() =>
			expect(c.messages.some((m) => m.type === 'operation-rejected')).toBe(true),
		)
		expect(await store.getOperationCount()).toBe(0)
	})

	test('a rejected foreign op does not advance the ack past the client own ops', async () => {
		const { login } = await setup()
		const c = await login('bob', 'bob-node')
		const own = op('bob-node')
		const foreign = op('victim-node', { sequenceNumber: 1_000_000 })
		c.client.send(batch([own, foreign], 'mixed'))
		await vi.waitFor(() => expect(c.messages.some((m) => m.type === 'acknowledgment')).toBe(true))
		const ack = c.messages.find((m) => m.type === 'acknowledgment')
		expect(ack?.type === 'acknowledgment' ? ack.lastSequenceNumber : null).toBe(own.sequenceNumber)
	})

	test('a node id claimed by one user cannot be used by another (NODE_ID_CLAIMED)', async () => {
		const { login } = await setup()
		await login('bob', 'shared-device')
		const mallory = await login('alice', 'shared-device')
		const error = mallory.messages.find((m) => m.type === 'error')
		expect(error?.type === 'error' ? error.code : null).toBe('NODE_ID_CLAIMED')
		expect(mallory.messages.some((m) => m.type === 'handshake-response')).toBe(false)
	})

	test('the same user may reconnect with its own node id', async () => {
		const { login } = await setup()
		await login('bob-1', 'bob-device')
		const again = await login('bob-2', 'bob-device')
		expect(again.messages.some((m) => m.type === 'handshake-response')).toBe(true)
	})
})

describe('Side channels after the handshake (SEC-5)', () => {
	async function seedNote(store: MemoryServerStore, recordId: string, userId: string) {
		await store.applyRemoteOperation(
			op('seed', { recordId, data: { title: 'n', userId }, sequenceNumber: ++seq }),
		)
	}

	test("a yjs update reaches the writer's other devices but not another tenant", async () => {
		const { login, store } = await setup()
		await seedNote(store, 'bob-note', 'bob')
		const bobPhone = await login('bob', 'bob-phone')
		const bobLaptop = await login('bob', 'bob-laptop')
		const alice = await login('alice', 'alice-node')
		bobPhone.client.send({
			type: 'yjs-doc-update',
			messageId: 'y1',
			collection: 'notes',
			recordId: 'bob-note',
			field: 'body',
			update: 'AAAA',
		})
		await vi.waitFor(() =>
			expect(bobLaptop.messages.some((m) => m.type === 'yjs-doc-update')).toBe(true),
		)
		expect(alice.messages.some((m) => m.type === 'yjs-doc-update')).toBe(false)
	})

	test("a yjs update to another tenant's record is not relayed to anyone", async () => {
		const { login, store } = await setup()
		await seedNote(store, 'bob-note', 'bob')
		const bob = await login('bob', 'bob-node')
		const alice = await login('alice', 'alice-node')
		alice.client.send({
			type: 'yjs-doc-update',
			messageId: 'y2',
			collection: 'notes',
			recordId: 'bob-note',
			field: 'body',
			update: 'AAAA',
		})
		await tick()
		expect(bob.messages.some((m) => m.type === 'yjs-doc-update')).toBe(false)
	})

	test('presence is shared within a tenant and never across tenants', async () => {
		const { login } = await setup()
		const bob1 = await login('bob', 'bob-1')
		const bob2 = await login('bob', 'bob-2')
		const alice = await login('alice', 'alice-1')
		bob2.client.send({
			type: 'awareness-update',
			messageId: 'p0',
			clientId: 20,
			states: { '20': null },
		})
		alice.client.send({
			type: 'awareness-update',
			messageId: 'p-a',
			clientId: 30,
			states: { '30': null },
		})
		await tick()
		bob1.client.send({
			type: 'awareness-update',
			messageId: 'p1',
			clientId: 10,
			states: { '10': { user: { name: 'Bob', color: '#00f' } } as never },
		})
		await vi.waitFor(() =>
			expect(bob2.messages.some((m) => m.type === 'awareness-update')).toBe(true),
		)
		expect(alice.messages.some((m) => m.type === 'awareness-update')).toBe(false)
	})

	test('blob pushes are bounded per chunk and per session', async () => {
		const persisted: string[] = []
		const { login } = await setup({
			persistBlobChunk: (hash) => void persisted.push(hash),
			blobLimits: { maxChunkBytes: 8, maxBytesPerSession: 12 },
		})
		const bob = await login('bob', 'bob-node')
		const push = async (text: string) => {
			const bytes = new TextEncoder().encode(text)
			const digest = await crypto.subtle.digest('SHA-256', bytes)
			const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
			bob.client.send({
				type: 'blob-chunk-push',
				messageId: `p-${text}`,
				hash,
				bytes: Buffer.from(bytes).toString('base64'),
			})
			await tick()
		}
		await push('123456789') // 9 bytes > 8: too large
		await push('12345678') // 8 bytes: accepted
		await push('abcdefgh') // would make 16 > 12: over quota
		expect(persisted).toHaveLength(1)
		const codes = bob.messages.flatMap((m) => (m.type === 'error' ? [m.code] : []))
		expect(codes).toEqual(['BLOB_CHUNK_TOO_LARGE', 'BLOB_QUOTA_EXCEEDED'])
	})
})
