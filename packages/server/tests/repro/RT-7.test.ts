/**
 * RT-7 repro (red team, 2026-10-01): the handshake response echoes the server's write
 * count for any node id the client names in its own version vector, leaking another
 * tenant's device activity. Asserts the CORRECT behaviour (fails before the fix).
 */
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { batch, createHarness, makeOp, tick } from './rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string(), userId: t.string() } } },
})

const auth = new TokenAuthProvider({
	validate: async (token) =>
		token.startsWith('alice')
			? { userId: 'alice', scopes: { notes: { userId: 'alice' } } }
			: token.startsWith('bob')
				? { userId: 'bob', scopes: { notes: { userId: 'bob' } } }
				: null,
})

function responseVector(messages: SyncMessage[]): Record<string, number> {
	const response = messages.find((m) => m.type === 'handshake-response')
	return response?.type === 'handshake-response'
		? (response.versionVector as Record<string, number>)
		: {}
}

describe('RT-7: handshake vector oracle', () => {
	for (const mode of ['version-vector', 'delivery-watermark'] as const) {
		test(`${mode}: naming another tenant's node id reveals nothing about it`, async () => {
			const harness = await createHarness(schema, auth)
			const bob = await harness.login('bob-token', 'bob-node')
			bob.send(
				batch([
					makeOp('bob-node', 1, { data: { title: 'b1', userId: 'bob' } }),
					makeOp('bob-node', 2, { data: { title: 'b2', userId: 'bob' } }),
				]),
			)
			await tick()
			const alice = await harness.login('alice-token', 'alice-node', {
				versionVector: { 'bob-node': 0, 'alice-node': 0 },
				...(mode === 'delivery-watermark'
					? { lastDeliverySequence: 0, syncScope: { notes: { userId: 'alice' } } }
					: {}),
			} as never)
			const vector = responseVector(alice.messages)
			expect(vector).not.toHaveProperty('bob-node')
		})
	}
})
