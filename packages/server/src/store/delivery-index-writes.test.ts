/**
 * Writing the delivery visibility index (C2.3), on every server store: rows are written in
 * the transaction that writes the operation and its scope snapshot, on every apply path,
 * keyed by the pre and post snapshots; the contiguous frontier follows live writes; a
 * restore and the log-integrity quarantine drop the rows of the operations they remove.
 * Postgres runs with KORA_PG_TEST_URL.
 */
import { defineSchema, member, memberOfKey, t } from '@korajs/core'
import { afterAll, describe, expect, test } from 'vitest'
import {
	type DeliveryStoreHandle,
	deliveryOp,
	deliveryStoreKinds,
	removeDeliveryTempFiles,
} from '../../tests/fixtures/delivery-stores'
import { dropTrackedPgSchemas } from '../../tests/fixtures/pg-test-schemas'
import { partitionKey, unknownPartitionKey } from './delivery-partitions'
import type { ServerStore } from './server-store'

afterAll(dropTrackedPgSchemas)
afterAll(removeDeliveryTempFiles)

const schema = defineSchema({
	version: 1,
	collections: {
		notes: { fields: { body: t.string(), schoolId: t.string() }, scope: ['schoolId'] },
		logs: { fields: { line: t.string() } },
	},
})

const accessSchema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'edit'],
		groups: { boards: { owner: 'ownerId', role: 'edit' } },
	},
	collections: {
		members: {
			fields: { userId: t.string(), group: t.string(), role: t.string() },
			access: { read: memberOfKey('group') },
		},
		boards: {
			fields: { title: t.string(), ownerId: t.string().stamp('userId') },
			access: { read: member('id') },
		},
	},
})

async function rowsOf(handle: DeliveryStoreHandle): Promise<Array<[string, number]>> {
	if (!handle.sql) return []
	const rows = await handle.sql(
		'SELECT CAST(partition_key AS TEXT) AS k, delivery_seq AS s FROM kora_delivery_partitions ORDER BY delivery_seq, partition_key',
	)
	return rows.map((row) => [String(row.k), Number(row.s)])
}

const key = (value: string | null): string => partitionKey('notes', 'schoolId', value).toString()

/** The rows for an operation, sorted as `rowsOf` sorts. */
function rows(seq: number, ...keys: string[]): Array<[string, number]> {
	return keys.sort().map((k) => [k, seq] as [string, number])
}

async function throughOf(store: ServerStore): Promise<number> {
	return (await store.getDeliveryPartitionState?.())?.through ?? -1
}

