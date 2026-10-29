/**
 * Migration and backfill of the delivery visibility index (C2.6): a rolling deploy where an
 * older instance appends without index rows only slows sessions down, the delivery poll fills
 * the gap, a plan change in the middle of a backfill starts over, and a backup carries no index
 * (a restore rebuilds it). Memory has no second instance to roll, so SQLite and Postgres
 * (KORA_PG_TEST_URL) run these.
 */
import { defineSchema, t } from '@korajs/core'
import { afterAll, describe, expect, test, vi } from 'vitest'
import {
	type DeliveryStoreHandle,
	deliveryOp,
	deliveryStoreKinds,
	removeDeliveryTempFiles,
} from '../../tests/fixtures/delivery-stores'
import { dropTrackedPgSchemas } from '../../tests/fixtures/pg-test-schemas'
import { type DeliverySources, partitionKey } from './delivery-partitions'
import type { ServerStore } from './server-store'

afterAll(dropTrackedPgSchemas)
afterAll(removeDeliveryTempFiles)

const schema = defineSchema({
	version: 1,
	collections: {
		notes: { fields: { body: t.string(), schoolId: t.string() }, scope: ['schoolId'] },
	},
})

type Indexed = ServerStore & {
	pauseDeliveryBackfillForTests(paused: boolean): void
	deliveryPlan: unknown
	kickDeliveryBackfill(): void
}

async function note(store: ServerStore, id: string, school: string): Promise<void> {
	await store.applyRemoteOperation(
		deliveryOp({ collection: 'notes', recordId: id, data: { body: 'b', schoolId: school } }),
	)
}

async function rowSeqs(handle: DeliveryStoreHandle): Promise<number[]> {
	const rows =
		(await handle.sql?.(
			'SELECT delivery_seq AS s FROM kora_delivery_partitions ORDER BY delivery_seq',
		)) ?? []
	return rows.map((row) => Number(row.s))
}

const SCHOOL_A: DeliverySources = {
	partitionKeys: [partitionKey('notes', 'schoolId', 'a')],
	collections: [],
	nodeIds: [],
}

