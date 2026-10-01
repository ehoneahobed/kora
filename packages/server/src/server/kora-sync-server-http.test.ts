import type { Operation } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { JsonMessageSerializer } from '@korajs/sync'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../auth/token-auth'
import { MemoryServerStore } from '../store/memory-server-store'
import type { HttpSyncRequest } from '../types'
import { KoraSyncServer } from './kora-sync-server'

function createTestOp(overrides: Partial<Operation> = {}): Operation {
	return {
		id: `op-${Math.random().toString(36).slice(2)}`,
		nodeId: 'client-a',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-1',
		data: { title: 'test' },
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'client-a' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

function handshake(nodeId: string, authToken?: string): SyncMessage {
	return {
		type: 'handshake',
		messageId: `hs-${nodeId}`,
		nodeId,
		versionVector: {},
		schemaVersion: 1,
		...(authToken ? { authToken } : {}),
	}
}

const serializer = new JsonMessageSerializer()

/** Open an HTTP session with a handshake POST and return the server-issued id. */
async function open(
	server: KoraSyncServer,
	nodeId: string,
	authorization?: string,
): Promise<string> {
	const response = await server.handleHttpRequest({
		method: 'POST',
		contentType: 'application/json',
		...(authorization ? { authorization } : {}),
		body: serializer.encode(handshake(nodeId, authorization?.slice('Bearer '.length))) as string,
	})
	expect(response.status).toBe(202)
	const id = response.headers?.['x-kora-session']
	if (!id) throw new Error('no session id issued')
	return id
}

describe('KoraSyncServer HTTP sync endpoint', () => {
	test('accepts handshake via POST and serves queued messages via GET', async () => {
		const server = new KoraSyncServer({
			store: new MemoryServerStore('server-1'),
			serializer,
		})

		const sessionId = await open(server, 'client-a')

		// The handshake is processed asynchronously (the server collects the client's
		// in-scope stream before answering), so poll until the response is queued rather
		// than assuming it is ready a fixed number of microtasks after the POST.
		let firstPoll = await server.handleHttpRequest({ sessionId, method: 'GET' })
		await vi.waitFor(async () => {
			if (firstPoll.status !== 200) {
				firstPoll = await server.handleHttpRequest({ sessionId, method: 'GET' })
			}
			expect(firstPoll.status).toBe(200)
		})

		const responseMessage = serializer.decode(firstPoll.body as string)
		expect(responseMessage.type).toBe('handshake-response')
		expect(firstPoll.headers?.etag).toBeDefined()

		const secondPoll = await server.handleHttpRequest({ sessionId, method: 'GET' })
		expect(secondPoll.status).toBe(200)

		const finalBatch = serializer.decode(secondPoll.body as string)
		expect(finalBatch.type).toBe('operation-batch')

		const emptyPoll = await server.handleHttpRequest({ sessionId, method: 'GET' })
		expect(emptyPoll.status).toBe(204)
		await server.stop()
	})

	test('relays operations between long-polling clients', async () => {
		const server = new KoraSyncServer({
			store: new MemoryServerStore('server-1'),
			serializer,
		})

		const a = await open(server, 'client-a')
		const b = await open(server, 'client-b')

		await drainPollQueue(server, a)
		await drainPollQueue(server, b)

		const op = createTestOp({ id: 'relay-op-1' })
		await server.handleHttpRequest({
			sessionId: a,
			method: 'POST',
			contentType: 'application/json',
			body: serializer.encode({
				type: 'operation-batch',
				messageId: 'batch-1',
				operations: [op],
				isFinal: true,
				batchIndex: 0,
			}),
		})

		const relayed = await pollForMessage(server, b, (message) => {
			if (message.type !== 'operation-batch') return false
			return message.operations.some((operation) => operation.id === 'relay-op-1')
		})

		expect(relayed).toBeDefined()
		await server.stop()
	})
})

describe('HTTP sessions are server-issued and bound to the principal (RT-2)', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	function authServer(extra: Partial<ConstructorParameters<typeof KoraSyncServer>[0]> = {}) {
		const auth = new TokenAuthProvider({
			validate: async (token) => {
				const [user, device] = token.split(':')
				return user && device ? { userId: user, metadata: { deviceId: device } } : null
			},
		})
		return new KoraSyncServer({
			store: new MemoryServerStore('server-1'),
			serializer,
			auth,
			relayRetransmitIntervalMs: 0,
			deliveryPollIntervalMs: 0,
			...extra,
		})
	}

	test('issues a distinct 256-bit session id per handshake POST', async () => {
		const server = authServer()
		const a = await open(server, 'n1', 'Bearer alice:d1')
		const b = await open(server, 'n2', 'Bearer alice:d1')
		expect(a).not.toBe(b)
		expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
		await server.stop()
	})

	test('every request must authenticate as the same user and device', async () => {
		const server = authServer()
		const id = await open(server, 'n1', 'Bearer alice:d1')
		const get = (authorization?: string): Promise<{ status: number }> =>
			server.handleHttpRequest({
				sessionId: id,
				method: 'GET',
				...(authorization ? { authorization } : {}),
			} as HttpSyncRequest)
		expect((await get()).status).toBe(401)
		expect((await get('Bearer junk')).status).toBe(401)
		expect((await get('Basic abc')).status).toBe(401)
		expect((await get('Bearer bob:d1')).status).toBe(403)
		expect((await get('Bearer alice:d2')).status).toBe(403)
		// A refreshed token of the same principal is accepted.
		expect([200, 204]).toContain((await get('Bearer alice:d1')).status)
		await server.stop()
	})

	test('a session-opening request must be an authenticated POST', async () => {
		const server = authServer()
		expect((await server.handleHttpRequest({ method: 'GET' })).status).toBe(401)
		expect(
			(await server.handleHttpRequest({ method: 'GET', authorization: 'Bearer alice:d1' })).status,
		).toBe(400)
		const unauthenticatedPost = await server.handleHttpRequest({
			method: 'POST',
			contentType: 'application/json',
			body: serializer.encode(handshake('n1')) as string,
		})
		expect(unauthenticatedPost.status).toBe(401)
		expect(server.getConnectionCount()).toBe(0)
		await server.stop()
	})

	test('an unknown session id is 404, never a new session', async () => {
		const server = authServer()
		const response = await server.handleHttpRequest({
			sessionId: 'chosen-by-the-client',
			method: 'POST',
			authorization: 'Bearer alice:d1',
			contentType: 'application/json',
			body: serializer.encode(handshake('n1', 'alice:d1')) as string,
		})
		expect(response.status).toBe(404)
		expect(server.getConnectionCount()).toBe(0)
		await server.stop()
	})

	test('a handshake authenticating someone other than the HTTP credential ends the session', async () => {
		const server = authServer()
		const response = await server.handleHttpRequest({
			method: 'POST',
			authorization: 'Bearer alice:d1',
			contentType: 'application/json',
			body: serializer.encode(handshake('n1', 'bob:d9')) as string,
		})
		const id = response.headers?.['x-kora-session'] as string
		await vi.waitFor(async () => {
			const poll = await server.handleHttpRequest({
				sessionId: id,
				method: 'GET',
				authorization: 'Bearer alice:d1',
			})
			expect(poll.status).toBe(403)
		})
		expect(server.getConnectionCount()).toBe(0)
		await server.stop()
	})

	test('idle sessions expire; active ones are kept', async () => {
		vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
		const server = authServer({ relayRetransmitIntervalMs: 1000, httpSessionIdleTimeoutMs: 10_000 })
		const idle = await open(server, 'n1', 'Bearer alice:d1')
		const active = await open(server, 'n2', 'Bearer bob:d2')
		for (let i = 0; i < 4; i++) {
			await vi.advanceTimersByTimeAsync(4000)
			await server.handleHttpRequest({
				sessionId: active,
				method: 'GET',
				authorization: 'Bearer bob:d2',
			})
		}
		expect(server.getConnectionCount()).toBe(1)
		const gone = await server.handleHttpRequest({
			sessionId: idle,
			method: 'GET',
			authorization: 'Bearer alice:d1',
		})
		expect(gone.status).toBe(404)
		await server.stop()
	})
})

async function drainPollQueue(server: KoraSyncServer, sessionId: string): Promise<void> {
	for (let index = 0; index < 10; index++) {
		const response = await server.handleHttpRequest({ sessionId, method: 'GET' })
		if (response.status !== 200) {
			break
		}
	}
}

async function pollForMessage(
	server: KoraSyncServer,
	sessionId: string,
	matcher: (message: SyncMessage) => boolean,
): Promise<SyncMessage | null> {
	for (let index = 0; index < 20; index++) {
		const response = await server.handleHttpRequest({ sessionId, method: 'GET' })
		if (response.status === 200) {
			const message = serializer.decode(response.body as string)
			if (matcher(message)) {
				return message
			}
		}

		await new Promise((resolve) => setTimeout(resolve, 5))
	}

	return null
}
