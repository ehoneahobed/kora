import { defineSchema, t } from '@kora/core'

/**
 * Minimal todo schema for basic tests.
 */
export const minimalSchema = defineSchema({
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

/**
 * Full-featured schema for comprehensive tests.
 */
export const fullSchema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				completed: t.boolean().default(false),
				priority: t.enum(['low', 'medium', 'high']).default('medium'),
				tags: t.array(t.string()).default([]),
				assignee: t.string().optional(),
				due_date: t.timestamp().optional(),
				count: t.number().default(0),
			},
			indexes: ['assignee', 'completed'],
		},
		projects: {
			fields: {
				name: t.string(),
				description: t.string().optional(),
				active: t.boolean().default(true),
			},
		},
	},
})