for (const kind of deliveryStoreKinds().filter((k) => k.name !== 'memory')) {
	describe(`delivery index migration: ${kind.name}`, () => {
		test('an older instance appending without rows only leaves a tail the poll then indexes', async () => {
			const handle = await kind.make()
			try {
				const store = handle.store as Indexed
				await store.setSchema(schema)
				await store.whenDeliveryIndexIdle?.()
				await note(store, 'n1', 'a')
				await note(store, 'n2', 'b')
				await note(store, 'n3', 'a')
				expect((await store.getDeliveryPartitionState?.())?.through).toBe(3)

				// An instance of the previous release: it writes the operation and no rows.
				const plan = store.deliveryPlan
				store.deliveryPlan = null
				await note(store, 'n4', 'a')
				store.deliveryPlan = plan
				// A current instance writes its rows, but the frontier cannot jump the gap.
				await note(store, 'n5', 'a')
				expect((await store.getDeliveryPartitionState?.())?.through).toBe(3)
				expect(await rowSeqs(handle)).toEqual([1, 2, 3, 5])

				// Sessions still get every operation: the index answers up to the frontier and
				// says so, and the caller reads the rest through the global scan.
				const read = await store.getOperationsAfterDeliveryIn?.(SCHOOL_A, 0, 100)
				expect(read?.complete).toBe(true)
				expect(read?.coveredThrough).toBe(3)
				expect(read?.operations.map((d) => d.deliverySequence)).toEqual([1, 3])
				const tail = await store.getOperationsAfterDelivery(read?.coveredThrough ?? 0, 100)
				expect(tail.map((d) => d.deliverySequence)).toEqual([4, 5])

				// The delivery poll closes the gap in the background.
				await store.catchUpDeliveryIndex?.(5)
				await store.whenDeliveryIndexIdle?.()
				expect((await store.getDeliveryPartitionState?.())?.through).toBe(5)
				expect(await rowSeqs(handle)).toEqual([1, 2, 3, 4, 5])
				const healed = await store.getOperationsAfterDeliveryIn?.(SCHOOL_A, 0, 100)
				expect(healed?.operations.map((d) => d.deliverySequence)).toEqual([1, 3, 4, 5])
				expect(healed?.coveredThrough).toBe(5)
			} finally {
				await handle.done()
			}
		})

		test('the poll starts no backfill when nothing is behind the frontier', async () => {
			const handle = await kind.make()
			try {
				const store = handle.store as Indexed
				await store.setSchema(schema)
				await store.whenDeliveryIndexIdle?.()
				await note(store, 'n1', 'a')
				const kick = vi.spyOn(store, 'kickDeliveryBackfill')
				await store.catchUpDeliveryIndex?.(1)
				await store.catchUpDeliveryIndex?.(0)
				expect(kick).not.toHaveBeenCalled()
				await store.catchUpDeliveryIndex?.(2)
				expect(kick).toHaveBeenCalledTimes(1)
				await store.whenDeliveryIndexIdle?.()
			} finally {
				await handle.done()
			}
		})

		test('a plan change in the middle of a backfill starts it over under the new plan', async () => {
			const handle = await kind.make()
			try {
				const store = handle.store as Indexed
				store.pauseDeliveryBackfillForTests(true)
				await store.setSchema(schema)
				for (let i = 0; i < 9; i++) await note(store, `n${i}`, i % 2 === 0 ? 'a' : 'b')
				await store.setDeliveryPartitions?.({ notes: ['body'] })
				// The reset left nothing covered and no rows.
				expect((await store.getDeliveryPartitionState?.())?.through).toBe(0)
				expect(await rowSeqs(handle)).toEqual([])
				expect(await store.backfillDeliveryPartitions?.(1, 4)).toBe(4)
				expect((await store.getDeliveryPartitionState?.())?.through).toBe(4)

				// Another plan arrives half way: the progress under the old one is void.
				await store.setDeliveryPartitions?.({ notes: ['body', 'extra'] })
				expect((await store.getDeliveryPartitionState?.())?.through).toBe(0)
				expect(await rowSeqs(handle)).toEqual([])
				await store.backfillDeliveryPartitions?.()
				const state = await store.getDeliveryPartitionState?.()
				expect(state?.through).toBe(9)
				expect(state?.usable).toBe(true)
				// Each operation is filed under its body, its school and the unknown key (it has no 'extra').
				const rows = await rowSeqs(handle)
				expect(rows.filter((s) => s === 1)).toHaveLength(3)
				expect(new Set(rows).size).toBe(9)
			} finally {
				await handle.done()
			}
		})

		test('a backup carries no index and a restore indexes the restored log', async () => {
			const handle = await kind.make()
			try {
				const store = handle.store as Indexed
				await store.setSchema(schema)
				await store.whenDeliveryIndexIdle?.()
				for (let i = 0; i < 6; i++) await note(store, `n${i}`, i % 2 === 0 ? 'a' : 'b')
				const backup = await store.exportBackup()
				// The sections are named in the file: manifest, operations, keys, checksum.
				const names: string[] = []
				const view = new DataView(backup.buffer, backup.byteOffset, backup.byteLength)
				for (let offset = 0; offset + 8 <= backup.byteLength; ) {
					const nameLength = view.getUint32(offset, true)
					const contentLength = view.getUint32(offset + 4, true)
					names.push(new TextDecoder().decode(backup.slice(offset + 8, offset + 8 + nameLength)))
					offset += 8 + nameLength + contentLength
				}
				expect(names.filter((n) => /partition|delivery|index/i.test(n))).toEqual([])

				const fresh = await kind.make()
				try {
					const target = fresh.store as Indexed
					await target.setSchema(schema)
					await target.whenDeliveryIndexIdle?.()
					await target.importBackup(backup, false)
					await target.whenDeliveryIndexIdle?.()
					await target.backfillDeliveryPartitions?.()
					expect((await target.getDeliveryPartitionState?.())?.through).toBe(6)
					expect(await rowSeqs(fresh)).toEqual([1, 2, 3, 4, 5, 6])
					const read = await target.getOperationsAfterDeliveryIn?.(SCHOOL_A, 0, 100)
					expect(read?.operations.map((d) => d.deliverySequence)).toEqual([1, 3, 5])
				} finally {
					await fresh.done()
				}
			} finally {
				await handle.done()
			}
		})
	})
}
