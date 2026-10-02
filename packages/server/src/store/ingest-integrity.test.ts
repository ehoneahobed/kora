import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyServerOperation } from '../apply/apply-server-operation'
import { BackupValidationError, validateIngestedOperation } from '../apply/ingest-validation'
import { MemoryServerStore } from './memory-server-store'
import { PostgresServerStore } from './postgres-server-store'
import { buildServerBackup } from './server-backup'
import { SEQUENCE_CONFLICT_CODE, SequenceConflictError, type ServerStore } from './server-store'
import { createSqliteServerStore } from './sqlite-server-store'

/**
 * Store-level ingest integrity (W3 step 4, SRV-4, SYNC-7): one operation per
 * (node, sequence), atomic dedup, batched record reads, and server-time validation
 * on every path into the log.
 */

const PG_URL = process.env.KORA_PG_TEST_URL
const PG_SCHEMA = 'kora_test_ingest_integrity'

const schema = defineSchema({
	version: 1,
	collections: {
		projects: { fields: { name: t.string() } },
		todos: {
			fields: { title: t.string(), projectId: t.string().optional() },
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
	},
})

function op(overrides: Partial<Operation> = {}): Operation {
	const nodeId = overrides.nodeId ?? 'node-a'
	return {
		id: `op-${Math.random().toString(36).slice(2)}`,
		nodeId,
		type: 'insert',
		collection: 'todos',
		recordId: `rec-${Math.random().toString(36).slice(2)}`,
		data: { title: 't' },
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: 0, nodeId },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

function runContract(name: string, create: () => Promise<ServerStore>): void {
	describe(`ingest integrity: ${name}`, () => {
		test('a different operation under an existing (node, sequence) is refused', async () => {
			const store = await create()
			const first = op({ sequenceNumber: 7 })
			expect(await store.applyRemoteOperation(first)).toBe('applied')
			const second = op({ sequenceNumber: 7 })
			await expect(store.applyRemoteOperation(second)).rejects.toBeInstanceOf(SequenceConflictError)
			// The same operation again is a plain duplicate, not a conflict.
			expect(await store.applyRemoteOperation(first)).toBe('duplicate')
			expect(await store.getOperationCount()).toBe(1)
			// Other nodes may use the same number.
			expect(await store.applyRemoteOperation(op({ nodeId: 'node-b', sequenceNumber: 7 }))).toBe(
				'applied',
			)
		})

		test('the apply pipeline turns the conflict into a non-retriable rejection', async () => {
			const store = await create()
			await applyServerOperation(store, op({ sequenceNumber: 3 }))
			const result = await applyServerOperation(store, op({ sequenceNumber: 3 }))
			expect(result.result).toBe('skipped')
			expect(result.rejection).toEqual(
				expect.objectContaining({ code: SEQUENCE_CONFLICT_CODE, retriable: false }),
			)
		})

		test('findRecordsByIds reads several records, soft-deleted ones included', async () => {
			const store = await create()
			const a = op({ recordId: 'a', sequenceNumber: 1 })
			const b = op({ recordId: 'b', sequenceNumber: 2 })
			await store.applyRemoteOperation(a)
			await store.applyRemoteOperation(b)
			await store.applyRemoteOperation(
				op({ type: 'delete', recordId: 'b', data: null, sequenceNumber: 3 }),
			)
			const rows = (await store.findRecordsByIds?.('todos', ['a', 'b', 'missing'])) ?? new Map()
			expect([...rows.keys()].sort()).toEqual(['a', 'b'])
			expect(rows.get('a')?.title).toBe('t')
		})

		test('a backup holding a far-future operation is refused whole', async () => {
			const store = await create()
			const good = op({ sequenceNumber: 1 })
			const future = op({
				sequenceNumber: 2,
				timestamp: { wallTime: Date.now() + 24 * 3_600_000, logical: 0, nodeId: 'node-a' },
			})
			const backup = await buildServerBackup('other', [good, future], new Map([['node-a', 2]]))
			await expect(store.importBackup(backup, true)).rejects.toBeInstanceOf(BackupValidationError)
			await expect(store.importBackup(backup, false)).rejects.toBeInstanceOf(BackupValidationError)
			expect(await store.getOperationCount()).toBe(0)
		})

		test('a merge restore reports sequence conflicts instead of throwing midway', async () => {
			const store = await create()
			await store.applyRemoteOperation(op({ sequenceNumber: 1 }))
			const clash = op({ sequenceNumber: 1 })
			const fresh = op({ sequenceNumber: 2 })
			const backup = await buildServerBackup('other', [clash, fresh], new Map([['node-a', 2]]))
			const result = await store.importBackup(backup, true)
			expect(result).toEqual({ operationsRestored: 1, success: false })
		})
	})
}

runContract('memory', async () => {
	const store = new MemoryServerStore('server')
	await store.setSchema(schema)
	return store
})
runContract('sqlite', async () => {
	const store = createSqliteServerStore({ filename: ':memory:', nodeId: 'server' })
	await store.setSchema(schema)
	return store
})

describe('ingest validation on every path (SYNC-7, SRV-4)', () => {
	test('far-future timestamps and unsafe sequence numbers are refused', () => {
		const now = 1_700_000_000_000
		expect(
			validateIngestedOperation(op({ timestamp: { wallTime: now, logical: 0, nodeId: 'n' } }), now),
		).toEqual({ valid: true })
		expect(
			validateIngestedOperation(
				op({ timestamp: { wallTime: now + 120_000, logical: 0, nodeId: 'n' } }),
				now,
			),
		).toEqual(expect.objectContaining({ valid: false, code: 'INVALID_TIMESTAMP' }))
		for (const sequenceNumber of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
			expect(
				validateIngestedOperation(
					op({ sequenceNumber, timestamp: { wallTime: now, logical: 0, nodeId: 'n' } }),
					now,
				),
			).toEqual(expect.objectContaining({ valid: false, code: 'INVALID_SEQUENCE_NUMBER' }))
		}
	})

	test('applyServerOperation (route kora.apply, applyLocalOperation) refuses a far-future op', async () => {
		const store = new MemoryServerStore('server')
		await store.setSchema(schema)
		const result = await applyServerOperation(
			store,
			op({ timestamp: { wallTime: Date.now() + 3_600_000, logical: 0, nodeId: 'node-a' } }),
		)
		expect(result.rejection).toEqual(
			expect.objectContaining({ code: 'INVALID_TIMESTAMP', retriable: false }),
		)
		expect(await store.getOperationCount()).toBe(0)
	})
})

describe.skipIf(!PG_URL)('ingest integrity: postgres', () => {
	let client: ReturnType<typeof postgres>
	const stores: PostgresServerStore[] = []

	async function create(nodeId = 'server'): Promise<PostgresServerStore> {
		const store = new PostgresServerStore(drizzle(client), nodeId)
		await store.setSchema(schema)
		stores.push(store)
		return store
	}

	beforeAll(async () => {
		client = postgres(PG_URL as string, { max: 8, connection: { search_path: PG_SCHEMA } })
		await client.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}`)
	})
	afterAll(async () => {
		for (const store of stores) await store.close()
		await client.end()
	})
	beforeEach(async () => {
		await client.unsafe(
			'DROP TABLE IF EXISTS todos, projects, operations, sync_state, node_claims, blob_owners, delivery_counter, kora_server_meta CASCADE',
		)
	})

	runContractInline()

	function runContractInline(): void {
		test('a different operation under an existing (node, sequence) is refused', async () => {
			const store = await create()
			expect(await store.applyRemoteOperation(op({ sequenceNumber: 7 }))).toBe('applied')
			await expect(store.applyRemoteOperation(op({ sequenceNumber: 7 }))).rejects.toBeInstanceOf(
				SequenceConflictError,
			)
			expect(await store.getOperationCount()).toBe(1)
		})
	}

	test('sequence numbers are 64-bit and the shared vector is read from the database', async () => {
		const a = await create('server-a')
		const b = await create('server-b')
		const big = 2 ** 40
		expect(await a.applyRemoteOperation(op({ nodeId: 'big', sequenceNumber: big }))).toBe('applied')
		expect((await b.readVersionVector()).get('big')).toBe(big)
		const types = (await client.unsafe(
			`SELECT column_name, data_type FROM information_schema.columns
			 WHERE table_schema = '${PG_SCHEMA}' AND column_name IN ('sequence_number', 'max_sequence_number')`,
		)) as Array<{ column_name: string; data_type: string }>
		expect(types.map((row) => row.data_type)).toEqual(['bigint', 'bigint'])
	})

	test('an INTEGER log from an older release is widened on startup', async () => {
		await create()
		await client.unsafe('DROP TABLE operations, sync_state CASCADE')
		await client.unsafe(`
			CREATE TABLE operations (
				id TEXT PRIMARY KEY, node_id TEXT NOT NULL, type TEXT NOT NULL,
				collection TEXT NOT NULL, record_id TEXT NOT NULL, data TEXT, previous_data TEXT,
				wall_time BIGINT NOT NULL, logical INTEGER NOT NULL, timestamp_node_id TEXT NOT NULL,
				sequence_number INTEGER NOT NULL, causal_deps TEXT NOT NULL DEFAULT '[]',
				schema_version INTEGER NOT NULL, received_at BIGINT NOT NULL)`)
		await client.unsafe(
			'CREATE TABLE sync_state (node_id TEXT PRIMARY KEY, max_sequence_number INTEGER NOT NULL, last_seen_at BIGINT NOT NULL)',
		)
		const store = await create('server-upgraded')
		expect(await store.applyRemoteOperation(op({ nodeId: 'old', sequenceNumber: 2 ** 31 }))).toBe(
			'applied',
		)
	})
})
