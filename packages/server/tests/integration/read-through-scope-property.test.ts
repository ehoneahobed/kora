/**
 * The scope of a read, against an oracle that does not use the endpoint: for generated records
 * and generated scopes (string, number and boolean equalities, string and number `$in` lists,
 * a second `$in`, `$or` mixes of them) an `ok` answer holds exactly the records the scope
 * matches. The stores are only asked for the parts they can compare, so the JavaScript
 * re-check of the whole scope is what keeps the rest out; this property fails without it.
 */
import { fc } from '@fast-check/vitest'
import { defineSchema, t } from '@korajs/core'
import { recordMatchesCollectionScope } from '@korajs/core/internal'
import { afterAll, describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import type { ReadResponse } from '../../src/read/read-types'
import type { MemoryServerStore } from '../../src/store/memory-server-store'
import { deliveryStoreKinds, removeDeliveryTempFiles } from '../fixtures/delivery-stores'
import { dropTrackedPgSchemas } from '../fixtures/pg-test-schemas'
import { createHarness } from '../repro/rt-fixture'

afterAll(dropTrackedPgSchemas)
afterAll(removeDeliveryTempFiles)

const schema = defineSchema({
	version: 1,
	collections: {
		courses: {
			fields: {
				schoolId: t.string(),
				title: t.string(),
				position: t.number().default(0),
				published: t.boolean().default(false),
			},
		},
	},
})

const SCHOOLS = ['s1', 's2', 's3']
const TITLES = ['a', 'b']

type Branch = Record<string, unknown>

const branchArb: fc.Arbitrary<Branch> = fc
	.record(
		{
			schoolId: fc.oneof(
				fc.constantFrom(...SCHOOLS),
				fc.record({ $in: fc.subarray(SCHOOLS, { minLength: 1 }) }),
			),
			title: fc.oneof(
				fc.constantFrom(...TITLES),
				fc.record({ $in: fc.subarray(TITLES, { minLength: 1 }) }),
			),
			position: fc.oneof(
				fc.integer({ min: 0, max: 2 }),
				fc.record({ $in: fc.subarray([0, 1, 2], { minLength: 1 }) }),
			),
			published: fc.boolean(),
		},
		{ requiredKeys: [] },
	)
	.filter((branch) => Object.keys(branch).length > 0)

const scopeArb: fc.Arbitrary<Branch> = fc.oneof(
	branchArb,
	fc.array(branchArb, { minLength: 2, maxLength: 3 }).map((branches) => ({ $or: branches })),
)

const recordArb = fc.record({
	schoolId: fc.constantFrom(...SCHOOLS),
	title: fc.constantFrom(...TITLES),
	position: fc.integer({ min: 0, max: 2 }),
	published: fc.boolean(),
})

const kinds = [
	{
		name: 'memory',
		make: null as null | (() => Promise<{ store: unknown; done: () => Promise<void> }>),
	},
	...deliveryStoreKinds()
		.filter((k) => k.name === 'sqlite')
		.map((k) => ({ name: k.name, make: k.make })),
]

describe('an ok read of a generated scope is exactly what the scope matches', () => {
	for (const kind of kinds) {
		test(`${kind.name}: same records as the oracle`, async () => {
			let okChecked = 0
			let nonEmpty = 0
			await fc.assert(
				fc.asyncProperty(
					scopeArb,
					fc.array(recordArb, { minLength: 1, maxLength: 8 }),
					async (scope, records) => {
						const handle = kind.make ? await kind.make() : null
						try {
							const auth = new TokenAuthProvider({
								validate: async () => ({ userId: 'u', scopes: { courses: scope } }),
							})
							const harness = await createHarness(
								schema,
								auth,
								{},
								handle ? (handle.store as MemoryServerStore) : undefined,
							)
							const ctx = harness.server.getKoraContext()
							for (const [i, record] of records.entries()) {
								await ctx.apply({
									collection: 'courses',
									type: 'insert',
									recordId: `r${i}`,
									data: record,
								})
							}
							const answer = await harness.server.handleReadRequest({
								method: 'POST',
								authorization: 'Bearer x',
								contentType: 'application/json',
								body: JSON.stringify({
									v: 1,
									schemaVersion: 1,
									queries: [{ key: 'q', collection: 'courses', where: {}, orderBy: [] }],
								}),
							})
							// A scope shape the grant refuses is not a read.
							if (answer.status === 403) return
							expect(answer.status, answer.body).toBe(200)
							const result = (JSON.parse(answer.body ?? '') as ReadResponse).results[0]
							if (result?.status !== 'ok') return
							const expected = records
								.map((record, i) => ({ id: `r${i}`, ...record }))
								.filter((record) => recordMatchesCollectionScope(record, scope))
								.map((record) => record.id)
								.sort()
							expect((result.records ?? []).map((r) => r.id).sort()).toEqual(expected)
							okChecked += 1
							if (expected.length > 0) nonEmpty += 1
						} finally {
							await handle?.done()
						}
					},
				),
				{ numRuns: 60, seed: 20261030 },
			)
			expect(okChecked).toBeGreaterThan(0)
			expect(nonEmpty).toBeGreaterThan(0)
		}, 480_000)
	}
})
