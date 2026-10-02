/**
 * RT-6 repro (red team, 2026-10-01): every refused operation costs a store read before
 * the rate limiter is charged, and there is no per-batch op cap. 500 out-of-scope ops
 * in one batch produced 500 rejections (500 store reads) and no RATE_LIMIT.
 * Asserts the CORRECT behaviour (fails before the fix).
 */
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { batch, createHarness, makeOp, tick } from './rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string(), userId: t.string() } } },
})

const auth = new TokenAuthProvider({
	validate: async (token) =>
		token.startsWith('alice') ? { userId: 'alice', scopes: { notes: { userId: 'alice' } } } : null,
})

function outOfScope(count: number) {
	return Array.from({ length: count }, (_, i) =>
		makeOp('alice-node', i + 1, { data: { title: 'x', userId: 'bob' } }),
	)
}

function codes(messages: SyncMessage[]): string[] {
	return messages.filter((m) => m.type === 'error').map((m) => (m.type === 'error' ? m.code : ''))
}

describe('RT-6: refused ops bypass the rate limiter', () => {
	test('the rate limiter is charged before any store read', async () => {
		const store = new MemoryServerStore('server-1')
		const harness = await createHarness(schema, auth, { maxOpsPerMinute: 50 }, store)
		const alice = await harness.login('alice-token', 'alice-node')
		const reads = vi.spyOn(store, 'queryCollection')
		alice.send(batch(outOfScope(500)))
		await tick(150)
		const rejections = alice.messages.filter((m) => m.type === 'operation-rejected').length
		expect(codes(alice.messages)).toContain('RATE_LIMIT')
		expect(rejections).toBeLessThanOrEqual(50)
		expect(reads.mock.calls.length).toBeLessThanOrEqual(50)
	})

	test('an oversized batch is refused before any store read', async () => {
		const store = new MemoryServerStore('server-1')
		const harness = await createHarness(schema, auth, { maxOpsPerMinute: 1_000_000 }, store)
		const alice = await harness.login('alice-token', 'alice-node')
		const reads = vi.spyOn(store, 'queryCollection')
		alice.send(batch(outOfScope(5000)))
		await tick(300)
		expect(alice.messages.filter((m) => m.type === 'operation-rejected').length).toBe(0)
		expect(reads.mock.calls.length).toBe(0)
		expect(codes(alice.messages).length).toBeGreaterThan(0)
	})
})
