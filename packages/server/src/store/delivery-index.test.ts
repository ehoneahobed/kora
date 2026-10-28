/**
 * The delivery visibility index tables (C2.2), on every server store: the table and the
 * two composite indexes are created, repaired when missing or invalid, rebuilt when the
 * partition plan changes, and backfilled in resumable chunks behind a contiguous frontier.
 * Postgres runs with KORA_PG_TEST_URL.
 */
import { defineSchema, t } from '@korajs/core'
import { afterAll, describe, expect, test } from 'vitest'
import {
	type DeliveryStoreHandle,
	deliveryOp,
	deliveryStoreKinds,
	removeDeliveryTempFiles,
} from '../../tests/fixtures/delivery-stores'
import { dropTrackedPgSchemas } from '../../tests/fixtures/pg-test-schemas'
import { partitionKey } from './delivery-partitions'
import type { PostgresServerStore } from './postgres-server-store'
import type { ServerStore } from './server-store'
import type { SqliteServerStore } from './sqlite-server-store'

afterAll(dropTrackedPgSchemas)
afterAll(removeDeliveryTempFiles)

const schema = defineSchema({
	version: 1,
	collections: {
		notes: { fields: { body: t.string(), schoolId: t.string() }, scope: ['schoolId'] },
		logs: { fields: { line: t.string() } },
	},
})

/** A store whose background index backfill the test drives by hand. */
function paused(
	store: ServerStore,
): ServerStore & { pauseDeliveryBackfillForTests(p: boolean): void } {
	const driven = store as ServerStore & { pauseDeliveryBackfillForTests?: (p: boolean) => void }
	if (!driven.pauseDeliveryBackfillForTests)
		return Object.assign(store, { pauseDeliveryBackfillForTests: () => {} })
	return driven as ServerStore & { pauseDeliveryBackfillForTests(p: boolean): void }
}

/** Twelve notes in two schools and three log lines, in a fixed order. */
async function fill(store: ServerStore): Promise<Array<{ seq: number; school: string | null }>> {
	const expected: Array<{ seq: number; school: string | null }> = []
	let counter = 0
	for (let i = 0; i < 12; i++) {
		const school = i % 2 === 0 ? 's1' : 's2'
		await store.applyRemoteOperation(
			deliveryOp({ collection: 'notes', recordId: `n${i}`, data: { body: 'b', schoolId: school } }),
		)
		counter += 1
		expected.push({ seq: counter, school })
		if (i % 4 === 3) {
			await store.applyRemoteOperation(
				deliveryOp({ collection: 'logs', recordId: `l${i}`, data: { line: 'x' } }),
			)
			counter += 1
			expected.push({ seq: counter, school: null })
		}
	}
	return expected
}

async function rowsOf(handle: DeliveryStoreHandle): Promise<Array<[string, number]>> {
	if (!handle.sql) return []
	const rows = await handle.sql(
		'SELECT CAST(partition_key AS TEXT) AS k, delivery_seq AS s FROM kora_delivery_partitions ORDER BY delivery_seq, partition_key',
	)
	return rows.map((row) => [String(row.k), Number(row.s)])
}

function expectedRows(
	expected: Array<{ seq: number; school: string | null }>,
	upTo = Number.POSITIVE_INFINITY,
): Array<[string, number]> {
	return expected
		.filter((e) => e.school !== null && e.seq <= upTo)
		.map((e) => [partitionKey('notes', 'schoolId', e.school).toString(), e.seq] as [string, number])
}

