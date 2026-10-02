import { hashBlob } from '@korajs/core'
import type {
	AwarenessUpdateMessage,
	BlobChunkRequestMessage,
	BlobChunkResponseMessage,
	SyncMessage,
	YjsDocUpdateMessage,
} from '@korajs/sync'
import { encodeBlobChunkBytes } from '@korajs/sync'
import { beforeAll, describe, expect, test } from 'vitest'
import { AwarenessRelay } from '../awareness/awareness-relay'
import type {
	ServerCloseHandler,
	ServerErrorHandler,
	ServerMessageHandler,
	ServerTransport,
} from '../transport/server-transport'
import { BlobChunkRelay } from './blob-chunk-relay'
import { YjsDocRelay } from './yjs-doc-relay'

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
}

const chunk = new Uint8Array([1])
let chunkHash = ''
beforeAll(async () => {
	chunkHash = await hashBlob(chunk)
})

function request(requestId: string): BlobChunkRequestMessage {
	return { type: 'blob-chunk-request', messageId: `m-${requestId}`, requestId, hash: chunkHash }
}

function response(requestId: string): BlobChunkResponseMessage {
	return {
		type: 'blob-chunk-response',
		messageId: `r-${requestId}`,
		requestId,
		bytes: encodeBlobChunkBytes(chunk),
	}
}

const allowAll = { canReadFromStore: async () => true, canForward: async () => true }

function awareness(
	clientId: number,
	states: AwarenessUpdateMessage['states'],
): AwarenessUpdateMessage {
	return { type: 'awareness-update', messageId: `a-${clientId}`, clientId, states }
}

const presence = (name: string) => ({ user: { name, color: '#000' } }) as never

describe('BlobChunkRelay limits (SEC-5)', () => {
	test('caps outstanding forwarded requests per session', async () => {
		const relay = new BlobChunkRelay(undefined, allowAll, { maxPendingPerSession: 3 })
		const b = new FakeTransport()
		relay.addClient('a', new FakeTransport())
		relay.addClient('b', b)
		for (let i = 0; i < 10; i++) await relay.handleRequest('a', request(`r${i}`))
		expect(relay.getPendingCount()).toBe(3)
		expect(b.sent).toHaveLength(3)
		await relay.handleRequest('b', request('rb'))
		expect(relay.getPendingCount()).toBe(4)
	})

	test('forgets unanswered requests after the TTL', async () => {
		const relay = new BlobChunkRelay(undefined, allowAll, {
			maxPendingPerSession: 1,
			pendingTtlMs: 0,
		})
		relay.addClient('a', new FakeTransport())
		relay.addClient('b', new FakeTransport())
		await relay.handleRequest('a', request('r1'))
		await relay.handleRequest('a', request('r2'))
		expect(relay.getPendingCount()).toBe(1)
	})

	test("a session cannot hijack another session's pending request id", async () => {
		const relay = new BlobChunkRelay(undefined, allowAll)
		const a = new FakeTransport()
		const mallory = new FakeTransport()
		relay.addClient('a', a)
		relay.addClient('b', new FakeTransport())
		relay.addClient('m', mallory)
		await relay.handleRequest('a', request('shared'))
		await relay.handleRequest('m', request('shared'))
		await relay.handleResponse('b', response('shared'))
		expect(a.sent.some((m) => m.type === 'blob-chunk-response')).toBe(true)
		expect(mallory.sent.some((m) => m.type === 'blob-chunk-response')).toBe(false)
	})

	test('an unregistered session can neither request nor be forwarded to', async () => {
		const relay = new BlobChunkRelay(undefined, allowAll)
		const b = new FakeTransport()
		relay.addClient('b', b)
		await relay.handleRequest('stranger', request('r'))
		expect(relay.getPendingCount()).toBe(0)
		expect(b.sent).toHaveLength(0)
	})
})

