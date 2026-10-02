import { type Operation, defineSchema, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { BlobAccessIndex } from '../richtext/blob-access-index'
import { MemoryServerStore } from '../store/memory-server-store'
import type { MaterializedRecord } from '../store/server-store'
import { authorizeOperationReferences, operationHasReferences } from './reference-authorization'

const schema = defineSchema({
	version: 1,
	collections: {
		projects: { fields: { owner: t.string() } },
		tasks: {
			fields: {
				owner: t.string(),
				projectId: t.string().optional(),
				file: t.blob().optional(),
			},
		},
	},
	relations: {
		taskProject: {
			from: 'tasks',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'restrict',
		},
	},
})

const bobScope = { projects: { owner: 'bob' }, tasks: { owner: 'bob' } }

function op(overrides: Partial<Operation>): Operation {
	return {
		id: 'op',
		nodeId: 'n',
		type: 'insert',
		collection: 'tasks',
		recordId: 'task-1',
		data: { owner: 'bob' },
		previousData: null,
		timestamp: { wallTime: 1, logical: 0, nodeId: 'n' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

const rows: Record<string, MaterializedRecord> = {
	'projects/bob-p': { id: 'bob-p', owner: 'bob' },
	'projects/alice-p': { id: 'alice-p', owner: 'alice' },
}
const readRow = async (collection: string, id: string) => rows[`${collection}/${id}`] ?? null

describe('authorizeOperationReferences: foreign keys (RT-13)', () => {
	const context = { schema, downlinkScopes: bobScope, readRow }

	test('a parent inside the writer scope is allowed', async () => {
		const result = await authorizeOperationReferences(
			op({ data: { owner: 'bob', projectId: 'bob-p' } }),
			null,
			context,
		)
		expect(result.allowed).toBe(true)
	})

	test('a parent outside the scope, or missing, is a SCOPE_VIOLATION', async () => {
		for (const projectId of ['alice-p', 'missing']) {
			const result = await authorizeOperationReferences(
				op({ data: { owner: 'bob', projectId } }),
				null,
				context,
			)
			expect(result).toMatchObject({ allowed: false, code: 'SCOPE_VIOLATION' })
			expect(result.allowed ? '' : result.message).not.toContain('alice')
		}
	})

	test('a null reference, an unchanged reference and a delete are not checked', async () => {
		const stored = { id: 'task-1', owner: 'bob', projectId: 'alice-p' }
		expect(
			(
				await authorizeOperationReferences(
					op({ data: { owner: 'bob', projectId: null } }),
					null,
					context,
				)
			).allowed,
		).toBe(true)
		expect(
			(
				await authorizeOperationReferences(
					op({ type: 'update', data: { projectId: 'alice-p' } }),
					stored,
					context,
				)
			).allowed,
		).toBe(true)
		expect(
			(await authorizeOperationReferences(op({ type: 'delete', data: null }), stored, context))
				.allowed,
		).toBe(true)
	})

	test('an unscoped writer (no tenant boundary) is not checked', async () => {
		const result = await authorizeOperationReferences(
			op({ data: { owner: 'bob', projectId: 'missing' } }),
			null,
			{ schema, downlinkScopes: undefined, readRow },
		)
		expect(result.allowed).toBe(true)
	})

	test('operationHasReferences detects relation and blob fields only', () => {
		expect(operationHasReferences(op({ data: { owner: 'bob' } }), schema)).toBe(false)
		expect(operationHasReferences(op({ data: { projectId: 'x' } }), schema)).toBe(true)
		expect(operationHasReferences(op({ data: { file: null } }), schema)).toBe(true)
		expect(operationHasReferences(op({ type: 'delete', data: null }), schema)).toBe(false)
	})
})

describe('authorizeOperationReferences: blob fields (RT-11)', () => {
	test('a forged hash is refused and a malformed blob value is refused', async () => {
		const store = new MemoryServerStore('s')
		await store.setSchema(schema)
		const blobs = new BlobAccessIndex(store, null)
		const hash = 'a'.repeat(64)
		await blobs.authorizeReference({ hash, scopes: undefined, owner: 'alice' })
		const context = { schema, downlinkScopes: bobScope, readRow, blobs, blobOwner: 'bob' }
		const forged = await authorizeOperationReferences(
			op({ data: { owner: 'bob', file: { hash, size: 1 } } }),
			null,
			context,
		)
		expect(forged).toMatchObject({ allowed: false, code: 'SCOPE_VIOLATION' })
		const malformed = await authorizeOperationReferences(
			op({ data: { owner: 'bob', file: { not: 'a ref' } } }),
			null,
			context,
		)
		expect(malformed.allowed).toBe(false)
		const fresh = await authorizeOperationReferences(
			op({ data: { owner: 'bob', file: { hash: 'b'.repeat(64), size: 1 } } }),
			null,
			context,
		)
		expect(fresh.allowed).toBe(true)
	})
})
