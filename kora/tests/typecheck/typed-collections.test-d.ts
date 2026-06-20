import { defineSchema, t } from '@korajs/core'
import { createApp } from 'korajs'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				completed: t.boolean().default(false),
			},
		},
	},
})

const app = createApp({
	schema,
	store: { adapter: 'better-sqlite3', name: ':memory:' },
})

async function typedCollections(): Promise<void> {
	await app.ready

	const inserted = await app.todos.insert({ title: 'Ship Kora' })
	const _title: string = inserted.title
	const _completed: boolean = inserted.completed

	await app.todos.update(inserted.id, { completed: true })

	const query = app.todos.where({ completed: false }).orderBy('createdAt')
	const results = await query.exec()
	const _firstTitle: string = results[0]?.title ?? ''
}

void typedCollections()
