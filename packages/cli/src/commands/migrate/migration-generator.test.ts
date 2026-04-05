import { defineSchema, t } from '@kora/core'
import { describe, expect, test } from 'vitest'
import { generateMigration } from './migration-generator'
import { diffSchemas } from './schema-differ'

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

		expect(generated.up.some((statement) => statement.includes('CREATE TABLE IF NOT EXISTS todos'))).toBe(
			true,
		)
		expect(generated.down.some((statement) => statement.includes('DROP TABLE IF EXISTS todos'))).toBe(true)
	})

	test('generates rebuild statements for changed collection', () => {
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
				todos: {
					fields: {
						title: t.string(),
						completed: t.boolean().default(false),
					},
				},
			},
		})

		const diff = diffSchemas(previous, current)
		const generated = generateMigration(previous, current, diff)

		expect(generated.up.some((statement) => statement.includes('CREATE TABLE _kora_mig_todos_new'))).toBe(
			true,
		)
		expect(generated.up.some((statement) => statement.includes('ALTER TABLE _kora_mig_todos_new RENAME TO todos'))).toBe(
			true,
		)
	})
})