describe('YjsDocRelay delivery filter (SEC-5)', () => {
	const update: YjsDocUpdateMessage = {
		type: 'yjs-doc-update',
		messageId: 'y',
		collection: 'notes',
		recordId: 'n1',
		field: 'body',
		update: 'AA==',
	}

	test('delivers only to sessions the filter admits, never back to the sender', () => {
		const relay = new YjsDocRelay()
		const sender = new FakeTransport()
		const sameTenant = new FakeTransport()
		const otherTenant = new FakeTransport()
		relay.addClient('s', sender)
		relay.addClient('same', sameTenant)
		relay.addClient('other', otherTenant)
		relay.handleUpdate('s', update, (target) => target === 'same')
		expect(sameTenant.sent).toHaveLength(1)
		expect(otherTenant.sent).toHaveLength(0)
		expect(sender.sent).toHaveLength(0)
	})

	test('an unregistered sender is ignored', () => {
		const relay = new YjsDocRelay()
		const peer = new FakeTransport()
		relay.addClient('peer', peer)
		relay.handleUpdate('stranger', update)
		expect(peer.sent).toHaveLength(0)
	})
})

describe('AwarenessRelay binding and partitions (SEC-5)', () => {
	test('relays only within the same partition, including catch-up and removal', () => {
		const relay = new AwarenessRelay()
		const a1 = new FakeTransport()
		const a2 = new FakeTransport()
		const b1 = new FakeTransport()
		relay.addClient('a1', 1, a1, 'tenant-a')
		relay.addClient('b1', 3, b1, 'tenant-b')
		relay.handleUpdate('a1', awareness(1, { '1': presence('A1') }))
		relay.handleUpdate('b1', awareness(3, { '3': presence('B1') }))
		relay.addClient('a2', 2, a2, 'tenant-a')
		// Catch-up for a2 contains tenant-a state only.
		const catchUp = a2.sent[0]
		expect(catchUp?.type === 'awareness-update' ? Object.keys(catchUp.states) : []).toEqual(['1'])
		expect(b1.sent).toHaveLength(0)
		relay.removeClient('a1')
		expect(a2.sent.some((m) => m.type === 'awareness-update' && m.states['1'] === null)).toBe(true)
		expect(b1.sent).toHaveLength(0)
	})

	test("a sender cannot overwrite or remove another client's state", () => {
		const relay = new AwarenessRelay()
		const victim = new FakeTransport()
		const peer = new FakeTransport()
		relay.addClient('victim', 1, victim)
		relay.addClient('mallory', 2, new FakeTransport())
		relay.addClient('peer', 3, peer)
		relay.handleUpdate('victim', awareness(1, { '1': presence('Victim') }))
		peer.sent.length = 0
		relay.handleUpdate('mallory', awareness(2, { '1': null, '2': presence('admin') }))
		const relayed = peer.sent.filter((m) => m.type === 'awareness-update')
		expect(relayed).toHaveLength(1)
		const states = relayed[0]?.type === 'awareness-update' ? relayed[0].states : {}
		expect(Object.keys(states)).toEqual(['2'])
	})

	test('an update stamped with another clientId is dropped', () => {
		const relay = new AwarenessRelay()
		const peer = new FakeTransport()
		relay.addClient('mallory', 2, new FakeTransport())
		relay.addClient('peer', 3, peer)
		relay.handleUpdate('mallory', awareness(1, { '1': presence('spoof') }))
		expect(peer.sent).toHaveLength(0)
	})

	test('re-registering a session does not rebind its clientId', () => {
		const relay = new AwarenessRelay()
		const peer = new FakeTransport()
		relay.addClient('mallory', 2, new FakeTransport())
		relay.addClient('mallory', 1, new FakeTransport())
		relay.addClient('peer', 3, peer)
		relay.handleUpdate('mallory', awareness(1, { '1': presence('spoof') }))
		expect(peer.sent).toHaveLength(0)
	})
})
