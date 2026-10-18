/**
 * Client retries do not keep a relay request alive past its lifetime (2026-10-18).
 *
 * Before the fix each re-send of a request (same id, same session) replaced the
 * pending entry with a fresh creation time, and expiry was checked only when another
 * request arrived. A peer that stayed connected but never answered therefore kept the
 * request pending forever: the relay never sent its expiry "not held" and the requester
 * waited out its own 2 minute deadline. A re-send also replaced the entry object, so a
 * valid answer whose hash was being verified meanwhile was dropped.
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
				now = dueAt
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

describe('blob chunk relay: a request expires at its TTL however often it is re-sent', () => {
	test('peer connected but silent, client retrying: "not held" arrives at the TTL', async () => {
		const clock = manualClock()
		const relay = new BlobChunkRelay(undefined, open, { pendingTtlMs: 60_000, clock })
		const requester = fakeTransport()
		const peer = fakeTransport()
		relay.addClient('A', requester)
		relay.addClient('B', peer)

		await relay.handleRequest('A', req('r1'))
		// The client's retries (5 s, then 10 s, 20 s later), all under the same id.
		for (const wait of [5_000, 10_000, 20_000]) {
			clock.advance(wait)
			await relay.handleRequest('A', req('r1'))
		}
		expect(peer.sent).toHaveLength(4)
		expect(answers(requester)).toHaveLength(0)

		// No other request arrives: expiry does not wait for one.
		clock.advance(60_000 - 35_000 - 1)
		expect(answers(requester)).toHaveLength(0)
		clock.advance(1)
		expect(answers(requester)).toEqual([
			{ type: 'blob-chunk-response', messageId: 'blob-resp-r1', requestId: 'r1', bytes: null },
		])
		expect(relay.getPendingCount()).toBe(0)
		expect(relay.getStats().expired).toBe(1)
		expect(clock.activeTimers()).toBe(0)
	})

	test('a re-send that arrives after its own expiry is answered once and not forwarded again', async () => {
		const clock = manualClock()
		const relay = new BlobChunkRelay(undefined, open, { pendingTtlMs: 1_000, clock })
		const requester = fakeTransport()
		const peer = fakeTransport()
		relay.addClient('A', requester)
		relay.addClient('B', peer)
		await relay.handleRequest('A', req('r1'))
		// The timer has not run yet (the retry races it): the retry finds its entry expired.
		clock.jump(1_000)
		await relay.handleRequest('A', req('r1'))
		expect(answers(requester)).toEqual([
			{ type: 'blob-chunk-response', messageId: 'blob-resp-r1', requestId: 'r1', bytes: null },
		])
		expect(peer.sent).toHaveLength(1)
		expect(relay.getPendingCount()).toBe(0)
	})

	test('a re-send whose request expires while the policy is consulted is not taken again', async () => {
		const clock = manualClock()
		let gate: (() => void) | null = null
		let holdNext = false
		const relay = new BlobChunkRelay(
			undefined,
			{
				canReadFromStore: async () => false,
				canForward: () =>
					holdNext
						? new Promise<boolean>((resolve) => {
								gate = () => resolve(true)
							})
						: Promise.resolve(true),
			},
			{ pendingTtlMs: 1_000, clock },
		)
		const requester = fakeTransport()
		const peer = fakeTransport()
		relay.addClient('A', requester)
		relay.addClient('B', peer)
		await relay.handleRequest('A', req('r1'))
		holdNext = true
		const resend = relay.handleRequest('A', req('r1'))
		clock.advance(1_000) // expires while the re-send waits on the policy
		expect(answers(requester).map((m) => m.bytes)).toEqual([null])
		const release: () => void = gate ?? (() => undefined)
		release()
		await resend
		expect(peer.sent).toHaveLength(1)
		expect(relay.getPendingCount()).toBe(0)
		expect(clock.activeTimers()).toBe(0)
	})

	test('re-sends do not lift the per-session pending cap or the expiry of other requests', async () => {
		const clock = manualClock()
		const relay = new BlobChunkRelay(undefined, open, {
			pendingTtlMs: 10_000,
			maxPendingPerSession: 2,
			clock,
		})
		const requester = fakeTransport()
		relay.addClient('A', requester)
		relay.addClient('B', fakeTransport())
		await relay.handleRequest('A', req('r1'))
		clock.advance(4_000)
		await relay.handleRequest('A', req('r2'))
		clock.advance(4_000)
		await relay.handleRequest('A', req('r1'))
		await relay.handleRequest('A', req('r2'))
		await relay.handleRequest('A', req('r3'))
		expect(answers(requester).map((m) => [m.requestId, m.throttled])).toEqual([['r3', true]])
		// r1 expires at 10 s from its first send, r2 at 14 s, re-sends notwithstanding.
		clock.advance(2_000)
		expect(answers(requester).map((m) => m.requestId)).toEqual(['r3', 'r1'])
		clock.advance(4_000)
		expect(answers(requester).map((m) => m.requestId)).toEqual(['r3', 'r1', 'r2'])
		expect(clock.activeTimers()).toBe(0)
	})

	test("a re-send while a peer's bytes are being verified does not drop the answer", async () => {
		const clock = manualClock()
		const relay = new BlobChunkRelay(undefined, open, { clock })
		const bytes = new Uint8Array([7, 8, 9])
		const hash = await hashBlob(bytes)
		const requester = fakeTransport()
		relay.addClient('A', requester)
		relay.addClient('B', fakeTransport())
		await relay.handleRequest('A', req('r1', hash))
		const encoded = encodeBlobChunkBytes(bytes)
		const verifying = relay.handleResponse('B', {
			type: 'blob-chunk-response',
			messageId: 'b-r1',
			requestId: 'r1',
			bytes: encoded,
		})
		await relay.handleRequest('A', req('r1', hash))
		await verifying
		expect(answers(requester).map((m) => m.bytes)).toEqual([encoded])
		expect(relay.getPendingCount()).toBe(0)
	})

	test('clear() leaves no timer running', async () => {
		const clock = manualClock()
		const relay = new BlobChunkRelay(undefined, open, { clock })
		relay.addClient('A', fakeTransport())
		relay.addClient('B', fakeTransport())
		await relay.handleRequest('A', req('r1'))
		expect(clock.activeTimers()).toBe(1)
		relay.clear()
		expect(clock.activeTimers()).toBe(0)
	})

	test('a request answered before its TTL leaves no timer running', async () => {
		const clock = manualClock()
		const relay = new BlobChunkRelay(undefined, open, { clock })
		const requester = fakeTransport()
		relay.addClient('A', requester)
		relay.addClient('B', fakeTransport())
		await relay.handleRequest('A', req('r1'))
		await relay.handleResponse('B', {
			type: 'blob-chunk-response',
			messageId: 'b-r1',
			requestId: 'r1',
			bytes: null,
		})
		expect(answers(requester)).toHaveLength(1)
		expect(clock.activeTimers()).toBe(0)
	})
})
