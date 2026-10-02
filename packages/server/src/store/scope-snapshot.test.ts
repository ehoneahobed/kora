import { type Operation, defineSchema, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { MemoryServerStore } from './memory-server-store'
import { replayScopeSnapshots, scopeValuesOf } from './scope-snapshot'
import type { ServerStore } from './server-store'
import { MAX_SCOPE_SNAPSHOT_STRING_LENGTH } from './server-store'
import { createSqliteServerStore } from './sqlite-server-store'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				owner: t.string(),
				done: t.boolean().default(false),
				tags: t.array(t.string()).default([]),
			},
		},
	},
})

let seq = 0
function op(overrides: Partial<Operation>): Operation {
	seq += 1
	return {
		id: `op-${seq}`,
		nodeId: 'n',
		type: 'insert',
		collection: 'todos',
		recordId: 'todo-1',
		data: {},
		previousData: null,
		timestamp: { wallTime: 1000 + seq, logical: 0, nodeId: 'n' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

function history(): Operation[] {
	return [
		op({ data: { title: 'draft', owner: 'bob', done: false, tags: ['x'] } }),
		op({ type: 'update', data: { title: 'final' }, previousData: { owner: 'alice' } }),
		op({ type: 'update', data: { owner: 'alice' } }),
		op({ type: 'delete', data: null }),
	]
}

describe('scopeValuesOf', () => {
	test('keeps id and scalar fields, never arrays or over-long strings', () => {
		const values = scopeValuesOf(schema, 'todos', 'todo-1', {
			id: 'ignored',
			title: 'x'.repeat(MAX_SCOPE_SNAPSHOT_STRING_LENGTH + 1),
			owner: 'bob',
			done: true,
			tags: ['a'],
		})
		expect(values).toEqual({ id: 'todo-1', owner: 'bob', done: true })
		expect(scopeValuesOf(schema, 'todos', 'todo-1', null)).toBeNull()
		expect(scopeValuesOf(schema, 'nope', 'todo-1', { id: 'x' })).toBeNull()
	})
})

describe('replayScopeSnapshots (migration backfill)', () => {
	test('each operation gets the scope values before and after it, from the log', () => {
		const ops = history()
		const snapshots = replayScopeSnapshots(
			schema,
			'todos',
			'todo-1',
			ops.map((o) => ({
				id: o.id,
				type: o.type,
				data: o.data,
				atomicOps: null,
				timestamp: o.timestamp,
			})),
		)
		const [insert, edit, transfer, remove] = ops.map((o) => snapshots.get(o.id))
		expect(insert).toEqual({
			pre: null,
			post: { id: 'todo-1', title: 'draft', owner: 'bob', done: false },
		})
		// The writer's previousData (owner: alice) is never used.
		expect(edit?.pre?.owner).toBe('bob')
		expect(edit?.post?.owner).toBe('bob')
		expect(transfer?.pre?.owner).toBe('bob')
		expect(transfer?.post?.owner).toBe('alice')
		// A delete keeps the record's last values.
		expect(remove?.post?.owner).toBe('alice')
	})
})

async function contract(name: string, make: () => Promise<ServerStore>): Promise<void> {
	describe(`${name}: operation scope snapshots and blob owners`, () => {
		test('snapshots are captured at apply time from the stored rows', async () => {
			const store = await make()
			await store.setSchema(schema)
			const ops = history()
			for (const o of ops) await store.applyRemoteOperation(o)
			const snapshots = await store.getOperationScopeSnapshots?.(ops.map((o) => o.id))
			expect(snapshots?.size).toBe(4)
			expect(snapshots?.get(ops[1]?.id ?? '')?.pre?.owner).toBe('bob')
			expect(snapshots?.get(ops[2]?.id ?? '')?.post?.owner).toBe('alice')
			expect(snapshots?.get(ops[3]?.id ?? '')?.post?.owner).toBe('alice')
			const delivered = await store.getOperationsAfterDelivery(0, 10)
			expect(delivered.map((d) => d.scopeSnapshot?.post?.owner)).toEqual([
				'bob',
				'bob',
				'alice',
				'alice',
			])
		})

		test('operations stored before the schema was set are backfilled from the log', async () => {
			const store = await make()
			const ops = history()
			for (const o of ops) await store.applyRemoteOperation(o)
			await store.setSchema(schema)
			const snapshots = await store.getOperationScopeSnapshots?.(ops.map((o) => o.id))
			expect(snapshots?.get(ops[0]?.id ?? '')?.post?.owner).toBe('bob')
			expect(snapshots?.get(ops[2]?.id ?? '')?.pre?.owner).toBe('bob')
			expect(snapshots?.get(ops[2]?.id ?? '')?.post?.owner).toBe('alice')
		})

		test('blob ownership: first claim wins, pushes add owners', async () => {
			const store = await make()
			const hash = 'a'.repeat(64)
			expect(await store.claimBlobIfUnowned?.(hash, 'alice')).toBe(true)
			expect(await store.claimBlobIfUnowned?.(hash, 'bob')).toBe(false)
			expect(await store.claimBlobIfUnowned?.(hash, 'alice')).toBe(true)
			await store.recordBlobOwner?.(hash, 'bob')
			await store.recordBlobOwner?.(hash, 'bob')
			const owners = await store.getBlobOwners?.([hash, 'b'.repeat(64)])
			expect([...(owners?.get(hash) ?? [])].sort()).toEqual(['alice', 'bob'])
			expect(owners?.get('b'.repeat(64))).toEqual([])
		})
	})
}

contract('MemoryServerStore', async () => new MemoryServerStore('s'))
contract('SqliteServerStore', async () => createSqliteServerStore({}))
