/**
 * RT-26 repro (red team round 3, 2026-10-02): session revalidation (RT-18) compares
 * only the principal's identity, so a scope or role change made while a session is
 * live (a user removed from a team) takes effect only when the token expires.
 *
 * Asserts the CORRECT behaviour (fails before the fix): revalidation also compares
 * the resolved scopes and ends the session with a retriable `SCOPE_CHANGED` when they
 * differ, so the client reconnects and is handed its new scope. An unchanged scope
 * keeps the session.
 */
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { createHarness, tick } from './rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: { docs: { fields: { team: t.string(), title: t.string() } } },
})

function errors(messages: SyncMessage[]): Array<{ code: string; retriable: boolean }> {
	return messages.flatMap((m) =>
		m.type === 'error' ? [{ code: m.code, retriable: m.retriable }] : [],
	)
}

describe('RT-26: revalidation compares resolved scopes', () => {
	test('a narrowed scope ends the live session (retriable)', async () => {
		let team = 'red'
		const auth = new TokenAuthProvider({
			validate: async () => ({ userId: 'ann', scopes: { docs: { team } } }),
		})
		const harness = await createHarness(schema, auth)
		const ann = await harness.login('ann-token', 'ann-node')

		await harness.server.revalidateSessions()
		await tick()
		expect(errors(ann.messages)).toEqual([])

		team = 'blue'
		await harness.server.revalidateSessions()
		await tick()
		expect(errors(ann.messages)).toContainEqual({ code: 'SCOPE_CHANGED', retriable: true })
	})
})
