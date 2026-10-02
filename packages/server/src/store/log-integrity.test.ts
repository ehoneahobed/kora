import type { Operation } from '@korajs/core'
import Database from 'better-sqlite3'
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3'
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { type ServerOperationRow, checkServerOperationRow } from './log-integrity'
import { PostgresServerStore } from './postgres-server-store'
import { SqliteServerStore } from './sqlite-server-store'

/** W8 step 0, server half: unreadable operation rows are quarantined once at startup. */

const good: ServerOperationRow = {
	id: 'op-1',
	node_id: 'node-a',
	type: 'insert',
	collection: 'todos',
	record_id: 'rec-1',
	data: '{"title":"x"}',
	previous_data: null,
	atomic_ops: null,
	wall_time: 1_700_000_000_000,
	logical: 0,
	timestamp_node_id: 'node-a',
	sequence_number: 1,
	causal_deps: '[]',
	schema_version: 1,
}

const op = (id: string, sequenceNumber: number): Operation => ({
	id,
	nodeId: 'node-a',
	type: 'insert',
	collection: 'todos',
	recordId: id,
	data: { title: id },
	previousData: null,
	timestamp: { wallTime: Date.now(), logical: 0, nodeId: 'node-a' },
	sequenceNumber,
	causalDeps: [],
	schemaVersion: 1,
})

describe('checkServerOperationRow', () => {
	test('a stored operation is readable', () => {
		expect(checkServerOperationRow(good)).toBeNull()
		// Postgres BIGINT columns arrive as strings.
		expect(
			checkServerOperationRow({ ...good, wall_time: '1700000000000', sequence_number: '7' }),
		).toBeNull()
	})

	test.each([
		[{ data: '{oops' }, 'data-malformed'],
		[{ atomic_ops: '[1]' }, 'data-malformed'],
		[{ causal_deps: 'x' }, 'causal-deps-malformed'],
		[{ wall_time: -1 }, 'timestamp-malformed'],
		[{ wall_time: 1.5 }, 'timestamp-malformed'],
		[{ logical: 100_000 }, 'timestamp-malformed'],
		[{ type: 'upsert' }, 'type-invalid'],
		[{ sequence_number: 0 }, 'sequence-invalid'],
		[{ timestamp_node_id: '' }, 'identity-malformed'],
	])('%o -> %s', (overrides, problem) => {
		expect(checkServerOperationRow({ ...good, ...overrides })).toMatchObject({ problem })
	})
})

describe('SqliteServerStore startup scan', () => {
	test('quarantines unreadable rows once, keeps them verbatim, and reads the rest', async () => {
		const sqlite = new Database(':memory:')
		const first = new SqliteServerStore(drizzleSqlite(sqlite), 'server')
		await first.applyRemoteOperation(op('ok', 1))
		await first.applyRemoteOperation(op('bad', 2))
		expect(first.getLogIntegrityReport()).toMatchObject({ ran: true, quarantined: [] })
		// Damage written outside the store (a manual edit, an old tool), then the scan
		// must run again: clear its marker as a pre-scan database would be.
		sqlite.prepare("UPDATE operations SET data = '{broken' WHERE id = 'bad'").run()
		sqlite.prepare("DELETE FROM kora_server_meta WHERE key = 'log_integrity_scan_v1'").run()

		const second = new SqliteServerStore(drizzleSqlite(sqlite), 'server')
		const report = second.getLogIntegrityReport()
		expect(report).toMatchObject({
			ran: true,
			checkedRows: 2,
			totalQuarantined: 1,
			quarantined: [{ operationId: 'bad', problem: 'data-malformed' }],
		})
		expect((await second.getOperationsAfterDelivery(0, 10)).map((d) => d.operation.id)).toEqual([
			'ok',
		])
		const kept = sqlite.prepare('SELECT row_json FROM operations_quarantine').all() as Array<{
			row_json: string
		}>
		expect(JSON.parse(kept[0]?.row_json ?? '{}').data).toBe('{broken')

		const third = new SqliteServerStore(drizzleSqlite(sqlite), 'server')
		expect(third.getLogIntegrityReport()).toMatchObject({ ran: false, totalQuarantined: 1 })
	})
})

const PG_URL = process.env.KORA_PG_TEST_URL
const PG_SCHEMA = 'kora_test_log_integrity'

describe.skipIf(!PG_URL)('PostgresServerStore startup scan', () => {
	let client: ReturnType<typeof postgres>
	const stores: PostgresServerStore[] = []
	beforeAll(async () => {
		client = postgres(PG_URL as string, { max: 4, connection: { search_path: PG_SCHEMA } })
		await client.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}`)
	})
	afterAll(async () => {
		for (const store of stores) await store.close()
		await client.end()
	})
	beforeEach(async () => {
		await client.unsafe(
			'DROP TABLE IF EXISTS operations, operations_quarantine, sync_state, node_claims, blob_owners, delivery_counter, kora_server_meta, operation_resolutions, sequence_pairs CASCADE',
		)
	})

	test('quarantines unreadable rows once and reads the rest', async () => {
		const first = new PostgresServerStore(drizzlePg(client), 'server')
		stores.push(first)
		await first.applyRemoteOperation(op('ok', 1))
		await first.applyRemoteOperation(op('bad', 2))
		await client.unsafe("UPDATE operations SET causal_deps = 'nope' WHERE id = 'bad'")
		await client.unsafe("DELETE FROM kora_server_meta WHERE key = 'log_integrity_scan_v1'")

		const second = new PostgresServerStore(drizzlePg(client), 'server')
		stores.push(second)
		expect(await second.getLogIntegrityReport()).toMatchObject({
			ran: true,
			totalQuarantined: 1,
			quarantined: [{ operationId: 'bad', problem: 'causal-deps-malformed' }],
		})
		expect((await second.getOperationsAfterDelivery(0, 10)).map((d) => d.operation.id)).toEqual([
			'ok',
		])
		const third = new PostgresServerStore(drizzlePg(client), 'server')
		stores.push(third)
		expect(await third.getLogIntegrityReport()).toMatchObject({ ran: false, totalQuarantined: 1 })
	})
})
