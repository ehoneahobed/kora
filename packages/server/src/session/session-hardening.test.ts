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

	test('own ops the server already stores are acked as duplicates before any other check (RT-31)', async () => {
		const { login, store } = await setup()
		const c = await login('bob', 'bob-node')
		// Stored earlier, inside Bob's scope at the time.
		const first = op('bob-node', { data: { title: 't', userId: 'bob' } })
		const second = op('bob-node', { data: { title: 't', userId: 'bob' } })
		await store.applyRemoteOperation(first)
		await store.applyRemoteOperation(second)
		const lookup = vi.spyOn(store, 'findStoredOperations')
		// The device re-uploads: `first` unchanged, `second` renumbered by the client's
		// sequence repair (same id, new sequence), plus a write that would be refused
		// today (out of Bob's scope) but is already stored.
		const outOfScope = op('bob-node', { data: { title: 't', userId: 'alice' } })
		await store.applyRemoteOperation(outOfScope)
		const renumbered = { ...second, sequenceNumber: outOfScope.sequenceNumber + 5 }
		c.client.send(batch([first, outOfScope, renumbered], 'reupload'))
		await vi.waitFor(() => expect(c.messages.some((m) => m.type === 'acknowledgment')).toBe(true))
		expect(c.messages.some((m) => m.type === 'operation-rejected')).toBe(false)
		const ack = c.messages.find((m) => m.type === 'acknowledgment')
		expect(ack?.type === 'acknowledgment' ? ack.lastSequenceNumber : null).toBe(
			renumbered.sequenceNumber,
		)
		expect(lookup).toHaveBeenCalledTimes(1)
		expect(await store.getOperationCount()).toBe(3)
	})

	test('a stored id claimed under this node by an op of another node is not a duplicate', async () => {
		const { login, store } = await setup()
		const foreign = op('other-device')
		await store.applyRemoteOperation(foreign)
		const c = await login('bob', 'bob-node')
		c.client.send(
			batch(
				[
					{
						...foreign,
						nodeId: 'bob-node',
						timestamp: { ...foreign.timestamp, nodeId: 'bob-node' },
					},
				],
				'stolen-id',
			),
		)
		await vi.waitFor(() => expect(c.messages.some((m) => m.type === 'acknowledgment')).toBe(true))
		// Judged like any new op (the store then dedups the id): never acked unexamined.
		expect(await store.getOperationCount()).toBe(1)
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

	test('releaseNodeClaim ends live sessions on the node and hands it to the next claimant (RT-5)', async () => {
		const { login, server } = await setup()
		const bob = await login('bob', 'lost-device')
		expect(await server.releaseNodeClaim('lost-device')).toBe(true)
		await tick()
		const error = bob.messages.find((m) => m.type === 'error')
		expect(error?.type === 'error' ? [error.code, error.retriable] : null).toEqual([
			'NODE_RELEASED',
			true,
		])
		const alice = await login('alice', 'lost-device')
		expect(alice.messages.some((m) => m.type === 'handshake-response')).toBe(true)
		expect(await server.releaseNodeClaim('never-seen')).toBe(false)
	})
})

