/**
 * RT-12 repro (red team round 2, 2026-10-01): anonymous node-id hijack.
 *
 * Every anonymous principal claims node ids under one shared owner
 * (`kora:anonymous`), so any anonymous client can handshake with another anonymous
 * device's node id and upload under it. A forged high sequence then makes the
 * victim's client skip its own queued writes. A provider issuing the userId
 * `kora:anonymous` collides with that owner as well.
 *
 * Asserts the CORRECT behaviour (fails before the fix): an anonymous node claim is
 * bound to a per-device secret the server issues at first claim, and the `kora:`
 * user-id prefix is reserved.
 */
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { MixedAuthProvider } from '../../src/auth/mixed-auth-provider'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { batch, createHarness, makeOp, tick } from './rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: { responses: { fields: { answer: t.string() } } },
})

const primary = new TokenAuthProvider({
	validate: async (token) =>
		token === 'impostor-token'
			? { userId: 'kora:anonymous', scopes: { responses: {} } }
			: token === 'alice-token'
				? { userId: 'alice', scopes: { responses: {} } }
				: null,
})

function accepted(messages: SyncMessage[]): boolean {
	return messages.some((m) => m.type === 'handshake-response' && m.accepted)
}

function nodeTokenOf(messages: SyncMessage[]): string | undefined {
	const response = messages.find((m) => m.type === 'handshake-response') as
		| { nodeToken?: string }
		| undefined
	return response?.nodeToken
}

describe('RT-12: anonymous node-id hijack', () => {
	test("an anonymous client cannot take another anonymous device's node id", async () => {
		const auth = new MixedAuthProvider({ primary, anonymousScopes: { responses: {} } })
		const harness = await createHarness(schema, auth)
		const victim = await harness.login('', 'victim-node')
		expect(accepted(victim.messages)).toBe(true)

		const attacker = await harness.login('', 'victim-node')
		expect(accepted(attacker.messages)).toBe(false)

		// Whatever the attacker sends under the victim's node id is not stored.
		const forged = makeOp('victim-node', 1_000_000, {
			collection: 'responses',
			data: { answer: 'forged' },
		})
		attacker.send(batch([forged]))
		await tick()
		expect(harness.store.getVersionVector().get('victim-node') ?? 0).toBeLessThan(1_000_000)
	})

	test('the device that holds its node token reconnects with it', async () => {
		const auth = new MixedAuthProvider({ primary, anonymousScopes: { responses: {} } })
		const harness = await createHarness(schema, auth)
		const first = await harness.login('', 'kiosk-node')
		const token = nodeTokenOf(first.messages)
		expect(typeof token).toBe('string')
		first.client.disconnect()
		await tick()
		const again = await harness.login('', 'kiosk-node', {
			nodeToken: token,
		} as Partial<SyncMessage>)
		expect(accepted(again.messages)).toBe(true)
	})

	test('a provider may not issue a user id in the reserved kora: namespace', async () => {
		const auth = new MixedAuthProvider({ primary, anonymousScopes: { responses: {} } })
		const harness = await createHarness(schema, auth)
		const anon = await harness.login('', 'anon-node')
		expect(accepted(anon.messages)).toBe(true)
		const impostor = await harness.login('impostor-token', 'impostor-node')
		expect(accepted(impostor.messages)).toBe(false)
	})
})
