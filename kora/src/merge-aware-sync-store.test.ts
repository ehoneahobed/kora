import { defineSchema, t } from '@korajs/core'
import type {
	KoraEventByType,
	KoraEventEmitter,
	KoraEventListener,
	KoraEventType,
	Operation,
} from '@korajs/core'
import { MergeEngine } from '@korajs/merge'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { MergeAwareSyncStore } from './merge-aware-sync-store'

/** Minimal event emitter for testing (avoids @korajs/core/internal import) */
class TestEventEmitter implements KoraEventEmitter {
	private listeners = new Map<string, Set<(event: unknown) => void>>()
	on<T extends KoraEventType>(type: T, listener: KoraEventListener<T>): () => void {
		let set = this.listeners.get(type)
		if (!set) {
			set = new Set()
			this.listeners.set(type, set)
		}
		set.add(listener as (event: unknown) => void)
		return () => {
			set?.delete(listener as (event: unknown) => void)
		}
	}
	off<T extends KoraEventType>(type: T, listener: KoraEventListener<T>): void {
		this.listeners.get(type)?.delete(listener as (event: unknown) => void)
	}
	emit<T extends KoraEventType>(event: KoraEventByType<T>): void {
		const set = this.listeners.get(event.type)
		if (set) for (const fn of set) fn(event)
	}
}

