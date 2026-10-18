import { type KoraEventEmitter, generateUUIDv7 } from '@korajs/core'
import type { ChunkProvider } from './blob-transfer'
import {
	type BlobChunkFailureReason,
	BlobTransferError,
	type BlobTransferErrorCode,
} from './blob-transfer-error'
import type { ContentAddressedBlobStore } from './content-addressed-blob-store'

/**
 * Blob chunk exchange messages. These ride any message transport (the sync
 * WebSocket in production, an in-memory pair in tests). A receiver requests a
 * chunk by hash and correlates the answer by `requestId`.
 */
export interface ChunkRequestMessage {
	type: 'blob-chunk-request'
	requestId: string
	hash: string
}
export interface ChunkResponseMessage {
	type: 'blob-chunk-response'
	requestId: string
	/** The chunk bytes, or null when the responder does not hold that hash. */
	bytes: Uint8Array | null
	/**
	 * The server refused the request for rate, not because the chunk is missing
	 * (RT-24). The requester retries after `retryAfterMs` instead of failing.
	 */
	throttled?: boolean
	/** With `throttled`: how long to wait before retrying, in ms. */
	retryAfterMs?: number
}
export type ChunkMessage = ChunkRequestMessage | ChunkResponseMessage

/**
 * A bidirectional message port carrying {@link ChunkMessage}s. Implemented over
 * the sync connection in production; `createChunkPortPair` provides an in-memory
 * duplex pair for tests.
 */
export interface ChunkMessagePort {
	/**
	 * Send a message. Returns `false` when it could not be sent (no live connection);
	 * any other return (including none) counts as sent.
	 */
	// biome-ignore lint/suspicious/noConfusingVoidType: ports written against the earlier void-returning signature must still type-check; only an explicit false means "not sent".
	send(message: ChunkMessage): boolean | void
	/** Register a handler for incoming messages. Multiple handlers are allowed. */
	onMessage(handler: (message: ChunkMessage) => void): void
	/**
	 * Optional: register a handler called each time the connection becomes able to
	 * carry requests again (after a connect or a reconnect). A requester re-sends its
	 * pending requests there, since they may have been lost with the old connection.
	 * Handlers live as long as the port.
	 */
	onReady?(handler: () => void): void
}

/** A {@link ChunkProvider} that fetches chunks over a message port. */
export interface RemoteChunkProvider extends ChunkProvider {
	/** Number of requests still awaiting a response (for diagnostics/tests). */
	pendingCount(): number
	/**
	 * Stop: every pending request rejects with `BLOB_CHUNK_CANCELLED`, every timer is
	 * cleared, and later `getChunk` calls reject at once. Called when the app closes.
	 */
	close(): void
}

/** Timer functions the provider uses; injectable so tests need no real time. */
export interface ChunkProviderClock {
	now(): number
	setTimeout(callback: () => void, delayMs: number): unknown
	clearTimeout(handle: unknown): void
}

/** Options for {@link createRemoteChunkProvider}. */
export interface RemoteChunkProviderOptions {
	/**
	 * Longest time one request may go without any answer before it fails with
	 * `BLOB_CHUNK_TIMEOUT` (default 2 minutes). Until then it is re-sent, under the
	 * same request id, each time an attempt goes unanswered and each time the
	 * connection comes back. A "throttled" answer counts as an answer.
	 */
	deadlineMs?: number
	/** @deprecated Use `deadlineMs`: the time after which a request nobody answers fails. */
	timeoutMs?: number
	/** Wait for an answer to the first attempt before re-sending, in ms (default 5 s). */
	attemptTimeoutMs?: number
	/** Largest wait for one attempt; each unanswered attempt doubles it (default 30 s). */
	maxAttemptTimeoutMs?: number
	/** Random spread of each attempt wait, as a fraction (default 0.2, so plus or minus 20%). */
	jitter?: number
	/**
	 * Longest time, counted from the request's start, after which a "throttled" answer
	 * fails the request instead of being waited out (default 10 minutes). The transfer
	 * is resumable, so a failed request can simply be retried later.
	 */
	maxThrottleWaitMs?: number
	/** Smallest back-off after a throttled answer, in ms (default 250). */
	minThrottleDelayMs?: number
	/** Largest single back-off after a throttled answer, in ms (default 30s). */
	maxThrottleDelayMs?: number
	/** Receives `blob:request-retried` and `blob:request-failed`. */
	emitter?: KoraEventEmitter
	/** Clock and timers (default: `Date.now`, `setTimeout`, `clearTimeout`). */
	clock?: ChunkProviderClock
	/** Random source in [0, 1) for the jitter (default `Math.random`). */
	random?: () => number
}

