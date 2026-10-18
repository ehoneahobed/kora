import type { KoraEvent } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { describe, expect, test } from 'vitest'
import {
	type ChunkMessage,
	type ChunkMessagePort,
	type ChunkRequestMessage,
	createChunkPortPair,
	createRemoteChunkProvider,
	serveBlobChunks,
} from './blob-chunk-transport'
import { fetchBlobManifest } from './blob-manifest-transfer'
import { prepareBlobForSend, receiveBlob } from './blob-transfer'
import { BlobTransferError } from './blob-transfer-error'
import { MemoryBlobStore } from './content-addressed-blob-store'

function randomBytes(n: number, seed: number): Uint8Array {
	const out = new Uint8Array(n)
	let x = seed >>> 0
	for (let i = 0; i < n; i++) {
		x = (x * 1664525 + 1013904223) >>> 0
		out[i] = (x >>> 24) & 0xff
	}
	return out
}

describe('blob chunk transport (request/response over a message port)', () => {
	test('a receiver pulls a blob chunk-by-chunk over the port and reassembles it', async () => {
		const bytes = randomBytes(2000, 5)

		// Server side: stage the blob's chunks and serve chunk requests over its port.
		const serverStore = new MemoryBlobStore()
		const { manifest } = await prepareBlobForSend(bytes, serverStore, { chunkSize: 256 })
		const pair = createChunkPortPair()
		serveBlobChunks(pair.a, serverStore)

		// Receiver side: a provider backed by the other end of the port.
		const provider = createRemoteChunkProvider(pair.b)
		const chunkStore = new MemoryBlobStore()
		const blobStore = new MemoryBlobStore()

		const result = await receiveBlob(manifest, provider, { chunkStore, blobStore })
		expect(result.ref.hash).toBe(manifest.blobHash)
		expect(await blobStore.get(result.ref.hash)).toEqual(bytes)
		expect(provider.pendingCount()).toBe(0) // every request resolved
	})

	test('resumes over the port: a second pull fetches only the missing chunks', async () => {
		const bytes = randomBytes(2000, 6)
		const serverStore = new MemoryBlobStore()
		const { manifest } = await prepareBlobForSend(bytes, serverStore, { chunkSize: 256 })
		const pair = createChunkPortPair()
		serveBlobChunks(pair.a, serverStore)
		const provider = createRemoteChunkProvider(pair.b)

		const chunkStore = new MemoryBlobStore()
		const blobStore = new MemoryBlobStore()

		// Pre-stage the first two chunks locally (as if a prior transfer was cut off).
		const staged = await prepareBlobForSend(bytes, new MemoryBlobStore(), { chunkSize: 256 })
		const firstTwo = staged.manifest.chunkHashes.slice(0, 2)
		for (const hash of firstTwo) {
			const chunk = await serverStore.get(hash)
			if (chunk) {
				await chunkStore.put(chunk)
			}
		}

		const result = await receiveBlob(manifest, provider, { chunkStore, blobStore })
		expect(result.chunksSkipped).toBe(2)
		expect(result.chunksFetched).toBe(manifest.chunkHashes.length - 2)
		expect(await blobStore.get(result.ref.hash)).toEqual(bytes)
	})

	test('a missing chunk on the server surfaces as unavailable, not a hang', async () => {
		// Manifest references a chunk the server does not have.
		const bytes = randomBytes(500, 7)
		const senderStore = new MemoryBlobStore()
		const { manifest } = await prepareBlobForSend(bytes, senderStore, { chunkSize: 256 })

		const emptyServerStore = new MemoryBlobStore() // holds nothing
		const pair = createChunkPortPair()
		serveBlobChunks(pair.a, emptyServerStore)
		const provider = createRemoteChunkProvider(pair.b)

		await expect(
			receiveBlob(manifest, provider, {
				chunkStore: new MemoryBlobStore(),
				blobStore: new MemoryBlobStore(),
			}),
		).rejects.toMatchObject({
			code: 'BLOB_CHUNK_UNAVAILABLE',
			attempts: 1,
			lastReason: 'not-held',
		})
	})

	test('a corrupt chunk on the server is reported as unavailable (integrity guard)', async () => {
		const bytes = randomBytes(300, 9)
		const serverStore = new MemoryBlobStore()
		const { manifest } = await prepareBlobForSend(bytes, serverStore, { chunkSize: 256 })
		// Corrupt the stored bytes for the first chunk so the server's get() throws.
		const firstHash = manifest.chunkHashes[0] as string
		;(serverStore as unknown as { blobs: Map<string, Uint8Array> }).blobs.set(
			firstHash,
			new Uint8Array([0, 0, 0]),
		)
		const pair = createChunkPortPair()
		serveBlobChunks(pair.a, serverStore)
		const provider = createRemoteChunkProvider(pair.b)

		// The server answers null for the corrupt chunk → receiver reports unavailable.
		await expect(
			receiveBlob(manifest, provider, {
				chunkStore: new MemoryBlobStore(),
				blobStore: new MemoryBlobStore(),
			}),
		).rejects.toMatchObject({
			code: 'BLOB_CHUNK_UNAVAILABLE',
			attempts: 1,
			lastReason: 'not-held',
		})
	})

	test('a throttled answer is retried after a back-off instead of failing (RT-24)', async () => {
		const pair = createChunkPortPair()
		const chunk = new Uint8Array([7, 7, 7])
		let requests = 0
		pair.a.onMessage((message) => {
			if (message.type !== 'blob-chunk-request') return
			requests += 1
			pair.a.send(
				requests < 3
					? {
							type: 'blob-chunk-response',
							requestId: message.requestId,
							bytes: null,
							throttled: true,
							retryAfterMs: 1,
						}
					: { type: 'blob-chunk-response', requestId: message.requestId, bytes: chunk },
			)
		})
		const provider = createRemoteChunkProvider(pair.b, { minThrottleDelayMs: 1 })
		expect(await provider.getChunk('h')).toEqual(chunk)
		expect(requests).toBe(3)
		expect(provider.pendingCount()).toBe(0)
	})

	test('a request throttled past the wait budget fails', async () => {
		const pair = createChunkPortPair()
		pair.a.onMessage((message) => {
			if (message.type !== 'blob-chunk-request') return
			pair.a.send({
				type: 'blob-chunk-response',
				requestId: message.requestId,
				bytes: null,
				throttled: true,
				retryAfterMs: 50,
			})
		})
		const provider = createRemoteChunkProvider(pair.b, {
			minThrottleDelayMs: 1,
			maxThrottleWaitMs: 10,
		})
		await expect(provider.getChunk('h')).rejects.toThrow('throttled')
	})
})

