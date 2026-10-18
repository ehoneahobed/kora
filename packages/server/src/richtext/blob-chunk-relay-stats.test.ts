/**
 * Every counter `getStats()` exposes, by every path that moves it (2026-10-18).
 *
 * Rule: an answer the requester received is counted under its kind; a request the
 * relay could not answer because its requester left is counted once under
 * `requesterGone` and under no other counter. Before the fix a requester that
 * disconnected with requests pending was not counted at all, an undeliverable "not
 * held" or "throttled" was counted twice, and an immediate "not held" (nobody the
 * requester may ask) was not counted.
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
import {
	type BlobAccessPolicy,
	BlobChunkRelay,
	type BlobChunkRelayClock,
	type BlobChunkRelayStats,
} from './blob-chunk-relay'

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

function fakeTransport(): ServerTransport & { sent: SyncMessage[]; drop(): void } {
	const sent: SyncMessage[] = []
	let connected = true
	const transport = {
		sent,
		send: (m: SyncMessage) => void sent.push(m),
		isConnected: () => connected,
		drop: () => {
			connected = false
		},
	}
	return transport as unknown as ServerTransport & { sent: SyncMessage[]; drop(): void }
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

const ZERO: BlobChunkRelayStats = {
	notHeldAfterPeers: 0,
	notHeldNobodyToAsk: 0,
	expired: 0,
	throttledOverPendingCap: 0,
	throttledNotReceivable: 0,
	refusedDuplicateRequestId: 0,
	requesterGone: 0,
}
const only = (counts: Partial<BlobChunkRelayStats>): BlobChunkRelayStats => ({ ...ZERO, ...counts })
const notHeld = (requestId: string): BlobChunkResponseMessage => ({
	type: 'blob-chunk-response',
	messageId: `n-${requestId}`,
	requestId,
	bytes: null,
})

function setup(
	options: {
		policy?: Partial<BlobAccessPolicy>
		store?: (hash: string) => Promise<Uint8Array | null>
		maxPendingPerSession?: number
		pendingTtlMs?: number
		peers?: number
	} = {},
) {
	const clock = manualClock()
	const relay = new BlobChunkRelay(
		options.store,
		{ ...open, ...options.policy },
		{
			clock,
			pendingTtlMs: options.pendingTtlMs ?? 1_000,
			...(options.maxPendingPerSession !== undefined
				? { maxPendingPerSession: options.maxPendingPerSession }
				: {}),
		},
	)
	const requester = fakeTransport()
	relay.addClient('A', requester)
	const peers: Array<ReturnType<typeof fakeTransport>> = []
	for (let i = 0; i < (options.peers ?? 1); i++) {
		const peer = fakeTransport()
		peers.push(peer)
		relay.addClient(`P${i}`, peer)
	}
	return { clock, relay, requester, peers }
}

/** A policy check whose first call is held until released; later calls admit at once. */
function gate(): { check: () => Promise<boolean>; release(): void; waiting(): boolean } {
	let release: (() => void) | null = null
	return {
		check: () =>
			release !== null
				? Promise.resolve(true)
				: new Promise<boolean>((resolve) => {
						release = () => resolve(true)
					}),
		release: () => {
			const go: () => void = release ?? (() => undefined)
			go()
		},
		waiting: () => release !== null,
	}
}
async function until(done: () => boolean): Promise<void> {
	for (let i = 0; i < 100 && !done(); i++) await Promise.resolve()
	expect(done()).toBe(true)
}

