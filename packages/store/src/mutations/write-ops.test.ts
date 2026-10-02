import { defineSchema, op, t } from '@korajs/core'
import type { KoraEvent, Operation } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { parseFieldVersions } from '../lww/field-versions'
import { InvalidStateTransitionError } from '../state-machine/state-validator'
import { Store } from '../store/store'
import type { StorageAdapter, Transaction } from '../types'

/**
 * Contract of the single local write path (W6): transaction entries, single
 * writes and referential side effects are all built inside the commit's storage
 * transaction, with sequence numbers reserved there, per-field stamps, the state
 * machine and atomic ops resolved against the committed row.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		projects: { fields: { name: t.string() } },
		todos: {
			fields: {
				title: t.string(),
				projectId: t.string().optional(),
				n: t.number().default(0),
			},
		},
		notes: { fields: { body: t.string(), projectId: t.string().optional() } },
		guards: { fields: { label: t.string(), projectId: t.string().optional() } },
		folders: { fields: { name: t.string(), parentId: t.string().optional() } },
		orders: {
			fields: {
				status: t.enum(['draft', 'submitted', 'delivered']).default('draft'),
			},
			stateMachine: {
				field: 'status',
				transitions: { draft: ['submitted'], submitted: ['delivered'], delivered: [] },
				onInvalidTransition: 'reject',
			},
		},
	},
	relations: {
		todoProject: {
			from: 'todos',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'cascade',
		},
		noteProject: {
			from: 'notes',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'set-null',
		},
		folderParent: {
			from: 'folders',
			to: 'folders',
			type: 'many-to-one',
			field: 'parentId',
			onDelete: 'cascade',
		},
	},
})

const NODE = 'write-node'

async function persistedCounter(adapter: StorageAdapter): Promise<number> {
	const rows = await adapter.query<{ sequence_number: number }>(
		'SELECT sequence_number FROM _kora_version_vector WHERE node_id = ?',
		[NODE],
	)
	return rows[0]?.sequence_number ?? 0
}

async function rawRow(
	adapter: StorageAdapter,
	table: string,
	id: string,
): Promise<Record<string, unknown>> {
	const rows = await adapter.query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id = ?`, [
		id,
	])
	const row = rows[0]
	if (!row) throw new Error(`row ${table}/${id} missing`)
	return row
}

describe('single local write path', () => {
	let adapter: BetterSqlite3Adapter
	let store: Store

	beforeEach(async () => {
		adapter = new BetterSqlite3Adapter(':memory:')
		store = new Store({ schema, adapter, nodeId: NODE })
		await store.open()
	})

	afterEach(async () => {
		await store.close()
	})

	test('transaction inserts and updates stamp every written field (STORE-3)', async () => {
		let id = ''
		const [insertOp] = await store.transaction(async (tx) => {
			id = (await tx.collection('todos').insert({ title: 'a' })).id
		})
		const inserted = await rawRow(adapter, 'todos', id)
		const insertVersions = parseFieldVersions(inserted._field_versions)
		expect(Object.keys(insertVersions).sort()).toEqual(['n', 'title'])
		expect(new Set(Object.values(insertVersions)).size).toBe(1)
		expect(inserted._version).toBe(insertVersions.title)
		expect(insertOp?.sequenceNumber).toBe(1)

		await store.transaction(async (tx) => {
			await tx.collection('todos').update(id, { title: 'b' })
		})
		const updated = await rawRow(adapter, 'todos', id)
		const updateVersions = parseFieldVersions(updated._field_versions)
		expect(updateVersions.title).toBe(updated._version)
		expect((updateVersions.title ?? '') > (insertVersions.title ?? '')).toBe(true)
		// Untouched fields keep their own stamps.
		expect(updateVersions.n).toBe(insertVersions.n)
	})

	test('a transaction reserves one contiguous block covering cascades and set-null', async () => {
		const project = await store.collection('projects').insert({ name: 'p' }) // 1
		const t1 = await store.collection('todos').insert({ title: 't1', projectId: project.id }) // 2
		const n1 = await store.collection('notes').insert({ body: 'n1', projectId: project.id }) // 3

		const ops = await store.transaction(async (tx) => {
			await tx.collection('projects').insert({ name: 'q' }) // 4
			await tx.collection('projects').delete(project.id) // 5 + cascades 6, 7
			await tx.collection('todos').insert({ title: 'after' }) // 8
		})

		expect(ops.map((o) => o.sequenceNumber)).toEqual([4, 5, 6, 7, 8])
		expect(await persistedCounter(adapter)).toBe(8)
		const parentDelete = ops[1] as Operation
		const sideEffects = ops.slice(2, 4)
		for (const effect of sideEffects) {
			expect(effect.causalDeps).toContain(parentDelete.id)
			expect(effect.transactionId).toBe(parentDelete.transactionId)
		}
		expect(await store.collection('todos').findById(t1.id)).toBeNull()

		// set-null went through the update builder: stamped, versioned, with
		// previousData read inside the transaction.
		const note = await rawRow(adapter, 'notes', n1.id)
		expect(note.projectId).toBeNull()
		const noteVersions = parseFieldVersions(note._field_versions)
		expect(noteVersions.projectId).toBe(note._version)
		const setNull = sideEffects.find((o) => o.collection === 'notes')
		expect(setNull?.previousData).toEqual({ projectId: project.id })
	})

	test('a failed write burns no sequence number', async () => {
		await store.collection('todos').insert({ title: 'one' }) // 1
		await expect(store.collection('todos').update('missing', { title: 'x' })).rejects.toThrow()
		await expect(
			store.transaction(async (tx) => {
				await tx.collection('todos').insert({ title: 'rolled back' })
				await tx.collection('orders').insert({})
				// Fails at commit: the record is gone by then.
				await tx
					.collection('todos')
					.delete('missing-at-commit')
					.catch(() => {})
				throw new Error('abort')
			}),
		).rejects.toThrow('abort')
		const next = await store.collection('todos').insert({ title: 'two' })
		const ops = await store.getAllOperations()
		expect(ops.map((o) => o.sequenceNumber).sort()).toEqual([1, 2])
		expect(ops.find((o) => o.recordId === next.id)?.sequenceNumber).toBe(2)
		expect(await persistedCounter(adapter)).toBe(2)
	})

	test('a self-referencing cascade terminates and deletes the whole subtree', async () => {
		const root = await store.collection('folders').insert({ name: 'root' })
		const child = await store.collection('folders').insert({ name: 'child', parentId: root.id })
		await store.collection('folders').insert({ name: 'grandchild', parentId: child.id })
		// A cycle: root points back at its grandchild's parent.
		await store.collection('folders').update(root.id, { parentId: child.id })

		await store.collection('folders').delete(root.id)
		const live = await store.collection('folders').where({}).exec()
		expect(live).toEqual([])
		const deletes = (await store.getAllOperations()).filter((o) => o.type === 'delete')
		expect(new Set(deletes.map((o) => o.recordId)).size).toBe(deletes.length)
	})

	test('state machine and atomic ops resolve against the row inside the commit', async () => {
		const order = await store.collection('orders').insert({})
		// Sequential transitions inside one transaction are valid in order.
		await store.transaction(async (tx) => {
			await tx.collection('orders').update(order.id, { status: 'submitted' })
			await tx.collection('orders').update(order.id, { status: 'delivered' })
		})
		expect((await store.collection('orders').findById(order.id))?.status).toBe('delivered')
		await expect(
			store.transaction(async (tx) => {
				await tx.collection('orders').update(order.id, { status: 'draft' })
			}),
		).rejects.toBeInstanceOf(InvalidStateTransitionError)

		const todo = await store.collection('todos').insert({ title: 'c' })
		await Promise.all(
			Array.from({ length: 6 }, (_, i) =>
				i % 2 === 0
					? store.collection('todos').update(todo.id, { n: op.increment(1) })
					: store.transaction(async (tx) => {
							await tx.collection('todos').update(todo.id, { n: op.increment(1) })
						}),
			),
		)
		expect((await store.collection('todos').findById(todo.id))?.n).toBe(6)
		const increments = (await store.getAllOperations()).filter(
			(o) => o.recordId === todo.id && o.type === 'update',
		)
		// previousData chains: each increment saw the previous one's result.
		expect(increments.map((o) => (o.previousData as { n: number }).n).sort()).toEqual([
			0, 1, 2, 3, 4, 5,
		])
	})
})

describe('storage-full errors', () => {
	test('SQLITE_FULL from a write surfaces as store:quota-exceeded and still rejects', async () => {
		const inner = new BetterSqlite3Adapter(':memory:')
		let full = false
		const adapter: StorageAdapter = {
			open: (s) => inner.open(s),
			close: () => inner.close(),
			execute: (sql, params) => inner.execute(sql, params),
			query: (sql, params) => inner.query(sql, params),
			migrate: (from, to, plan) => inner.migrate(from, to, plan),
			transaction: (fn) =>
				inner.transaction(async (tx: Transaction) => {
					await fn(tx)
					if (full) throw new Error('SQLITE_FULL: database or disk is full')
				}),
		}
		const emitter = new SimpleEventEmitter()
		const events: KoraEvent[] = []
		emitter.on('store:quota-exceeded', (event) => events.push(event))
		const store = new Store({ schema, adapter, nodeId: NODE, emitter, dbName: 'quota-db' })
		await store.open()
		try {
			full = true
			await expect(store.collection('todos').insert({ title: 'x' })).rejects.toThrow('SQLITE_FULL')
			await expect(
				store.transaction(async (tx) => {
					await tx.collection('todos').insert({ title: 'y' })
				}),
			).rejects.toThrow('SQLITE_FULL')
			expect(events).toHaveLength(2)
			expect(events[0]).toMatchObject({ type: 'store:quota-exceeded', dbName: 'quota-db' })
			// Nothing was published for the failed writes.
			expect(store.getVersionVector().get(NODE)).toBeUndefined()
		} finally {
			full = false
			await store.close()
		}
	})
})