const schema = defineSchema({
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

function makeOperation(overrides: Partial<Operation>): Operation {
	return {
		id: 'op-remote-1',
		nodeId: 'remote-node',
		type: 'update',
		collection: 'todos',
		recordId: 'rec-1',
		data: { title: 'Remote Title' },
		previousData: { title: 'Original Title' },
		timestamp: { wallTime: 2000, logical: 0, nodeId: 'remote-node' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

describe('MergeAwareSyncStore', () => {
	let store: Store
	let adapter: BetterSqlite3Adapter
	let emitter: TestEventEmitter
	let mergeEngine: MergeEngine
	let syncStore: MergeAwareSyncStore

	beforeEach(async () => {
		adapter = new BetterSqlite3Adapter(':memory:')
		emitter = new TestEventEmitter()
		store = new Store({ schema, adapter, nodeId: 'local-node', emitter })
		await store.open()
		mergeEngine = new MergeEngine()
		syncStore = new MergeAwareSyncStore(store, mergeEngine, emitter)
	})

	afterEach(async () => {
		await store.close()
	})

	test('delegates getVersionVector to store', () => {
		expect(syncStore.getVersionVector()).toEqual(store.getVersionVector())
	})

	test('delegates getNodeId to store', () => {
		expect(syncStore.getNodeId()).toBe('local-node')
	})

	test('delegates getOperationRange to store', async () => {
		const ops = await syncStore.getOperationRange('some-node', 1, 10)
		expect(ops).toEqual([])
	})

	test('delegates insert operations directly to store', async () => {
		const insertOp = makeOperation({
			type: 'insert',
			data: { title: 'New Todo', completed: 0 },
			previousData: null,
		})
		const result = await syncStore.applyRemoteOperation(insertOp)
		expect(result).toBe('applied')

		const record = await store.collection('todos').findById('rec-1')
		expect(record).not.toBeNull()
		expect(record?.title).toBe('New Todo')
	})

	test('delegates delete operations directly to store', async () => {
		// First insert a record
		await store.collection('todos').insert({ title: 'To Delete' })

		const deleteOp = makeOperation({
			type: 'delete',
			data: null,
			previousData: null,
		})
		const result = await syncStore.applyRemoteOperation(deleteOp)
		// May be 'applied' or 'skipped' depending on record existence
		expect(['applied', 'skipped']).toContain(result)
	})

	test('applies non-conflicting remote update directly', async () => {
		// Insert a record with "Original Title" (matching the remote op's previousData)
		const insertOp = makeOperation({
			id: 'op-insert-1',
			type: 'insert',
			data: { title: 'Original Title', completed: 0 },
			previousData: null,
			timestamp: { wallTime: 500, logical: 0, nodeId: 'remote-node' },
		})
		await store.applyRemoteOperation(insertOp)

		// Remote update: title "Original Title" -> "Remote Title"
		// Local has not changed title, so no conflict
		const updateOp = makeOperation({
			previousData: { title: 'Original Title' },
			data: { title: 'Remote Title' },
		})
		const result = await syncStore.applyRemoteOperation(updateOp)
		expect(result).toBe('applied')

		const record = await store.collection('todos').findById('rec-1')
		expect(record?.title).toBe('Remote Title')
	})

	test('runs merge engine when conflict detected', async () => {
		// Insert a record
		const insertOp = makeOperation({
			id: 'op-insert-1',
			type: 'insert',
			data: { title: 'Original Title', completed: 0 },
			previousData: null,
			timestamp: { wallTime: 500, logical: 0, nodeId: 'remote-node' },
		})
		await store.applyRemoteOperation(insertOp)

		// Simulate local update: change title to "Local Title"
		await store.collection('todos').update('rec-1', { title: 'Local Title' })

		// Remote update expects title was "Original Title" but locally it's now "Local Title"
		const mergeEvents: unknown[] = []
		emitter.on('merge:started', (e) => mergeEvents.push(e))

		const updateOp = makeOperation({
			previousData: { title: 'Original Title' },
			data: { title: 'Remote Title' },
			timestamp: { wallTime: 3000, logical: 0, nodeId: 'remote-node' },
		})
		const result = await syncStore.applyRemoteOperation(updateOp)
		expect(result).toBe('applied')

		// Merge was triggered
		expect(mergeEvents.length).toBe(1)
	})

	test('invokes onMergeConflict when field-level merge conflicts', async () => {
		const onMergeConflict = vi.fn()
		const conflictAwareStore = new MergeAwareSyncStore(store, mergeEngine, emitter, {
			onMergeConflict,
		})

		const insertOp = makeOperation({
			id: 'op-insert-conflict',
			type: 'insert',
			data: { title: 'Original Title', completed: 0 },
			previousData: null,
			timestamp: { wallTime: 500, logical: 0, nodeId: 'remote-node' },
		})
		await store.applyRemoteOperation(insertOp)
		await store.collection('todos').update('rec-1', { title: 'Local Title' })

		const updateOp = makeOperation({
			previousData: { title: 'Original Title' },
			data: { title: 'Remote Title' },
			timestamp: { wallTime: 3000, logical: 0, nodeId: 'remote-node' },
		})
		await conflictAwareStore.applyRemoteOperation(updateOp)

		expect(onMergeConflict).toHaveBeenCalledOnce()
	})

	test('remote delete cascades to referencing records per schema onDelete', async () => {
		const cascadeSchema = defineSchema({
			version: 1,
			collections: {
				projects: {
					fields: {
						name: t.string(),
					},
				},
				todos: {
					fields: {
						title: t.string(),
						projectId: t.string(),
					},
				},
			},
			relations: {
				todoBelongsToProject: {
					from: 'todos',
					to: 'projects',
					type: 'many-to-one',
					field: 'projectId',
					onDelete: 'cascade',
				},
			},
		})

		const cascadeAdapter = new BetterSqlite3Adapter(':memory:')
		const cascadeStore = new Store({
			schema: cascadeSchema,
			adapter: cascadeAdapter,
			nodeId: 'local-node',
			emitter,
		})
		await cascadeStore.open()
		const cascadeSyncStore = new MergeAwareSyncStore(cascadeStore, mergeEngine, emitter)

		try {
			const projectInsert = makeOperation({
				id: 'op-project-insert',
				type: 'insert',
				collection: 'projects',
				recordId: 'proj-1',
				data: { name: 'Kora' },
				previousData: null,
				timestamp: { wallTime: 100, logical: 0, nodeId: 'remote-node' },
			})
			await cascadeSyncStore.applyRemoteOperation(projectInsert)

			const todoInsert = makeOperation({
				id: 'op-todo-insert',
				type: 'insert',
				collection: 'todos',
				recordId: 'todo-1',
				data: { title: 'Ship', projectId: 'proj-1' },
				previousData: null,
				timestamp: { wallTime: 200, logical: 0, nodeId: 'remote-node' },
			})
			await cascadeSyncStore.applyRemoteOperation(todoInsert)

			const projectDelete = makeOperation({
				id: 'op-project-delete',
				type: 'delete',
				collection: 'projects',
				recordId: 'proj-1',
				data: null,
				previousData: null,
				timestamp: { wallTime: 300, logical: 0, nodeId: 'remote-node' },
			})
			const result = await cascadeSyncStore.applyRemoteOperation(projectDelete)
			expect(result).toBe('applied')

			const todo = await cascadeStore.collection('todos').findById('todo-1')
			expect(todo).toBeNull()

			const project = await cascadeStore.collection('projects').findById('proj-1')
			expect(project).toBeNull()
		} finally {
			await cascadeStore.close()
		}
	})

	test('local update newer than remote delete keeps the record', async () => {
		const insertOp = makeOperation({
			id: 'op-insert-1',
			type: 'insert',
			data: { title: 'Original', completed: 0 },
			previousData: null,
			timestamp: { wallTime: 500, logical: 0, nodeId: 'remote-node' },
		})
		await syncStore.applyRemoteOperation(insertOp)

		await store.collection('todos').update('rec-1', { title: 'Local wins' })
		const localOp = await store.getLatestLocalOperationForRecord('todos', 'rec-1')
		expect(localOp).not.toBeNull()

		const deleteOp = makeOperation({
			id: 'op-delete-remote',
			type: 'delete',
			data: null,
			previousData: null,
			timestamp: {
				wallTime: localOp!.timestamp.wallTime - 1,
				logical: 0,
				nodeId: 'remote-node',
			},
		})
		const result = await syncStore.applyRemoteOperation(deleteOp)
		expect(result).toBe('skipped')

		const record = await store.collection('todos').findById('rec-1')
		expect(record).not.toBeNull()
		expect(record?.title).toBe('Local wins')
	})

	test('remote delete newer than local update removes the record', async () => {
		const insertOp = makeOperation({
			id: 'op-insert-2',
			type: 'insert',
			data: { title: 'Original', completed: 0 },
			previousData: null,
			timestamp: { wallTime: 500, logical: 0, nodeId: 'remote-node' },
		})
		await syncStore.applyRemoteOperation(insertOp)

		await store.collection('todos').update('rec-1', { title: 'Stale local' })
		const localOp = await store.getLatestLocalOperationForRecord('todos', 'rec-1')
		expect(localOp).not.toBeNull()

		const deleteOp = makeOperation({
			id: 'op-delete-remote-late',
			type: 'delete',
			data: null,
			previousData: null,
			timestamp: {
				wallTime: localOp!.timestamp.wallTime + 1,
				logical: 0,
				nodeId: 'remote-node',
			},
		})
		const result = await syncStore.applyRemoteOperation(deleteOp)
		expect(result).toBe('applied')

		const record = await store.collection('todos').findById('rec-1')
		expect(record).toBeNull()
	})

	test('local delete newer than remote update keeps tombstone without zombie fields', async () => {
		const insertOp = makeOperation({
			id: 'op-insert-3',
			type: 'insert',
			data: { title: 'Base', completed: 0 },
			previousData: null,
			timestamp: { wallTime: 500, logical: 0, nodeId: 'remote-node' },
		})
		await syncStore.applyRemoteOperation(insertOp)

		await store.collection('todos').delete('rec-1')
		const localOp = await store.getLatestLocalOperationForRecord('todos', 'rec-1')
		expect(localOp?.type).toBe('delete')

		const updateOp = makeOperation({
			id: 'op-update-stale',
			data: { title: 'Remote stale update' },
			previousData: { title: 'Base' },
			timestamp: {
				wallTime: localOp!.timestamp.wallTime - 1,
				logical: 0,
				nodeId: 'remote-node',
			},
		})
		const result = await syncStore.applyRemoteOperation(updateOp)
		expect(result).toBe('skipped')

		const row = await store.findMaterializedRow('todos', 'rec-1')
		expect(row?.deleted).toBe(true)
	})

	test('remote update newer than local delete reactivates without zombie state', async () => {
		const insertOp = makeOperation({
			id: 'op-insert-4',
			type: 'insert',
			data: { title: 'Base', completed: 0 },
			previousData: null,
			timestamp: { wallTime: 500, logical: 0, nodeId: 'remote-node' },
		})
		await syncStore.applyRemoteOperation(insertOp)

		await store.collection('todos').delete('rec-1')
		const localOp = await store.getLatestLocalOperationForRecord('todos', 'rec-1')
		expect(localOp?.type).toBe('delete')

		const updateOp = makeOperation({
			id: 'op-update-late',
			data: { title: 'Remote resurrection', completed: 1 },
			previousData: { title: 'Base', completed: 0 },
			timestamp: {
				wallTime: localOp!.timestamp.wallTime + 1,
				logical: 0,
				nodeId: 'remote-node',
			},
		})
		const result = await syncStore.applyRemoteOperation(updateOp)
		expect(result).toBe('applied')

		const record = await store.collection('todos').findById('rec-1')
		expect(record).not.toBeNull()
		expect(record?.title).toBe('Remote resurrection')
		expect(record?.completed).toBe(true)
	})

	test('deduplicates operations via store', async () => {
		const insertOp = makeOperation({
			type: 'insert',
			data: { title: 'Test', completed: 0 },
			previousData: null,
		})

		const first = await syncStore.applyRemoteOperation(insertOp)
		expect(first).toBe('applied')

		const second = await syncStore.applyRemoteOperation(insertOp)
		expect(second).toBe('duplicate')
	})
})
