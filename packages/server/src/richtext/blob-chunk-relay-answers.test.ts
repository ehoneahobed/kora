/**
 * The blob relay never leaves a connected requester without an answer (2026-10-18).
 * Before the fix it stayed silent when every peer said "not held", over the per-session
 * pending cap, when the requester may not receive, for a request id pending for another
 * session, and when a request expired, so the client waited out a 30 s timeout.
 */
import type { BlobChunkRequestMessage, BlobChunkResponseMessage, SyncMessage } from '@korajs/sync'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { LogEntry, Logger } from '../logging/structured-logger'
import type { ServerTransport } from '../transport/server-transport'
import { BlobChunkRelay } from './blob-chunk-relay'

beforeEach(() => {
	vi.useFakeTimers()
})
afterEach(() => {
	vi.useRealTimers()
})

describe('blob chunk delivery, server relay: a connected requester always gets an answer', () => {
	function fakeTransport() {
		const sent: SyncMessage[] = []
		let connected = true
		const t = {
			sent,
			send: (m: SyncMessage) => void sent.push(m),
			isConnected: () => connected,
			drop: () => {
				connected = false
			},
		}
		return t as unknown as ServerTransport & { sent: SyncMessage[]; drop(): void }
	}
	const req = (requestId: string): BlobChunkRequestMessage => ({
		type: 'blob-chunk-request',
		messageId: `m-${requestId}`,
		requestId,
		hash: 'd'.repeat(64),
	})
	const notHeld = (requestId: string): BlobChunkResponseMessage => ({
		type: 'blob-chunk-response',
		messageId: `n-${requestId}`,
		requestId,
		bytes: null,
	})
	const open = { canReadFromStore: async () => false, canForward: async () => true }

	test('every peer asked says "not held": the requester is told "not held" (not before)', async () => {
		const relay = new BlobChunkRelay(undefined, { ...open, mayReceive: () => true })
		const requester = fakeTransport()
		relay.addClient('A', requester)
		relay.addClient('B', fakeTransport())
		relay.addClient('C', fakeTransport())
		await relay.handleRequest('A', req('r1'))
		await relay.handleResponse('B', notHeld('r1'))
		expect(requester.sent).toHaveLength(0) // C may still hold it
		await relay.handleResponse('C', notHeld('r1'))
		expect(requester.sent).toEqual([
			{ type: 'blob-chunk-response', messageId: 'blob-resp-r1', requestId: 'r1', bytes: null },
		])
		expect(relay.getPendingCount()).toBe(0)
		expect(relay.getStats().notHeldAfterPeers).toBe(1)
	})

	test('a re-sent request is not forwarded again to a peer that said "not held"', async () => {
		const relay = new BlobChunkRelay(undefined, open)
		const requester = fakeTransport()
		const b = fakeTransport()
		const c = fakeTransport()
		relay.addClient('A', requester)
		relay.addClient('B', b)
		relay.addClient('C', c)
		await relay.handleRequest('A', req('r1'))
		await relay.handleResponse('B', notHeld('r1'))
		await relay.handleRequest('A', req('r1')) // the client's retry, same id
		expect(b.sent).toHaveLength(1)
		expect(c.sent).toHaveLength(2)
		expect(requester.sent).toHaveLength(0)
		await relay.handleResponse('C', notHeld('r1'))
		expect((requester.sent[0] as BlobChunkResponseMessage).bytes).toBeNull()
	})

	test('a peer that leaves counts as "not held"', async () => {
		const relay = new BlobChunkRelay(undefined, open)
		const requester = fakeTransport()
		relay.addClient('A', requester)
		relay.addClient('B', fakeTransport())
		await relay.handleRequest('A', req('r1'))
		relay.removeClient('B')
		expect((requester.sent[0] as BlobChunkResponseMessage).bytes).toBeNull()
		expect(relay.getPendingCount()).toBe(0)
	})

	test('over the per-session pending cap the request is answered "throttled"', async () => {
		const relay = new BlobChunkRelay(undefined, open, { maxPendingPerSession: 1 })
		const requester = fakeTransport()
		const peer = fakeTransport()
		relay.addClient('A', requester)
		relay.addClient('B', peer)
		await relay.handleRequest('A', req('r1'))
		await relay.handleRequest('A', req('r2'))
		expect(peer.sent).toHaveLength(1) // r2 not forwarded
		expect(requester.sent).toEqual([
			{
				type: 'blob-chunk-response',
				messageId: 'blob-resp-r2',
				requestId: 'r2',
				bytes: null,
				throttled: true,
				retryAfterMs: 2_000,
			},
		])
		// A re-send of the pending r1 is not a new request: it is forwarded again.
		await relay.handleRequest('A', req('r1'))
		expect(peer.sent).toHaveLength(2)
		expect(relay.getStats().throttledOverPendingCap).toBe(1)
	})

	test('a central-store hit for a session that may not receive is answered "throttled", without bytes', async () => {
		const relay = new BlobChunkRelay(async () => new Uint8Array([1, 2, 3]), {
			canReadFromStore: async () => true,
			canForward: async () => false,
			mayReceive: () => false, // e.g. access rules not in force at decision time
		})
		const requester = fakeTransport()
		relay.addClient('A', requester)
		await relay.handleRequest('A', req('r1'))
		expect(requester.sent).toHaveLength(1)
		const answer = requester.sent[0] as BlobChunkResponseMessage
		expect(answer.bytes).toBeNull()
		expect(answer.throttled).toBe(true)
		expect(relay.getStats().throttledNotReceivable).toBe(1)
	})

	test('a request id pending for another session is refused "throttled"; the owner is unaffected', async () => {
		const relay = new BlobChunkRelay(undefined, open)
		const owner = fakeTransport()
		const other = fakeTransport()
		const peer = fakeTransport()
		relay.addClient('A', owner)
		relay.addClient('X', other)
		relay.addClient('B', peer)
		await relay.handleRequest('A', req('r1'))
		await relay.handleRequest('X', req('r1'))
		// X was asked as a peer for A's r1; its own r1 gets a retriable refusal.
		const answers = other.sent.filter((m) => m.type === 'blob-chunk-response')
		expect(answers).toHaveLength(1)
		expect((answers[0] as BlobChunkResponseMessage).throttled).toBe(true)
		expect(owner.sent).toHaveLength(0)
		expect(relay.getPendingCount()).toBe(1)
		expect(relay.getStats().refusedDuplicateRequestId).toBe(1)
	})

	test('an expired request is answered "not held"', async () => {
		const relay = new BlobChunkRelay(undefined, open, { pendingTtlMs: 1_000 })
		const requester = fakeTransport()
		relay.addClient('A', requester)
		relay.addClient('B', fakeTransport())
		await relay.handleRequest('A', req('r1'))
		expect(requester.sent).toHaveLength(0)
		vi.setSystemTime(Date.now() + 1_001)
		await relay.handleRequest('A', req('r2')) // expiry is checked as requests arrive
		expect(requester.sent).toEqual([
			{ type: 'blob-chunk-response', messageId: 'blob-resp-r1', requestId: 'r1', bytes: null },
		])
		expect(relay.getStats().expired).toBe(1)
	})

	test('the pending-cap and duplicate-id refusals are logged, and retryAfterMs is configurable', async () => {
		const entries: LogEntry[] = []
		const logger: Logger = { log: (entry) => void entries.push(entry) }
		let hold: (() => void) | null = null
		const relay = new BlobChunkRelay(
			undefined,
			{
				canReadFromStore: async () => false,
				canForward: (requesterId) =>
					requesterId === 'Y' && hold === null
						? new Promise<boolean>((resolve) => {
								hold = () => resolve(true)
							})
						: Promise.resolve(true),
			},
			{ maxPendingPerSession: 1, retryAfterMs: 750 },
			logger,
		)
		const a = fakeTransport()
		const x = fakeTransport()
		const y = fakeTransport()
		relay.addClient('A', a)
		relay.addClient('X', x)
		relay.addClient('Y', y)
		relay.addClient('B', fakeTransport())
		await relay.handleRequest('A', req('r1'))
		await relay.handleRequest('A', req('r2')) // over the cap
		await relay.handleRequest('X', req('r1')) // r1 is pending for A
		// Y asks for r9 and waits on the policy while X registers r9: refused after the await.
		const late = relay.handleRequest('Y', req('r9'))
		for (let i = 0; i < 50 && hold === null; i++) await Promise.resolve()
		await relay.handleRequest('X', req('r9'))
		const release: () => void = hold ?? (() => undefined)
		release()
		await late
		const throttled = [...a.sent, ...x.sent, ...y.sent].filter(
			(m): m is BlobChunkResponseMessage =>
				m.type === 'blob-chunk-response' && m.throttled === true,
		)
		expect(throttled.map((m) => [m.requestId, m.retryAfterMs])).toEqual([
			['r2', 750],
			['r1', 750],
			['r9', 750],
		])
		expect(entries.map((e) => [e.event, e.sessionId, e.level])).toEqual([
			['blob_relay.pending_cap', 'A', 'warn'],
			['blob_relay.duplicate_request_id', 'X', 'warn'],
			['blob_relay.duplicate_request_id', 'Y', 'warn'],
		])
		expect(relay.getStats()).toMatchObject({
			throttledOverPendingCap: 1,
			refusedDuplicateRequestId: 2,
		})
	})

	test('stats count a delivered "not held" and an undeliverable one once each', async () => {
		const relay = new BlobChunkRelay(undefined, open)
		const requester = fakeTransport()
		relay.addClient('A', requester)
		relay.addClient('B', fakeTransport())
		await relay.handleRequest('A', req('r1'))
		await relay.handleResponse('B', notHeld('r1'))
		await relay.handleRequest('A', req('r2'))
		requester.drop()
		await relay.handleResponse('B', notHeld('r2'))
		// The second "not held" never reached its requester: requesterGone only.
		expect(relay.getStats()).toMatchObject({ notHeldAfterPeers: 1, requesterGone: 1 })
	})

	test('a logger that throws never keeps the requester from its answer', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		try {
			const logger: Logger = {
				log: () => {
					throw new Error('logger boom')
				},
			}
			const relay = new BlobChunkRelay(undefined, open, { maxPendingPerSession: 1 }, logger)
			const a = fakeTransport()
			const x = fakeTransport()
			relay.addClient('A', a)
			relay.addClient('X', x)
			relay.addClient('B', fakeTransport())
			await relay.handleRequest('A', req('r1'))
			await expect(relay.handleRequest('A', req('r2'))).resolves.toBeUndefined() // over the cap
			await expect(relay.handleRequest('X', req('r1'))).resolves.toBeUndefined() // duplicate id
			const throttled = (t: { sent: SyncMessage[] }) =>
				t.sent
					.filter((m): m is BlobChunkResponseMessage => m.type === 'blob-chunk-response')
					.map((m) => [m.requestId, m.throttled])
			expect(throttled(a)).toEqual([['r2', true]])
			expect(throttled(x)).toEqual([['r1', true]])
			expect(logged).toHaveBeenCalledTimes(2)
		} finally {
			logged.mockRestore()
		}
	})
})
