/**
 * Blob chunk delivery (2026-10-18): blob chunk requests were lost and never retried, so a
 * pull waited 30 s and failed with a plain Error on a healthy connection.
 *  - The sync engine sent requests only while 'streaming' and silently dropped them
 *    while 'syncing' (handshake accepted, initial delta still arriving), although rows
 *    are already visible to the app then.
 *  - The remote chunk provider made one attempt with a 30 s timeout, no retry, and a
 *    reconnect did not re-send pending requests.
 *  (The server relay's side, never silent toward a connected requester, is covered by
 *  packages/server/src/richtext/blob-chunk-relay-answers.test.ts.)
 *
 * Deterministic: fake timers, in-memory transports, injected jitter. Asserts the
 * CORRECT behaviour (every test fails before the fix).
 */
import { KoraError, type KoraEvent } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { BlobTransferError, createRemoteChunkProvider } from '@korajs/store'
import {
	type BlobChunkRequestMessage,
	type HandshakeMessage,
	SyncEngine,
	type SyncMessage,
	type SyncStore,
} from '@korajs/sync'
import { createMemoryTransportPair } from '@korajs/sync/internal'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createSyncEngineChunkPort } from '../../src/blob/sync-chunk-port'

function mockStore(): SyncStore {
	return {
		getVersionVector: () => new Map(),
		getNodeId: () => 'probe-node',
		applyRemoteOperation: vi.fn(async () => 'applied' as const),
		getOperationRange: vi.fn(async () => []),
	}
}

/** Fake server: accepts the handshake; the final delta batch is sent only on demand. */
function fakeServer(server: ReturnType<typeof createMemoryTransportPair>['server']) {
	const blobRequests: BlobChunkRequestMessage[] = []
	server.onMessage((msg: SyncMessage) => {
		if (msg.type === 'handshake') {
			const hs = msg as HandshakeMessage
			server.send({
				type: 'handshake-response',
				messageId: `resp-${hs.messageId}`,
				nodeId: 'server-node',
				versionVector: {},
				schemaVersion: hs.schemaVersion,
				accepted: true,
			})
		} else if (msg.type === 'blob-chunk-request') {
			blobRequests.push(msg)
		}
	})
	return {
		blobRequests,
		sendFinalDelta: () =>
			server.send({
				type: 'operation-batch',
				messageId: 'delta-final',
				operations: [],
				isFinal: true,
				batchIndex: 0,
				totalBatches: 1,
			}),
		answer: (requestId: string, bytes: string | null) =>
			server.send({
				type: 'blob-chunk-response',
				messageId: `answer-${requestId}`,
				requestId,
				bytes,
			}),
	}
}

async function flush(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0)
}

function settle<T>(promise: Promise<T>) {
	return promise.then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error }),
	)
}

function collectEvents(emitter: SimpleEventEmitter): KoraEvent[] {
	const events: KoraEvent[] = []
	emitter.on('blob:request-retried', (e) => events.push(e))
	emitter.on('blob:request-failed', (e) => events.push(e))
	return events
}

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)

beforeEach(() => {
	vi.useFakeTimers()
})
afterEach(() => {
	vi.useRealTimers()
})