describe('Blob relay stays inside the tenant (RT-1)', () => {
	test('a request for an unreferenced hash reaches same-scope devices only', async () => {
		const { login } = await setup()
		const alice1 = await login('alice-1', 'alice-1')
		const alice2 = await login('alice-2', 'alice-2')
		const bob = await login('bob', 'bob-node')
		alice1.client.send({
			type: 'blob-chunk-request',
			messageId: 'r',
			requestId: 'oob',
			hash: 'e'.repeat(64),
		})
		await tick()
		expect(alice2.messages.some((m) => m.type === 'blob-chunk-request')).toBe(true)
		expect(bob.messages.some((m) => m.type === 'blob-chunk-request')).toBe(false)
	})

	test('a requester with nobody to ask is told "not held" at once', async () => {
		const { login } = await setup()
		const bob = await login('bob', 'bob-node')
		await login('alice', 'alice-node')
		bob.client.send({
			type: 'blob-chunk-request',
			messageId: 'r',
			requestId: 'lonely',
			hash: 'f'.repeat(64),
		})
		await tick()
		const answer = bob.messages.find((m) => m.type === 'blob-chunk-response')
		expect(answer?.type === 'blob-chunk-response' ? answer.bytes : 'missing').toBeNull()
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

describe('ingest limits are charged before store work (RT-6)', () => {
	const errorCodes = (messages: SyncMessage[]) =>
		messages.flatMap((m) => (m.type === 'error' ? [m.code] : []))

	test('out-of-scope ops count against the rate limit and stop store reads', async () => {
		const { login, store } = await setup({ maxOpsPerMinute: 3 })
		const alice = await login('alice', 'alice-node')
		const reads = vi.spyOn(store, 'queryCollection')
		const ops = Array.from({ length: 10 }, () =>
			op('alice-node', { data: { title: 't', userId: 'bob' } }),
		)
		alice.client.send(batch(ops))
		await tick()
		expect(alice.messages.filter((m) => m.type === 'operation-rejected')).toHaveLength(3)
		expect(errorCodes(alice.messages)).toEqual(['RATE_LIMIT'])
		expect(reads.mock.calls.length).toBeLessThanOrEqual(3)
	})

	test('foreign-node ops are charged before the duplicate lookup', async () => {
		const { login, store } = await setup({ maxOpsPerMinute: 2 })
		const alice = await login('alice', 'alice-node')
		const lookups = vi.spyOn(store, 'getOperationRange')
		alice.client.send(batch(Array.from({ length: 6 }, () => op('someone-else'))))
		await tick()
		expect(lookups.mock.calls.length).toBeLessThanOrEqual(2)
		expect(errorCodes(alice.messages)).toEqual(['RATE_LIMIT'])
	})

	test('a batch over maxOpsPerBatch is refused whole, unacknowledged, without store reads', async () => {
		const { login, store, server } = await setup({ maxOpsPerBatch: 5 })
		const alice = await login('alice', 'alice-node')
		const reads = vi.spyOn(store, 'queryCollection')
		alice.client.send(
			batch(
				Array.from({ length: 6 }, () =>
					op('alice-node', { data: { title: 't', userId: 'alice' } }),
				),
			),
		)
		await tick()
		expect(errorCodes(alice.messages)).toEqual(['BATCH_TOO_LARGE'])
		expect(alice.messages.some((m) => m.type === 'acknowledgment')).toBe(false)
		expect(reads).not.toHaveBeenCalled()
		const session = (
			server as unknown as { sessions: Map<string, { getIngestLimitCounts(): unknown }> }
		).sessions
		expect([...session.values()][0]?.getIngestLimitCounts()).toEqual({
			rateLimitedOperations: 0,
			rejectedBatches: 1,
			rateLimitedBlobRequests: 0,
		})
	})

	test('a batch at the cap is processed', async () => {
		const { login, store } = await setup({ maxOpsPerBatch: 2 })
		const alice = await login('alice', 'alice-node')
		const a = op('alice-node', { data: { title: 'a', userId: 'alice' } })
		const b = op('alice-node', { data: { title: 'b', userId: 'alice' } })
		alice.client.send(batch([a, b]))
		await tick()
		expect(await store.findRecord('notes', b.recordId)).not.toBeNull()
	})

	test('maxOpsPerBatch must be a positive integer', () => {
		expect(
			() => new KoraSyncServer({ store: new MemoryServerStore('s'), maxOpsPerBatch: 0 }),
		).toThrow(/maxOpsPerBatch/)
	})
})

describe('handshake vector reveals only own and delivered nodes (RT-7)', () => {
	test('a node id the client names is not echoed unless its ops are delivered', async () => {
		const { login, connect } = await setup()
		const bob = await login('bob', 'bob-node')
		bob.client.send(
			batch([op('bob-node', { sequenceNumber: 1, data: { title: 'b', userId: 'bob' } })]),
		)
		await tick()
		const probe = connect()
		probe.client.send({
			type: 'handshake',
			messageId: 'hs-probe',
			nodeId: 'alice-node',
			versionVector: { 'bob-node': 0, 'alice-node': 0 },
			schemaVersion: 1,
			authToken: 'alice',
		})
		await vi.waitFor(() =>
			expect(probe.messages.some((m) => m.type === 'handshake-response')).toBe(true),
		)
		const response = probe.messages.find((m) => m.type === 'handshake-response')
		const vector = response?.type === 'handshake-response' ? response.versionVector : {}
		expect(vector).not.toHaveProperty('bob-node')
	})

	test("the client's own entry and delivered nodes are present", async () => {
		const { login } = await setup()
		const a1 = await login('alice', 'alice-a')
		a1.client.send(
			batch([op('alice-a', { sequenceNumber: 1, data: { title: 'x', userId: 'alice' } })]),
		)
		await tick()
		const a2 = await login('alice-b', 'alice-b')
		const response = a2.messages.find((m) => m.type === 'handshake-response')
		const vector = response?.type === 'handshake-response' ? response.versionVector : {}
		expect(vector).toHaveProperty('alice-a', 1)
	})
})

describe('per-field versions are server-authored only (RT-27)', () => {
	test('a device-sent fieldVersions is dropped before the operation is stored or relayed', async () => {
		const { login, store } = await setup()
		const c = await login('bob-1', 'n-fv')
		const forged = op('n-fv', {
			sequenceNumber: 1,
			fieldVersions: { title: { wallTime: 9_999_999_999_999, logical: 0, nodeId: 'n-fv' } },
		})
		c.client.send(batch([forged]))
		await vi.waitFor(async () =>
			expect(await store.getOperationRange('n-fv', 1, 1)).toHaveLength(1),
		)
		const [stored] = await store.getOperationRange('n-fv', 1, 1)
		expect(stored?.fieldVersions).toBeUndefined()
		expect(stored?.id).toBe(forged.id)
	})
})