/** A manual clock: timers fire only when the test advances time. */
function manualClock() {
	let now = 0
	let nextId = 0
	const timers = new Map<number, { at: number; callback: () => void }>()
	return {
		clock: {
			now: () => now,
			setTimeout: (callback: () => void, delayMs: number): unknown => {
				nextId += 1
				timers.set(nextId, { at: now + delayMs, callback })
				return nextId
			},
			clearTimeout: (handle: unknown): void => {
				timers.delete(handle as number)
			},
		},
		advance(ms: number): void {
			const target = now + ms
			for (;;) {
				let due: [number, { at: number; callback: () => void }] | null = null
				for (const entry of timers) {
					if (entry[1].at <= target && (!due || entry[1].at < due[1].at)) due = entry
				}
				if (!due) break
				timers.delete(due[0])
				now = due[1].at
				due[1].callback()
			}
			now = target
		},
		timerCount: () => timers.size,
	}
}

/** A port whose sends are recorded; answers and ready signals are injected by the test. */
function scriptedPort() {
	const sent: ChunkRequestMessage[] = []
	const handlers: Array<(m: ChunkMessage) => void> = []
	const ready: Array<() => void> = []
	let connected = true
	const port: ChunkMessagePort = {
		send(message) {
			if (!connected) return false
			if (message.type === 'blob-chunk-request') sent.push(message)
			return true
		},
		onMessage(handler) {
			handlers.push(handler)
		},
		onReady(handler) {
			ready.push(handler)
		},
	}
	return {
		port,
		sent,
		answer(message: ChunkMessage): void {
			for (const handler of handlers) handler(message)
		},
		setConnected(value: boolean): void {
			connected = value
		},
		fireReady(): void {
			for (const handler of ready) handler()
		},
	}
}

