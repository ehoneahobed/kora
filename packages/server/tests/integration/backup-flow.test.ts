import { defineSchema, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { MemoryServerStore } from '../../src/store/memory-server-store'

const todosSchema = defineSchema({
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

const todosTitleOnlySchema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
			},
		},
	},
})

const itemsSchema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				name: t.string(),
			},
		},
	},
})

describe('Backup and restore flow', () => {
	test('export and import backup preserves all operations', async () => {
		const storeA = new MemoryServerStore('server-a')
		await storeA.setSchema(todosSchema)

		// Insert some operations into store A
		await storeA.applyRemoteOperation({
			id: 'op-1',
			nodeId: 'client-1',
			type: 'insert',
			collection: 'todos',
			recordId: 'rec-1',
			data: { title: 'hello', completed: false },
			previousData: null,
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'client-1' },
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		})
		await storeA.applyRemoteOperation({
			id: 'op-2',
			nodeId: 'client-1',
			type: 'insert',
			collection: 'todos',
			recordId: 'rec-2',
			data: { title: 'world', completed: true },
			previousData: null,
			timestamp: { wallTime: 1001, logical: 0, nodeId: 'client-1' },
			sequenceNumber: 2,
			causalDeps: [],
			schemaVersion: 1,
		})

		expect(await storeA.getOperationCount()).toBe(2)

		// Export backup
		const backup = await storeA.exportBackup()
		expect(backup).toBeInstanceOf(Uint8Array)
		expect(backup.byteLength).toBeGreaterThan(0)

		// Create store B and import
		const storeB = new MemoryServerStore('server-b')
		await storeB.setSchema(todosSchema)

		const result = await storeB.importBackup(backup, false)
		expect(result.success).toBe(true)
		expect(result.operationsRestored).toBe(2)

		// Verify operations match
		expect(await storeB.getOperationCount()).toBe(2)

		// Verify records are materialized correctly
		const recordsA = await storeA.materializeCollection('todos')
		const recordsB = await storeB.materializeCollection('todos')
		expect(recordsB).toEqual(recordsA)
	})

	test('merge mode does not duplicate operations', async () => {
		const storeA = new MemoryServerStore('server-a')
		await storeA.setSchema(todosTitleOnlySchema)

		// Insert one operation
		await storeA.applyRemoteOperation({
			id: 'op-1',
			nodeId: 'client-1',
			type: 'insert',
			collection: 'todos',
			recordId: 'rec-1',
			data: { title: 'alpha' },
			previousData: null,
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'client-1' },
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		})

		const backup = await storeA.exportBackup()

		const storeB = new MemoryServerStore('server-b')
		await storeB.setSchema(todosTitleOnlySchema)

		// Import, then import again (idempotent)
		const r1 = await storeB.importBackup(backup, true)
		expect(r1.success).toBe(true)
		expect(r1.operationsRestored).toBe(1)

		const r2 = await storeB.importBackup(backup, true)
		expect(r2.success).toBe(true)
		// Same content-addressed operations should not be duplicated
		expect(r2.operationsRestored).toBe(0)

		expect(await storeB.getOperationCount()).toBe(1)
	})

	test('export from populated server is valid binary', async () => {
		const store = new MemoryServerStore('server-test')
		await store.setSchema(itemsSchema)

		for (let i = 0; i < 10; i++) {
			await store.applyRemoteOperation({
				id: `op-${i}`,
				nodeId: 'client-1',
				type: 'insert',
				collection: 'items',
				recordId: `rec-${i}`,
				data: { name: `item-${i}` },
				previousData: null,
				timestamp: { wallTime: 1000 + i, logical: 0, nodeId: 'client-1' },
				sequenceNumber: i + 1,
				causalDeps: [],
				schemaVersion: 1,
			})
		}

		const backup = await store.exportBackup()
		expect(backup.byteLength).toBeGreaterThan(100)

		const emptyStore = new MemoryServerStore('server-empty')
		await emptyStore.setSchema(itemsSchema)
		const imported = await emptyStore.importBackup(backup, false)
		expect(imported.success).toBe(true)
		expect(imported.operationsRestored).toBe(10)
	})
})