describe('relay stats: notHeldAfterPeers', () => {
	test('every peer asked says "not held"', async () => {
		const { relay } = setup({ peers: 2 })
		await relay.handleRequest('A', req('r1'))
		await relay.handleResponse('P0', notHeld('r1'))
		expect(relay.getStats()).toEqual(ZERO)
		await relay.handleResponse('P1', notHeld('r1'))
		expect(relay.getStats()).toEqual(only({ notHeldAfterPeers: 1 }))
	})

	test('the only peer answers bytes that do not hash to the request', async () => {
		const { relay } = setup()
		await relay.handleRequest('A', req('r1'))
		await relay.handleResponse('P0', {
			type: 'blob-chunk-response',
			messageId: 'lie',
			requestId: 'r1',
			bytes: encodeBlobChunkBytes(new Uint8Array([1])),
		})
		expect(relay.getStats()).toEqual(only({ notHeldAfterPeers: 1 }))
	})

	test('the only peer asked leaves', async () => {
		const { relay } = setup()
		await relay.handleRequest('A', req('r1'))
		relay.removeClient('P0')
		expect(relay.getStats()).toEqual(only({ notHeldAfterPeers: 1 }))
	})

	test('a re-send with nobody new to ask is counted once, when the request ends', async () => {
		const { relay, peers, clock } = setup({ peers: 2 })
		await relay.handleRequest('A', req('r1'))
		await relay.handleResponse('P0', notHeld('r1'))
		peers[1]?.drop() // P1 never answers and is no longer admitted
		await relay.handleRequest('A', req('r1')) // P0 already said "not held": nobody to ask
		expect(relay.getStats()).toEqual(ZERO)
		clock.advance(1_000)
		expect(relay.getStats()).toEqual(only({ expired: 1 }))
	})

	test('late "not held" answers after completion are not counted again', async () => {
		const { relay } = setup()
		await relay.handleRequest('A', req('r1'))
		await relay.handleResponse('P0', notHeld('r1'))
		await relay.handleResponse('P0', notHeld('r1'))
		expect(relay.getStats()).toEqual(only({ notHeldAfterPeers: 1 }))
	})
})

describe('relay stats: notHeldNobodyToAsk', () => {
	test('no peer connected', async () => {
		const { relay } = setup({ peers: 0 })
		await relay.handleRequest('A', req('r1'))
		expect(relay.getStats()).toEqual(only({ notHeldNobodyToAsk: 1 }))
	})

	test('the policy admits no peer (and the store is not readable)', async () => {
		const { relay } = setup({
			store: async () => new Uint8Array([1]),
			policy: { canReadFromStore: async () => false, canForward: async () => false },
		})
		await relay.handleRequest('A', req('r1'))
		expect(relay.getStats()).toEqual(only({ notHeldNobodyToAsk: 1 }))
	})
})

describe('relay stats: expired', () => {
	test('the expiry timer answers a request nobody answered', async () => {
		const { relay, clock } = setup()
		await relay.handleRequest('A', req('r1'))
		clock.advance(1_000)
		expect(relay.getStats()).toEqual(only({ expired: 1 }))
	})

	test('a re-send that races its own expiry counts it once', async () => {
		const { relay, clock } = setup()
		await relay.handleRequest('A', req('r1'))
		clock.jump(1_000)
		await relay.handleRequest('A', req('r1'))
		clock.advance(5_000)
		expect(relay.getStats()).toEqual(only({ expired: 1 }))
	})
})

describe('relay stats: throttled answers', () => {
	test('throttledOverPendingCap: a new request over the cap', async () => {
		const { relay } = setup({ maxPendingPerSession: 1 })
		await relay.handleRequest('A', req('r1'))
		await relay.handleRequest('A', req('r2'))
		await relay.handleRequest('A', req('r1')) // a re-send is not over the cap
		expect(relay.getStats()).toEqual(only({ throttledOverPendingCap: 1 }))
	})

	test('throttledNotReceivable: central-store bytes for a session that may not receive', async () => {
		const { relay } = setup({
			store: async () => new Uint8Array([1]),
			policy: { canReadFromStore: async () => true, mayReceive: (id) => id !== 'A' },
		})
		await relay.handleRequest('A', req('r1'))
		expect(relay.getStats()).toEqual(only({ throttledNotReceivable: 1 }))
	})

	test("throttledNotReceivable: a peer's bytes for a session that may not receive", async () => {
		const bytes = new Uint8Array([4, 2])
		const hash = await hashBlob(bytes)
		let receivable = true
		const { relay } = setup({ policy: { mayReceive: (id) => id !== 'A' || receivable } })
		await relay.handleRequest('A', req('r1', hash))
		receivable = false
		await relay.handleResponse('P0', {
			type: 'blob-chunk-response',
			messageId: 'b',
			requestId: 'r1',
			bytes: encodeBlobChunkBytes(bytes),
		})
		expect(relay.getStats()).toEqual(only({ throttledNotReceivable: 1 }))
	})

	test('refusedDuplicateRequestId: before and after the policy is consulted', async () => {
		const held = gate()
		const { relay } = setup({
			policy: {
				canForward: (requesterId) => (requesterId === 'X' ? held.check() : Promise.resolve(true)),
			},
		})
		relay.addClient('X', fakeTransport())
		await relay.handleRequest('A', req('r1'))
		await relay.handleRequest('X', req('r1')) // r1 already pending for A
		const late = relay.handleRequest('X', req('r2'))
		await until(held.waiting)
		await relay.handleRequest('A', req('r2')) // A takes r2 while X waits
		held.release()
		await late
		expect(relay.getStats()).toEqual(only({ refusedDuplicateRequestId: 2 }))
	})
})