/** Default time after which a request that nobody answers fails. */
export const DEFAULT_BLOB_CHUNK_DEADLINE_MS = 120_000
/** Default wait for an answer to a request's first attempt. */
export const DEFAULT_BLOB_CHUNK_ATTEMPT_TIMEOUT_MS = 5_000
/** Default largest wait for one attempt. */
export const DEFAULT_BLOB_CHUNK_MAX_ATTEMPT_TIMEOUT_MS = 30_000

const DEFAULT_CLOCK: ChunkProviderClock = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

type RetryReason = 'timeout' | 'not-connected' | 'reconnected' | 'throttled'

interface PendingChunkRequest {
	requestId: string
	hash: string
	resolve: (bytes: Uint8Array | null) => void
	reject: (error: Error) => void
	/** The one timer this request owns: its attempt timeout or a throttle back-off. */
	timer: unknown
	/** Waiting out a throttle back-off (a reconnect does not cut it short). */
	backingOff: boolean
	startedAtMs: number
	/** When the other side last answered about this request (start, or a throttle). */
	lastAnswerAtMs: number
	/** Requests that actually left the port (a send that returned false or threw is not one). */
	attempts: number
	/** Every try, sent or not: drives the growing wait between tries. */
	tries: number
	throttledCount: number
	lastReason: BlobChunkFailureReason
}

/**
 * Create a {@link ChunkProvider} that requests chunks over a message port and
 * correlates each answer to its request by `requestId`.
 *
 * A request never rests on a single message: an unanswered attempt is re-sent,
 * under the same request id, after a wait that grows from `attemptTimeoutMs` to
 * `maxAttemptTimeoutMs` (with jitter), and every pending request is re-sent when
 * the port reports the connection ready again. Only after `deadlineMs` without any
 * answer does it fail, with a {@link BlobTransferError} (`BLOB_CHUNK_TIMEOUT`)
 * carrying the hash, the attempt count and the last reason. Re-sending is safe:
 * answering a chunk request only reads, and the first answer wins.
 *
 * A "not held" answer rejects with `BLOB_CHUNK_UNAVAILABLE` (the attempt count and
 * `lastReason: 'not-held'`) rather than resolving null, so the error reports how many
 * attempts were made; `getChunk` resolves only with bytes.
 *
 * A "throttled" answer (the server's blob request budget is spent, RT-24) is not a
 * failure: the request is re-sent after the server's `retryAfterMs` (bounded, with
 * exponential back-off when absent), until `maxThrottleWaitMs` has elapsed.
 *
 * @param port - The message port to the peer that holds the blob
 * @param options - Deadlines, back-off bounds, events and an injectable clock
 */
