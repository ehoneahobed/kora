import type { Operation } from '@korajs/core'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { SqliteServerStore } from '../../src/store/sqlite-server-store'

function createTestOp(overrides: Partial<Operation> = {}): Operation {
	return {
		id: `op-${Math.random().toString(36).slice(2)}`,
		nodeId: 'node-a',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-1',
		data: { title: 'test' },
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

describe('SqliteServerStore persistence', () => {
	let dbPath: string
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-test-'))
		dbPath = path.join(tmpDir, 'test.db')
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true })
	})

	function openStore(nodeId?: string): { store: SqliteServerStore; sqlite: InstanceType<typeof Database> } {
		const sqlite = new Database(dbPath)
		sqlite.pragma('journal_mode = WAL')
		const db = drizzle(sqlite)
		const store = new SqliteServerStore(db, nodeId)
		return { store, sqlite }
	}

	test('operations survive store close and reopen', async () => {
		const op1 = createTestOp({ id: 'persist-1', nodeId: 'node-a', sequenceNumber: 1 })
		const op2 = createTestOp({ id: 'persist-2', nodeId: 'node-a', sequenceNumber: 2 })
		const op3 = createTestOp({ id: 'persist-3', nodeId: 'node-b', sequenceNumber: 1 })

		// Phase 1: Write operations and close
		{
			const { store, sqlite } = openStore('server-1')
			await store.applyRemoteOperation(op1)
			await store.applyRemoteOperation(op2)
			await store.applyRemoteOperation(op3)
			await store.close()
			sqlite.close()
		}

		// Phase 2: Reopen and verify everything persisted
		{
			const { store, sqlite } = openStore('server-1')

			// Version vector preserved
			const vv = store.getVersionVector()
			expect(vv.get('node-a')).toBe(2)
			expect(vv.get('node-b')).toBe(1)

			// Operations retrievable
			const rangeA = await store.getOperationRange('node-a', 1, 2)
			expect(rangeA).toHaveLength(2)
			expect(rangeA[0]?.id).toBe('persist-1')
			expect(rangeA[1]?.id).toBe('persist-2')

			const rangeB = await store.getOperationRange('node-b', 1, 1)
			expect(rangeB).toHaveLength(1)
			expect(rangeB[0]?.id).toBe('persist-3')

			// Count matches
			expect(await store.getOperationCount()).toBe(3)

			await store.close()
			sqlite.close()
		}
	})

	test('duplicate detection works across restarts', async () => {
		const op = createTestOp({ id: 'dup-check', sequenceNumber: 1 })

		// Phase 1: Apply operation
		{
			const { store, sqlite } = openStore('server-1')
			expect(await store.applyRemoteOperation(op)).toBe('applied')
			await store.close()
			sqlite.close()
		}

		// Phase 2: Reapply same operation → should be duplicate
		{
			const { store, sqlite } = openStore('server-1')
			expect(await store.applyRemoteOperation(op)).toBe('duplicate')
			expect(await store.getOperationCount()).toBe(1)
			await store.close()
			sqlite.close()
		}
	})

	test('new operations can be added after reopen', async () => {
		const op1 = createTestOp({ id: 'first', nodeId: 'node-a', sequenceNumber: 1 })
		const op2 = createTestOp({ id: 'second', nodeId: 'node-a', sequenceNumber: 2 })

		// Phase 1: Write first operation
		{
			const { store, sqlite } = openStore('server-1')
			await store.applyRemoteOperation(op1)
			await store.close()
			sqlite.close()
		}

		// Phase 2: Reopen and add second operation
		{
			const { store, sqlite } = openStore('server-1')
			expect(await store.applyRemoteOperation(op2)).toBe('applied')
			expect(await store.getOperationCount()).toBe(2)
			expect(store.getVersionVector().get('node-a')).toBe(2)

			const range = await store.getOperationRange('node-a', 1, 2)
			expect(range).toHaveLength(2)
			expect(range[0]?.id).toBe('first')
			expect(range[1]?.id).toBe('second')

			await store.close()
			sqlite.close()
		}
	})

	test('operation data integrity preserved through persistence', async () => {
		const op = createTestOp({
			id: 'integrity-1',
			nodeId: 'node-x',
			type: 'update',
			collection: 'projects',
			recordId: 'rec-99',
			data: { name: 'Kora', tags: ['offline', 'sync'] },
			previousData: { name: 'Old Name', tags: ['draft'] },
			timestamp: { wallTime: 123456789, logical: 42, nodeId: 'node-x' },
			sequenceNumber: 7,
			causalDeps: ['dep-a', 'dep-b'],
			schemaVersion: 2,
		})

		// Write and close
		{
			const { store, sqlite } = openStore('server-1')
			await store.applyRemoteOperation(op)
			await store.close()
			sqlite.close()
		}

		// Reopen and verify full fidelity
		{
			const { store, sqlite } = openStore('server-1')
			const [retrieved] = await store.getOperationRange('node-x', 7, 7)
			expect(retrieved).toBeDefined()
			expect(retrieved).toEqual(op)
			await store.close()
			sqlite.close()
		}
	})
})
