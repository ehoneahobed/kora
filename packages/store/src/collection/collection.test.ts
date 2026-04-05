import { HybridLogicalClock } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createTestAdapter } from '../../tests/fixtures/test-adapter'
import { fullSchema, minimalSchema } from '../../tests/fixtures/test-schema'
import type { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { RecordNotFoundError } from '../errors'
import { Collection } from './collection'

describe('Collection', () => {
	let adapter: BetterSqlite3Adapter
	let clock: HybridLogicalClock
	let seq: number
	const nodeId = 'test-node-1'
	const mutations: Array<{ collection: string; operation: Operation }> = []

	function createCollection(schema = minimalSchema, collectionName = 'todos') {
		const def = schema.collections[collectionName]
		if (!def) throw new Error(`Collection ${collectionName} not found in schema`)
		return new Collection(
			collectionName,
			def,
			schema,
			adapter,
			clock,
			nodeId,
			() => ++seq,
			(col, op) => mutations.push({ collection: col, operation: op }),
		)
	}

	beforeEach(async () => {
		adapter = await createTestAdapter()
		clock = new HybridLogicalClock(nodeId)
		seq = 0
		mutations.length = 0
	})

	afterEach(async () => {
		await adapter.close()
	})

	describe('insert', () => {
		test('inserts a record and returns it with id, createdAt, updatedAt', async () => {
			const col = createCollection()
			const result = await col.insert({ title: 'Test todo' })

			expect(result.id).toBeDefined()
			expect(typeof result.id).toBe('string')
			expect(result.title).toBe('Test todo')
			expect(result.completed).toBe(false) // default
			expect(result.createdAt).toBeGreaterThan(0)
			expect(result.updatedAt).toBeGreaterThan(0)
		})

		test('persists the record to the database', async () => {
			const col = createCollection()
			const result = await col.insert({ title: 'Persisted' })

			const found = await col.findById(result.id)
			expect(found).not.toBeNull()
			expect(found?.title).toBe('Persisted')
		})

		test('creates an operation in the ops table', async () => {
			const col = createCollection()
			await col.insert({ title: 'Op test' })

			const ops = await adapter.query<{ type: string; record_id: string }>(
				'SELECT type, record_id FROM _kora_ops_todos',
			)
			expect(ops).toHaveLength(1)
			expect(ops[0]?.type).toBe('insert')
		})

		test('updates the version vector', async () => {
			const col = createCollection()
			await col.insert({ title: 'VV test' })

			const vv = await adapter.query<{ node_id: string; sequence_number: number }>(
				'SELECT * FROM _kora_version_vector WHERE node_id = ?',
				[nodeId],
			)
			expect(vv).toHaveLength(1)
			expect(vv[0]?.sequence_number).toBe(1)
		})

		test('calls onMutation callback', async () => {
			const col = createCollection()
			await col.insert({ title: 'Callback test' })

			expect(mutations).toHaveLength(1)
			expect(mutations[0]?.collection).toBe('todos')
			expect(mutations[0]?.operation.type).toBe('insert')
		})

		test('applies default values', async () => {
			const col = createCollection()
			const result = await col.insert({ title: 'Defaults' })
			expect(result.completed).toBe(false)
		})

		test('increments sequence numbers', async () => {
			const col = createCollection()
			await col.insert({ title: 'First' })
			await col.insert({ title: 'Second' })

			expect(mutations).toHaveLength(2)
			expect(mutations[0]?.operation.sequenceNumber).toBe(1)
			expect(mutations[1]?.operation.sequenceNumber).toBe(2)
		})
	})

	describe('findById', () => {
		test('returns null for non-existent record', async () => {
			const col = createCollection()
			const result = await col.findById('nonexistent')
			expect(result).toBeNull()
		})

		test('returns null for soft-deleted record', async () => {
			const col = createCollection()
			const inserted = await col.insert({ title: 'To delete' })
			await col.delete(inserted.id)

			const result = await col.findById(inserted.id)
			expect(result).toBeNull()
		})

		test('deserializes boolean fields', async () => {
			const col = createCollection()
			const inserted = await col.insert({ title: 'Bool', completed: true })

			const found = await col.findById(inserted.id)
			expect(found?.completed).toBe(true)
		})
	})

	describe('update', () => {
		test('updates specified fields only', async () => {
			const col = createCollection()
			const inserted = await col.insert({ title: 'Original' })

			const updated = await col.update(inserted.id, { title: 'Modified' })
			expect(updated.title).toBe('Modified')
			expect(updated.completed).toBe(false) // unchanged
		})

		test('creates an update operation with previousData', async () => {
			const col = createCollection()
			const inserted = await col.insert({ title: 'Before' })
			await col.update(inserted.id, { title: 'After' })

			expect(mutations).toHaveLength(2)
			const updateOp = mutations[1]?.operation
			expect(updateOp?.type).toBe('update')
			expect(updateOp?.data).toEqual({ title: 'After' })
			expect(updateOp?.previousData).toEqual({ title: 'Before' })
		})

		test('updates updatedAt timestamp', async () => {
			const col = createCollection()
			const inserted = await col.insert({ title: 'Time test' })

			// Small delay to ensure different timestamps
			const updated = await col.update(inserted.id, { title: 'Updated' })
			expect(updated.updatedAt).toBeGreaterThanOrEqual(inserted.updatedAt)
		})

		test('throws RecordNotFoundError for missing record', async () => {
			const col = createCollection()
			await expect(col.update('nonexistent', { title: 'x' })).rejects.toThrow(RecordNotFoundError)
		})

		test('throws RecordNotFoundError for deleted record', async () => {
			const col = createCollection()
			const inserted = await col.insert({ title: 'Deleted' })
			await col.delete(inserted.id)

			await expect(col.update(inserted.id, { title: 'x' })).rejects.toThrow(RecordNotFoundError)
		})
	})

	describe('delete', () => {
		test('soft-deletes the record', async () => {
			const col = createCollection()
			const inserted = await col.insert({ title: 'To delete' })
			await col.delete(inserted.id)

			const found = await col.findById(inserted.id)
			expect(found).toBeNull()
		})

		test('creates a delete operation', async () => {
			const col = createCollection()
			const inserted = await col.insert({ title: 'To delete' })
			await col.delete(inserted.id)

			expect(mutations).toHaveLength(2)
			const deleteOp = mutations[1]?.operation
			expect(deleteOp?.type).toBe('delete')
			expect(deleteOp?.data).toBeNull()
		})

		test('throws RecordNotFoundError for missing record', async () => {
			const col = createCollection()
			await expect(col.delete('nonexistent')).rejects.toThrow(RecordNotFoundError)
		})

		test('throws RecordNotFoundError for already-deleted record', async () => {
			const col = createCollection()
			const inserted = await col.insert({ title: 'Double delete' })
			await col.delete(inserted.id)

			await expect(col.delete(inserted.id)).rejects.toThrow(RecordNotFoundError)
		})
	})

	describe('with full schema', () => {
		test('inserts with enum and array fields', async () => {
			adapter = await createTestAdapter(fullSchema)
			const col = createCollection(fullSchema, 'todos')

			const result = await col.insert({
				title: 'Full test',
				tags: ['urgent', 'feature'],
				priority: 'high',
			})

			expect(result.priority).toBe('high')
			expect(result.tags).toEqual(['urgent', 'feature'])
			expect(result.count).toBe(0) // default
		})

		test('updates array fields', async () => {
			adapter = await createTestAdapter(fullSchema)
			const col = createCollection(fullSchema, 'todos')

			const inserted = await col.insert({ title: 'Tags test' })
			const updated = await col.update(inserted.id, { tags: ['new-tag'] })

			expect(updated.tags).toEqual(['new-tag'])
		})
	})
})