for (const kind of deliveryStoreKinds()) {
	describe(`delivery index writes: ${kind.name}`, () => {
		test('rows follow the pre and post snapshots and the frontier follows live writes', async () => {
			const handle = await kind.make()
			try {
				const { store } = handle
				await store.setSchema(schema)
				await store.whenDeliveryIndexIdle?.()
				const insert = deliveryOp({
					collection: 'notes',
					recordId: 'n1',
					data: { body: 'b', schoolId: 'a' },
				})
				await store.applyRemoteOperation(insert)
				const move = deliveryOp({
					type: 'update',
					collection: 'notes',
					recordId: 'n1',
					data: { schoolId: 'b' },
					previousData: { schoolId: 'a' },
					causalDeps: [insert.id],
				})
				await store.applyRemoteOperation(move)
				// A collection with no partition field needs no rows, only the frontier.
				await store.applyRemoteOperation(
					deliveryOp({ collection: 'logs', recordId: 'l1', data: { line: 'x' } }),
				)
				// A repeat is a duplicate: it takes no sequence and writes nothing.
				await store.applyRemoteOperation(insert)

				expect(await throughOf(store)).toBe(3)
				if (handle.sql) {
					expect(await rowsOf(handle)).toEqual([
						...rows(1, key('a')),
						// Moved from a to b: filed under both, so the exit is found through a (the
						// retraction) and the entry through b.
						...rows(2, key('a'), key('b')),
					])
				}
			} finally {
				await handle.done()
			}
		})

		test('an operation the index cannot place is filed under the collection unknown key', async () => {
			const handle = await kind.make()
			try {
				const { store } = handle
				// `ghost` is not in the schema; `notes.grade` is a partition field its
				// snapshots lack (a scope the provider knows and the schema does not declare).
				await store.setSchema(schema, {
					deliveryPartitions: { ghost: ['tenant'], notes: ['grade'] },
				})
				await store.whenDeliveryIndexIdle?.()
				await store.applyRemoteOperation(
					deliveryOp({ collection: 'ghost', recordId: 'g1', data: { tenant: 't1' } }),
				)
				await store.applyRemoteOperation(
					deliveryOp({ collection: 'notes', recordId: 'n1', data: { body: 'b', schoolId: 'a' } }),
				)
				expect(await throughOf(store)).toBe(2)
				if (handle.sql) {
					expect(await rowsOf(handle)).toEqual([
						...rows(1, unknownPartitionKey('ghost').toString()),
						...rows(2, key('a'), unknownPartitionKey('notes').toString()),
					])
				}
			} finally {
				await handle.done()
			}
		})

		test('server-built operations (transact) are indexed like uploads', async () => {
			const handle = await kind.make()
			try {
				const { store } = handle
				await store.setSchema(schema)
				await store.whenDeliveryIndexIdle?.()
				const built = [
					deliveryOp({ collection: 'notes', recordId: 'n1', data: { body: 'b', schoolId: 'a' } }),
					deliveryOp({ collection: 'notes', recordId: 'n2', data: { body: 'b', schoolId: 'b' } }),
				]
				const result = await store.transact?.(async () => built)
				expect(result?.committed).toBe(true)
				expect(await throughOf(store)).toBe(2)
				if (handle.sql)
					expect(await rowsOf(handle)).toEqual([...rows(1, key('a')), ...rows(2, key('b'))])
			} finally {
				await handle.done()
			}
		})

		test('a conditional apply is indexed like an upload', async () => {
			const handle = await kind.make()
			try {
				const { store } = handle
				if (!store.applyConditional) return
				await store.setSchema(schema)
				await store.whenDeliveryIndexIdle?.()
				const built = deliveryOp({
					collection: 'notes',
					recordId: 'n1',
					data: { body: 'b', schoolId: 'a' },
				})
				const result = await store.applyConditional({
					target: { collection: 'notes', id: 'n1' },
					admit: () => true,
					buildOperations: async () => [built],
				})
				expect(result.admitted).toBe(true)
				expect(await throughOf(store)).toBe(1)
				if (handle.sql) expect(await rowsOf(handle)).toEqual(rows(1, key('a')))
			} finally {
				await handle.done()
			}
		})

		test('a replace-mode restore drops the rows of the replaced log and rebuilds them', async () => {
			const handle = await kind.make()
			try {
				const { store } = handle
				await store.setSchema(schema)
				await store.whenDeliveryIndexIdle?.()
				await store.applyRemoteOperation(
					deliveryOp({ collection: 'notes', recordId: 'n1', data: { body: 'b', schoolId: 'a' } }),
				)
				const backup = await store.exportBackup()
				// After the backup: two more operations, in another school.
				await store.applyRemoteOperation(
					deliveryOp({ collection: 'notes', recordId: 'n2', data: { body: 'b', schoolId: 'z' } }),
				)
				await store.applyRemoteOperation(
					deliveryOp({ collection: 'notes', recordId: 'n3', data: { body: 'b', schoolId: 'z' } }),
				)
				await store.importBackup(backup, false)
				await store.whenDeliveryIndexIdle?.()
				await store.backfillDeliveryPartitions?.()
				// Only the restored operation is indexed, at its reassigned sequence.
				expect(await throughOf(store)).toBe(1)
				if (handle.sql) expect(await rowsOf(handle)).toEqual(rows(1, key('a')))
			} finally {
				await handle.done()
			}
		})
	})
}

describe('delivery index writes: sequences reserved without an operation', () => {
	for (const kind of deliveryStoreKinds()) {
		test(`${kind.name}: a membership-index reconcile is covered by the frontier`, async () => {
			const handle = await kind.make()
			try {
				const { store } = handle
				await store.setSchema(accessSchema)
				await store.whenDeliveryIndexIdle?.()
				await store.applyRemoteOperation(
					deliveryOp({
						collection: 'members',
						recordId: 'm1',
						data: { userId: 'ann', group: 'boards:b1', role: 'view' },
					}),
				)
				const backup = await store.exportBackup()
				// A replace-mode restore rebuilds the membership index, reserving a sequence of
				// its own: no operation carries it, and the frontier must still reach it.
				await store.importBackup(backup, false)
				await store.whenDeliveryIndexIdle?.()
				await store.backfillDeliveryPartitions?.()
				expect(await throughOf(store)).toBe(await store.getMaxDeliverySequence())
				// Live writes continue the frontier from there.
				await store.applyRemoteOperation(
					deliveryOp({
						collection: 'members',
						recordId: 'm2',
						data: { userId: 'bob', group: 'boards:b1', role: 'view' },
					}),
				)
				expect(await throughOf(store)).toBe(await store.getMaxDeliverySequence())
				if (handle.sql) {
					const keys = (await rowsOf(handle)).map(([k]) => k)
					expect(keys).toContain(partitionKey('members', 'userId', 'bob').toString())
					expect(keys).toContain(partitionKey('members', 'group', 'boards:b1').toString())
				}
			} finally {
				await handle.done()
			}
		})
	}
})

