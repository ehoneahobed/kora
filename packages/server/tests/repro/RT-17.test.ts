/**
 * RT-17 repro (red team round 2, 2026-10-01): blob requests are free and writes
 * trigger full scope rescans.
 *
 * - `blob-chunk-request` is not charged to the session rate limiter, so one session can
 *   make the server run unbounded access checks and central-store reads.
 * - Concurrent requests for one scope each rebuild the scope's referenced-hash set
 *   (a scan of every blob collection in scope) instead of sharing one rebuild.
 * - Every write, to any collection, throws away every scope's cached set.
 *
 * Asserts the CORRECT behaviour (fails before the fix).
 */
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { batch, createHarness, makeOp, tick } from './rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: {
		files: { fields: { owner: t.string(), doc: t.blob().optional() } },
		notes: { fields: { owner: t.string(), body: t.string() } },
	},
})

const auth = new TokenAuthProvider({
	validate: async (token) =>
		token.startsWith('alice')
			? { userId: 'alice', scopes: { files: { owner: 'alice' }, notes: { owner: 'alice' } } }
			: null,
})

const request = (i: number): SyncMessage => ({
	type: 'blob-chunk-request',
	messageId: `m${i}`,
	requestId: `req-${i}`,
	hash: i.toString(16).padStart(64, '0'),
})

describe('RT-17: blob request cost', () => {
	test('blob chunk requests are charged to the session rate limiter', async () => {
		const hash = 'a'.repeat(64)
		const resolveBlobChunk = vi.fn(async () => null)
		const harness = await createHarness(schema, auth, { maxOpsPerMinute: 10, resolveBlobChunk })
		const alice = await harness.login('alice-token', 'alice-node')
		// A record in Alice's scope references the hash, so every request reaches the
		// central store read.
		alice.send(
			batch([
				makeOp('alice-node', 1, {
					collection: 'files',
					recordId: 'f1',
					data: { owner: 'alice', doc: { hash, size: 1 } },
				}),
			]),
		)
		await tick()
		for (let i = 0; i < 50; i++) {
			alice.send({ type: 'blob-chunk-request', messageId: `m${i}`, requestId: `r${i}`, hash })
		}
		await tick(80)
		// Work is bounded by the session budget...
		expect(resolveBlobChunk.mock.calls.length).toBeLessThanOrEqual(10)
		// ...and every request is still answered ("not held" over budget), so the client
		// neither hangs nor is disconnected.
		const answered = alice.messages.filter((m) => m.type === 'blob-chunk-response')
		expect(answered.length).toBe(50)
		expect(alice.messages.some((m) => m.type === 'error')).toBe(false)
	})

	test('concurrent requests for one scope share one rebuild of its blob index', async () => {
		const harness = await createHarness(schema, auth, { resolveBlobChunk: async () => null })
		const alice = await harness.login('alice-token', 'alice-node')
		// A store read takes a little while (as a real database does), so the requests
		// overlap the first rebuild.
		const original = harness.store.queryCollection.bind(harness.store)
		const spy = vi.spyOn(harness.store, 'queryCollection').mockImplementation(async (...args) => {
			await tick(10)
			return original(...args)
		})
		for (let i = 0; i < 20; i++) alice.send(request(i))
		await tick(150)
		const fileScans = spy.mock.calls.filter(([collection]) => collection === 'files')
		expect(fileScans.length).toBe(1)
	})

	test('a write to a collection without blob fields keeps the cached blob index', async () => {
		const harness = await createHarness(schema, auth, { resolveBlobChunk: async () => null })
		const alice = await harness.login('alice-token', 'alice-node')
		alice.send(request(1))
		await tick()
		const spy = vi.spyOn(harness.store, 'queryCollection')
		alice.send(
			batch([
				makeOp('alice-node', 1, {
					collection: 'notes',
					recordId: 'n1',
					data: { owner: 'alice', body: 'hello' },
				}),
			]),
		)
		await tick()
		spy.mockClear()
		alice.send(request(2))
		await tick()
		const fileScans = spy.mock.calls.filter(([collection]) => collection === 'files')
		expect(fileScans.length).toBe(0)
	})
})
