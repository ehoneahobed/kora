import { describe, expect, test } from 'vitest'
import { HybridLogicalClock } from '../../src/clock/hlc'
import { createOperation, verifyOperationIntegrity } from '../../src/operations/operation'
import { defineSchema } from '../../src/schema/define'
import { t } from '../../src/schema/types'
import { validateRecord } from '../../src/schema/validation'
import { MockTimeSource } from '../fixtures/timestamps'

describe('Schema → Validate → Operation integration', () => {
	const schema = defineSchema({
		version: 1,
		collections: {
			todos: {
				fields: {
					title: t.string(),
					completed: t.boolean().default(false),
					priority: t.enum(['low', 'medium', 'high']).default('medium'),
					tags: t.array(t.string()).default([]),
					created_at: t.timestamp().auto(),
				},
				indexes: ['completed'],
			},
		},
	})

	const todosCollection = schema.collections.todos

	test('insert: defineSchema → validateRecord → createOperation → verify', async () => {
		if (!todosCollection) return

		// Step 1: Validate the input data against the schema
		const validatedData = validateRecord(
			'todos',
			todosCollection,
			{ title: 'Ship Kora v1' },
			'insert',
		)

		// Should have defaults applied
		expect(validatedData.title).toBe('Ship Kora v1')
		expect(validatedData.completed).toBe(false)
		expect(validatedData.priority).toBe('medium')
		expect(validatedData.tags).toEqual([])
		expect(validatedData).not.toHaveProperty('created_at') // auto, skipped

		// Step 2: Create an operation from the validated data
		const clock = new HybridLogicalClock('device-1', new MockTimeSource(1712188800000))
		const op = await createOperation(
			{
				nodeId: 'device-1',
				type: 'insert',
				collection: 'todos',
				recordId: 'rec-001',
				data: validatedData,
				previousData: null,
				sequenceNumber: 1,
				causalDeps: [],
				schemaVersion: schema.version,
			},
			clock,
		)

		// Step 3: Verify the operation
		expect(op.id).toMatch(/^[0-9a-f]{64}$/)
		expect(op.type).toBe('insert')
		expect(op.collection).toBe('todos')
		expect(op.data).toEqual(validatedData)
		expect(op.timestamp.wallTime).toBe(1712188800000)
		expect(op.schemaVersion).toBe(1)
		expect(Object.isFrozen(op)).toBe(true)

		// Step 4: Verify integrity
		expect(await verifyOperationIntegrity(op)).toBe(true)
	})

	test('update: validateRecord (partial) → createOperation → verify', async () => {
		if (!todosCollection) return

		const validatedData = validateRecord(
			'todos',
			todosCollection,
			{ completed: true },
			'update',
		)
		expect(validatedData).toEqual({ completed: true })

		const clock = new HybridLogicalClock('device-1', new MockTimeSource(1712188800000))
		const op = await createOperation(
			{
				nodeId: 'device-1',
				type: 'update',
				collection: 'todos',
				recordId: 'rec-001',
				data: validatedData,
				previousData: { completed: false },
				sequenceNumber: 2,
				causalDeps: ['prev-op-id'],
				schemaVersion: schema.version,
			},
			clock,
		)

		expect(op.type).toBe('update')
		expect(op.data).toEqual({ completed: true })
		expect(op.previousData).toEqual({ completed: false })
		expect(op.causalDeps).toEqual(['prev-op-id'])
		expect(await verifyOperationIntegrity(op)).toBe(true)
	})

	test('schema validation rejects invalid data before operation creation', () => {
		if (!todosCollection) return

		// Missing required field
		expect(() =>
			validateRecord('todos', todosCollection, { completed: true }, 'insert'),
		).toThrow(/Required field "title"/)

		// Invalid type
		expect(() =>
			validateRecord('todos', todosCollection, { title: 123 }, 'insert'),
		).toThrow(/must be a string/)

		// Invalid enum value
		expect(() =>
			validateRecord(
				'todos',
				todosCollection,
				{ title: 'test', priority: 'urgent' },
				'insert',
			),
		).toThrow(/must be one of/)
	})
})
