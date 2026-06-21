import { defineSchema, t } from '@korajs/core'
import { describe, expect, it } from 'vitest'
import { generateCollectionHooks } from './hook-generator'

describe('generateCollectionHooks', () => {
	it('generates a hook file per collection', () => {
		const schema = defineSchema({
			version: 1,
			collections: {
				todos: {
					fields: {
						title: t.string(),
					},
				},
			},
		})

		const files = generateCollectionHooks(schema)
		expect(files.has('todos.ts')).toBe(true)
		expect(files.get('todos.ts')).toContain('export function useTodos')
		expect(files.get('index.ts')).toContain("export { useTodos } from './todos'")
	})
})
