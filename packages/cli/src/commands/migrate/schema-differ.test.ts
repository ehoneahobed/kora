import { defineSchema, t } from '@kora/core'
import { describe, expect, test } from 'vitest'
import { diffSchemas } from './schema-differ'

describe('diffSchemas', () => {
	test('detects added and removed collections', () => {
		const previous = defineSchema({
			version: 1,
			collections: {
				todos: {
					fields: { title: t.string() },
				},
			},
		})

		const current = defineSchema({
			version: 2,
			collections: {
				projects: {
					fields: { name: t.string() },
				},
			},
		})

		const diff = diffSchemas(previous, current)
		expect(diff.changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'collection-added', collection: 'projects' }),
				expect.objectContaining({ type: 'collection-removed', collection: 'todos' }),
			]),
		)
		expect(diff.hasBreakingChanges).toBe(true)
	})

	test('detects field and index changes', () => {
		const previous = defineSchema({
			version: 1,
			collections: {
				todos: {
					fields: {
						title: t.string(),
					},
					indexes: ['title'],
				},
			},
		})

		const current = defineSchema({
			version: 2,
			collections: {
				todos: {
					fields: {
						title: t.string().optional(),
						completed: t.boolean().default(false),
					},
					indexes: ['completed'],
				},
			},
		})

		const diff = diffSchemas(previous, current)
		expect(diff.hasChanges).toBe(true)
		expect(diff.changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'field-changed', collection: 'todos', field: 'title' }),
				expect.objectContaining({ type: 'field-added', collection: 'todos', field: 'completed' }),
				expect.objectContaining({ type: 'index-removed', collection: 'todos', index: 'title' }),
				expect.objectContaining({ type: 'index-added', collection: 'todos', index: 'completed' }),
			]),
		)
	})

	test('returns no changes for identical schema', () => {
		const schema = defineSchema({
			version: 1,
			collections: {
				todos: {
					fields: { title: t.string() },
				},
			},
		})

		const diff = diffSchemas(schema, schema)
		expect(diff.hasChanges).toBe(false)
		expect(diff.changes).toHaveLength(0)
	})
})
