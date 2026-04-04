import type { SchemaInput } from '../../src/schema/define'
import { t } from '../../src/schema/types'

/** Minimal valid schema with one collection and one field */
export const MINIMAL_SCHEMA: SchemaInput = {
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
			},
		},
	},
}

/** Full-featured schema exercising all field types, indexes, constraints, resolvers, and relations */
export const FULL_SCHEMA: SchemaInput = {
	version: 2,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				completed: t.boolean().default(false),
				assignee: t.string().optional(),
				tags: t.array(t.string()).default([]),
				notes: t.richtext(),
				priority: t.enum(['low', 'medium', 'high']).default('medium'),
				due_date: t.timestamp().optional(),
				created_at: t.timestamp().auto(),
				project_id: t.string().optional(),
			},
			indexes: ['assignee', 'completed', 'due_date'],
			constraints: [
				{
					type: 'unique',
					fields: ['title'],
					onConflict: 'last-write-wins',
				},
			],
			resolve: {
				tags: (local, remote, _base) => {
					// Union of arrays
					const localArr = Array.isArray(local) ? local : []
					const remoteArr = Array.isArray(remote) ? remote : []
					return [...new Set([...localArr, ...remoteArr])]
				},
			},
		},
		projects: {
			fields: {
				name: t.string(),
				description: t.string().optional(),
			},
		},
	},
	relations: {
		todo_belongs_to_project: {
			from: 'todos',
			to: 'projects',
			type: 'many-to-one',
			field: 'project_id',
			onDelete: 'set-null',
		},
	},
}
