/**
 * Every path that answers a relay request also ends its pending entry (2026-10-18).
 *
 * Before the fix a retry served by the central store sent the bytes but left the entry
 * the first attempt had created for a silent peer. That entry kept counting against the
 * session's pending cap until its TTL and then produced a spurious "not held" for a
 * request already answered. A late peer answer, or a concurrent attempt still consulting
 * the policy, could likewise answer a completed request a second time.
 */
import { hashBlob } from '@korajs/core'
import {
	type BlobChunkRequestMessage,
	type BlobChunkResponseMessage,
	type SyncMessage,
	encodeBlobChunkBytes,
} from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import type { ServerTransport } from '../transport/server-transport'
import { BlobChunkRelay, type BlobChunkRelayClock } from './blob-chunk-relay'

interface ManualClock extends BlobChunkRelayClock {
	advance(ms: number): void
	/** Move time without running due timers (a message that races its timer). */
	jump(ms: number): void
	activeTimers(): number
}

/** A clock whose time moves only when the test says so; due timers fire in order. */
function manualClock(): ManualClock {
	let now = 0
	let nextId = 1
	const timers = new Map<number, { at: number; callback: () => void }>()
	return {
		now: () => now,
		setTimeout(callback, delayMs) {
			const id = nextId++
			timers.set(id, { at: now + Math.max(0, delayMs), callback })
			return id
		},
		clearTimeout(handle) {
			if (typeof handle === 'number') timers.delete(handle)
		},
		advance(ms) {
			const target = now + ms
			for (;;) {
				let dueId: number | null = null
				let dueAt = Number.POSITIVE_INFINITY
				for (const [id, timer] of timers) {
					if (timer.at <= target && timer.at < dueAt) {
						dueId = id
						dueAt = timer.at
					}
				}
				if (dueId === null) break
				const timer = timers.get(dueId)
				timers.delete(dueId)
				// Never backwards: after a jump (suspension) overdue timers run late, at "now".
				now = Math.max(now, dueAt)
				timer?.callback()
			}
			now = target
		},
		jump(ms) {
			now += ms
		},
		activeTimers: () => timers.size,
	}
}

function fakeTransport(): ServerTransport & { sent: SyncMessage[] } {
	const sent: SyncMessage[] = []
	const transport = {
		sent,
		send: (m: SyncMessage) => void sent.push(m),
		isConnected: () => true,
	}
	return transport as unknown as ServerTransport & { sent: SyncMessage[] }
}

const HASH = 'e'.repeat(64)
const req = (requestId: string, hash = HASH): BlobChunkRequestMessage => ({
	type: 'blob-chunk-request',
	messageId: `m-${requestId}`,
	requestId,
	hash,
})
const answers = (t: { sent: SyncMessage[] }): BlobChunkResponseMessage[] =>
	t.sent.filter((m): m is BlobChunkResponseMessage => m.type === 'blob-chunk-response')
const open = { canReadFromStore: async () => false, canForward: async () => true }

/** A central store the test fills (and can hold mid-read) as it goes. */
function centralStore(): {
	resolve: (hash: string) => Promise<Uint8Array | null>
	put(hash: string, bytes: Uint8Array): void
	holdNextRead(): () => void
} {
	const held = new Map<string, Uint8Array>()
	let hold: Promise<void> | null = null
	return {
		async resolve(hash) {
			if (hold) {
				const wait = hold
				hold = null
				await wait
			}
			return held.get(hash) ?? null
		},
		put(hash, bytes) {
			held.set(hash, bytes)
		},
		holdNextRead() {
			let release: () => void = () => undefined
			hold = new Promise<void>((resolve) => {
				release = resolve
			})
			return () => release()
		},
	}
}

const storeAndPeers = { canReadFromStore: async () => true, canForward: async () => true }

