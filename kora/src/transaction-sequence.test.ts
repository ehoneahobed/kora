import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from './create-app'
import type { KoraApp } from './types'

/**
 * STORE-1 stopgap: ApplyPipeline.commitTransaction persists the node's sequence
 * counter inside the commit transaction as MAX(existing, highest seq in batch),
 * so a later single-record write never reuses a sequence number the transaction
 * already consumed (and is therefore never mistaken for an acknowledged op).
 */
const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string() } },
	},
})

type Todos = { insert: (d: Record<string, unknown>) => Promise<{ id: string }> }

async function persistedCounter(app: KoraApp): Promise<number> {
	const store = app.getStore()
	const adapter = (
		store as unknown as {
			adapter: { query: <T>(sql: string, p?: unknown[]) => Promise<T[]> }
		}
	).adapter
	const rows = await adapter.query<{ sequence_number: number }>(
		'SELECT sequence_number FROM _kora_version_vector WHERE node_id = ?',
		[store.getNodeId()],
	)
	return rows[0]?.sequence_number ?? 0
}

describe('ApplyPipeline.commitTransaction sequence counter', () => {
	let app: KoraApp | undefined
	afterEach(async () => {
		await app?.close()
		app = undefined
	})

	test('persists the highest sequence of the batch and the next write continues after it', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready
		const todos = (app as unknown as { todos: Todos }).todos

		await todos.insert({ title: 'before' })
		const txOps = await app.transaction(async (tx) => {
			await tx.todos?.insert({ title: 'a' })
			await tx.todos?.insert({ title: 'b' })
		})
		const txMax = Math.max(...txOps.map((op) => op.sequenceNumber))
		expect(await persistedCounter(app)).toBe(txMax)

		await todos.insert({ title: 'after' })
		const all = await app.getStore().getAllOperations()
		const after = all.find((op) => (op.data as { title?: string } | null)?.title === 'after')
		expect(after?.sequenceNumber).toBe(txMax + 1)
	})

	test('never lowers a counter that advanced while the transaction was open', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready
		const todos = (app as unknown as { todos: Todos }).todos

		await app.transaction(async (tx) => {
			await tx.todos?.insert({ title: 'in-tx' })
			// Writes outside the transaction advance the persisted counter past the
			// transaction's own (stale) high-water mark.
			await todos.insert({ title: 'outside-1' })
			await todos.insert({ title: 'outside-2' })
			await todos.insert({ title: 'outside-3' })
		})

		const all = await app.getStore().getAllOperations()
		const highest = Math.max(...all.map((op) => op.sequenceNumber))
		expect(await persistedCounter(app)).toBe(highest)
	})
})