describe('remote chunk provider retries (deterministic clock)', () => {
	test('an unanswered request is re-sent with growing, jittered waits until the deadline', async () => {
		const time = manualClock()
		const net = scriptedPort()
		const provider = createRemoteChunkProvider(net.port, {
			clock: time.clock,
			random: () => 1, // the top of the jitter range: +20%
			attemptTimeoutMs: 1_000,
			maxAttemptTimeoutMs: 4_000,
			deadlineMs: 10_000,
		})
		const outcome = provider.getChunk('h').catch((e: unknown) => e)
		expect(net.sent).toHaveLength(1)
		time.advance(1_199)
		expect(net.sent).toHaveLength(1)
		time.advance(1) // 1 000 ms + 20%
		expect(net.sent).toHaveLength(2)
		time.advance(2_400) // 2 000 ms + 20%
		expect(net.sent).toHaveLength(3)
		time.advance(4_800) // capped at 4 000 ms + 20%
		expect(net.sent).toHaveLength(4)
		time.advance(1_600) // the deadline (10 s) cuts the last wait short
		const error = await outcome
		expect(error).toBeInstanceOf(BlobTransferError)
		expect(error).toMatchObject({ code: 'BLOB_CHUNK_TIMEOUT', attempts: 4, hash: 'h' })
		expect(new Set(net.sent.map((m) => m.requestId)).size).toBe(1)
		expect(time.timerCount()).toBe(0)
	})

	test('a request that cannot be sent reports "not-connected" and goes out on ready', async () => {
		const time = manualClock()
		const net = scriptedPort()
		net.setConnected(false)
		const emitter = new SimpleEventEmitter()
		const events: KoraEvent[] = []
		emitter.on('blob:request-retried', (e) => events.push(e))
		emitter.on('blob:request-failed', (e) => events.push(e))
		const provider = createRemoteChunkProvider(net.port, {
			clock: time.clock,
			random: () => 0.5,
			emitter,
		})
		const outcome = provider.getChunk('h')
		expect(net.sent).toHaveLength(0)
		net.setConnected(true)
		net.fireReady()
		expect(net.sent).toHaveLength(1)
		expect(events).toEqual([
			{
				type: 'blob:request-retried',
				hash: 'h',
				requestId: net.sent[0]?.requestId,
				// The first request that actually left: attempt 1.
				attempt: 1,
				reason: 'reconnected',
			},
		])
		net.answer({
			type: 'blob-chunk-response',
			requestId: net.sent[0]?.requestId ?? '',
			bytes: null,
		})
		// The try that never went out is not an attempt: one request was sent.
		await expect(outcome).rejects.toMatchObject({
			code: 'BLOB_CHUNK_UNAVAILABLE',
			attempts: 1,
			lastReason: 'not-held',
		})
		expect(time.timerCount()).toBe(0)
	})

	test('a throttled answer extends the deadline, and a reconnect does not cut its back-off short', async () => {
		const time = manualClock()
		const net = scriptedPort()
		const provider = createRemoteChunkProvider(net.port, {
			clock: time.clock,
			random: () => 0.5,
			attemptTimeoutMs: 1_000,
			deadlineMs: 3_000,
		})
		const outcome = provider.getChunk('h')
		const requestId = net.sent[0]?.requestId ?? ''
		time.advance(2_900)
		net.answer({
			type: 'blob-chunk-response',
			requestId,
			bytes: null,
			throttled: true,
			retryAfterMs: 2_000,
		})
		const sentBefore = net.sent.length
		net.fireReady()
		expect(net.sent).toHaveLength(sentBefore) // still backing off
		time.advance(2_000)
		expect(net.sent).toHaveLength(sentBefore + 1)
		time.advance(500) // past the original deadline, within the extended one
		net.answer({ type: 'blob-chunk-response', requestId, bytes: new Uint8Array([9]) })
		expect(await outcome).toEqual(new Uint8Array([9]))
		expect(time.timerCount()).toBe(0)
	})

	test('a port that answers synchronously leaves no timer behind', async () => {
		const time = manualClock()
		const handlers: Array<(m: ChunkMessage) => void> = []
		const port: ChunkMessagePort = {
			send(message) {
				if (message.type !== 'blob-chunk-request') return
				for (const handler of handlers) {
					handler({ type: 'blob-chunk-response', requestId: message.requestId, bytes: null })
				}
			},
			onMessage(handler) {
				handlers.push(handler)
			},
		}
		const provider = createRemoteChunkProvider(port, { clock: time.clock })
		await expect(provider.getChunk('h')).rejects.toMatchObject({ code: 'BLOB_CHUNK_UNAVAILABLE' })
		expect(time.timerCount()).toBe(0)
	})

	test('receiveBlob reports a chunk nobody holds as BLOB_CHUNK_UNAVAILABLE', async () => {
		const bytes = randomBytes(100, 3)
		const { manifest } = await prepareBlobForSend(bytes, new MemoryBlobStore(), { chunkSize: 64 })
		const error = await receiveBlob(
			manifest,
			{ getChunk: async () => null },
			{ chunkStore: new MemoryBlobStore(), blobStore: new MemoryBlobStore() },
		).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(BlobTransferError)
		expect(error).toMatchObject({ code: 'BLOB_CHUNK_UNAVAILABLE', lastReason: 'not-held' })
	})
})

