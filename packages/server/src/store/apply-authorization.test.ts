import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { describe, expect, test } from 'vitest'
import { applyServerOperation } from '../apply/apply-server-operation'
import { UplinkAuthorizationError, authorizeUplinkWrite } from '../scopes/server-scope-filter'
import { MemoryServerStore } from './memory-server-store'
import type { MaterializedRecord, ServerStore } from './server-store'
import { SqliteServerStore } from './sqlite-server-store'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), userId: t.string() } } },
})

let counter = 0
function op(overrides: Partial<Operation> = {}): Operation {
	counter += 1
	return {
		id: `op-${counter}`,
		nodeId: 'node-1',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-1',
		data: { title: 'bob secret', userId: 'bob' },
		previousData: null,
		timestamp: { wallTime: 1000 + counter, logical: 0, nodeId: 'node-1' },
		sequenceNumber: counter,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

const stores: Array<[string, (withSchema: boolean) => Promise<ServerStore>]> = [
	[
		'MemoryServerStore',
		async (withSchema) => {
			const store = new MemoryServerStore('server-1')
			if (withSchema) await store.setSchema(schema)
			return store
		},
	],
	[
		'SqliteServerStore',
		async (withSchema) => {
			const store = new SqliteServerStore(drizzle(new Database(':memory:')), 'server-1')
			if (withSchema) await store.setSchema(schema)
			return store
		},
	],
]

describe.each(stores)('%s in-store uplink authorization', (_name, create) => {
	for (const withSchema of [true, false]) {
		const label = withSchema ? 'materialized' : 'schemaless (op-log replay)'

		test(`${label}: a refused write throws and writes nothing`, async () => {
			const store = await create(withSchema)
			await store.applyRemoteOperation(op())
			const before = await store.getOperationCount()
			const takeover = op({ type: 'update', data: { userId: 'alice' } })
			await expect(
				store.applyRemoteOperation(takeover, {
					authorize: (stored) =>
						authorizeUplinkWrite(takeover, stored, { todos: { userId: 'alice' } }),
				}),
			).rejects.toBeInstanceOf(UplinkAuthorizationError)
			expect(await store.getOperationCount()).toBe(before)
			expect(store.getVersionVector().get('node-1')).toBe(counter - 1)
		})

		test(`${label}: the guard sees the stored row, including a soft-deleted one`, async () => {
			const store = await create(withSchema)
			await store.applyRemoteOperation(op())
			await store.applyRemoteOperation(op({ type: 'delete', data: null }))
			let seen: MaterializedRecord | null = null
			const revive = op({ data: { title: 'mine', userId: 'alice' } })
			await expect(
				store.applyRemoteOperation(revive, {
					authorize: (stored) => {
						seen = stored
						return authorizeUplinkWrite(revive, stored, { todos: { userId: 'alice' } })
					},
				}),
			).rejects.toBeInstanceOf(UplinkAuthorizationError)
			expect(seen).toMatchObject({ id: 'rec-1', userId: 'bob' })
		})

		test(`${label}: the guard receives null for a record that was never written`, async () => {
			const store = await create(withSchema)
			let seen: MaterializedRecord | null | undefined
			const fresh = op({ recordId: 'new-rec', data: { title: 'n', userId: 'alice' } })
			const result = await store.applyRemoteOperation(fresh, {
				authorize: (stored) => {
					seen = stored
					return authorizeUplinkWrite(fresh, stored, { todos: { userId: 'alice' } })
				},
			})
			expect(result).toBe('applied')
			expect(seen).toBeNull()
		})
	}

	test('claimNode binds a node id to the first principal', async () => {
		const store = await create(false)
		expect(await store.claimNode?.('device-1', 'alice')).toBe(true)
		expect(await store.claimNode?.('device-1', 'alice')).toBe(true)
		expect(await store.claimNode?.('device-1', 'mallory')).toBe(false)
		expect(await store.claimNode?.('device-2', 'mallory')).toBe(true)
	})

	test('an unclaimed node with operation history cannot be claimed (RT-5)', async () => {
		const store = await create(false)
		await store.applyRemoteOperation(op({ nodeId: 'node-1' }))
		expect(await store.claimNode?.('node-1', 'mallory')).toBe(false)
		expect(await store.claimNode?.('node-1', 'alice')).toBe(false)
	})

	test('an admin release lets the next claimant take the node over, once (RT-5)', async () => {
		const store = await create(false)
		await store.applyRemoteOperation(op({ nodeId: 'node-1' }))
		expect(await store.releaseNodeClaim?.('node-1')).toBe(true)
		expect(await store.claimNode?.('node-1', 'alice')).toBe(true)
		expect(await store.claimNode?.('node-1', 'mallory')).toBe(false)
		expect(await store.claimNode?.('node-1', 'alice')).toBe(true)
		// A claimed node can be released and reassigned too.
		expect(await store.releaseNodeClaim?.('node-1')).toBe(true)
		expect(await store.claimNode?.('node-1', 'bob')).toBe(true)
		expect(await store.claimNode?.('node-1', 'alice')).toBe(false)
	})

	test('releasing an unknown node reports false and never yields an empty owner', async () => {
		const store = await create(false)
		expect(await store.releaseNodeClaim?.('nobody')).toBe(false)
		expect(await store.claimNode?.('fresh', '')).toBe(false)
	})
})

describe('applyServerOperation with authorize', () => {
	test('maps an in-store refusal to a non-retriable rejection', async () => {
		const store = new MemoryServerStore('server-1')
		await store.setSchema(schema)
		await store.applyRemoteOperation(op())
		const overwrite = op({ data: { title: 'mine now', userId: 'alice' } })
		const result = await applyServerOperation(store, overwrite, undefined, {
			authorize: (stored) =>
				authorizeUplinkWrite(overwrite, stored, { todos: { userId: 'alice' } }),
		})
		expect(result.result).toBe('skipped')
		expect(result.rejection).toMatchObject({ code: 'SCOPE_VIOLATION', retriable: false })
		expect((await store.findRecord('todos', 'rec-1'))?.userId).toBe('bob')
	})

	test('maps a refused delete the same way', async () => {
		const store = new MemoryServerStore('server-1')
		await store.setSchema(schema)
		await store.applyRemoteOperation(op())
		const del = op({ type: 'delete', data: null })
		const result = await applyServerOperation(store, del, undefined, {
			authorize: (stored) => authorizeUplinkWrite(del, stored, { todos: { userId: 'alice' } }),
		})
		expect(result.rejection?.code).toBe('SCOPE_VIOLATION')
		expect(await store.findRecord('todos', 'rec-1')).not.toBeNull()
	})
})