describe('blob chunk delivery, client: a pull is never lost to a single message', () => {
	test('a request issued while the engine is still "syncing" goes out at once', async () => {
		const { client, server } = createMemoryTransportPair()
		const srv = fakeServer(server)
		const engine = new SyncEngine({
			transport: client,
			store: mockStore(),
			config: { url: 'ws://probe' },
		})
		await engine.start()
		await flush()
		// Handshake accepted, the final delta batch has not arrived: rows may already be
		// applied and visible to the app, which pulls the blob behind one at once.
		expect(engine.getState()).toBe('syncing')

		const provider = createRemoteChunkProvider(createSyncEngineChunkPort(engine), {
			random: () => 0.5,
		})
		const outcome = settle(provider.getChunk(HASH_A))
		await flush()
		expect(srv.blobRequests).toHaveLength(1)
		expect(srv.blobRequests[0]?.hash).toBe(HASH_A)

		srv.answer(srv.blobRequests[0]?.requestId ?? '', 'AQID')
		await flush()
		const result = await outcome
		expect(result.ok).toBe(true)
		if (result.ok) expect(result.value).toEqual(new Uint8Array([1, 2, 3]))
		expect(provider.pendingCount()).toBe(0)
		provider.close()
		await engine.stop()
	})

	test('a request made before the connection exists is sent when the handshake is accepted', async () => {
		const { client, server } = createMemoryTransportPair()
		const srv = fakeServer(server)
		const engine = new SyncEngine({
			transport: client,
			store: mockStore(),
			config: { url: 'ws://probe' },
		})
		const provider = createRemoteChunkProvider(createSyncEngineChunkPort(engine), {
			random: () => 0.5,
		})
		const outcome = settle(provider.getChunk(HASH_A))
		await flush()
		expect(srv.blobRequests).toHaveLength(0) // nothing to send it on yet

		await engine.start()
		await flush()
		// Re-sent on ready, long before its 5 s attempt timer.
		expect(srv.blobRequests).toHaveLength(1)
		srv.answer(srv.blobRequests[0]?.requestId ?? '', null)
		await flush()
		// Answered "not held": one request left the device (the try before the connection
		// existed was not sent, so it is not an attempt).
		expect(await outcome).toMatchObject({
			ok: false,
			error: { code: 'BLOB_CHUNK_UNAVAILABLE', attempts: 1, lastReason: 'not-held' },
		})
		provider.close()
		await engine.stop()
	})

	test('a lost answer is retried under the same request id with a growing wait', async () => {
		const { client, server } = createMemoryTransportPair()
		const srv = fakeServer(server)
		const engine = new SyncEngine({
			transport: client,
			store: mockStore(),
			config: { url: 'ws://probe' },
		})
		await engine.start()
		srv.sendFinalDelta()
		await flush()
		expect(engine.getState()).toBe('streaming')

		const emitter = new SimpleEventEmitter()
		const events = collectEvents(emitter)
		const provider = createRemoteChunkProvider(createSyncEngineChunkPort(engine), {
			random: () => 0.5, // no jitter: waits are exactly 5 s, 10 s, 20 s, 30 s, ...
			emitter,
		})
		const outcome = settle(provider.getChunk(HASH_B))
		await flush()
		expect(srv.blobRequests).toHaveLength(1)

		await vi.advanceTimersByTimeAsync(4_999)
		expect(srv.blobRequests).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(srv.blobRequests).toHaveLength(2) // re-sent after 5 s
		await vi.advanceTimersByTimeAsync(10_000)
		expect(srv.blobRequests).toHaveLength(3) // then after 10 s
		const ids = new Set(srv.blobRequests.map((r) => r.requestId))
		expect(ids.size).toBe(1) // one request id across attempts

		// The third attempt is answered: the pull succeeds.
		srv.answer(srv.blobRequests[2]?.requestId ?? '', 'BAUG')
		await flush()
		const result = await outcome
		expect(result.ok).toBe(true)
		expect(events.map((e) => e.type)).toEqual(['blob:request-retried', 'blob:request-retried'])
		expect(events[0]).toMatchObject({ hash: HASH_B, attempt: 2, reason: 'timeout' })
		// A late duplicate answer for the same id is ignored.
		srv.answer(srv.blobRequests[0]?.requestId ?? '', null)
		await flush()
		provider.close()
		await engine.stop()
	})

	test('a request nobody ever answers fails at the deadline with a coded BlobTransferError', async () => {
		const { client, server } = createMemoryTransportPair()
		const srv = fakeServer(server)
		const engine = new SyncEngine({
			transport: client,
			store: mockStore(),
			config: { url: 'ws://probe' },
		})
		await engine.start()
		srv.sendFinalDelta()
		await flush()

		const emitter = new SimpleEventEmitter()
		const events = collectEvents(emitter)
		const provider = createRemoteChunkProvider(createSyncEngineChunkPort(engine), {
			random: () => 0.5,
			emitter,
		})
		const engineTimers = vi.getTimerCount()
		const outcome = settle(provider.getChunk(HASH_B))
		await flush()
		expect(vi.getTimerCount()).toBe(engineTimers + 1) // one timer per pending request

		await vi.advanceTimersByTimeAsync(119_999)
		expect(provider.pendingCount()).toBe(1)
		await vi.advanceTimersByTimeAsync(1)
		const result = await outcome
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.error).toBeInstanceOf(BlobTransferError)
			expect(result.error).toBeInstanceOf(KoraError)
			const error = result.error as BlobTransferError
			expect(error.code).toBe('BLOB_CHUNK_TIMEOUT')
			expect(error.hash).toBe(HASH_B)
			expect(error.lastReason).toBe('timeout')
			// 5 + 10 + 20 + 30 + 30 = 95 s, then the deadline cuts the 6th wait short.
			expect(error.attempts).toBe(6)
			expect(srv.blobRequests).toHaveLength(6)
		}
		const failed = events.filter((e) => e.type === 'blob:request-failed')
		expect(failed).toHaveLength(1)
		expect(failed[0]).toMatchObject({ code: 'BLOB_CHUNK_TIMEOUT', attempts: 6, hash: HASH_B })
		expect(vi.getTimerCount()).toBe(engineTimers) // nothing left running for this request
		provider.close()
		await engine.stop()
	})

	test('a reconnect re-sends every pending request on the new connection at once', async () => {
		const { client, server } = createMemoryTransportPair()
		const srv = fakeServer(server)
		const engine = new SyncEngine({
			transport: client,
			store: mockStore(),
			config: { url: 'ws://probe' },
		})
		await engine.start()
		srv.sendFinalDelta()
		await flush()
		const emitter = new SimpleEventEmitter()
		const events = collectEvents(emitter)
		const provider = createRemoteChunkProvider(createSyncEngineChunkPort(engine), {
			random: () => 0.5,
			emitter,
		})
		const outcome = settle(provider.getChunk(HASH_C))
		await flush()
		expect(srv.blobRequests).toHaveLength(1)

		// The connection drops (the request or its answer is lost with it), then comes back.
		await engine.stop()
		await engine.start()
		await flush()
		expect(srv.blobRequests).toHaveLength(2) // re-sent at once, not after a timer
		expect(srv.blobRequests[1]?.requestId).toBe(srv.blobRequests[0]?.requestId)
		expect(events[0]).toMatchObject({ type: 'blob:request-retried', reason: 'reconnected' })

		srv.answer(srv.blobRequests[1]?.requestId ?? '', 'AQID')
		await flush()
		expect((await outcome).ok).toBe(true)
		provider.close()
		await engine.stop()
	})

	test('closing the provider cancels pending pulls and leaves no timer behind', async () => {
		const { client, server } = createMemoryTransportPair()
		fakeServer(server)
		const engine = new SyncEngine({
			transport: client,
			store: mockStore(),
			config: { url: 'ws://probe' },
		})
		await engine.start()
		await flush()
		const provider = createRemoteChunkProvider(createSyncEngineChunkPort(engine))
		const outcome = settle(provider.getChunk(HASH_A))
		await flush()
		await engine.stop()
		const timersBefore = vi.getTimerCount()
		provider.close()
		expect(vi.getTimerCount()).toBe(timersBefore - 1)
		const result = await outcome
		expect(result.ok).toBe(false)
		if (!result.ok) expect((result.error as BlobTransferError).code).toBe('BLOB_CHUNK_CANCELLED')
		await expect(provider.getChunk(HASH_A)).rejects.toMatchObject({ code: 'BLOB_CHUNK_CANCELLED' })
	})
})

