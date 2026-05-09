import type { Operation, SchemaDefinition } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
	generateAllCollectionDDL,
	generateCollectionDDL,
	replayOperationsForRecord,
} from './materialization'
import { MemoryServerStore } from './memory-server-store'
import type { MaterializedRecord } from './server-store'
import { SqliteServerStore } from './sqlite-server-store'

// ---------------------------------------------------------------------------
// Test schema
// ---------------------------------------------------------------------------

const testSchema = defineSchema({
	version: 1,
	collections: {
		forms: {
			fields: {
				title: t.string(),
				description: t.string().optional(),
				slug: t.string(),
				status: t.enum(['draft', 'published', 'archived']).default('draft'),
				viewCount: t.number().default(0),
				isPublic: t.boolean().default(false),
			},
			indexes: ['slug', 'status'],
		},
		submissions: {
			fields: {
				formId: t.string(),
				data: t.string(),
				submittedAt: t.timestamp(),
			},
			indexes: ['formId'],
		},
	},
})

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let opCounter = 0

function createTestOp(overrides: Partial<Operation> = {}): Operation {
	opCounter++
	return {
		id: `op-${opCounter}-${Math.random().toString(36).slice(2)}`,
		nodeId: 'node-a',
		type: 'insert',
		collection: 'forms',
		recordId: 'rec-1',
		data: { title: 'Test Form', slug: 'test-form', status: 'draft' },
		previousData: null,
		timestamp: { wallTime: 1000 + opCounter, logical: 0, nodeId: 'node-a' },
		sequenceNumber: opCounter,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

// ---------------------------------------------------------------------------
// Pure function tests: replayOperationsForRecord
// ---------------------------------------------------------------------------

describe('replayOperationsForRecord', () => {
	test('insert creates a record', () => {
		const result = replayOperationsForRecord([
			{ type: 'insert', data: { title: 'Hello', slug: 'hello' } },
		])
		expect(result).toEqual({ title: 'Hello', slug: 'hello' })
	})

	test('update merges fields', () => {
		const result = replayOperationsForRecord([
			{ type: 'insert', data: { title: 'Hello', slug: 'hello' } },
			{ type: 'update', data: { title: 'Updated' } },
		])
		expect(result).toEqual({ title: 'Updated', slug: 'hello' })
	})

	test('delete returns null', () => {
		const result = replayOperationsForRecord([
			{ type: 'insert', data: { title: 'Hello', slug: 'hello' } },
			{ type: 'delete', data: null },
		])
		expect(result).toBeNull()
	})

	test('re-insert after delete returns the new record', () => {
		const result = replayOperationsForRecord([
			{ type: 'insert', data: { title: 'First' } },
			{ type: 'delete', data: null },
			{ type: 'insert', data: { title: 'Second' } },
		])
		expect(result).toEqual({ title: 'Second' })
	})

	test('multiple updates accumulate', () => {
		const result = replayOperationsForRecord([
			{ type: 'insert', data: { a: 1, b: 2, c: 3 } },
			{ type: 'update', data: { a: 10 } },
			{ type: 'update', data: { b: 20 } },
			{ type: 'update', data: { c: 30 } },
		])
		expect(result).toEqual({ a: 10, b: 20, c: 30 })
	})

	test('empty ops returns null', () => {
		const result = replayOperationsForRecord([])
		expect(result).toBeNull()
	})
})

// ---------------------------------------------------------------------------
// DDL generation tests
// ---------------------------------------------------------------------------

describe('generateCollectionDDL', () => {
	test('generates CREATE TABLE with correct columns', () => {
		const ddl = generateCollectionDDL('forms', testSchema.collections.forms, 'sqlite')
		const createTable = ddl[0] as string
		expect(createTable).toContain('CREATE TABLE IF NOT EXISTS forms')
		expect(createTable).toContain('id TEXT PRIMARY KEY NOT NULL')
		expect(createTable).toContain('title TEXT')
		expect(createTable).toContain('slug TEXT')
		expect(createTable).toContain('status TEXT')
		expect(createTable).toContain('viewCount REAL')
		expect(createTable).toContain('isPublic INTEGER')
		expect(createTable).toContain('_created_at INTEGER NOT NULL DEFAULT 0')
		expect(createTable).toContain('_updated_at INTEGER NOT NULL DEFAULT 0')
		expect(createTable).toContain('_deleted INTEGER NOT NULL DEFAULT 0')
	})

	test('generates indexes', () => {
		const ddl = generateCollectionDDL('forms', testSchema.collections.forms, 'sqlite')
		const indexStatements = ddl.filter((s) => s.includes('CREATE INDEX'))
		expect(indexStatements.some((s) => s.includes('idx_forms_slug'))).toBe(true)
		expect(indexStatements.some((s) => s.includes('idx_forms_status'))).toBe(true)
		expect(indexStatements.some((s) => s.includes('idx_forms__deleted'))).toBe(true)
	})

	test('generates safe ALTER TABLE statements', () => {
		const ddl = generateCollectionDDL('forms', testSchema.collections.forms, 'sqlite')
		const alterStatements = ddl.filter((s) => s.startsWith('--kora:safe-alter'))
		expect(alterStatements.length).toBeGreaterThan(0)
		expect(alterStatements.some((s) => s.includes('ADD COLUMN title'))).toBe(true)
	})

	test('postgres dialect uses correct types', () => {
		const ddl = generateCollectionDDL('forms', testSchema.collections.forms, 'postgres')
		const createTable = ddl[0] as string
		expect(createTable).toContain('viewCount DOUBLE PRECISION')
		expect(createTable).toContain('_created_at BIGINT NOT NULL DEFAULT 0')
	})

	test('generates enum CHECK constraints', () => {
		const ddl = generateCollectionDDL('forms', testSchema.collections.forms, 'sqlite')
		const createTable = ddl[0] as string
		expect(createTable).toContain("CHECK (status IN ('draft', 'published', 'archived'))")
	})
})

// ---------------------------------------------------------------------------
// SqliteServerStore materialization tests
// ---------------------------------------------------------------------------

describe('SqliteServerStore materialization', () => {
	let store: SqliteServerStore

	beforeEach(() => {
		opCounter = 0
		const sqlite = new Database(':memory:')
		const db = drizzle(sqlite)
		store = new SqliteServerStore(db, 'server-1')
	})

	afterEach(async () => {
		await store.close()
	})

	test('setSchema creates collection tables', async () => {
		await store.setSchema(testSchema)
		// Should not throw — tables exist
		const result = await store.queryCollection('forms')
		expect(result).toEqual([])
	})

	test('applyRemoteOperation dual-writes to materialized table', async () => {
		await store.setSchema(testSchema)

		const op = createTestOp({
			collection: 'forms',
			recordId: 'form-1',
			data: { title: 'My Form', slug: 'my-form', status: 'published' },
		})
		await store.applyRemoteOperation(op)

		const record = await store.findRecord('forms', 'form-1')
		expect(record).not.toBeNull()
		expect((record as MaterializedRecord).title).toBe('My Form')
		expect((record as MaterializedRecord).slug).toBe('my-form')
		expect((record as MaterializedRecord).status).toBe('published')
	})

	test('materializeCollection reads from table when schema set', async () => {
		await store.setSchema(testSchema)

		await store.applyRemoteOperation(
			createTestOp({
				recordId: 'form-1',
				data: { title: 'Form 1', slug: 'form-1', status: 'published' },
			}),
		)
		await store.applyRemoteOperation(
			createTestOp({
				recordId: 'form-2',
				data: { title: 'Form 2', slug: 'form-2', status: 'draft' },
			}),
		)

		const records = await store.materializeCollection('forms')
		expect(records).toHaveLength(2)
		expect(records.map((r) => r.title).sort()).toEqual(['Form 1', 'Form 2'])
	})

	test('materializeCollection falls back to ops replay without schema', async () => {
		// No setSchema() call
		await store.applyRemoteOperation(
			createTestOp({
				recordId: 'form-1',
				data: { title: 'Form 1', slug: 'form-1' },
			}),
		)

		const records = await store.materializeCollection('forms')
		expect(records).toHaveLength(1)
		expect((records[0] as MaterializedRecord).title).toBe('Form 1')
	})

	test('queryCollection filters with WHERE', async () => {
		await store.setSchema(testSchema)

		await store.applyRemoteOperation(
			createTestOp({
				recordId: 'form-1',
				data: { title: 'Published', slug: 'pub', status: 'published' },
			}),
		)
		await store.applyRemoteOperation(
			createTestOp({
				recordId: 'form-2',
				data: { title: 'Draft', slug: 'dra', status: 'draft' },
			}),
		)
		await store.applyRemoteOperation(
			createTestOp({
				recordId: 'form-3',
				data: { title: 'Also Published', slug: 'pub2', status: 'published' },
			}),
		)

		const published = await store.queryCollection('forms', {
			where: { status: 'published' },
		})
		expect(published).toHaveLength(2)
		expect(published.every((r) => r.status === 'published')).toBe(true)
	})

	test('queryCollection supports multiple WHERE conditions', async () => {
		await store.setSchema(testSchema)

		await store.applyRemoteOperation(
			createTestOp({
				recordId: 'form-1',
				data: { title: 'Target', slug: 'target', status: 'published' },
			}),
		)
		await store.applyRemoteOperation(
			createTestOp({
				recordId: 'form-2',
				data: { title: 'Wrong Status', slug: 'target', status: 'draft' },
			}),
		)

		const results = await store.queryCollection('forms', {
			where: { slug: 'target', status: 'published' },
		})
		expect(results).toHaveLength(1)
		expect((results[0] as MaterializedRecord).title).toBe('Target')
	})

	test('queryCollection supports ORDER BY', async () => {
		await store.setSchema(testSchema)

		await store.applyRemoteOperation(
			createTestOp({
				recordId: 'form-a',
				data: { title: 'B Form', slug: 'b' },
			}),
		)
		await store.applyRemoteOperation(
			createTestOp({
				recordId: 'form-b',
				data: { title: 'A Form', slug: 'a' },
			}),
		)
		await store.applyRemoteOperation(
			createTestOp({
				recordId: 'form-c',
				data: { title: 'C Form', slug: 'c' },
			}),
		)

		const asc = await store.queryCollection('forms', {
			orderBy: 'title',
			orderDirection: 'asc',
		})
		expect(asc.map((r) => r.title)).toEqual(['A Form', 'B Form', 'C Form'])

		const desc = await store.queryCollection('forms', {
			orderBy: 'title',
			orderDirection: 'desc',
		})
		expect(desc.map((r) => r.title)).toEqual(['C Form', 'B Form', 'A Form'])
	})

	test('queryCollection supports LIMIT and OFFSET', async () => {
		await store.setSchema(testSchema)

		for (let i = 1; i <= 5; i++) {
			await store.applyRemoteOperation(
				createTestOp({
					recordId: `form-${i}`,
					data: { title: `Form ${i}`, slug: `form-${i}` },
				}),
			)
		}

		const page1 = await store.queryCollection('forms', {
			orderBy: 'title',
			limit: 2,
		})
		expect(page1).toHaveLength(2)

		const page2 = await store.queryCollection('forms', {
			orderBy: 'title',
			limit: 2,
			offset: 2,
		})
		expect(page2).toHaveLength(2)

		// No overlap
		const page1Ids = page1.map((r) => r.id)
		const page2Ids = page2.map((r) => r.id)
		expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false)
	})

	test('findRecord returns single record', async () => {
		await store.setSchema(testSchema)

		await store.applyRemoteOperation(
			createTestOp({
				recordId: 'form-1',
				data: { title: 'Found', slug: 'found' },
			}),
		)

		const record = await store.findRecord('forms', 'form-1')
		expect(record).not.toBeNull()
		expect((record as MaterializedRecord).title).toBe('Found')
	})

	test('findRecord returns null for non-existent record', async () => {
		await store.setSchema(testSchema)

		const record = await store.findRecord('forms', 'non-existent')
		expect(record).toBeNull()
	})

	test('countCollection counts records', async () => {
		await store.setSchema(testSchema)

		await store.applyRemoteOperation(
			createTestOp({
				recordId: 'form-1',
				data: { title: 'A', slug: 'a', status: 'published' },
			}),
		)
		await store.applyRemoteOperation(
			createTestOp({
				recordId: 'form-2',
				data: { title: 'B', slug: 'b', status: 'draft' },
			}),
		)
		await store.applyRemoteOperation(
			createTestOp({
				recordId: 'form-3',
				data: { title: 'C', slug: 'c', status: 'published' },
			}),
		)

		expect(await store.countCollection('forms')).toBe(3)
		expect(await store.countCollection('forms', { status: 'published' })).toBe(2)
		expect(await store.countCollection('forms', { status: 'draft' })).toBe(1)
	})

	test('updates modify materialized records correctly', async () => {
		await store.setSchema(testSchema)

		await store.applyRemoteOperation(
			createTestOp({
				type: 'insert',
				recordId: 'form-1',
				data: { title: 'Original', slug: 'original', status: 'draft' },
			}),
		)

		await store.applyRemoteOperation(
			createTestOp({
				type: 'update',
				recordId: 'form-1',
				data: { title: 'Updated', status: 'published' },
			}),
		)

		const record = await store.findRecord('forms', 'form-1')
		expect((record as MaterializedRecord).title).toBe('Updated')
		expect((record as MaterializedRecord).slug).toBe('original') // unchanged
		expect((record as MaterializedRecord).status).toBe('published')
	})

	test('deletes soft-delete materialized records', async () => {
		await store.setSchema(testSchema)

		await store.applyRemoteOperation(
			createTestOp({
				type: 'insert',
				recordId: 'form-1',
				data: { title: 'To Delete', slug: 'del' },
			}),
		)

		await store.applyRemoteOperation(
			createTestOp({
				type: 'delete',
				recordId: 'form-1',
				data: null,
			}),
		)

		const record = await store.findRecord('forms', 'form-1')
		expect(record).toBeNull()

		const all = await store.materializeCollection('forms')
		expect(all).toHaveLength(0)

		// But still exists as deleted when includeDeleted is true
		const withDeleted = await store.queryCollection('forms', { includeDeleted: true })
		expect(withDeleted).toHaveLength(1)
	})

	test('backfill works when schema is set after operations exist', async () => {
		// Insert operations BEFORE setting schema
		await store.applyRemoteOperation(
			createTestOp({
				recordId: 'form-1',
				data: { title: 'Pre-Schema Form', slug: 'pre-schema', status: 'published' },
			}),
		)
		await store.applyRemoteOperation(
			createTestOp({
				type: 'update',
				recordId: 'form-1',
				data: { title: 'Updated Pre-Schema' },
			}),
		)

		// Now set schema — should backfill
		await store.setSchema(testSchema)

		const record = await store.findRecord('forms', 'form-1')
		expect(record).not.toBeNull()
		expect((record as MaterializedRecord).title).toBe('Updated Pre-Schema')
		expect((record as MaterializedRecord).slug).toBe('pre-schema')
		expect((record as MaterializedRecord).status).toBe('published')
	})

	test('concurrent operations on same record produce correct state', async () => {
		await store.setSchema(testSchema)

		// Simulate two clients updating the same record concurrently
		await store.applyRemoteOperation(
			createTestOp({
				type: 'insert',
				nodeId: 'node-a',
				recordId: 'shared-1',
				data: { title: 'Original', slug: 'shared', status: 'draft' },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			}),
		)

		// Client A updates title at HLC 1001
		await store.applyRemoteOperation(
			createTestOp({
				type: 'update',
				nodeId: 'node-a',
				recordId: 'shared-1',
				data: { title: 'From A' },
				timestamp: { wallTime: 1001, logical: 0, nodeId: 'node-a' },
			}),
		)

		// Client B updates status at HLC 1002 (later)
		await store.applyRemoteOperation(
			createTestOp({
				type: 'update',
				nodeId: 'node-b',
				recordId: 'shared-1',
				data: { status: 'published' },
				timestamp: { wallTime: 1002, logical: 0, nodeId: 'node-b' },
			}),
		)

		const record = await store.findRecord('forms', 'shared-1')
		expect((record as MaterializedRecord).title).toBe('From A') // From earlier update
		expect((record as MaterializedRecord).status).toBe('published') // From later update
		expect((record as MaterializedRecord).slug).toBe('shared') // From original insert
	})

	test('queryCollection throws without schema', async () => {
		await expect(store.queryCollection('forms')).rejects.toThrow('Schema not set')
	})

	test('queryCollection throws for unknown collection', async () => {
		await store.setSchema(testSchema)
		await expect(store.queryCollection('nonexistent')).rejects.toThrow('Unknown collection')
	})

	test('queryCollection validates field names', async () => {
		await store.setSchema(testSchema)
		await expect(store.queryCollection('forms', { where: { invalid_field: 'x' } })).rejects.toThrow(
			'Invalid field name',
		)
	})

	test('operations for collections not in schema skip materialization', async () => {
		await store.setSchema(testSchema)

		// Insert into a collection that's not in the schema
		await store.applyRemoteOperation(
			createTestOp({
				collection: 'unknown_collection',
				recordId: 'rec-1',
				data: { foo: 'bar' },
			}),
		)

		// Operation is stored but no materialized table
		expect(await store.getOperationCount()).toBe(1)

		// Fallback materialization still works
		const records = await store.materializeCollection('unknown_collection')
		expect(records).toHaveLength(1)
	})
})

// ---------------------------------------------------------------------------
// MemoryServerStore materialization tests
// ---------------------------------------------------------------------------

describe('MemoryServerStore materialization', () => {
	let store: MemoryServerStore

	beforeEach(() => {
		opCounter = 0
		store = new MemoryServerStore('server-1')
	})

	test('setSchema enables queryCollection', async () => {
		await store.setSchema(testSchema)
		const result = await store.queryCollection('forms')
		expect(result).toEqual([])
	})

	test('dual-write materializes records on applyRemoteOperation', async () => {
		await store.setSchema(testSchema)

		await store.applyRemoteOperation(
			createTestOp({
				recordId: 'form-1',
				data: { title: 'Memory Form', slug: 'mem' },
			}),
		)

		const record = await store.findRecord('forms', 'form-1')
		expect(record).not.toBeNull()
		expect((record as MaterializedRecord).title).toBe('Memory Form')
	})

	test('queryCollection filters and orders', async () => {
		await store.setSchema(testSchema)

		await store.applyRemoteOperation(
			createTestOp({
				recordId: 'form-1',
				data: { title: 'B', slug: 'b', status: 'published' },
			}),
		)
		await store.applyRemoteOperation(
			createTestOp({
				recordId: 'form-2',
				data: { title: 'A', slug: 'a', status: 'draft' },
			}),
		)

		const published = await store.queryCollection('forms', {
			where: { status: 'published' },
		})
		expect(published).toHaveLength(1)
		expect((published[0] as MaterializedRecord).title).toBe('B')
	})

	test('backfill works when schema set after operations', async () => {
		await store.applyRemoteOperation(
			createTestOp({
				recordId: 'form-1',
				data: { title: 'Early', slug: 'early' },
			}),
		)

		await store.setSchema(testSchema)

		const record = await store.findRecord('forms', 'form-1')
		expect(record).not.toBeNull()
		expect((record as MaterializedRecord).title).toBe('Early')
	})

	test('countCollection works', async () => {
		await store.setSchema(testSchema)

		await store.applyRemoteOperation(
			createTestOp({
				recordId: 'form-1',
				data: { title: 'A', slug: 'a', status: 'published' },
			}),
		)
		await store.applyRemoteOperation(
			createTestOp({
				recordId: 'form-2',
				data: { title: 'B', slug: 'b', status: 'draft' },
			}),
		)

		expect(await store.countCollection('forms')).toBe(2)
		expect(await store.countCollection('forms', { status: 'published' })).toBe(1)
	})

	test('delete soft-deletes records', async () => {
		await store.setSchema(testSchema)

		await store.applyRemoteOperation(
			createTestOp({
				type: 'insert',
				recordId: 'form-1',
				data: { title: 'Will Delete', slug: 'del' },
			}),
		)
		await store.applyRemoteOperation(
			createTestOp({
				type: 'delete',
				recordId: 'form-1',
				data: null,
			}),
		)

		expect(await store.findRecord('forms', 'form-1')).toBeNull()
		expect(await store.countCollection('forms')).toBe(0)
	})
})
