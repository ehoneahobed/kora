import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { describe, expect, test } from 'vitest'
import {
	snapshotEntersScopes,
	snapshotExitsScopes,
	snapshotLacksScopeFields,
	snapshotValuesWithFallback,
} from '../scopes/server-scope-filter'
import { MemoryServerStore } from '../store/memory-server-store'
import { SqliteServerStore } from '../store/sqlite-server-store'
import { SCOPE_ENTRY_NODE_ID, buildScopeEntryOperation, isScopeEntryOperation } from './scope-entry'

const schema = defineSchema({
	version: 3,
	collections: {
		todos: { fields: { title: t.string(), owner: t.string(), tags: t.array(t.string()) } },
	},
})

function op(overrides: Partial<Operation>): Operation {
	return {
		id: 'op-1',
		nodeId: 'node-a',
		type: 'update',
		collection: 'todos',
		recordId: 'rec-1',
		data: { owner: 'bob' },
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

describe('buildScopeEntryOperation', () => {
	test('builds a deterministic system insert from the current row', async () => {
		const input = {
			trigger: op({}),
			row: {
				id: 'rec-1',
				title: 'plan',
				owner: 'bob',
				tags: ['a'],
				_created_at: 1,
				_updated_at: 2,
				_deleted: 0,
			},
			schema,
			timestamp: { wallTime: 2000, logical: 3, nodeId: 'node-b' },
			schemaVersion: 3,
		}
		const a = await buildScopeEntryOperation(input)
		const b = await buildScopeEntryOperation(input)
		expect(a.id).toBe(b.id)
		expect(a).toMatchObject({
			nodeId: SCOPE_ENTRY_NODE_ID,
			type: 'insert',
			recordId: 'rec-1',
			sequenceNumber: 0,
			causalDeps: [],
			previousData: null,
			schemaVersion: 3,
			timestamp: { wallTime: 2000, logical: 3, nodeId: 'node-b' },
			data: { title: 'plan', owner: 'bob', tags: ['a'] },
		})
		expect(isScopeEntryOperation(a)).toBe(true)
		// A different trigger gets a different entry id.
		const c = await buildScopeEntryOperation({ ...input, trigger: op({ id: 'op-2' }) })
		expect(c.id).not.toBe(a.id)
	})

	test('encodes binary column values in the tagged wire form', async () => {
		const entry = await buildScopeEntryOperation({
			trigger: op({}),
			row: { id: 'rec-1', title: new Uint8Array([1, 2, 3]) },
			schema,
			timestamp: { wallTime: 1, logical: 0, nodeId: 'n' },
			schemaVersion: 1,
		})
		expect(entry.data?.title).toEqual({ $koraBytes: 'AQID' })
	})
})

describe('scope snapshot transitions', () => {
	const scopes = { todos: { owner: 'bob' } }
	test('entry: pre out of scope, post in scope; inserts never enter', () => {
		const snapshot = { pre: { id: 'rec-1', owner: 'alice' }, post: { id: 'rec-1', owner: 'bob' } }
		expect(snapshotEntersScopes(op({}), snapshot, scopes)).toBe(true)
		expect(snapshotEntersScopes(op({ type: 'insert' }), snapshot, scopes)).toBe(false)
		expect(snapshotEntersScopes(op({}), { pre: null, post: snapshot.post }, scopes)).toBe(false)
		expect(snapshotEntersScopes(op({}), { pre: snapshot.post, post: snapshot.post }, scopes)).toBe(
			false,
		)
		expect(snapshotExitsScopes(op({}), { pre: snapshot.post, post: snapshot.pre }, scopes)).toBe(
			true,
		)
	})

	test('a scope field absent from a snapshot falls back to the current row (RT-20)', () => {
		const snapshot = { pre: { id: 'rec-1' }, post: { id: 'rec-1' } }
		expect(snapshotLacksScopeFields('todos', snapshot, scopes)).toBe(true)
		expect(snapshotValuesWithFallback('todos', snapshot.post, scopes, { owner: 'bob' })).toEqual({
			id: 'rec-1',
			owner: 'bob',
		})
		// Present-and-mismatched (including null) is kept: fails closed.
		expect(
			snapshotValuesWithFallback('todos', { id: 'rec-1', owner: null }, scopes, { owner: 'bob' }),
		).toEqual({ id: 'rec-1', owner: null })
		expect(snapshotValuesWithFallback('todos', null, scopes, { owner: 'bob' })).toBeNull()
	})
})

describe('getRecordLatestTimestamp', () => {
	const ops = [
		op({ id: 'a', type: 'insert', data: { title: 'x', owner: 'bob' } }),
		op({ id: 'b', timestamp: { wallTime: 3000, logical: 1, nodeId: 'node-a' }, sequenceNumber: 2 }),
		op({ id: 'c', timestamp: { wallTime: 3000, logical: 1, nodeId: 'node-z' }, nodeId: 'node-z' }),
		op({ id: 'd', recordId: 'other', timestamp: { wallTime: 9999, logical: 0, nodeId: 'n' } }),
	]
	test.each([
		['memory', () => new MemoryServerStore('s')],
		['sqlite', () => new SqliteServerStore(drizzle(new Database(':memory:')), 's')],
	])('%s store returns the newest HLC of the record', async (_name, make) => {
		const store = make()
		await store.setSchema(schema)
		for (const o of ops) await store.applyRemoteOperation(o)
		expect(await store.getRecordLatestTimestamp('todos', 'rec-1')).toEqual({
			wallTime: 3000,
			logical: 1,
			nodeId: 'node-z',
		})
		expect(await store.getRecordLatestTimestamp('todos', 'missing')).toBeNull()
		await store.close()
	})
})

describe('scope snapshot fingerprint (RT-20)', () => {
	test('sqlite recomputes snapshots when the captured fields change, once', async () => {
		const sqlite = new Database(':memory:')
		const v1 = defineSchema({
			version: 1,
			collections: { todos: { fields: { title: t.string() } } },
		})
		const v2 = defineSchema({
			version: 2,
			collections: { todos: { fields: { title: t.string(), orgId: t.string().optional() } } },
		})
		const store = new SqliteServerStore(drizzle(sqlite), 's')
		await store.setSchema(v1)
		await store.applyRemoteOperation(
			op({ id: 'ins', type: 'insert', data: { title: 'x', orgId: 'acme' } }),
		)
		expect(
			(await store.getOperationScopeSnapshots(['ins'])).get('ins')?.post?.orgId,
		).toBeUndefined()
		await store.setSchema(v2)
		expect((await store.getOperationScopeSnapshots(['ins'])).get('ins')?.post?.orgId).toBe('acme')
		await store.close()

		// A restart with the same schema keeps the stored snapshots (no recompute).
		const reopened = new SqliteServerStore(drizzle(sqlite), 's')
		sqlite.exec(
			`UPDATE operations SET scope_snapshot = '{"pre":null,"post":{"id":"rec-1","orgId":"kept"}}'`,
		)
		await reopened.setSchema(v2)
		expect((await reopened.getOperationScopeSnapshots(['ins'])).get('ins')?.post?.orgId).toBe(
			'kept',
		)
		await reopened.close()
	})
})
