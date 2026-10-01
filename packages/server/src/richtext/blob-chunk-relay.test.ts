import { hashBlob } from '@korajs/core'
import type { BlobChunkRequestMessage, BlobChunkResponseMessage, SyncMessage } from '@korajs/sync'
import { encodeBlobChunkBytes } from '@korajs/sync'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import type {
	ServerCloseHandler,
	ServerErrorHandler,
	ServerMessageHandler,
	ServerTransport,
} from '../transport/server-transport'
import { type BlobAccessPolicy, BlobChunkRelay } from './blob-chunk-relay'

/** Minimal in-memory server transport that records what was sent to a client. */
class FakeTransport implements ServerTransport {
	readonly sent: SyncMessage[] = []
	private connected = true

	send(message: SyncMessage): void {
		this.sent.push(message)
	}
	onMessage(_handler: ServerMessageHandler): void {}
	onClose(_handler: ServerCloseHandler): void {}
	onError(_handler: ServerErrorHandler): void {}
	isConnected(): boolean {
		return this.connected
	}
	close(): void {
		this.connected = false
	}
	disconnect(): void {
		this.connected = false
	}
}

function request(requestId: string, hash: string): BlobChunkRequestMessage {
	return { type: 'blob-chunk-request', messageId: `m-${requestId}`, requestId, hash }
}

function response(requestId: string, bytes: string | null): BlobChunkResponseMessage {
	return { type: 'blob-chunk-response', messageId: `m-${requestId}`, requestId, bytes }
}

/** Every session may access every hash (tenancy is tested separately). */
const allowAll: BlobAccessPolicy = { canAccess: async () => true }

/** Only the listed sessions may access the hash. */
function allowOnly(sessions: string[]): BlobAccessPolicy {
	return { canAccess: async (sessionId) => sessions.includes(sessionId) }
}

const chunk = new Uint8Array([1, 2, 3])
const encoded = encodeBlobChunkBytes(chunk)
let hash = ''
beforeAll(async () => {
	hash = await hashBlob(chunk)
})

function setup(
	policy: BlobAccessPolicy = allowAll,
	resolve?: (h: string) => Promise<Uint8Array | null>,
) {
	const relay = new BlobChunkRelay(resolve, policy)
	const transports = { a: new FakeTransport(), b: new FakeTransport(), c: new FakeTransport() }
	for (const [id, transport] of Object.entries(transports)) relay.addClient(id, transport)
	return { relay, ...transports }
}

describe('BlobChunkRelay (peer relay path)', () => {
	test('forwards a request to admitted peer sessions but not back to the requester', async () => {
		const { relay, a, b, c } = setup()
		await relay.handleRequest('a', request('r1', hash))
		expect(a.sent).toHaveLength(0) // never echoed to origin
		expect(b.sent).toEqual([request('r1', hash)])
		expect(c.sent).toEqual([request('r1', hash)])
		expect(relay.getPendingCount()).toBe(1)
	})

	test('routes a verified peer response back to the original requester by requestId', async () => {
		const { relay, a } = setup()
		await relay.handleRequest('a', request('r1', hash))
		await relay.handleResponse('b', response('r1', encoded))
		expect(a.sent).toHaveLength(1)
		const routed = a.sent[0] as BlobChunkResponseMessage
		expect(routed.type).toBe('blob-chunk-response')
		expect(routed.requestId).toBe('r1')
		expect(routed.bytes).toBe(encoded)
		expect(relay.getPendingCount()).toBe(0) // cleared once answered
	})

	test('ignores a "not held" (null) response so a peer without the chunk cannot preempt', async () => {
		const { relay, a } = setup()
		await relay.handleRequest('a', request('r1', hash))
		await relay.handleResponse('b', response('r1', null)) // b does not hold it
		expect(a.sent).toHaveLength(0)
		expect(relay.getPendingCount()).toBe(1) // still waiting
		await relay.handleResponse('c', response('r1', encoded)) // c has it
		expect(a.sent).toHaveLength(1)
		expect(relay.getPendingCount()).toBe(0)
	})

	test('drops pending requests when the requesting session disconnects', async () => {
		const { relay, a } = setup()
		await relay.handleRequest('a', request('r1', hash))
		expect(relay.getPendingCount()).toBe(1)
		relay.removeClient('a')
		expect(relay.getPendingCount()).toBe(0)
		// A late answer for the gone requester is a no-op, not a crash.
		await relay.handleResponse('b', response('r1', encoded))
		expect(a.sent).toHaveLength(0)
	})

	test('a request from an unknown session is ignored', async () => {
		const { relay, b } = setup()
		await relay.handleRequest('ghost', request('r1', hash))
		expect(b.sent).toHaveLength(0)
		expect(relay.getPendingCount()).toBe(0)
	})
})

