import { HybridLogicalClock, createOperation, generateUUIDv7 } from '@kora/core'
import type { Operation } from '@kora/core'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { fullSchema, minimalSchema } from '../../tests/fixtures/test-schema'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { StoreNotOpenError } from '../errors'
import { Store } from './store'

describe('Store', () => {
	let store: Store
	let adapter: BetterSqlite3Adapter

	beforeEach(async () => {
		adapter = new BetterSqlite3Adapter(':memory:')
		store = new Store({ schema: minimalSchema, adapter, nodeId: 'test-node' })
		await store.open()
	})

	afterEach(async () => {
		await store.close()
	})

	describe('open/close', () => {
		test('initializes with provided nodeId', () => {
			expect(store.getNodeId()).toBe('test-node')
		})

		test('generates nodeId if not provided', async () => {
			const s = new Store({ schema: minimalSchema, adapter: new BetterSqlite3Adapter(':memory:') })
			await s.open()
			expect(store.getNodeId()).toBeTruthy()
			expect(typeof s.getNodeId()).toBe('string')
			await s.close()
		})

		test('uses configured nodeId when provided', async () => {
			const s = new Store({
				schema: minimalSchema,
				adapter: new BetterSqlite3Adapter(':memory:'),
				nodeId: 'custom-node-id',
			})
			await s.open()
			expect(s.getNodeId()).toBe('custom-node-id')
			await s.close()
		})

		test('starts with empty version vector', () => {
			expect(store.getVersionVector().size).toBe(0)
		})

		test('throws StoreNotOpenError before open', async () => {
			const s = new Store({ schema: minimalSchema, adapter: new BetterSqlite3Adapter(':memory:') })
			expect(() => s.collection('todos')).toThrow(StoreNotOpenError)
			expect(() => s.getNodeId()).toThrow(StoreNotOpenError)
			expect(() => s.getVersionVector()).toThrow(StoreNotOpenError)
		})
	})

	describe('collection', () => {
		test('returns a collection accessor for a valid collection', () => {
			const col = store.collection('todos')
			expect(col).toBeDefined()
			expect(typeof col.insert).toBe('function')
			expect(typeof col.findById).toBe('function')
			expect(typeof col.update).toBe('function')
			expect(typeof col.delete).toBe('function')
			expect(typeof col.where).toBe('function')
		})

		test('throws for unknown collection', () => {
			expect(() => store.collection('nonexistent')).toThrow('Unknown collection')
		})
	})

	describe('CRUD through Store', () => {
		test('insert and findById', async () => {
			const col = store.collection('todos')
			const record = await col.insert({ title: 'Store test' })

			expect(record.id).toBeDefined()
			expect(record.title).toBe('Store test')

			const found = await col.findById(record.id)
			expect(found?.title).toBe('Store test')
		})

		test('update', async () => {
			const col = store.collection('todos')
			const record = await col.insert({ title: 'Before' })
			const updated = await col.update(record.id, { title: 'After' })

			expect(updated.title).toBe('After')
		})

		test('delete', async () => {
			const col = store.collection('todos')
			const record = await col.insert({ title: 'To delete' })
			await col.delete(record.id)

			const found = await col.findById(record.id)
			expect(found).toBeNull()
		})

		test('where query', async () => {
			const col = store.collection('todos')
			await col.insert({ title: 'A', completed: true })
			await col.insert({ title: 'B' })

			const results = await col.where({ completed: false }).exec()
			expect(results).toHaveLength(1)
			expect(results[0]?.title).toBe('B')
		})
	})

	describe('version vector', () => {
		test('updates after mutations', async () => {
			const col = store.collection('todos')
			await col.insert({ title: 'VV test 1' })
			await col.insert({ title: 'VV test 2' })

			const vv = store.getVersionVector()
			expect(vv.get('test-node')).toBe(2)
		})
	})

	describe('applyRemoteOperation', () => {
		async function createRemoteOp(overrides: Partial<Operation> = {}): Promise<Operation> {
			const clock = new HybridLogicalClock('remote-node')
			return createOperation(
				{
					nodeId: 'remote-node',
					type: 'insert',
					collection: 'todos',
					recordId: generateUUIDv7(),
					data: { title: 'Remote todo', completed: false },
					previousData: null,
					sequenceNumber: 1,
					causalDeps: [],
					schemaVersion: 1,
					...overrides,
				},
				clock,
			)
		}

		test('applies a remote insert', async () => {
			const op = await createRemoteOp()
			const result = await store.applyRemoteOperation(op)
			expect(result).toBe('applied')

			const col = store.collection('todos')
			const found = await col.findById(op.recordId)
			expect(found).not.toBeNull()
			expect(found?.title).toBe('Remote todo')
		})

		test('deduplicates by operation id', async () => {
			const op = await createRemoteOp()
			await store.applyRemoteOperation(op)
			const result = await store.applyRemoteOperation(op)
			expect(result).toBe('duplicate')
		})

		test('skips operations for unknown collections', async () => {
			const clock = new HybridLogicalClock('remote-node')
			const op = await createOperation(
				{
					nodeId: 'remote-node',
					type: 'insert',
					collection: 'nonexistent',
					recordId: generateUUIDv7(),
					data: { title: 'Bad' },
					previousData: null,
					sequenceNumber: 1,
					causalDeps: [],
					schemaVersion: 1,
				},
				clock,
			)
			const result = await store.applyRemoteOperation(op)
			expect(result).toBe('skipped')
		})

		test('updates version vector for remote node', async () => {
			const op = await createRemoteOp({ sequenceNumber: 5 })
			await store.applyRemoteOperation(op)

			const vv = store.getVersionVector()
			expect(vv.get('remote-node')).toBe(5)
		})

		test('applies remote update', async () => {
			// First insert locally
			const col = store.collection('todos')
			const record = await col.insert({ title: 'Local' })

			// Then apply remote update
			const clock = new HybridLogicalClock('remote-node')
			const op = await createOperation(
				{
					nodeId: 'remote-node',
					type: 'update',
					collection: 'todos',
					recordId: record.id,
					data: { title: 'Updated remotely' },
					previousData: { title: 'Local' },
					sequenceNumber: 1,
					causalDeps: [],
					schemaVersion: 1,
				},
				clock,
			)

			await store.applyRemoteOperation(op)

			const found = await col.findById(record.id)
			expect(found?.title).toBe('Updated remotely')
		})

		test('applies remote delete', async () => {
			const col = store.collection('todos')
			const record = await col.insert({ title: 'To remote delete' })

			const clock = new HybridLogicalClock('remote-node')
			const op = await createOperation(
				{
					nodeId: 'remote-node',
					type: 'delete',
					collection: 'todos',
					recordId: record.id,
					data: null,
					previousData: null,
					sequenceNumber: 1,
					causalDeps: [],
					schemaVersion: 1,
				},
				clock,
			)

			await store.applyRemoteOperation(op)

			const found = await col.findById(record.id)
			expect(found).toBeNull()
		})
	})

	describe('getOperationRange', () => {
		test('returns operations for a node within range', async () => {
			const col = store.collection('todos')
			await col.insert({ title: 'Op 1' })
			await col.insert({ title: 'Op 2' })
			await col.insert({ title: 'Op 3' })

			const ops = await store.getOperationRange('test-node', 1, 3)
			expect(ops).toHaveLength(3)
			expect(ops[0]?.sequenceNumber).toBe(1)
			expect(ops[2]?.sequenceNumber).toBe(3)
		})

		test('returns subset when range is partial', async () => {
			const col = store.collection('todos')
			await col.insert({ title: 'Op 1' })
			await col.insert({ title: 'Op 2' })
			await col.insert({ title: 'Op 3' })

			const ops = await store.getOperationRange('test-node', 2, 3)
			expect(ops).toHaveLength(2)
			expect(ops[0]?.sequenceNumber).toBe(2)
		})

		test('returns empty for non-existent node', async () => {
			const ops = await store.getOperationRange('unknown-node', 1, 10)
			expect(ops).toEqual([])
		})

		test('includes collection name on deserialized operations', async () => {
			const col = store.collection('todos')
			await col.insert({ title: 'Named op' })

			const ops = await store.getOperationRange('test-node', 1, 1)
			expect(ops[0]?.collection).toBe('todos')
		})
	})
})