describe('delivery index writes: the log-integrity quarantine', () => {
	for (const kind of deliveryStoreKinds().filter((k) => k.name !== 'memory')) {
		test(`${kind.name}: rows of a quarantined operation go with it`, async () => {
			const handle = await kind.make()
			try {
				const { store, sql: sqlRun } = handle
				if (!sqlRun || !handle.open) return
				await store.setSchema(schema)
				await store.whenDeliveryIndexIdle?.()
				const good = deliveryOp({
					collection: 'notes',
					recordId: 'n1',
					data: { body: 'b', schoolId: 'a' },
				})
				const bad = deliveryOp({
					collection: 'notes',
					recordId: 'n2',
					data: { body: 'b', schoolId: 'b' },
				})
				await store.applyRemoteOperation(good)
				await store.applyRemoteOperation(bad)
				expect(await rowsOf(handle)).toEqual([...rows(1, key('a')), ...rows(2, key('b'))])
				// Damage written outside the store, then the integrity scan runs again.
				await sqlRun(`UPDATE operations SET data = '{broken' WHERE id = '${bad.id}'`)
				await sqlRun("DELETE FROM kora_server_meta WHERE key = 'log_integrity_scan_v1'")
				const restarted = handle.open()
				await restarted.setSchema(schema)
				await restarted.whenDeliveryIndexIdle?.()
				expect(
					(await restarted.getOperationsAfterDelivery(0, 10)).map((d) => d.operation.id),
				).toEqual([good.id])
				// The index is rebuilt from the readable log only; sequence 2 holds nothing.
				await restarted.backfillDeliveryPartitions?.()
				expect(await rowsOf(handle)).toEqual(rows(1, key('a')))
				expect(await throughOf(restarted)).toBe(2)
			} finally {
				await handle.done()
			}
		})
	}
})

describe('delivery index writes: atomicity', () => {
	for (const kind of deliveryStoreKinds().filter((k) => k.name !== 'memory')) {
		test(`${kind.name}: a failed index write rolls the operation back, a failed operation leaves no rows`, async () => {
			const handle = await kind.make()
			try {
				const { store } = handle
				await store.setSchema(schema)
				await store.whenDeliveryIndexIdle?.()
				const sqlRun = handle.sql
				if (!sqlRun) return
				// The index rows cannot be written for school "bad": the whole write must fail.
				const bad = key('bad')
				if (kind.name === 'sqlite') {
					await sqlRun(
						`CREATE TRIGGER refuse_bad BEFORE INSERT ON kora_delivery_partitions WHEN NEW.partition_key = ${bad} BEGIN SELECT RAISE(ABORT, 'refused'); END`,
					)
				} else {
					await sqlRun(
						`CREATE FUNCTION refuse_bad() RETURNS trigger AS $$ BEGIN IF NEW.partition_key = ${bad} THEN RAISE EXCEPTION 'refused'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`,
					)
					await sqlRun(
						'CREATE TRIGGER refuse_bad BEFORE INSERT ON kora_delivery_partitions FOR EACH ROW EXECUTE FUNCTION refuse_bad()',
					)
				}
				const doomed = deliveryOp({
					collection: 'notes',
					recordId: 'n9',
					data: { body: 'b', schoolId: 'bad' },
				})
				await expect(store.applyRemoteOperation(doomed)).rejects.toThrow()
				// Neither the operation, nor its snapshot, nor any row, nor the frontier moved.
				expect(await store.getOperationCount()).toBe(0)
				expect(await store.findStoredOperations?.([doomed.id])).toEqual(new Map())
				expect(await rowsOf(handle)).toEqual([])
				expect(await throughOf(store)).toBe(0)
				// And the next write is fine, at the sequence the failed one did not keep.
				await store.applyRemoteOperation(
					deliveryOp({ collection: 'notes', recordId: 'n1', data: { body: 'b', schoolId: 'a' } }),
				)
				expect(await rowsOf(handle)).toEqual(rows(1, key('a')))
				expect(await throughOf(store)).toBe(1)
			} finally {
				await handle.done()
			}
		})
	}
})

describe('delivery index writes: another plan never advances the frontier', () => {
	for (const kind of deliveryStoreKinds().filter((k) => k.name !== 'memory')) {
		test(`${kind.name}: an instance on another plan writes rows but leaves the frontier to the owner`, async () => {
			const handle = await kind.make()
			try {
				const owner = handle.store
				await owner.setSchema(schema)
				await owner.whenDeliveryIndexIdle?.()
				const other = handle.open?.()
				if (!other) return
				// `other` runs another plan (a rolling deploy): the index is rebuilt under it.
				await other.setSchema(schema, { deliveryPartitions: { notes: ['body'] } })
				await other.whenDeliveryIndexIdle?.()

				await other.applyRemoteOperation(
					deliveryOp({ collection: 'notes', recordId: 'n1', data: { body: 'b', schoolId: 'a' } }),
				)
				expect(await throughOf(other)).toBe(1)
				// The first instance is on the previous plan: its write is filed under keys the
				// current plan does not use, so it must not extend the frontier.
				await owner.applyRemoteOperation(
					deliveryOp({ collection: 'notes', recordId: 'n2', data: { body: 'b', schoolId: 'a' } }),
				)
				expect(await throughOf(owner)).toBe(1)
				await other.applyRemoteOperation(
					deliveryOp({ collection: 'notes', recordId: 'n3', data: { body: 'b', schoolId: 'a' } }),
				)
				// A gap: the frontier waits for the backfill of the plan's owner, which closes it.
				expect(await throughOf(other)).toBe(1)
				await other.backfillDeliveryPartitions?.()
				expect(await throughOf(other)).toBe(3)
			} finally {
				await handle.done()
			}
		})
	}
})