describe('BlobChunkRelay tenancy (RT-1)', () => {
	test('a requester the policy refuses gets "not held" and nobody is asked', async () => {
		const { relay, a, b, c } = setup(allowOnly(['b', 'c']))
		await relay.handleRequest('a', request('r1', hash))
		expect(a.sent).toEqual([
			{ type: 'blob-chunk-response', messageId: 'blob-resp-r1', requestId: 'r1', bytes: null },
		])
		expect(b.sent).toHaveLength(0)
		expect(c.sent).toHaveLength(0)
		expect(relay.getPendingCount()).toBe(0)
	})

	test('the request reaches only admitted peers', async () => {
		const { relay, b, c } = setup(allowOnly(['a', 'b']))
		await relay.handleRequest('a', request('r1', hash))
		expect(b.sent).toHaveLength(1)
		expect(c.sent).toHaveLength(0)
	})

	test('a session that was not asked cannot answer', async () => {
		const { relay, a } = setup(allowOnly(['a', 'b']))
		await relay.handleRequest('a', request('r1', hash))
		await relay.handleResponse('c', response('r1', encoded))
		expect(a.sent).toHaveLength(0)
		expect(relay.getPendingCount()).toBe(1)
	})

	test('bytes that do not hash to the requested hash are dropped', async () => {
		const { relay, a } = setup()
		await relay.handleRequest('a', request('r1', hash))
		await relay.handleResponse('b', response('r1', encodeBlobChunkBytes(new Uint8Array([6]))))
		expect(a.sent).toHaveLength(0)
		await relay.handleResponse('c', response('r1', encoded))
		expect(a.sent).toHaveLength(1)
	})

	test('a throwing policy fails closed', async () => {
		const { relay, a, b } = setup({
			canAccess: async () => {
				throw new Error('store down')
			},
		})
		await relay.handleRequest('a', request('r1', hash))
		expect((a.sent[0] as BlobChunkResponseMessage).bytes).toBeNull()
		expect(b.sent).toHaveLength(0)
	})

	test('verified bytes are handed to the policy (manifest learning)', async () => {
		const observe = vi.fn()
		const { relay } = setup({ canAccess: async () => true, observeVerifiedBytes: observe })
		await relay.handleRequest('a', request('r1', hash))
		await relay.handleResponse('b', response('r1', encoded))
		expect(observe).toHaveBeenCalledWith(hash, chunk)
	})
})

describe('BlobChunkRelay (central-store path)', () => {
	test('answers an admitted requester directly from the server store', async () => {
		const { relay, a, b } = setup(allowAll, async (h) => (h === hash ? chunk : null))
		await relay.handleRequest('a', request('r1', hash))
		expect(b.sent).toHaveLength(0) // no peer broadcast needed
		expect(a.sent).toHaveLength(1)
		expect((a.sent[0] as BlobChunkResponseMessage).bytes).toBe(encoded)
	})

	test('never serves a requester the policy refuses, even when the store holds the bytes', async () => {
		const resolve = vi.fn(async () => chunk)
		const { relay, a } = setup(allowOnly(['b']), resolve)
		await relay.handleRequest('a', request('r1', hash))
		expect(resolve).not.toHaveBeenCalled()
		expect((a.sent[0] as BlobChunkResponseMessage).bytes).toBeNull()
	})

	test('falls back to peer relay when the server store does not hold the chunk', async () => {
		const { relay, b } = setup(allowAll, async () => null)
		await relay.handleRequest('a', request('r1', hash))
		expect(b.sent).toEqual([request('r1', hash)]) // forwarded to peers
		expect(relay.getPendingCount()).toBe(1)
	})
})
