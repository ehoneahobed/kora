/**
 * A rolling deploy and a backfill in progress (C2.6) never change what a session receives:
 * the index answers up to its frontier, the global scan reads the tail above it, and the
 * delivery poll closes the gap. A session that connects while an older instance's appends
 * (written without index rows) sit above the frontier gets exactly the global scan's stream.
 *
 * Needs a store with a persistent frontier, so it runs on SQLite and, with KORA_PG_TEST_URL,
 * on Postgres.
 */
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { afterAll, describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import type { DeliveryIndexRead, DeliverySources } from '../../src/store/delivery-partitions'
import type { MemoryServerStore } from '../../src/store/memory-server-store'
import type { DeliveredOperation, DeliveryPartitionState } from '../../src/store/server-store'
import { deliveryStoreKinds, removeDeliveryTempFiles } from '../fixtures/delivery-stores'
import { dropTrackedPgSchemas } from '../fixtures/pg-test-schemas'
import { createHarness } from '../repro/rt-fixture'

afterAll(dropTrackedPgSchemas)
afterAll(removeDeliveryTempFiles)

const schema = defineSchema({
	version: 1,
	collections: {
		notes: { fields: { schoolId: t.string(), body: t.string().default('') }, scope: ['schoolId'] },
	},
})

const auth = new TokenAuthProvider({
	validate: async (token) =>
		token === 'north' ? { userId: 'north', scopes: { notes: { schoolId: 'north' } } } : null,
})

/** The parts of a store this test reaches into (the instance's plan stands in for its release). */
interface TestStore {
	deliveryPlan: unknown
	getOperationsAfterDeliveryIn?: (
		sources: DeliverySources,
		after: number,
		limit: number,
	) => Promise<DeliveryIndexRead>
	getOperationsAfterDelivery: (after: number, limit: number) => Promise<DeliveredOperation[]>
	whenDeliveryIndexIdle: () => Promise<void>
	getDeliveryPartitionState: () => Promise<DeliveryPartitionState>
}

function ids(messages: SyncMessage[]): string[] {
	return messages.flatMap((m) =>
		m.type === 'operation-batch' ? (m.operations as Array<{ id: string }>).map((o) => o.id) : [],
	)
}

for (const kind of deliveryStoreKinds().filter((k) => k.name !== 'memory')) {
	describe(`sessions during a rolling deploy: ${kind.name}`, () => {
		test('the tail above the frontier is read by scan, and the poll then indexes it', async () => {
			const handle = await kind.make()
			try {
				const store = handle.store as unknown as TestStore
				const harness = await createHarness(
					schema,
					auth,
					{ batchSize: 2 },
					handle.store as unknown as MemoryServerStore,
				)
				const ctx = harness.server.getKoraContext()
				const write = async (i: number): Promise<void> => {
					await ctx.apply({
						collection: 'notes',
						type: 'insert',
						recordId: `n${i}`,
						data: { schoolId: i % 3 === 0 ? 'south' : 'north', body: `b${i}` },
					})
				}
				await store.whenDeliveryIndexIdle()
				for (let i = 1; i <= 12; i++) await write(i)
				// Operations 13 to 16 come from an instance of the previous release: no rows.
				const plan = store.deliveryPlan
				store.deliveryPlan = null
				for (let i = 13; i <= 16; i++) await write(i)
				store.deliveryPlan = plan
				expect((await store.getDeliveryPartitionState()).through).toBe(12)

				const play = async (useIndex: boolean) => {
					const original = store.getOperationsAfterDeliveryIn
					const scan = store.getOperationsAfterDelivery
					let scanned = 0
					let indexed = 0
					store.getOperationsAfterDelivery = async (a, l) => {
						const rows = await scan.call(store, a, l)
						scanned += rows.length
						return rows
					}
					store.getOperationsAfterDeliveryIn =
						useIndex && original
							? async (s, a, l) => {
									const read = await original.call(store, s, a, l)
									indexed += read.operations.length
									return read
								}
							: undefined
					try {
						const north = await harness.login('north', 'north-node', {
							lastDeliverySequence: 0,
						} as Partial<SyncMessage>)
						await harness.settle()
						await north.client.disconnect()
						return { messages: north.messages, scanned, indexed }
					} finally {
						store.getOperationsAfterDeliveryIn = original
						store.getOperationsAfterDelivery = scan
					}
				}

				const gap = await play(true)
				const reference = await play(false)
				expect(ids(gap.messages)).toEqual(ids(reference.messages))
				// 8 of the first 12 and all 4 of the tail are the north school's (n3, n6, n9,
				// n12 and n15 are the south's, so 16 - 5 = 11).
				expect(ids(gap.messages)).toHaveLength(11)
				// The head came from the index; the scan read the four-operation tail only, once
				// for the handshake pre-pass and once for the stream.
				expect(gap.indexed).toBeGreaterThan(0)
				expect(gap.scanned).toBeLessThanOrEqual(8)
				expect(reference.scanned).toBeGreaterThanOrEqual(16)

				// The delivery poll closes the gap, so the next session scans nothing.
				await (harness.server as unknown as { pollDeliveryLog(): Promise<void> }).pollDeliveryLog()
				await store.whenDeliveryIndexIdle()
				expect((await store.getDeliveryPartitionState()).through).toBe(16)
				const healed = await play(true)
				expect(ids(healed.messages)).toEqual(ids(reference.messages))
				expect(healed.scanned).toBe(0)
				expect(healed.indexed).toBeGreaterThan(0)
			} finally {
				await handle.done()
			}
		})
	})
}
