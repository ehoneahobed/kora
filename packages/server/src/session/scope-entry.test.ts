import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { describe, expect, test } from 'vitest'
import {
	snapshotEntersScopes,
	snapshotExitsScopes,
	snapshotLacksScopeFields,
	snapshotValuesWithFallback,
} from '../scopes/server-scope-filter'
import { MemoryServerStore } from '../store/memory-server-store'
import { PostgresServerStore } from '../store/postgres-server-store'
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

	test('carries per-field versions and the creation stamp when the store folds them (RT-27)', async () => {
		const created = { wallTime: 1000, logical: 0, nodeId: 'node-a' }
		const titleAt = { wallTime: 5000, logical: 2, nodeId: 'node-c' }
		const entry = await buildScopeEntryOperation({
			trigger: op({}),
			row: { id: 'rec-1', title: 'plan', owner: 'bob', tags: ['a'], _created_at: 1000 },
			schema,
			timestamp: { wallTime: 9000, logical: 0, nodeId: 'node-b' },
			fieldVersions: {
				fields: { title: titleAt, owner: { wallTime: 9000, logical: 0, nodeId: 'node-b' } },
				created,
				latest: { wallTime: 9000, logical: 0, nodeId: 'node-b' },
			},
			schemaVersion: 3,
		})
		// The entry is stamped at the record's creation; each field at its own writer.
		expect(entry.timestamp).toEqual(created)
		expect(entry.fieldVersions).toEqual({
			title: titleAt,
			owner: { wallTime: 9000, logical: 0, nodeId: 'node-b' },
			// No operation wrote it (a later schema default): as old as the record.
			tags: created,
		})
		// Same id with or without versions: the id names (record, trigger) only.
		const plain = await buildScopeEntryOperation({
			trigger: op({}),
			row: { id: 'rec-1', title: 'plan', owner: 'bob', tags: ['a'] },
			schema,
			timestamp: { wallTime: 9000, logical: 0, nodeId: 'node-b' },
			schemaVersion: 3,
		})
		expect(plain.id).toBe(entry.id)
		expect(plain.fieldVersions).toBeUndefined()
		expect(plain.timestamp).toEqual({ wallTime: 9000, logical: 0, nodeId: 'node-b' })
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

describe('getRecordFieldVersions (RT-27)', () => {
	const at = (wallTime: number, nodeId = 'node-a') => ({ wallTime, logical: 0, nodeId })
	const ops = [
		op({ id: 'i', type: 'insert', data: { title: 'x', owner: 'alice' }, timestamp: at(1000) }),
		op({ id: 'u1', data: { owner: 'bob' }, timestamp: at(2000), sequenceNumber: 2 }),
		// Same wall time and logical: the node id breaks the tie, byte order.
		op({ id: 'u2', data: { title: 'Z' }, timestamp: at(3000, 'node-Z'), sequenceNumber: 3 }),
		op({ id: 'u3', data: { title: 'a' }, timestamp: at(3000, 'node-a'), sequenceNumber: 4 }),
		op({ id: 'o', recordId: 'other', data: { title: 'q' }, timestamp: at(9999) }),
	]
	const expected = {
		fields: { title: at(3000, 'node-a'), owner: at(2000) },
		created: at(1000),
		latest: at(3000, 'node-a'),
	}
	const PG_URL = process.env.KORA_PG_TEST_URL
	const stores: [
		string,
		() => Promise<{
			store: MemoryServerStore | SqliteServerStore | PostgresServerStore
			done: () => Promise<void>
		}>,
	][] = [
		['memory', async () => ({ store: new MemoryServerStore('s'), done: async () => {} })],
		[
			'sqlite',
			async () => ({
				store: new SqliteServerStore(drizzle(new Database(':memory:')), 's'),
				done: async () => {},
			}),
		],
	]
	if (PG_URL) {
		stores.push([
			'postgres',
			async () => {
				const client = postgres(PG_URL, {
					max: 2,
					connection: { search_path: 'kora_test_field_versions' },
				})
				await client.unsafe('CREATE SCHEMA IF NOT EXISTS kora_test_field_versions')
				await client.unsafe(
					'DROP TABLE IF EXISTS todos, operations, sync_state, node_claims, blob_owners, delivery_counter, kora_server_meta CASCADE',
				)
				return { store: new PostgresServerStore(drizzlePg(client), 's'), done: () => client.end() }
			},
		])
	}
	test.each(stores)(
		'%s store folds per-field versions like the materialization',
		async (_n, make) => {
			const { store, done } = await make()
			await store.setSchema(schema)
			for (const o of ops) await store.applyRemoteOperation(o)
			expect(await store.getRecordFieldVersions('todos', 'rec-1')).toEqual(expected)
			expect((await store.findRecord('todos', 'rec-1'))?.title).toBe('a')
			expect(await store.getRecordFieldVersions('todos', 'missing')).toBeNull()
			await store.applyRemoteOperation(
				op({ id: 'del', type: 'delete', data: null, timestamp: at(4000), sequenceNumber: 5 }),
			)
			expect(await store.getRecordFieldVersions('todos', 'rec-1')).toBeNull()
			await store.close()
			await done()
		},
	)
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