describe('blob chunk relay: an answered request leaves nothing pending', () => {
	test('silent peer, retry served by the central store: no later "not held", allowance freed', async () => {
		const clock = manualClock()
		const store = centralStore()
		const relay = new BlobChunkRelay(store.resolve, storeAndPeers, {
			pendingTtlMs: 60_000,
			maxPendingPerSession: 2,
			clock,
		})
		const bytes = new Uint8Array([1, 2, 3])
		const hash = await hashBlob(bytes)
		const requester = fakeTransport()
		const peer = fakeTransport()
		relay.addClient('A', requester)
		relay.addClient('B', peer)

		// Not in the store yet: forwarded to a peer that never answers.
		await relay.handleRequest('A', req('r1', hash))
		expect(peer.sent).toHaveLength(1)
		expect(relay.getPendingCount()).toBe(1)

		// Persistence completes; the client's retry is served by the store.
		store.put(hash, bytes)
		clock.advance(5_000)
		await relay.handleRequest('A', req('r1', hash))
		expect(answers(requester).map((m) => m.bytes)).toEqual([encodeBlobChunkBytes(bytes)])
		expect(relay.getPendingCount()).toBe(0)
		expect(clock.activeTimers()).toBe(0)

		// A burst that fills the cap is taken, not throttled.
		await relay.handleRequest('A', req('r2'))
		await relay.handleRequest('A', req('r3'))
		expect(answers(requester).filter((m) => m.throttled === true)).toHaveLength(0)
		expect(relay.getPendingCount()).toBe(2)

		// Past r1's TTL: r1 gets no second answer; only r2 and r3 expire.
		clock.advance(60_000)
		expect(answers(requester).map((m) => m.requestId)).toEqual(['r1', 'r2', 'r3'])
		expect(relay.getStats().expired).toBe(2)
		expect(clock.activeTimers()).toBe(0)
	})

	test('a late peer answer after a central-store answer sends nothing and leaves nothing', async () => {
		const clock = manualClock()
		const store = centralStore()
		const relay = new BlobChunkRelay(store.resolve, storeAndPeers, { clock })
		const bytes = new Uint8Array([4, 5, 6])
		const hash = await hashBlob(bytes)
		const requester = fakeTransport()
		relay.addClient('A', requester)
		relay.addClient('B', fakeTransport())
		await relay.handleRequest('A', req('r1', hash))
		store.put(hash, bytes)
		await relay.handleRequest('A', req('r1', hash))
		expect(answers(requester)).toHaveLength(1)

		await relay.handleResponse('B', {
			type: 'blob-chunk-response',
			messageId: 'b-r1',
			requestId: 'r1',
			bytes: encodeBlobChunkBytes(bytes),
		})
		await relay.handleResponse('B', {
			type: 'blob-chunk-response',
			messageId: 'b-r1-null',
			requestId: 'r1',
			bytes: null,
		})
		clock.advance(120_000)
		expect(answers(requester)).toHaveLength(1)
		expect(relay.getPendingCount()).toBe(0)
		expect(clock.activeTimers()).toBe(0)
	})

	test("a peer's bytes arriving while a retry reads the central store are the only answer", async () => {
		const clock = manualClock()
		const store = centralStore()
		const relay = new BlobChunkRelay(store.resolve, storeAndPeers, { clock })
		const bytes = new Uint8Array([7, 7, 7])
		const hash = await hashBlob(bytes)
		const requester = fakeTransport()
		relay.addClient('A', requester)
		relay.addClient('B', fakeTransport())
		await relay.handleRequest('A', req('r1', hash))
		store.put(hash, bytes)
		const release = store.holdNextRead()
		const retry = relay.handleRequest('A', req('r1', hash))
		await relay.handleResponse('B', {
			type: 'blob-chunk-response',
			messageId: 'b-r1',
			requestId: 'r1',
			bytes: encodeBlobChunkBytes(bytes),
		})
		release()
		await retry
		expect(answers(requester)).toHaveLength(1)
		expect(relay.getPendingCount()).toBe(0)
		expect(clock.activeTimers()).toBe(0)
	})

	test('a first attempt still consulting the policy does not re-open a request the store answered', async () => {
		const clock = manualClock()
		const store = centralStore()
		let gate: (() => void) | null = null
		let holdNext = true
		const relay = new BlobChunkRelay(
			store.resolve,
			{
				canReadFromStore: async () => true,
				canForward: () =>
					holdNext
						? new Promise<boolean>((resolve) => {
								holdNext = false
								gate = () => resolve(true)
							})
						: Promise.resolve(true),
			},
			{ clock },
		)
		const bytes = new Uint8Array([9, 9])
		const hash = await hashBlob(bytes)
		const requester = fakeTransport()
		const peer = fakeTransport()
		relay.addClient('A', requester)
		relay.addClient('B', peer)
		const first = relay.handleRequest('A', req('r1', hash))
		// Let the first attempt miss the store and reach the (held) forwarding check.
		for (let i = 0; i < 100 && gate === null; i++) await Promise.resolve()
		expect(gate).not.toBeNull()
		store.put(hash, bytes)
		await relay.handleRequest('A', req('r1', hash))
		expect(answers(requester)).toHaveLength(1)
		const release: () => void = gate ?? (() => undefined)
		release()
		await first
		clock.advance(120_000)
		expect(answers(requester)).toHaveLength(1)
		expect(peer.sent).toHaveLength(0)
		expect(relay.getPendingCount()).toBe(0)
		expect(clock.activeTimers()).toBe(0)
	})

	test("a central-store answer leaves another session's request under the same id alone", async () => {
		const clock = manualClock()
		const store = centralStore()
		const relay = new BlobChunkRelay(store.resolve, storeAndPeers, { pendingTtlMs: 1_000, clock })
		const bytes = new Uint8Array([3, 1])
		const hash = await hashBlob(bytes)
		const a = fakeTransport()
		const c = fakeTransport()
		relay.addClient('A', a)
		relay.addClient('B', fakeTransport())
		relay.addClient('C', c)
		await relay.handleRequest('A', req('r1'))
		store.put(hash, bytes)
		await relay.handleRequest('C', req('r1', hash))
		expect(answers(c).map((m) => m.bytes)).toEqual([encodeBlobChunkBytes(bytes)])
		expect(relay.getPendingCount()).toBe(1)
		clock.advance(1_000)
		expect(answers(a).map((m) => m.bytes)).toEqual([null])
	})
})

