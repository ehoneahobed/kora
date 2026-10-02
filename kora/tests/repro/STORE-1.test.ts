import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'
import type { KoraApp } from '../../src/types'

// STORE-1: sequence numbers allocated inside app.transaction must never be
// reused by later writes from the same node.
const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string() } },
	},
})

describe('STORE-1 sequence uniqueness across app.transaction', () => {
	let app: KoraApp
	afterEach(async () => {
		if (app) await app.close()
	})

	test('ops written by app.transaction and a following insert have unique (nodeId, seq)', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready
		const todos = (app as unknown as Record<string, any>).todos
		await todos.insert({ title: 'pre' })
		await app.transaction(async (tx) => {
			await tx.todos!.insert({ title: 'a' })
			await tx.todos!.insert({ title: 'b' })
		})
		await todos.insert({ title: 'post' })

		const ops = await app.getStore().getAllOperations()
		const keys = ops.map((o) => `${o.nodeId}:${o.sequenceNumber}`)
		expect(ops.length).toBe(4)
		expect(new Set(keys).size).toBe(keys.length)
		// persisted watermark must cover every logged op
		const rows = await (app.getStore() as any).adapter.query(
			'SELECT sequence_number FROM _kora_version_vector WHERE node_id = ?',
			[app.getStore().getNodeId()],
		)
		expect(rows[0].sequence_number).toBe(Math.max(...ops.map((o) => o.sequenceNumber)))
	})

	test('two concurrent app.transaction calls do not share sequence numbers', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready
		await Promise.all([
			app.transaction(async (tx) => {
				await tx.todos!.insert({ title: 'x1' })
			}),
			app.transaction(async (tx) => {
				await tx.todos!.insert({ title: 'y1' })
			}),
		])
		const ops = await app.getStore().getAllOperations()
		const seqs = ops.map((o) => o.sequenceNumber)
		expect(new Set(seqs).size).toBe(seqs.length)
	})

	test('a write after an acked transaction is still reported as unsynced', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready
		const store = app.getStore()
		const txOps = await app.transaction(async (tx) => {
			await tx.todos!.insert({ title: 'a' })
			await tx.todos!.insert({ title: 'b' })
		})
		// Server has acknowledged everything up to the transaction's last op.
		const serverVector = new Map([
			[store.getNodeId(), Math.max(...txOps.map((o) => o.sequenceNumber))],
		])
		await (app as unknown as Record<string, any>).todos.insert({ title: 'post' })
		const unsynced = await store.getUnsyncedOperations(serverVector)
		expect(unsynced.map((o) => (o.data as { title: string }).title)).toEqual(['post'])
	})
})