for (const kind of deliveryStoreKinds()) {
	describe(`delivery index tables: ${kind.name}`, () => {
		test('are created with the schema and the plan fingerprint is recorded', async () => {
			const handle = await kind.make()
			try {
				await handle.store.setSchema(schema)
				await handle.store.whenDeliveryIndexIdle?.()
				const state = await handle.store.getDeliveryPartitionState?.()
				expect(state?.fingerprint).toBe(state?.planFingerprint)
				expect(state?.through).toBe(0)
				expect(state?.usable).toBe(true)
				if (handle.sql && handle.kind === 'sqlite') {
					const tables = await handle.sql(
						"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'kora_delivery_partitions'",
					)
					expect(String(tables[0]?.sql)).toContain('WITHOUT ROWID')
					const indexes = await handle.sql(
						"SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_collection_delivery', 'idx_node_delivery') ORDER BY name",
					)
					expect(indexes.map((r) => r.name)).toEqual([
						'idx_collection_delivery',
						'idx_node_delivery',
					])
				}
				if (handle.sql && handle.kind === 'postgres') {
					const indexes = await handle.sql(
						`SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
						 JOIN pg_namespace n ON n.oid = c.relnamespace
						 WHERE n.nspname = current_schema() AND c.relname IN ('idx_collection_delivery', 'idx_node_delivery') ORDER BY c.relname`,
					)
					expect(indexes).toEqual([
						{ name: 'idx_collection_delivery', valid: true },
						{ name: 'idx_node_delivery', valid: true },
					])
				}
			} finally {
				await handle.done()
			}
		})

		test('backfill indexes in chunks behind a contiguous frontier, and resumes', async () => {
			const handle = await kind.make()
			try {
				const store = paused(handle.store)
				store.pauseDeliveryBackfillForTests(true)
				await store.setSchema(schema)
				const expected = await fill(store)
				// A plan change resets the index: nothing is covered until it is rebuilt.
				await store.setDeliveryPartitions?.({ logs: ['tenant'] })
				await store.setDeliveryPartitions?.({})
				if (kind.name === 'memory') {
					// The memory store has nothing to wait for: it indexes its log at once.
					expect((await store.getDeliveryPartitionState?.())?.through).toBe(expected.length)
					return
				}
				const reset = await store.getDeliveryPartitionState?.()
				expect(reset?.through).toBe(0)
				expect(await rowsOf(handle)).toEqual([])

				// 15 operations, chunks of 5: the frontier follows each chunk's last operation.
				expect(await store.backfillDeliveryPartitions?.(1, 5)).toBe(5)
				expect((await store.getDeliveryPartitionState?.())?.through).toBe(5)
				expect(await rowsOf(handle)).toEqual(expectedRows(expected, 5))

				// A restart in the middle continues from the stored frontier.
				const restarted = handle.open ? handle.open() : store
				if (restarted !== store) {
					const second = paused(restarted)
					second.pauseDeliveryBackfillForTests(true)
					await second.setSchema(schema)
					expect((await second.getDeliveryPartitionState?.())?.through).toBe(5)
					expect(await second.backfillDeliveryPartitions?.(1, 5)).toBe(5)
					expect((await second.getDeliveryPartitionState?.())?.through).toBe(10)
				} else {
					expect(await store.backfillDeliveryPartitions?.(1, 5)).toBe(5)
				}
				const last = restarted === store ? store : restarted
				// The chunk that reaches the end moves the frontier to the delivery counter.
				await last.backfillDeliveryPartitions?.(undefined, 5)
				const done = await last.getDeliveryPartitionState?.()
				expect(done?.through).toBe(expected[expected.length - 1]?.seq)
				expect(await rowsOf(handle)).toEqual(expectedRows(expected))
				// Idempotent: nothing left, nothing changes.
				expect(await last.backfillDeliveryPartitions?.()).toBe(0)
				expect(await rowsOf(handle)).toEqual(expectedRows(expected))
			} finally {
				await handle.done()
			}
		})

		test('a different partition plan rebuilds the index from scratch', async () => {
			const handle = await kind.make()
			try {
				const store = paused(handle.store)
				store.pauseDeliveryBackfillForTests(true)
				await store.setSchema(schema)
				const expected = await fill(store)
				await store.backfillDeliveryPartitions?.()
				expect((await store.getDeliveryPartitionState?.())?.through).toBe(expected.length)

				await store.setDeliveryPartitions?.({ notes: ['body'] })
				const reset = await store.getDeliveryPartitionState?.()
				expect(reset?.through).toBe(kind.name === 'memory' ? expected.length : 0)
				expect(reset?.fingerprint).toBe(reset?.planFingerprint)
				if (kind.name !== 'memory') expect(await rowsOf(handle)).toEqual([])

				await store.backfillDeliveryPartitions?.()
				expect((await store.getDeliveryPartitionState?.())?.through).toBe(expected.length)
				// notes now have two partition fields: both are filed.
				const rows = await rowsOf(handle)
				if (handle.sql) {
					const body = partitionKey('notes', 'body', 'b').toString()
					expect(rows.filter(([k]) => k === body)).toHaveLength(12)
					expect(rows).toHaveLength(24)
				}
			} finally {
				await handle.done()
			}
		})
	})
}