describe('blob chunk relay: any answer closes the attempts begun before it', () => {
	/** canForward: the first call is held until released (then admits); later calls use `admitLater`. */
	function heldFirstForward(admitLater: () => boolean): {
		canForward: () => Promise<boolean>
		release(): void
		held(): boolean
	} {
		let gate: (() => void) | null = null
		let first = true
		return {
			canForward: () => {
				if (first) {
					first = false
					return new Promise<boolean>((resolve) => {
						gate = () => resolve(true)
					})
				}
				return Promise.resolve(admitLater())
			},
			release: () => {
				const open: () => void = gate ?? (() => undefined)
				open()
			},
			held: () => gate !== null,
		}
	}

	test('an immediate "not held" (nobody to ask) stops an older attempt from forwarding later', async () => {
		const clock = manualClock()
		const forward = heldFirstForward(() => false)
		const relay = new BlobChunkRelay(
			undefined,
			{ canReadFromStore: async () => false, canForward: forward.canForward },
			{ clock },
		)
		const requester = fakeTransport()
		const peer = fakeTransport()
		relay.addClient('A', requester)
		relay.addClient('B', peer)
		const older = relay.handleRequest('A', req('r1'))
		for (let i = 0; i < 100 && !forward.held(); i++) await Promise.resolve()
		expect(forward.held()).toBe(true)
		// The retry finds nobody it may ask: answered "not held" at once.
		await relay.handleRequest('A', req('r1'))
		expect(answers(requester).map((m) => m.bytes)).toEqual([null])
		// The older attempt's policy result (now admitting B) arrives afterwards.
		forward.release()
		await older
		clock.advance(120_000)
		expect(answers(requester)).toHaveLength(1)
		expect(peer.sent).toHaveLength(0)
		expect(relay.getPendingCount()).toBe(0)
		expect(clock.activeTimers()).toBe(0)
	})

	test('a "throttled" answer stops an older attempt from registering or answering again', async () => {
		const clock = manualClock()
		const forward = heldFirstForward(() => true)
		const relay = new BlobChunkRelay(
			undefined,
			{ canReadFromStore: async () => false, canForward: forward.canForward },
			{ clock },
		)
		const requester = fakeTransport()
		const peer = fakeTransport()
		relay.addClient('A', requester)
		relay.addClient('B', peer)
		relay.addClient('X', fakeTransport())
		const older = relay.handleRequest('A', req('r1'))
		for (let i = 0; i < 100 && !forward.held(); i++) await Promise.resolve()
		expect(forward.held()).toBe(true)
		// Another session takes r1 meanwhile; A's retry is refused "throttled".
		await relay.handleRequest('X', req('r1'))
		await relay.handleRequest('A', req('r1'))
		expect(answers(requester).map((m) => [m.requestId, m.throttled])).toEqual([['r1', true]])
		forward.release()
		await older
		// The older attempt neither registered, forwarded, nor answered (or counted) again.
		expect(answers(requester)).toHaveLength(1)
		expect(relay.getStats().refusedDuplicateRequestId).toBe(1)
		expect(relay.getPendingCount()).toBe(1)
		expect(peer.sent).toHaveLength(1) // X's request only
	})
})
