import { defineSchema, t } from '@kora/core'
import { describe, expect, test } from 'vitest'
import { generateTypes } from '../../src/commands/generate/type-generator'

describe('generate types flow', () => {
	test('generates valid TypeScript from minimal schema', () => {
		const schema = defineSchema({
			version: 1,
			collections: {
				notes: {
					fields: {
						title: t.string(),
						body: t.string().optional(),
					},
				},
			},
		})

		const output = generateTypes(schema)

		// Should be valid TypeScript structure
		expect(output).toContain('export interface NotesRecord')
		expect(output).toContain('export interface NotesInsertInput')
		expect(output).toContain('export interface NotesUpdateInput')
		expect(output).toContain('readonly id: string')
		expect(output).toContain('readonly title: string')
		expect(output).toContain('readonly body?: string')
	})

	test('generates correct types for complex schema', () => {
		const schema = defineSchema({
			version: 2,
			collections: {
				tasks: {
					fields: {
						title: t.string(),
						done: t.boolean().default(false),
						priority: t.enum(['low', 'medium', 'high']).default('medium'),
						tags: t.array(t.string()).default([]),
						due_date: t.timestamp().optional(),
						created_at: t.timestamp().auto(),
					},
					indexes: ['done'],
				},
				users: {
					fields: {
						name: t.string(),
						email: t.string(),
						age: t.number().optional(),
					},
				},
			},
		})

		const output = generateTypes(schema)

		// TasksRecord should have all fields including auto
		expect(output).toMatch(/export interface TasksRecord \{[\s\S]*created_at/)
		expect(output).toContain("'low' | 'medium' | 'high'")
		expect(output).toContain('Array<string>')

		// TasksInsertInput should omit auto fields
		const insertBlock = output.split('TasksInsertInput')[1]?.split('export')[0] ?? ''
		expect(insertBlock).not.toContain('created_at')
		// done has a default, so it should be optional in InsertInput
		expect(insertBlock).toContain('done?:')

		// TasksUpdateInput should have all non-auto fields as optional
		const updateBlock = output.split('TasksUpdateInput')[1]?.split('export')[0] ?? ''
		expect(updateBlock).toContain('title?:')
		expect(updateBlock).not.toContain('created_at')

		// Users interfaces should exist
		expect(output).toContain('export interface UsersRecord')
		expect(output).toContain('export interface UsersInsertInput')
		expect(output).toContain('export interface UsersUpdateInput')
	})

	test('empty collections produce header-only output', () => {
		const schema = {
			version: 1,
			collections: {} as Record<string, never>,
			relations: {},
		}

		const output = generateTypes(schema)
		expect(output).toContain('Auto-generated')
		expect(output).not.toContain('export interface')
	})
})