describe('relay stats: requesterGone, counted once and under nothing else', () => {
	test('the requester disconnects with requests pending (the close path)', async () => {
		const { relay, clock } = setup()
		await relay.handleRequest('A', req('r1'))
		await relay.handleRequest('A', req('r2'))
		relay.removeClient('A')
		clock.advance(5_000)
		expect(relay.getStats()).toEqual(only({ requesterGone: 2 }))
	})

	test('the requester leaves while the policy is consulted', async () => {
		const held = gate()
		const { relay } = setup({ policy: { canForward: () => held.check() } })
		const pending = relay.handleRequest('A', req('r1'))
		await until(held.waiting)
		relay.removeClient('A')
		held.release()
		await pending
		expect(relay.getStats()).toEqual(only({ requesterGone: 1 }))
	})

	test('a re-send in flight when the requester leaves is not counted twice', async () => {
		const held = gate()
		let holdNext = false
		const { relay } = setup({
			policy: { canForward: () => (holdNext ? held.check() : Promise.resolve(true)) },
		})
		await relay.handleRequest('A', req('r1'))
		holdNext = true
		const resend = relay.handleRequest('A', req('r1'))
		await until(held.waiting)
		relay.removeClient('A')
		held.release()
		await resend
		expect(relay.getStats()).toEqual(only({ requesterGone: 1 }))
	})

	test('a "not held" for a requester whose connection dropped', async () => {
		const { relay, requester } = setup()
		await relay.handleRequest('A', req('r1'))
		requester.drop()
		await relay.handleResponse('P0', notHeld('r1'))
		expect(relay.getStats()).toEqual(only({ requesterGone: 1 }))
	})

	test('an expiry for a requester whose connection dropped', async () => {
		const { relay, requester, clock } = setup()
		await relay.handleRequest('A', req('r1'))
		requester.drop()
		clock.advance(1_000)
		expect(relay.getStats()).toEqual(only({ requesterGone: 1 }))
	})

	test('a throttle for a requester whose connection dropped', async () => {
		const { relay, requester } = setup({ maxPendingPerSession: 1 })
		await relay.handleRequest('A', req('r1'))
		requester.drop()
		await relay.handleRequest('A', req('r2'))
		expect(relay.getStats()).toEqual(only({ requesterGone: 1 }))
	})

	test("a peer's bytes or the store's bytes for a requester whose connection dropped", async () => {
		const bytes = new Uint8Array([9, 9, 9])
		const hash = await hashBlob(bytes)
		const { relay, requester } = setup({
			store: async (h) => (h === 'f'.repeat(64) ? bytes : null),
			policy: { canReadFromStore: async () => true },
		})
		await relay.handleRequest('A', req('r1', hash))
		requester.drop()
		await relay.handleResponse('P0', {
			type: 'blob-chunk-response',
			messageId: 'b',
			requestId: 'r1',
			bytes: encodeBlobChunkBytes(bytes),
		})
		expect(relay.getStats()).toEqual(only({ requesterGone: 1 }))
		await relay.handleRequest('A', req('r2', 'f'.repeat(64)))
		expect(relay.getStats()).toEqual(only({ requesterGone: 2 }))
	})

	test('a delivered answer of bytes moves no counter', async () => {
		const bytes = new Uint8Array([5])
		const hash = await hashBlob(bytes)
		const { relay } = setup()
		await relay.handleRequest('A', req('r1', hash))
		await relay.handleResponse('P0', {
			type: 'blob-chunk-response',
			messageId: 'b',
			requestId: 'r1',
			bytes: encodeBlobChunkBytes(bytes),
		})
		expect(relay.getStats()).toEqual(ZERO)
	})
})
