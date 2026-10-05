import { defineSchema, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { generateMigration } from './migration-generator'
import { diffSchemas } from './schema-differ'
import { parseEvolveTableDirective } from './table-evolution-directive'

describe('generateMigration', () => {
	test('generates collection create/drop statements', () => {
		const previous = defineSchema({
			version: 1,
			collections: {
				projects: {
					fields: { name: t.string() },
				},
			},
		})
		const current = defineSchema({
			version: 2,
			collections: {
				projects: {
					fields: { name: t.string() },
				},
				todos: {
					fields: { title: t.string() },
				},
			},
		})

		const diff = diffSchemas(previous, current)
		const generated = generateMigration(previous, current, diff)

		expect(
			generated.up.some((statement) => statement.includes('CREATE TABLE IF NOT EXISTS "todos"')),
		).toBe(true)
		expect(
			generated.down.some((statement) => statement.includes('DROP TABLE IF EXISTS "todos"')),
		).toBe(true)
	})

	test('a changed collection becomes relax + evolve-table directives, never a re-created table', () => {
		const previous = defineSchema({
			version: 1,
			collections: {
				todos: {
					fields: { title: t.string(), done: t.string().optional(), old: t.string().optional() },
					indexes: ['old'],
				},
			},
		})

		const current = defineSchema({
			version: 2,
			collections: {
				todos: {
					fields: {
						title: t.string(),
						done: t.boolean().optional(),
						completed: t.boolean().default(false),
					},
					indexes: ['title'],
				},
			},
		})

		const generated = generateMigration(previous, current, diffSchemas(previous, current))
		expect(generated.up).toHaveLength(2)
		expect(generated.up[0]).toMatch(/^--kora:relax-value-domain /)
		expect(parseEvolveTableDirective(generated.up[1] as string)).toEqual({
			table: 'todos',
			add: { completed: { kind: 'boolean', default: false } },
			drop: ['old'],
			change: { done: { from: { kind: 'string' }, to: { kind: 'boolean' } } },
			addIndexes: ['title'],
			removeIndexes: ['old'],
		})
		expect(generated.up.join('\n')).not.toMatch(/CREATE TABLE|DROP TABLE/)
		// The inverse undoes it, in order (relax, then evolve back).
		expect(generated.down[0]).toMatch(/^--kora:relax-value-domain /)
		expect(parseEvolveTableDirective(generated.down[1] as string)).toMatchObject({
			add: { old: { kind: 'string' } },
			drop: ['completed'],
			addIndexes: ['old'],
			removeIndexes: ['title'],
		})
	})

	test('the inverse of several changes keeps each change in its own statement order', () => {
		const previous = defineSchema({
			version: 1,
			collections: { gone: { fields: { name: t.string() }, indexes: ['name'] } },
		})
		const current = defineSchema({
			version: 2,
			collections: { added: { fields: { name: t.string() } } },
		})
		const generated = generateMigration(previous, current, diffSchemas(previous, current))
		const recreate = generated.down.findIndex((statement) =>
			statement.startsWith('CREATE TABLE IF NOT EXISTS "gone"'),
		)
		const index = generated.down.findIndex((statement) => statement.includes('ON "gone" ("name")'))
		expect(recreate).toBeGreaterThanOrEqual(0)
		expect(index).toBeGreaterThan(recreate)
	})

	test('rejects unsafe required lossy type changes', () => {
		const previous = defineSchema({
			version: 1,
			collections: {
				todos: {
					fields: { notes: t.array(t.string()).optional() },
				},
			},
		})

		const current = defineSchema({
			version: 2,
			collections: {
				todos: {
					fields: { notes: t.richtext() },
				},
			},
		})

		expect(() => generateMigration(previous, current, diffSchemas(previous, current))).toThrow(
			'Cannot auto-migrate collection "todos"',
		)
	})
})