describe('delivery index repair: sqlite', () => {
	const kind = deliveryStoreKinds().find((k) => k.name === 'sqlite')
	test('a dropped table and dropped indexes are recreated and the index rebuilt', async () => {
		if (!kind) return
		const handle = await kind.make()
		try {
			await handle.store.setSchema(schema)
			const expected = await fill(handle.store)
			await handle.store.backfillDeliveryPartitions?.()
			await handle.store.close()
			// Damage done while no instance runs: table and both indexes gone, meta left behind.
			const damaged = handle.open?.() as SqliteServerStore
			await handle.sql?.('DROP TABLE kora_delivery_partitions')
			await handle.sql?.('DROP INDEX idx_collection_delivery')
			await handle.sql?.('DROP INDEX idx_node_delivery')
			await damaged.close()
			const repaired = handle.open?.() as SqliteServerStore
			repaired.pauseDeliveryBackfillForTests(true)
			await repaired.setSchema(schema)
			// The empty table is not trusted just because the meta rows survived.
			expect((await repaired.getDeliveryPartitionState()).through).toBe(0)
			expect((await repaired.getDeliveryPartitionState()).usable).toBe(true)
			await repaired.backfillDeliveryPartitions()
			expect(await rowsOf(handle)).toEqual(expectedRows(expected))
			expect((await repaired.getDeliveryPartitionState()).through).toBe(expected.length)
		} finally {
			await handle.done()
		}
	})
})

describe('delivery index repair: postgres', () => {
	const kind = deliveryStoreKinds().find((k) => k.name === 'postgres')
	test.skipIf(!kind)('an INVALID index is treated as absent and built again', async () => {
		const handle = await (kind as NonNullable<typeof kind>).make()
		try {
			await handle.store.setSchema(schema)
			await handle.store.whenDeliveryIndexIdle?.()
			// What a crash during CREATE INDEX CONCURRENTLY leaves behind.
			await handle.sql?.(
				"UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'idx_collection_delivery'::regclass",
			)
			const restarted = handle.open?.() as PostgresServerStore
			await restarted.setSchema(schema)
			await restarted.whenDeliveryIndexIdle()
			const rows = await handle.sql?.(
				"SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = 'idx_collection_delivery'::regclass",
			)
			expect(rows).toEqual([{ valid: true }])
			expect((await restarted.getDeliveryPartitionState()).usable).toBe(true)
		} finally {
			await handle.done()
		}
	})

	test.skipIf(!kind)('a missing index and a dropped table are created again', async () => {
		const handle = await (kind as NonNullable<typeof kind>).make()
		try {
			await handle.store.setSchema(schema)
			const expected = await fill(handle.store)
			await handle.store.whenDeliveryIndexIdle?.()
			await handle.store.backfillDeliveryPartitions?.()
			await handle.sql?.('DROP INDEX idx_node_delivery')
			await handle.sql?.('DROP TABLE kora_delivery_partitions')
			const restarted = handle.open?.() as PostgresServerStore
			restarted.pauseDeliveryBackfillForTests(true)
			await restarted.setSchema(schema)
			await restarted.whenDeliveryIndexIdle()
			const indexes = await handle.sql?.(
				`SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
				 JOIN pg_namespace n ON n.oid = c.relnamespace
				 WHERE n.nspname = current_schema() AND c.relname = 'idx_node_delivery'`,
			)
			expect(indexes).toEqual([{ name: 'idx_node_delivery' }])
			// The recreated table is empty: the frontier is not trusted.
			expect((await restarted.getDeliveryPartitionState()).through).toBe(0)
			await restarted.backfillDeliveryPartitions()
			expect(await rowsOf(handle)).toEqual(expectedRows(expected))
		} finally {
			await handle.done()
		}
	})
})