describe('a "not held" answer after retries reports the attempts actually made', () => {
	async function untilSent(net: { sent: ChunkRequestMessage[] }, count: number): Promise<void> {
		for (let i = 0; i < 100 && net.sent.length < count; i++) await Promise.resolve()
		expect(net.sent).toHaveLength(count)
	}

	/** Two unanswered attempts re-sent, then the third answered "not held". */
	async function threeAttemptsThenNotHeld(
		time: ReturnType<typeof manualClock>,
		net: ReturnType<typeof scriptedPort>,
	): Promise<void> {
		await untilSent(net, 1)
		time.advance(1_000)
		time.advance(2_000)
		expect(net.sent).toHaveLength(3)
		net.answer({
			type: 'blob-chunk-response',
			requestId: net.sent[2]?.requestId ?? '',
			bytes: null,
		})
	}

	test('receiveBlob: BLOB_CHUNK_UNAVAILABLE carries the true attempt count', async () => {
		const time = manualClock()
		const net = scriptedPort()
		const events: KoraEvent[] = []
		const emitter = new SimpleEventEmitter()
		emitter.on('blob:request-failed', (event) => events.push(event))
		const provider = createRemoteChunkProvider(net.port, {
			clock: time.clock,
			random: () => 0.5,
			attemptTimeoutMs: 1_000,
			emitter,
		})
		const { manifest } = await prepareBlobForSend(randomBytes(50, 4), new MemoryBlobStore(), {
			chunkSize: 64,
		})
		const outcome = receiveBlob(manifest, provider, {
			chunkStore: new MemoryBlobStore(),
			blobStore: new MemoryBlobStore(),
		}).catch((e: unknown) => e)
		await threeAttemptsThenNotHeld(time, net)
		const error = await outcome
		expect(error).toBeInstanceOf(BlobTransferError)
		expect(error).toMatchObject({
			code: 'BLOB_CHUNK_UNAVAILABLE',
			hash: manifest.chunkHashes[0],
			attempts: 3,
			lastReason: 'not-held',
		})
		expect(events).toMatchObject([
			{
				type: 'blob:request-failed',
				code: 'BLOB_CHUNK_UNAVAILABLE',
				attempts: 3,
				reason: 'not-held',
			},
		])
		expect(provider.pendingCount()).toBe(0)
		expect(time.timerCount()).toBe(0)
	})

	test('fetchBlobManifest: BLOB_CHUNK_UNAVAILABLE carries the true attempt count', async () => {
		const time = manualClock()
		const net = scriptedPort()
		const provider = createRemoteChunkProvider(net.port, {
			clock: time.clock,
			random: () => 0.5,
			attemptTimeoutMs: 1_000,
		})
		const outcome = fetchBlobManifest(provider, 'm'.repeat(64)).catch((e: unknown) => e)
		await threeAttemptsThenNotHeld(time, net)
		expect(await outcome).toMatchObject({
			code: 'BLOB_CHUNK_UNAVAILABLE',
			hash: 'm'.repeat(64),
			attempts: 3,
			lastReason: 'not-held',
		})
	})

	test('a custom provider answering null is one provider call: attempts 1', async () => {
		const error = await fetchBlobManifest({ getChunk: async () => null }, 'n'.repeat(64)).catch(
			(e: unknown) => e,
		)
		expect(error).toMatchObject({
			code: 'BLOB_CHUNK_UNAVAILABLE',
			attempts: 1,
			lastReason: 'not-held',
		})
	})
})

