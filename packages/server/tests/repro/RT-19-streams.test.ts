/**
 * RT-19 repro, server half (red team round 3, 2026-10-02): every server->client path
 * must deliver a record that moves into a session's scope as a complete record.
 *
 * The delivery stream (initial and live), the legacy version-vector delta and the
 * legacy live relay judge each operation on its post-apply scope snapshot (RT-14), so
 * a record transferred to Bob reaches Bob only as the scope-changing update, which a
 * client cannot materialize. The fix sends a server-built scope-entry operation:
 * an insert carrying the record's current values, with a deterministic id, a system
 * node id, and the record's latest HLC (so it never overrides newer client data).
 *
 * Asserts the CORRECT behaviour (fails before the fix).
 */
import { HybridLogicalClock, defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { type Harness, batch, createHarness, makeOp, tick } from './rt-fixture'

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

function deliveredOps(messages: SyncMessage[]): Operation[] {
	return messages.flatMap((m) =>
		m.type === 'operation-batch' ? (m.operations as Operation[]) : [],
	)
}

async function aliceHistory(harness: Harness): Promise<Operation[]> {
	const alice = await harness.login('alice-token', 'alice-node')
	const insert = makeOp('alice-node', 1, {
		collection: 'todos',
		recordId: 'todo-1',
		data: { title: 'salary: 90k (draft)', owner: 'alice' },
	})
	const edit = makeOp('alice-node', 2, {
		type: 'update',
		collection: 'todos',
		recordId: 'todo-1',
		data: { title: 'handover notes' },
		previousData: { title: 'salary: 90k (draft)' },
		causalDeps: [insert.id],
	})
	alice.send(batch([insert, edit]))
	await tick()
	return [insert, edit]
}

async function transferToBob(harness: Harness): Promise<void> {
	const transfer = await harness.server
		.getKoraContext()
		.apply({ collection: 'todos', type: 'update', recordId: 'todo-1', data: { owner: 'bob' } })
	expect(transfer.ok).toBe(true)
	await tick()
}

/** The scope-entry insert for todo-1, checked for shape; history ids never leak. */
function expectEntry(ops: Operation[], history: Operation[]): Operation {
	const historyIds = new Set(history.map((op) => op.id))
	expect(ops.filter((op) => historyIds.has(op.id))).toEqual([])
	const entry = ops.find((op) => op.recordId === 'todo-1' && op.type === 'insert')
	expect(entry).toBeDefined()
	const op = entry as Operation
	expect(op.data).toMatchObject({ title: 'handover notes', owner: 'bob' })
	// Never above the record's newest write, so it cannot override newer client data.
	const newest = ops
		.filter((o) => o.recordId === 'todo-1' && o.id !== op.id)
		.reduce((max, o) => (HybridLogicalClock.compare(o.timestamp, max) > 0 ? o.timestamp : max), {
			wallTime: 0,
			logical: 0,
			nodeId: '',
		})
	expect(HybridLogicalClock.compare(op.timestamp, newest)).toBeGreaterThanOrEqual(0)
	return op
}

describe('RT-19: scope entry on every server->client path', () => {
	test('delivery stream (initial sync of a fresh device)', async () => {
		const harness = await createHarness(schema, auth)
		const history = await aliceHistory(harness)
		await transferToBob(harness)
		const bob = await harness.login('bob-token', 'bob-node', {
			lastDeliverySequence: 0,
		} as Partial<SyncMessage>)
		const ops = deliveredOps(bob.messages)
		const entry = expectEntry(ops, history)
		// The entry precedes the transfer that triggered it.
		const transferIndex = ops.findIndex((op) => op.type === 'update' && op.recordId === 'todo-1')
		expect(ops.indexOf(entry)).toBeLessThan(transferIndex)
		// Deterministic: a second fresh device gets the identical entry id.
		const bob2 = await harness.login('bob-token-2', 'bob-node-2', {
			lastDeliverySequence: 0,
		} as Partial<SyncMessage>)
		expect(deliveredOps(bob2.messages).map((op) => op.id)).toContain(entry.id)
	})

	test('delivery stream (live push to a streaming device)', async () => {
		const harness = await createHarness(schema, auth)
		const bob = await harness.login('bob-token', 'bob-node', {
			lastDeliverySequence: 0,
		} as Partial<SyncMessage>)
		const history = await aliceHistory(harness)
		await transferToBob(harness)
		expectEntry(deliveredOps(bob.messages), history)
	})

	test('legacy version-vector delta', async () => {
		const harness = await createHarness(schema, auth)
		const history = await aliceHistory(harness)
		await transferToBob(harness)
		const bob = await harness.login('bob-token', 'bob-node')
		expectEntry(deliveredOps(bob.messages), history)
	})

	test('legacy live relay', async () => {
		const harness = await createHarness(schema, auth)
		const bob = await harness.login('bob-token', 'bob-node')
		const history = await aliceHistory(harness)
		await transferToBob(harness)
		expectEntry(deliveredOps(bob.messages), history)
	})
})
