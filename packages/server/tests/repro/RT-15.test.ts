/**
 * RT-15 repro (red team round 2, 2026-10-01): retraction injection via writer
 * previousData.
 *
 * With `scopeExitPolicy: 'retract'`, the server decides that an update moved a record
 * out of a session's scope by layering the writer's `previousData` over the stored
 * row. `previousData` is attacker-controlled: Bob can update his own record with
 * `previousData: { owner: 'alice' }` and every Alice session receives a retraction for
 * Bob's record id (noise in her log, and Bob's record ids leak to her).
 *
 * Asserts the CORRECT behaviour (fails before the fix): the pre-image is the server's
 * stored row before the write, never the writer's previousData.
 */
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { batch, createHarness, makeOp, tick } from './rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), owner: t.string() } } },
})

const auth = new TokenAuthProvider({
	validate: async (token) => {
		const user = token.split('-')[0] ?? ''
		return user === 'alice' || user === 'bob'
			? { userId: user, scopes: { todos: { owner: user } } }
			: null
	},
})

function retractedIds(messages: SyncMessage[]): string[] {
	const ids: string[] = []
	for (const m of messages) {
		if (m.type !== 'operation-batch') continue
		for (const r of m.retractions ?? []) ids.push(r.recordId)
	}
	return ids
}

const retract = { scopeExitPolicy: 'retract', lastDeliverySequence: 0 } as Partial<SyncMessage>

describe('RT-15: retraction pre-image comes from the writer', () => {
	test("a forged previousData does not inject a retraction into another tenant's stream", async () => {
		const harness = await createHarness(schema, auth)
		const alice = await harness.login('alice-token', 'alice-node', retract)
		const bob = await harness.login('bob-token', 'bob-node')
		const insert = makeOp('bob-node', 1, {
			collection: 'todos',
			recordId: 'bob-todo',
			data: { title: 'mine', owner: 'bob' },
		})
		const forged = makeOp('bob-node', 2, {
			type: 'update',
			collection: 'todos',
			recordId: 'bob-todo',
			data: { title: 'still mine' },
			previousData: { title: 'mine', owner: 'alice' },
			causalDeps: [insert.id],
		})
		bob.send(batch([insert, forged]))
		await tick(80)
		expect(retractedIds(alice.messages)).not.toContain('bob-todo')

		// A fresh retract-mode session replaying the log sees no injected retraction either.
		const alice2 = await harness.login('alice-token-2', 'alice-node-2', retract)
		expect(retractedIds(alice2.messages)).not.toContain('bob-todo')
	})

	test('a genuine move out of scope is still retracted', async () => {
		const harness = await createHarness(schema, auth)
		const alice = await harness.login('alice-token', 'alice-node', retract)
		alice.send(
			batch([
				makeOp('alice-node', 1, {
					collection: 'todos',
					recordId: 'alice-todo',
					data: { title: 'to hand over', owner: 'alice' },
				}),
			]),
		)
		await tick()
		const moved = await harness.server.getKoraContext().apply({
			collection: 'todos',
			type: 'update',
			recordId: 'alice-todo',
			data: { owner: 'bob' },
		})
		expect(moved.ok).toBe(true)
		const alice2 = await harness.login('alice-token-2', 'alice-node-2', retract)
		expect(retractedIds(alice2.messages)).toContain('alice-todo')
	})
})