export function createRemoteChunkProvider(
	port: ChunkMessagePort,
	options: RemoteChunkProviderOptions = {},
): RemoteChunkProvider {
	const deadlineMs = options.deadlineMs ?? options.timeoutMs ?? DEFAULT_BLOB_CHUNK_DEADLINE_MS
	const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_BLOB_CHUNK_ATTEMPT_TIMEOUT_MS
	const maxAttemptTimeoutMs = Math.max(
		attemptTimeoutMs,
		options.maxAttemptTimeoutMs ?? DEFAULT_BLOB_CHUNK_MAX_ATTEMPT_TIMEOUT_MS,
	)
	const jitter = Math.min(1, Math.max(0, options.jitter ?? 0.2))
	const maxThrottleWaitMs = options.maxThrottleWaitMs ?? 10 * 60_000
	const minDelayMs = options.minThrottleDelayMs ?? 250
	const maxDelayMs = options.maxThrottleDelayMs ?? 30_000
	const clock = options.clock ?? DEFAULT_CLOCK
	const random = options.random ?? Math.random
	const emitter = options.emitter ?? null
	const pending = new Map<string, PendingChunkRequest>()
	let closed = false

	/** Remove a request and its timer. False when it already ended (first answer wins). */
	const finish = (entry: PendingChunkRequest): boolean => {
		if (pending.get(entry.requestId) !== entry) return false
		pending.delete(entry.requestId)
		clock.clearTimeout(entry.timer)
		return true
	}

	const fail = (entry: PendingChunkRequest, code: BlobTransferErrorCode, message: string): void => {
		if (!finish(entry)) return
		emitter?.emit({
			type: 'blob:request-failed',
			hash: entry.hash,
			requestId: entry.requestId,
			attempts: entry.attempts,
			code,
			reason: entry.lastReason,
			message,
		})
		entry.reject(new BlobTransferError(message, code, entry.hash, entry.attempts, entry.lastReason))
	}

	/** The wait for an answer to the current attempt, never past the deadline. */
	const attemptWaitMs = (entry: PendingChunkRequest): number => {
		const base = Math.min(maxAttemptTimeoutMs, attemptTimeoutMs * 2 ** (entry.tries - 1))
		const spread = base * jitter * (2 * random() - 1)
		const wait = Math.max(1, Math.round(base + spread))
		const remaining = entry.lastAnswerAtMs + deadlineMs - clock.now()
		return Math.max(0, Math.min(wait, remaining))
	}

	/**
	 * Try to send the request (the first try, or a retry under the same request id) and
	 * arm its timeout. Only a request that left the port counts as an attempt and emits
	 * `blob:request-retried` (numbered by the requests actually sent), so `attempts`
	 * never counts a try made while offline.
	 */
	const attempt = (entry: PendingChunkRequest, retryReason: RetryReason | null): void => {
		if (pending.get(entry.requestId) !== entry) return
		clock.clearTimeout(entry.timer)
		entry.backingOff = false
		entry.tries += 1
		// Counted before sending, so a port that answers synchronously (inside send) is
		// reported with this attempt included; taken back below if it was not sent.
		entry.attempts += 1
		entry.lastReason = 'timeout'
		// Armed before sending: a port that answers synchronously finds the timer to
		// clear (or replace with a throttle back-off) instead of leaking a new one.
		entry.timer = clock.setTimeout(() => onAttemptTimeout(entry), attemptWaitMs(entry))
		let sent: boolean
		try {
			sent =
				port.send({ type: 'blob-chunk-request', requestId: entry.requestId, hash: entry.hash }) !==
				false
		} catch {
			// A port that throws (its connection just closed) did not send: the request
			// stays pending and is re-sent by its timer or on ready, never lost.
			sent = false
		}
		if (!sent) {
			if (pending.get(entry.requestId) === entry) {
				entry.attempts -= 1
				if (!entry.backingOff) entry.lastReason = 'not-connected'
			}
			return
		}
		if (retryReason !== null) {
			emitter?.emit({
				type: 'blob:request-retried',
				hash: entry.hash,
				requestId: entry.requestId,
				attempt: entry.attempts,
				reason: retryReason,
			})
		}
	}

	const retry = (entry: PendingChunkRequest, reason: RetryReason): void => {
		attempt(entry, reason)
	}

	const onAttemptTimeout = (entry: PendingChunkRequest): void => {
		if (pending.get(entry.requestId) !== entry) return
		if (clock.now() - entry.lastAnswerAtMs >= deadlineMs) {
			fail(
				entry,
				'BLOB_CHUNK_TIMEOUT',
				`Blob chunk request for ${entry.hash} got no answer within ${deadlineMs}ms (${entry.attempts} attempts, last: ${entry.lastReason}). The transfer is resumable: pull the blob again to fetch the missing chunks.`,
			)
			return
		}
		retry(entry, entry.lastReason === 'not-connected' ? 'not-connected' : 'timeout')
	}

	port.onMessage((message) => {
		if (message.type !== 'blob-chunk-response') {
			return
		}
		const entry = pending.get(message.requestId)
		if (!entry) {
			// Already answered (a re-sent request is answered twice), failed or closed:
			// the first answer won, so a late duplicate is ignored.
			return
		}
		if (message.throttled === true) {
			// Over the server's blob budget: back off and ask again, same request id.
			clock.clearTimeout(entry.timer)
			const now = clock.now()
			entry.lastAnswerAtMs = now
			entry.lastReason = 'throttled'
			entry.throttledCount += 1
			const backoff = Math.min(maxDelayMs, minDelayMs * 2 ** (entry.throttledCount - 1))
			const delay = Math.min(maxDelayMs, Math.max(minDelayMs, message.retryAfterMs ?? backoff))
			if (now + delay - entry.startedAtMs > maxThrottleWaitMs) {
				fail(
					entry,
					'BLOB_CHUNK_TIMEOUT',
					`Blob chunk request for ${entry.hash} was throttled for longer than ${maxThrottleWaitMs}ms`,
				)
				return
			}
			entry.backingOff = true
			entry.timer = clock.setTimeout(() => retry(entry, 'throttled'), delay)
			return
		}
		if (message.bytes === null) {
			// A real answer ("not held"). It fails here, not as a bare null, so the error
			// carries what only this provider measured: how many attempts were sent before
			// the answer (re-sends after silence, reconnects, throttles), not a guessed 1.
			// The ChunkProvider contract allows either; receiveBlob and fetchBlobManifest
			// report both as BLOB_CHUNK_UNAVAILABLE.
			entry.lastReason = 'not-held'
			fail(
				entry,
				'BLOB_CHUNK_UNAVAILABLE',
				`Blob chunk ${entry.hash} could not be obtained after ${entry.attempts} attempts: no reachable peer or server holds it, or may share it with this device`,
			)
			return
		}
		if (!finish(entry)) return
		entry.resolve(message.bytes)
	})

	// Requests pending across a reconnect may have been lost with the old connection
	// (or never sent): re-send them at once instead of waiting out their timers.
	port.onReady?.(() => {
		if (closed) return
		for (const entry of [...pending.values()]) {
			if (entry.backingOff) continue
			retry(entry, 'reconnected')
		}
	})

	return {
		pendingCount: () => pending.size,
		close(): void {
			if (closed) return
			closed = true
			for (const entry of [...pending.values()]) {
				entry.lastReason = 'closed'
				fail(
					entry,
					'BLOB_CHUNK_CANCELLED',
					`Blob chunk request for ${entry.hash} was cancelled: the chunk provider closed`,
				)
			}
		},
		getChunk(hash: string): Promise<Uint8Array | null> {
			if (closed) {
				return Promise.reject(
					new BlobTransferError(
						`Blob chunk request for ${hash} was refused: the chunk provider is closed`,
						'BLOB_CHUNK_CANCELLED',
						hash,
						0,
						'closed',
					),
				)
			}
			const requestId = generateUUIDv7()
			return new Promise<Uint8Array | null>((resolve, reject) => {
				const now = clock.now()
				const entry: PendingChunkRequest = {
					requestId,
					hash,
					resolve,
					reject,
					timer: undefined,
					backingOff: false,
					startedAtMs: now,
					lastAnswerAtMs: now,
					attempts: 0,
					tries: 0,
					throttledCount: 0,
					lastReason: 'timeout',
				}
				pending.set(requestId, entry)
				attempt(entry, null)
			})
		},
	}
}

