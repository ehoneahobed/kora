/**
 * The membership sources of the delivery index (C2.5): every operation
 * `operationTouchesMemberships` (or `revivesGroupOfMine`) acts on for a user is returned by
 * the index read over `addMembershipSources` alone, whatever the user's grant is. A property
 * over generated logs of membership rows and group records, on every server store.
 * Postgres runs with KORA_PG_TEST_URL.
 */
import { fc } from '@fast-check/vitest'
import { defineSchema, member, memberOfKey, owner, t } from '@korajs/core'
import { groupKey } from '@korajs/core/internal'
import { afterAll, describe, expect, test } from 'vitest'
import {
	deliveryOp,
	deliveryStoreKinds,
	removeDeliveryTempFiles,
} from '../../tests/fixtures/delivery-stores'
import { dropTrackedPgSchemas } from '../../tests/fixtures/pg-test-schemas'
import { operationTouchesMemberships } from '../access/access-delivery'
import {
	DeliverySourceBuilder,
	addMembershipSources,
	deriveDeliveryPartitionPlan,
} from './delivery-partitions'

afterAll(dropTrackedPgSchemas)
afterAll(removeDeliveryTempFiles)

const schema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'edit', 'manage'],
		groups: { documents: { owner: 'ownerId', role: 'manage' } },
	},
	collections: {
		members: {
			fields: { userId: t.string(), group: t.string(), role: t.string() },
			access: { read: memberOfKey('group', 'manage') },
		},
		documents: {
			fields: { title: t.string(), ownerId: t.string().stamp('userId') },
			access: { read: member('id'), create: owner('ownerId') },
		},
		notes: {
			fields: { documentId: t.string(), body: t.string() },
			access: { read: member('documentId', 'view', { group: 'documents' }) },
		},
	},
})
if (!schema.access) throw new Error('the fixture schema declares access rules')
const access = schema.access
const plan = deriveDeliveryPartitionPlan(schema)
const USERS = ['u1', 'u2', 'u3'] as const
const USER = 'u1'

type Step =
	| { kind: 'member'; user: (typeof USERS)[number]; group: number }
	| { kind: 'owner'; group: number; owner: (typeof USERS)[number] }
	| { kind: 'delete'; group: number }
	| { kind: 'touch'; group: number }
	| { kind: 'note'; group: number }

const stepArb: fc.Arbitrary<Step> = fc.oneof(
	fc.record({
		kind: fc.constant('member' as const),
		user: fc.constantFrom(...USERS),
		group: fc.integer({ min: 0, max: 2 }),
	}),
	fc.record({
		kind: fc.constant('owner' as const),
		group: fc.integer({ min: 0, max: 2 }),
		owner: fc.constantFrom(...USERS),
	}),
	fc.record({ kind: fc.constant('delete' as const), group: fc.integer({ min: 0, max: 2 }) }),
	fc.record({ kind: fc.constant('touch' as const), group: fc.integer({ min: 0, max: 2 }) }),
	fc.record({ kind: fc.constant('note' as const), group: fc.integer({ min: 0, max: 2 }) }),
)

for (const kind of deliveryStoreKinds()) {
	describe(`membership sources: ${kind.name}`, () => {
		let nonVacuous = 0
		test('return every operation operationTouchesMemberships acts on, for any grant', async () => {
			await fc.assert(
				fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 16 }), async (steps) => {
					const handle = await kind.make()
					try {
						const { store } = handle
						await store.setSchema(schema)
						await store.whenDeliveryIndexIdle?.()
						const docs = new Set<number>()
						const rows = new Set<string>()
						let noteCounter = 0
						for (const step of steps) {
							if (step.kind === 'member') {
								const recordId = `m-${step.user}-${step.group}`
								await store.applyRemoteOperation(
									deliveryOp({
										collection: 'members',
										recordId,
										data: {
											userId: step.user,
											group: groupKey('documents', `g${step.group}`),
											role: 'view',
										},
									}),
								)
								if (step.user === USER) rows.add(groupKey('documents', `g${step.group}`))
								continue
							}
							const recordId = `g${step.group}`
							if (step.kind === 'note') {
								noteCounter += 1
								await store.applyRemoteOperation(
									deliveryOp({
										collection: 'notes',
										recordId: `n${noteCounter}`,
										data: { documentId: recordId, body: 'b' },
									}),
								)
								continue
							}
							if (!docs.has(step.group)) {
								docs.add(step.group)
								await store.applyRemoteOperation(
									deliveryOp({
										collection: 'documents',
										recordId,
										data: {
											title: 't',
											ownerId: step.kind === 'owner' ? step.owner : 'u2',
										},
									}),
								)
								continue
							}
							if (step.kind === 'delete') {
								await store.applyRemoteOperation(
									deliveryOp({ collection: 'documents', recordId, type: 'delete', data: null }),
								)
							} else {
								await store.applyRemoteOperation(
									deliveryOp({
										collection: 'documents',
										recordId,
										type: 'update',
										data: step.kind === 'owner' ? { ownerId: step.owner } : { title: 't2' },
									}),
								)
							}
						}
						await store.backfillDeliveryPartitions?.()
						const log = await store.getOperationsAfterDelivery(0, 10_000)
						// What the global scan acts on, judged exactly as the session does.
						const memberOf = new Set(rows)
						const acted = log.filter((d) => {
							const snapshot = d.scopeSnapshot ?? null
							if (operationTouchesMemberships(access, d.operation, snapshot, USER, memberOf)) {
								return true
							}
							return (
								d.operation.type === 'update' &&
								snapshot !== null &&
								snapshot.pre === null &&
								snapshot.post !== null &&
								d.operation.collection === 'documents' &&
								rows.has(groupKey('documents', d.operation.recordId))
							)
						})
						const builder = new DeliverySourceBuilder()
						addMembershipSources(builder, plan, access, USER, rows)
						const sources = builder.build()
						expect(sources).not.toBeNull()
						if (sources === null) return
						const read = await store.getOperationsAfterDeliveryIn?.(sources, 0, 10_000)
						expect(read?.complete).toBe(true)
						const returned = new Set(read?.operations.map((d) => d.operation.id))
						for (const d of acted) expect(returned.has(d.operation.id)).toBe(true)
						nonVacuous += acted.length
					} finally {
						await handle.done()
					}
				}),
				{ numRuns: kind.name === 'memory' ? 80 : 15 },
			)
			expect(nonVacuous).toBeGreaterThan(0)
		}, 180_000)
	})
}
