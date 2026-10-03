import { defineSchema, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { createApp } from './create-app'

// Runtime checks that the inferred types (typed-api.ts, core infer.ts) describe what the
// API really returns and accepts.
const schema = defineSchema({
	version: 1,
	collections: {
		projects: { fields: { name: t.string() } },
		todos: {
			fields: {
				title: t.string(),
				assignee: t.string().optional(),
				done: t.boolean().default(false),
				notes: t.richtext().optional(),
				dueAt: t.timestamp().optional(),
				createdOn: t.timestamp().auto(),
				projectId: t.string().optional(),
			},
		},
	},
	relations: {
		todoProject: {
			from: 'todos',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'set-null',
		},
	},
})

describe('typed API value domain', () => {
	const app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })

	test('reads: richtext is bytes, auto timestamp is set, cleared optional is null', async () => {
		await app.ready
		const todo = await app.todos.insert({ title: 'x', notes: 'hello', assignee: 'a' })
		const found = await app.todos.findById(todo.id)
		const queried = await app.todos.where({ id: todo.id }).exec()
		// Reads return the stored Yjs bytes. (insert()/update() currently echo the value as
		// written; the record type follows reads.)
		expect(found?.notes).toBeInstanceOf(Uint8Array)
		expect(queried[0]?.notes).toBeInstanceOf(Uint8Array)
		expect(typeof todo.createdOn).toBe('number')
		expect(todo.done).toBe(false)
		const cleared = await app.todos.update(todo.id, { assignee: null, done: null })
		expect(cleared.assignee).toBeNull()
		expect(cleared.done).toBeNull()
	})

	test('a Date is refused for a timestamp field (milliseconds only)', async () => {
		await app.ready
		await expect(
			app.todos.insert({ title: 'x', dueAt: new Date() as unknown as number }),
		).rejects.toThrow(/timestamp/)
	})

	test('include() adds the singular relation property', async () => {
		await app.ready
		const project = await app.projects.insert({ name: 'P' })
		await app.todos.insert({ title: 'y', projectId: project.id })
		const rows = await app.todos.where({ title: 'y' }).include('project').exec()
		expect(rows[0]?.project?.name).toBe('P')
		const children = await app.projects.where({ id: project.id }).include('todos').exec()
		expect(children[0]?.todos.map((row) => row.title)).toEqual(['y'])
	})

	test('transactions expose every collection', async () => {
		await app.ready
		await app.transaction(async (tx) => {
			const p = await tx.projects.insert({ name: 'T' })
			await tx.todos.insert({ title: 'in tx', projectId: p.id })
		})
		expect(await app.todos.where({ title: 'in tx' }).count()).toBe(1)
		await app.close()
	})
})
