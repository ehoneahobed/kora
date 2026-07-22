import type { BlobChunkRequestMessage, BlobChunkResponseMessage, SyncMessage } from '@korajs/sync'
import { encodeBlobChunkBytes } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import type {
	ServerCloseHandler,
	ServerErrorHandler,
	ServerMessageHandler,
	ServerTransport,
} from '../transport/server-transport'
import { BlobChunkRelay } from './blob-chunk-relay'

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

describe('BlobChunkRelay (peer relay path)', () => {
	test('forwards a request to peer sessions but not back to the requester', () => {
		const relay = new BlobChunkRelay()
		const a = new FakeTransport()
		const b = new FakeTransport()
		const c = new FakeTransport()
		relay.addClient('a', a)
		relay.addClient('b', b)
		relay.addClient('c', c)

		relay.handleRequest('a', request('r1', 'hash-1'))

		expect(a.sent).toHaveLength(0) // never echoed to origin
		expect(b.sent).toEqual([request('r1', 'hash-1')])
		expect(c.sent).toEqual([request('r1', 'hash-1')])
		expect(relay.getPendingCount()).toBe(1)
	})

	test('routes a peer response back to the original requester by requestId', () => {
		const relay = new BlobChunkRelay()
		const a = new FakeTransport()
		const b = new FakeTransport()
		relay.addClient('a', a)
		relay.addClient('b', b)

		relay.handleRequest('a', request('r1', 'hash-1'))
		const bytes = encodeBlobChunkBytes(new Uint8Array([1, 2, 3]))
		relay.handleResponse('b', response('r1', bytes))

		expect(a.sent).toHaveLength(1)
		const routed = a.sent[0] as BlobChunkResponseMessage
		expect(routed.type).toBe('blob-chunk-response')
		expect(routed.requestId).toBe('r1')
		expect(routed.bytes).toBe(bytes)
		expect(relay.getPendingCount()).toBe(0) // cleared once answered
	})

	test('ignores a "not held" (null) response so a peer without the chunk cannot preempt', () => {
		const relay = new BlobChunkRelay()
		const a = new FakeTransport()
		const b = new FakeTransport()
		const c = new FakeTransport()
		relay.addClient('a', a)
		relay.addClient('b', b)
		relay.addClient('c', c)

		relay.handleRequest('a', request('r1', 'hash-1'))
		relay.handleResponse('b', response('r1', null)) // b does not hold it
		expect(a.sent).toHaveLength(0)
		expect(relay.getPendingCount()).toBe(1) // still waiting

		const bytes = encodeBlobChunkBytes(new Uint8Array([9]))
		relay.handleResponse('c', response('r1', bytes)) // c has it
		expect(a.sent).toHaveLength(1)
		expect(relay.getPendingCount()).toBe(0)
	})

	test('drops pending requests when the requesting session disconnects', () => {
		const relay = new BlobChunkRelay()
		const a = new FakeTransport()
		const b = new FakeTransport()
		relay.addClient('a', a)
		relay.addClient('b', b)

		relay.handleRequest('a', request('r1', 'hash-1'))
		expect(relay.getPendingCount()).toBe(1)

		relay.removeClient('a')
		expect(relay.getPendingCount()).toBe(0)

		// A late answer for the gone requester is a no-op, not a crash.
		relay.handleResponse('b', response('r1', encodeBlobChunkBytes(new Uint8Array([1]))))
		expect(a.sent).toHaveLength(0)
	})

	test('a request from an unknown session is ignored', () => {
		const relay = new BlobChunkRelay()
		const b = new FakeTransport()
		relay.addClient('b', b)

		relay.handleRequest('ghost', request('r1', 'hash-1'))
		expect(b.sent).toHaveLength(0)
		expect(relay.getPendingCount()).toBe(0)
	})
})

describe('BlobChunkRelay (central-store path)', () => {
	test('answers directly from the server store when resolveBlobChunk holds the chunk', async () => {
		const chunk = new Uint8Array([7, 7, 7])
		const relay = new BlobChunkRelay(async (hash) => (hash === 'hash-1' ? chunk : null))
		const a = new FakeTransport()
		const b = new FakeTransport()
		relay.addClient('a', a)
		relay.addClient('b', b)

		relay.handleRequest('a', request('r1', 'hash-1'))
		await Promise.resolve()
		await Promise.resolve()

		expect(b.sent).toHaveLength(0) // no peer broadcast needed
		expect(a.sent).toHaveLength(1)
		const routed = a.sent[0] as BlobChunkResponseMessage
		expect(routed.bytes).toBe(encodeBlobChunkBytes(chunk))
	})

	test('falls back to peer relay when the server store does not hold the chunk', async () => {
		const relay = new BlobChunkRelay(async () => null)
		const a = new FakeTransport()
		const b = new FakeTransport()
		relay.addClient('a', a)
		relay.addClient('b', b)

		relay.handleRequest('a', request('r1', 'hash-1'))
		await Promise.resolve()
		await Promise.resolve()

		expect(b.sent).toEqual([request('r1', 'hash-1')]) // forwarded to peers
		expect(relay.getPendingCount()).toBe(1)
	})
})
