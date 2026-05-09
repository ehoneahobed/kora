import { HybridLogicalClock } from '@korajs/core'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { fullSchema, minimalSchema } from '../../tests/fixtures/test-schema'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { RecordNotFoundError } from '../errors'
import { Store } from '../store/store'
import type { TransactionContext } from './transaction-context'

describe('TransactionContext', () => {
	let store: Store
	let adapter: BetterSqlite3Adapter
	let sequenceCounter: number

	beforeEach(async () => {
		adapter = new BetterSqlite3Adapter(':memory:')
		store = new Store({ schema: fullSchema, adapter, nodeId: 'tx-test-node' })
		await store.open()
		sequenceCounter = 0
	})

	afterEach(async () => {
		await store.close()
	})

	function createTx(): TransactionContext {
		return store.createTransaction()
	}

	describe('basic operations', () => {
		test('insert within transaction returns record with id', async () => {
			const tx = createTx()
			const record = await tx.collection('todos').insert({ title: 'Test todo' })

			expect(record.id).toBeDefined()
			expect(record.title).toBe('Test todo')
			expect(record.completed).toBe(false) // default

			// Not committed yet — record should NOT be in store
			const found = await store.collection('todos').findById(record.id)
			expect(found).toBeNull()

			// Commit
			await tx.commit()

			// Now it should be visible
			const foundAfter = await store.collection('todos').findById(record.id)
			expect(foundAfter).not.toBeNull()
			expect(foundAfter?.title).toBe('Test todo')
		})

		test('update within transaction reflects changes', async () => {
			// Pre-insert a record outside transaction
			const existing = await store.collection('todos').insert({ title: 'Existing' })

			const tx = createTx()
			const updated = await tx.collection('todos').update(existing.id, { completed: true })

			expect(updated.completed).toBe(true)
			expect(updated.title).toBe('Existing')

			// Before commit: store should still have old value
			const beforeCommit = await store.collection('todos').findById(existing.id)
			expect(beforeCommit?.completed).toBe(false)

			await tx.commit()

			// After commit: store should have new value
			const afterCommit = await store.collection('todos').findById(existing.id)
			expect(afterCommit?.completed).toBe(true)
		})

		test('delete within transaction removes record on commit', async () => {
			const existing = await store.collection('todos').insert({ title: 'To delete' })

			const tx = createTx()
			await tx.collection('todos').delete(existing.id)

			// Before commit: still exists
			const beforeCommit = await store.collection('todos').findById(existing.id)
			expect(beforeCommit).not.toBeNull()

			await tx.commit()

			// After commit: deleted
			const afterCommit = await store.collection('todos').findById(existing.id)
			expect(afterCommit).toBeNull()
		})

		test('findById within transaction sees buffered inserts', async () => {
			const tx = createTx()
			const record = await tx.collection('todos').insert({ title: 'Buffered' })

			// Should be visible within the transaction
			const found = await tx.collection('todos').findById(record.id)
			expect(found).not.toBeNull()
			expect(found?.title).toBe('Buffered')
		})

		test('findById within transaction sees buffered updates', async () => {
			const existing = await store.collection('todos').insert({ title: 'Original' })

			const tx = createTx()
			await tx.collection('todos').update(existing.id, { title: 'Updated' })

			const found = await tx.collection('todos').findById(existing.id)
			expect(found?.title).toBe('Updated')
		})

		test('findById within transaction sees buffered deletes', async () => {
			const existing = await store.collection('todos').insert({ title: 'To delete' })

			const tx = createTx()
			await tx.collection('todos').delete(existing.id)

			const found = await tx.collection('todos').findById(existing.id)
			expect(found).toBeNull()
		})
	})

	describe('atomicity', () => {
		test('all operations share the same transactionId', async () => {
			const tx = createTx()
			const txId = tx.getTransactionId()

			await tx.collection('todos').insert({ title: 'Todo 1' })
			await tx.collection('todos').insert({ title: 'Todo 2' })
			const existing = await store.collection('projects').insert({ name: 'Project' })
			await tx.collection('projects').update(existing.id, { active: false })

			const { operations } = await tx.commit()

			expect(operations.length).toBe(3)
			for (const op of operations) {
				expect(op.transactionId).toBe(txId)
			}
		})

		test('commit is atomic — all operations succeed or none', async () => {
			const existing = await store.collection('todos').insert({ title: 'Existing' })

			const tx = createTx()
			await tx.collection('todos').insert({ title: 'New' })
			await tx.collection('todos').update(existing.id, { completed: true })

			const { operations } = await tx.commit()
			expect(operations.length).toBe(2)

			// Both should be visible
			const updated = await store.collection('todos').findById(existing.id)
			expect(updated?.completed).toBe(true)
		})

		test('rollback discards all operations', async () => {
			const existing = await store.collection('todos').insert({ title: 'Existing' })

			const tx = createTx()
			await tx.collection('todos').insert({ title: 'Should not exist' })
			await tx.collection('todos').update(existing.id, { completed: true })

			tx.rollback()

			// Existing record should be unchanged
			const found = await store.collection('todos').findById(existing.id)
			expect(found?.completed).toBe(false)
		})

		test('error in user code triggers rollback', async () => {
			const existing = await store.collection('todos').insert({ title: 'Safe' })

			const ops = await store
				.transaction(async (tx) => {
					await tx.collection('todos').update(existing.id, { completed: true })
					throw new Error('Intentional error')
				})
				.catch(() => null)

			expect(ops).toBeNull()

			// Record should be unchanged
			const found = await store.collection('todos').findById(existing.id)
			expect(found?.completed).toBe(false)
		})

		test('empty transaction commits successfully', async () => {
			const tx = createTx()
			const { operations } = await tx.commit()
			expect(operations.length).toBe(0)
		})
	})

	describe('multi-collection', () => {
		test('insert across multiple collections atomically', async () => {
			const tx = createTx()
			const todo = await tx.collection('todos').insert({ title: 'Task' })
			const project = await tx.collection('projects').insert({ name: 'Project' })

			const { operations, affectedCollections } = await tx.commit()

			expect(operations.length).toBe(2)
			expect(affectedCollections.has('todos')).toBe(true)
			expect(affectedCollections.has('projects')).toBe(true)

			const foundTodo = await store.collection('todos').findById(todo.id)
			const foundProject = await store.collection('projects').findById(project.id)
			expect(foundTodo).not.toBeNull()
			expect(foundProject).not.toBeNull()
		})

		test('operations across collections all share transactionId', async () => {
			const tx = createTx()
			await tx.collection('todos').insert({ title: 'Task' })
			await tx.collection('projects').insert({ name: 'Project' })

			const { operations } = await tx.commit()
			const txId = operations[0]?.transactionId
			expect(txId).toBeDefined()
			for (const op of operations) {
				expect(op.transactionId).toBe(txId)
			}
		})
	})

	describe('error handling', () => {
		test('throws for unknown collection', () => {
			const tx = createTx()
			expect(() => tx.collection('nonexistent')).toThrow('Unknown collection')
		})

		test('throws RecordNotFoundError on update of missing record', async () => {
			const tx = createTx()
			await expect(tx.collection('todos').update('nonexistent-id', { title: 'X' })).rejects.toThrow(
				RecordNotFoundError,
			)
		})

		test('throws RecordNotFoundError on delete of missing record', async () => {
			const tx = createTx()
			await expect(tx.collection('todos').delete('nonexistent-id')).rejects.toThrow(
				RecordNotFoundError,
			)
		})

		test('cannot commit twice', async () => {
			const tx = createTx()
			await tx.commit()
			await expect(tx.commit()).rejects.toThrow('already committed')
		})

		test('cannot commit after rollback', async () => {
			const tx = createTx()
			tx.rollback()
			await expect(tx.commit()).rejects.toThrow('rolled back')
		})

		test('cannot insert after commit', async () => {
			const tx = createTx()
			await tx.commit()
			await expect(tx.collection('todos').insert({ title: 'Too late' })).rejects.toThrow(
				'committed',
			)
		})

		test('cannot insert after rollback', async () => {
			const tx = createTx()
			tx.rollback()
			await expect(tx.collection('todos').insert({ title: 'Too late' })).rejects.toThrow(
				'rolled-back',
			)
		})
	})

	describe('Store.transaction() convenience method', () => {
		test('commits successfully and returns operations', async () => {
			const ops = await store.transaction(async (tx) => {
				await tx.collection('todos').insert({ title: 'Via store.transaction' })
			})

			expect(ops.length).toBe(1)
			expect(ops[0]?.type).toBe('insert')
			expect(ops[0]?.transactionId).toBeDefined()
		})

		test('rolls back on error and re-throws', async () => {
			await expect(
				store.transaction(async (tx) => {
					await tx.collection('todos').insert({ title: 'Will be rolled back' })
					throw new Error('Boom')
				}),
			).rejects.toThrow('Boom')
		})

		test('subscription notifications fire after commit', async () => {
			const results: string[] = []
			store
				.collection('todos')
				.where({})
				.subscribe((records) => {
					results.push(...records.map((r) => r.title as string))
				})

			// Wait for initial subscription to fire
			await new Promise((r) => setTimeout(r, 10))
			const initialLength = results.length

			await store.transaction(async (tx) => {
				await tx.collection('todos').insert({ title: 'Subscribed A' })
				await tx.collection('todos').insert({ title: 'Subscribed B' })
			})

			// Wait for subscription to be notified
			await new Promise((r) => setTimeout(r, 50))

			// Both records should appear in a single subscription notification
			expect(results.length).toBeGreaterThan(initialLength)
		})
	})

	describe('mutation name', () => {
		test('setMutationName propagates to all operations', async () => {
			const tx = createTx()
			tx.setMutationName('complete-sale')

			await tx.collection('todos').insert({ title: 'Task' })
			await tx.collection('projects').insert({ name: 'Project' })

			const { operations } = await tx.commit()
			for (const op of operations) {
				expect(op.mutationName).toBe('complete-sale')
			}
		})

		test('getMutationName returns the set name', () => {
			const tx = createTx()
			expect(tx.getMutationName()).toBeUndefined()
			tx.setMutationName('my-mutation')
			expect(tx.getMutationName()).toBe('my-mutation')
		})

		test('operations without mutationName do not have the field', async () => {
			const tx = createTx()
			await tx.collection('todos').insert({ title: 'No mutation name' })
			const { operations } = await tx.commit()
			expect(operations[0]?.mutationName).toBeUndefined()
		})
	})

	describe('transactionId persistence', () => {
		test('transactionId survives serialization round-trip', async () => {
			await store.transaction(async (tx) => {
				await tx.collection('todos').insert({ title: 'Persistent' })
			})

			// Read back operations from the store
			const ops = await store.getOperationRange('tx-test-node', 1, 100)
			const txOps = ops.filter((op) => op.transactionId !== undefined)
			expect(txOps.length).toBeGreaterThan(0)
			expect(typeof txOps[0]?.transactionId).toBe('string')
		})
	})
})
