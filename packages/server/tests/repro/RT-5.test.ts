/**
 * RT-5 repro (red team, 2026-10-01): node-id claims.
 * - MixedAuthProvider gives an anonymous client a new userId on every connection, so
 *   its second connection is locked out with NODE_ID_CLAIMED.
 * - At upgrade the claims table is empty: any principal can squat a node id that
 *   already has op history written by someone else.
 * - There is no admin release.
 * Asserts the CORRECT behaviour (fails before the fix).
 */
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { MixedAuthProvider } from '../../src/auth/mixed-auth-provider'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createHarness, makeOp, tick } from './rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: {
		notes: { fields: { title: t.string(), userId: t.string() } },
		responses: { fields: { answer: t.string() } },
	},
})

const primary = new TokenAuthProvider({
	validate: async (token) =>
		token.startsWith('alice')
			? { userId: 'alice', scopes: { notes: { userId: 'alice' } } }
			: token.startsWith('mallory')
				? { userId: 'mallory', scopes: { notes: { userId: 'mallory' } } }
				: null,
})

function errorCode(messages: SyncMessage[]): string | null {
	const error = messages.find((m) => m.type === 'error')
	return error?.type === 'error' ? error.code : null
}

function accepted(messages: SyncMessage[]): boolean {
	return messages.some((m) => m.type === 'handshake-response' && m.accepted)
}

describe('RT-5: node-id claims', () => {
	test('an anonymous device can reconnect with its own node id', async () => {
		const auth = new MixedAuthProvider({ primary, anonymousScopes: { responses: {} } })
		const harness = await createHarness(schema, auth)
		const first = await harness.login('', 'kiosk-node')
		expect(accepted(first.messages)).toBe(true)
		// Since RT-12 the anonymous claim is bound to the node token issued at the first
		// claim, which the device stores next to its node id and presents again.
		const response = first.messages.find((m) => m.type === 'handshake-response') as
			| { nodeToken?: string }
			| undefined
		first.client.disconnect()
		await tick()
		const second = await harness.login('', 'kiosk-node', {
			nodeToken: response?.nodeToken,
		} as Partial<SyncMessage>)
		expect(errorCode(second.messages)).toBeNull()
		expect(accepted(second.messages)).toBe(true)
	})

	test("an anonymous client cannot take a signed-in user's node id", async () => {
		const auth = new MixedAuthProvider({ primary, anonymousScopes: { responses: {} } })
		const harness = await createHarness(schema, auth)
		const alice = await harness.login('alice-token', 'alice-node')
		expect(accepted(alice.messages)).toBe(true)
		const anon = await harness.login('', 'alice-node')
		expect(accepted(anon.messages)).toBe(false)
	})

	test('a node id with op history and no claim (pre-claims data) cannot be squatted', async () => {
		const store = new MemoryServerStore('server-1')
		await store.setSchema(schema)
		// History written before node claims existed (upgrade from beta.12).
		await store.applyRemoteOperation(
			makeOp('alice-node', 1, { data: { title: 'old', userId: 'alice' } }),
		)
		const harness = await createHarness(schema, primary, {}, store)
		const mallory = await harness.login('mallory-token', 'alice-node')
		expect(accepted(mallory.messages)).toBe(false)
		expect(errorCode(mallory.messages)).not.toBeNull()
	})

	test('an admin can release a node claim', async () => {
		const harness = await createHarness(schema, primary)
		const alice = await harness.login('alice-token', 'shared-node')
		expect(accepted(alice.messages)).toBe(true)
		alice.client.disconnect()
		await tick()
		const server = harness.server as unknown as {
			releaseNodeClaim?: (nodeId: string) => Promise<boolean>
		}
		expect(typeof server.releaseNodeClaim).toBe('function')
		expect(await server.releaseNodeClaim?.('shared-node')).toBe(true)
		const mallory = await harness.login('mallory-token', 'shared-node')
		expect(accepted(mallory.messages)).toBe(true)
	})
})
