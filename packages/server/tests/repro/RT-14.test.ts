/**
 * RT-14 repro (red team round 2, 2026-10-01): an ownership transfer discloses the
 * record's full edit history.
 *
 * Download visibility of a historical operation is judged on the record as it is
 * NOW, so once Bob's record is transferred to Alice, Alice's next initial sync (the
 * delivery stream or the version-vector delta) receives every edit Bob ever made
 * while the record was his, including values he overwrote before the transfer.
 *
 * Asserts the CORRECT behaviour (fails before the fix): each operation is judged on
 * the scope values the record had when that operation was applied.
 */
import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { type Harness, batch, createHarness, deliveredOpIds, makeOp, tick } from './rt-fixture'

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

async function bobHistoryThenTransfer(harness: Harness): Promise<Operation[]> {
	const bob = await harness.login('bob-token', 'bob-node')
	const insert = makeOp('bob-node', 1, {
		collection: 'todos',
		recordId: 'todo-1',
		data: { title: 'salary: 90k (draft)', owner: 'bob' },
	})
	const edit = makeOp('bob-node', 2, {
		type: 'update',
		collection: 'todos',
		recordId: 'todo-1',
		data: { title: 'handover notes' },
		previousData: { title: 'salary: 90k (draft)' },
		causalDeps: [insert.id],
	})
	bob.send(batch([insert, edit]))
	await tick()
	// A trusted server route transfers the record to Alice.
	const transfer = await harness.server
		.getKoraContext()
		.apply({ collection: 'todos', type: 'update', recordId: 'todo-1', data: { owner: 'alice' } })
	expect(transfer.ok).toBe(true)
	return [insert, edit]
}

function sentHistory(messages: SyncMessage[], history: Operation[]): string[] {
	const ids = new Set(history.map((op) => op.id))
	return deliveredOpIds(messages).filter((id) => ids.has(id))
}

describe('RT-14: ownership transfer discloses history', () => {
	test('the delivery stream does not send pre-transfer operations to the new owner', async () => {
		const harness = await createHarness(schema, auth)
		const history = await bobHistoryThenTransfer(harness)
		const alice = await harness.login('alice-token', 'alice-node', {
			lastDeliverySequence: 0,
		} as Partial<SyncMessage>)
		expect(sentHistory(alice.messages, history)).toEqual([])
		// The transfer itself is in scope and delivered.
		expect(deliveredOpIds(alice.messages).length).toBeGreaterThan(0)
	})

	test('the version-vector delta does not send pre-transfer operations either', async () => {
		const harness = await createHarness(schema, auth)
		const history = await bobHistoryThenTransfer(harness)
		const alice = await harness.login('alice-token', 'alice-node')
		expect(sentHistory(alice.messages, history)).toEqual([])
	})

	test('the previous owner still receives its own history on resync', async () => {
		const harness = await createHarness(schema, auth)
		const history = await bobHistoryThenTransfer(harness)
		const bob2 = await harness.login('bob-token-2', 'bob-node-2', {
			lastDeliverySequence: 0,
		} as Partial<SyncMessage>)
		expect(sentHistory(bob2.messages, history).sort()).toEqual(history.map((op) => op.id).sort())
	})
})
