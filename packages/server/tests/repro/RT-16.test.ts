/**
 * RT-16 repro (red team round 2, 2026-10-01): directional uplink grants skip
 * `resolveSessionScopes`.
 *
 * When an auth provider returns `downlinkScopes`/`uplinkScopes`, the downlink goes
 * through the grant resolver (verified `$claims` bound to the schema, fail-closed
 * bindings, handshake narrowing) but the uplink grant is used raw. A grant written
 * with `claimScopes(...)` therefore never binds, so every write is refused (it fails
 * closed), and the accepted uplink scope sent to the client carries `$claims`.
 *
 * Asserts the CORRECT behaviour (fails before the fix).
 */
import { claimScopes, defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { batch, createHarness, makeOp, tick } from './rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: {
		notes: { fields: { title: t.string(), userId: t.string() }, scope: ['userId'] },
	},
})

const auth = new TokenAuthProvider({
	validate: async (token) =>
		token === 'alice-token'
			? {
					userId: 'alice',
					downlinkScopes: claimScopes({ userId: 'alice' }),
					uplinkScopes: claimScopes({ userId: 'alice' }),
				}
			: null,
})

function rejectedIds(messages: SyncMessage[]): string[] {
	return messages
		.filter((m) => m.type === 'operation-rejected')
		.map((m) => (m as unknown as { operationId: string }).operationId)
}

describe('RT-16: directional uplink grants are resolved like downlink grants', () => {
	test('a claims-based uplink grant binds to the schema and admits own writes', async () => {
		const harness = await createHarness(schema, auth)
		const alice = await harness.login('alice-token', 'alice-node')
		const response = alice.messages.find((m) => m.type === 'handshake-response') as
			| { acceptedUplinkScopes?: Record<string, unknown> }
			| undefined
		expect(response?.acceptedUplinkScopes).toEqual({ notes: { userId: 'alice' } })

		const own = makeOp('alice-node', 1, {
			collection: 'notes',
			recordId: 'n1',
			data: { title: 'mine', userId: 'alice' },
		})
		const foreign = makeOp('alice-node', 2, {
			collection: 'notes',
			recordId: 'n2',
			data: { title: 'theirs', userId: 'bob' },
		})
		alice.send(batch([own, foreign]))
		await tick()
		expect(rejectedIds(alice.messages)).toEqual([foreign.id])
		expect(await harness.store.findRecord('notes', 'n1')).not.toBeNull()
	})
})