describe('remote chunk provider: attempts count only requests that left the port', () => {
	function recorder(): { emitter: SimpleEventEmitter; events: KoraEvent[] } {
		const emitter = new SimpleEventEmitter()
		const events: KoraEvent[] = []
		emitter.on('blob:request-retried', (e) => events.push(e))
		emitter.on('blob:request-failed', (e) => events.push(e))
		return { emitter, events }
	}

	test('a request that never left times out with attempts 0, "not-connected", and no retry events', async () => {
		const time = manualClock()
		const net = scriptedPort()
		net.setConnected(false)
		const { emitter, events } = recorder()
		const provider = createRemoteChunkProvider(net.port, {
			clock: time.clock,
			random: () => 0.5,
			attemptTimeoutMs: 1_000,
			deadlineMs: 10_000,
			emitter,
		})
		const outcome = provider.getChunk('h').catch((e: unknown) => e)
		time.advance(10_000)
		expect(await outcome).toMatchObject({
			code: 'BLOB_CHUNK_TIMEOUT',
			attempts: 0,
			lastReason: 'not-connected',
		})
		expect(events).toMatchObject([
			{ type: 'blob:request-failed', attempts: 0, reason: 'not-connected' },
		])
		expect(time.timerCount()).toBe(0)
	})

	test('a request that never left is cancelled with attempts 0', async () => {
		const time = manualClock()
		const net = scriptedPort()
		net.setConnected(false)
		const { emitter, events } = recorder()
		const provider = createRemoteChunkProvider(net.port, { clock: time.clock, emitter })
		const outcome = provider.getChunk('h').catch((e: unknown) => e)
		provider.close()
		expect(await outcome).toMatchObject({
			code: 'BLOB_CHUNK_CANCELLED',
			attempts: 0,
			lastReason: 'closed',
		})
		expect(events).toMatchObject([
			{ type: 'blob:request-failed', code: 'BLOB_CHUNK_CANCELLED', attempts: 0 },
		])
	})

	test('offline tries between real sends are not counted, and retry events number real sends', async () => {
		const time = manualClock()
		const net = scriptedPort()
		const { emitter, events } = recorder()
		const provider = createRemoteChunkProvider(net.port, {
			clock: time.clock,
			random: () => 0.5,
			attemptTimeoutMs: 1_000,
			deadlineMs: 60_000,
			emitter,
		})
		const outcome = provider.getChunk('h').catch((e: unknown) => e)
		expect(net.sent).toHaveLength(1) // attempt 1
		net.setConnected(false)
		time.advance(1_000) // a try that cannot be sent
		time.advance(2_000) // another
		expect(net.sent).toHaveLength(1)
		net.setConnected(true)
		net.fireReady() // attempt 2
		expect(net.sent).toHaveLength(2)
		expect(events).toEqual([
			{
				type: 'blob:request-retried',
				hash: 'h',
				requestId: net.sent[0]?.requestId,
				attempt: 2,
				reason: 'reconnected',
			},
		])
		net.answer({
			type: 'blob-chunk-response',
			requestId: net.sent[1]?.requestId ?? '',
			bytes: null,
		})
		expect(await outcome).toMatchObject({ code: 'BLOB_CHUNK_UNAVAILABLE', attempts: 2 })
	})

	test('a port that throws on send did not send: the try is not counted', async () => {
		const time = manualClock()
		const handlers: Array<(m: ChunkMessage) => void> = []
		let throwing = true
		const sent: ChunkRequestMessage[] = []
		const port: ChunkMessagePort = {
			send(message) {
				if (throwing) throw new Error('socket closed')
				if (message.type === 'blob-chunk-request') sent.push(message)
			},
			onMessage(handler) {
				handlers.push(handler)
			},
		}
		const provider = createRemoteChunkProvider(port, {
			clock: time.clock,
			random: () => 0.5,
			attemptTimeoutMs: 1_000,
		})
		const outcome = provider.getChunk('h').catch((e: unknown) => e)
		throwing = false
		time.advance(1_000)
		expect(sent).toHaveLength(1)
		for (const handler of handlers) {
			handler({ type: 'blob-chunk-response', requestId: sent[0]?.requestId ?? '', bytes: null })
		}
		expect(await outcome).toMatchObject({ code: 'BLOB_CHUNK_UNAVAILABLE', attempts: 1 })
	})

	test('the deprecated timeoutMs is the deadline when deadlineMs is absent', async () => {
		const time = manualClock()
		const net = scriptedPort()
		const provider = createRemoteChunkProvider(net.port, {
			clock: time.clock,
			random: () => 0.5,
			timeoutMs: 3_000,
		})
		const outcome = provider.getChunk('h').catch((e: unknown) => e)
		time.advance(2_999)
		expect(provider.pendingCount()).toBe(1)
		time.advance(1)
		expect(await outcome).toMatchObject({ code: 'BLOB_CHUNK_TIMEOUT', attempts: 1 })
	})

	test('an answer after the request failed is ignored: no second event, nothing pending', async () => {
		const time = manualClock()
		const net = scriptedPort()
		const { emitter, events } = recorder()
		const provider = createRemoteChunkProvider(net.port, {
			clock: time.clock,
			random: () => 0.5,
			deadlineMs: 1_000,
			emitter,
		})
		const outcome = provider.getChunk('h').catch((e: unknown) => e)
		time.advance(1_000)
		expect(await outcome).toMatchObject({ code: 'BLOB_CHUNK_TIMEOUT' })
		const requestId = net.sent[0]?.requestId ?? ''
		net.answer({ type: 'blob-chunk-response', requestId, bytes: new Uint8Array([1]) })
		net.answer({ type: 'blob-chunk-response', requestId, bytes: null })
		net.answer({ type: 'blob-chunk-response', requestId, bytes: null, throttled: true })
		expect(events.filter((e) => e.type === 'blob:request-failed')).toHaveLength(1)
		expect(provider.pendingCount()).toBe(0)
		expect(time.timerCount()).toBe(0)
	})

	test('close() is idempotent: each pending request fails once, later requests are refused', async () => {
		const time = manualClock()
		const net = scriptedPort()
		const { emitter, events } = recorder()
		const provider = createRemoteChunkProvider(net.port, { clock: time.clock, emitter })
		const a = provider.getChunk('a').catch((e: unknown) => e)
		const b = provider.getChunk('b').catch((e: unknown) => e)
		provider.close()
		provider.close()
		expect(await a).toMatchObject({ code: 'BLOB_CHUNK_CANCELLED', hash: 'a', attempts: 1 })
		expect(await b).toMatchObject({ code: 'BLOB_CHUNK_CANCELLED', hash: 'b', attempts: 1 })
		expect(events.filter((e) => e.type === 'blob:request-failed')).toHaveLength(2)
		await expect(provider.getChunk('c')).rejects.toMatchObject({
			code: 'BLOB_CHUNK_CANCELLED',
			attempts: 0,
		})
		net.fireReady()
		expect(net.sent).toHaveLength(2)
		expect(time.timerCount()).toBe(0)
	})
})