describe('blob chunk delivery, client: handler errors surface as events', () => {
	test('a throwing blob handler is emitted as blob:handler-error; the provider still gets its answer', async () => {
		const { client, server } = createMemoryTransportPair()
		const srv = fakeServer(server)
		const emitter = new SimpleEventEmitter()
		const errors: KoraEvent[] = []
		emitter.on('blob:handler-error', (e) => errors.push(e))
		const engine = new SyncEngine({
			transport: client,
			store: mockStore(),
			config: { url: 'ws://probe' },
			emitter,
		})
		const channel = engine.getBlobChunkChannel()
		channel.onMessage(() => {
			throw new KoraError('handler failed', 'TEST_HANDLER')
		})
		channel.onReady(() => {
			throw new Error('ready failed')
		})
		const provider = createRemoteChunkProvider(createSyncEngineChunkPort(engine), {
			random: () => 0.5,
		})
		const outcome = settle(provider.getChunk(HASH_C))
		await engine.start()
		await flush()
		expect(srv.blobRequests).toHaveLength(1) // the provider's ready handler still ran
		srv.answer(srv.blobRequests[0]?.requestId ?? '', 'AQID')
		await flush()
		const result = await outcome
		expect(result.ok).toBe(true)
		expect(errors).toEqual([
			{ type: 'blob:handler-error', phase: 'ready', message: 'ready failed' },
			{
				type: 'blob:handler-error',
				phase: 'message',
				messageType: 'blob-chunk-response',
				code: 'TEST_HANDLER',
				message: 'handler failed',
			},
		])
		provider.close()
		await engine.stop()
	})
})
