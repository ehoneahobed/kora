import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'
import type { KoraApp } from '../../src/types'

// STORE-2: cascade side-effect ops generated while committing app.transaction
// must not reuse sequence numbers of the transaction's own ops.
const schema = defineSchema({
	version: 1,
	collections: {
		projects: { fields: { name: t.string() } },
		todos: { fields: { title: t.string(), projectId: t.string() } },
	},
	relations: {
		todoBelongsToProject: {
			from: 'todos',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'cascade',
		},
	},
})

describe('STORE-2 cascade inside app.transaction', () => {
	let app: KoraApp
	afterEach(async () => {
		if (app) await app.close()
	})

	test('cascaded child deletes get fresh sequence numbers', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready
		const a = app as unknown as Record<string, any>
		const p = await a.projects.insert({ name: 'P' })
		await a.todos.insert({ title: 't1', projectId: p.id })
		await a.todos.insert({ title: 't2', projectId: p.id })

		await app.transaction(async (tx) => {
			await tx.projects!.insert({ name: 'Q' })
			await tx.projects!.delete(p.id)
		})
		await a.projects.insert({ name: 'after' })

		const ops = await app.getStore().getAllOperations()
		const seqs = ops.map((o) => o.sequenceNumber).sort((x, y) => x - y)
		expect(new Set(seqs).size).toBe(seqs.length)
		expect(await a.todos.where({}).exec()).toHaveLength(0)
	})
})