/**
 * Serve blob chunk requests arriving on a message port from a blob store. Answers
 * each `blob-chunk-request` with the bytes for that hash, or null when the store
 * does not hold it. Returns nothing; attach it once per connection.
 *
 * @param port - The message port from the peer requesting chunks
 * @param blobStore - The store to serve chunks from (keyed by chunk hash)
 */
export function serveBlobChunks(
	port: ChunkMessagePort,
	blobStore: ContentAddressedBlobStore,
): void {
	port.onMessage((message) => {
		if (message.type !== 'blob-chunk-request') {
			return
		}
		void blobStore.get(message.hash).then(
			(bytes) => {
				port.send({ type: 'blob-chunk-response', requestId: message.requestId, bytes })
			},
			() => {
				// Integrity failure or read error: report as not-held rather than
				// crashing the connection. The requester treats null as unavailable.
				port.send({ type: 'blob-chunk-response', requestId: message.requestId, bytes: null })
			},
		)
	})
}

/**
 * Create a connected in-memory pair of {@link ChunkMessagePort}s. Messages sent
 * on one arrive on the other, asynchronously (next microtask) so the pair models
 * a real transport rather than re-entrant synchronous delivery. For tests.
 */
export function createChunkPortPair(): { a: ChunkMessagePort; b: ChunkMessagePort } {
	const handlersA: Array<(m: ChunkMessage) => void> = []
	const handlersB: Array<(m: ChunkMessage) => void> = []

	const a: ChunkMessagePort = {
		send(message) {
			queueMicrotask(() => {
				for (const handler of handlersB) {
					handler(message)
				}
			})
			return true
		},
		onMessage(handler) {
			handlersA.push(handler)
		},
	}
	const b: ChunkMessagePort = {
		send(message) {
			queueMicrotask(() => {
				for (const handler of handlersA) {
					handler(message)
				}
			})
			return true
		},
		onMessage(handler) {
			handlersB.push(handler)
		},
	}
	return { a, b }
}
