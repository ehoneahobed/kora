/**
 * The invariant of the read-through endpoint (first-visit parity S2), as a property over
 * generated logs: a read NEVER returns more than the sync delivery stream would hold on the
 * same session, and never a row that reflects an operation after the stated frontier.
 *
 * The fixture is the school system of `delivery-index-property.test.ts` (access rules with
 * memberships, scope entries, moves between schools, deletes, owner transfers). After every
 * generated action a fresh session catches up from sequence 0 and the records it holds
 * (batches applied in the order a client applies them: narrowing, retractions, operations)
 * are the reference set; a read of every collection must be a subset of it, on a store that
 * keeps a membership index. A second mode lets the log change between the read of the rows
 * and the read of the frontier, and checks every returned record against the delivery
 * sequence of its newest operation.
 */
import { fc } from '@fast-check/vitest'
import { defineSchema, member, memberOfKey, owner, t } from '@korajs/core'
import { recordMatchesCollectionScope } from '@korajs/core/internal'
import type { SyncMessage } from '@korajs/sync'
import { afterAll, describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import type { ReadResponse } from '../../src/read/read-types'
import type { MemoryServerStore } from '../../src/store/memory-server-store'
import {
	type DeliveryStoreHandle,
	deliveryStoreKinds,
	removeDeliveryTempFiles,
} from '../fixtures/delivery-stores'
import { dropTrackedPgSchemas } from '../fixtures/pg-test-schemas'
import { type Harness, createHarness } from '../repro/rt-fixture'

afterAll(dropTrackedPgSchemas)
afterAll(removeDeliveryTempFiles)

const schema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'edit', 'manage'],
		groups: { schools: { owner: 'ownerId', role: 'manage' } },
	},
	collections: {
		members: {
			fields: { userId: t.string(), group: t.string(), role: t.string() },
			access: { read: memberOfKey('group', 'manage') },
		},
		schools: {
			fields: { name: t.string(), ownerId: t.string().stamp('userId') },
			access: { read: member('id'), create: owner('ownerId') },
		},
		lessons: {
			fields: { schoolId: t.string(), title: t.string() },
			access: { read: member('schoolId', 'view', { group: 'schools' }) },
		},
		students: {
			fields: { schoolId: t.string(), name: t.string() },
			access: { read: member('schoolId', 'edit', { group: 'schools' }) },
		},
	},
})

const auth = new TokenAuthProvider({
	validate: async (token) => (['ann', 'bob', 'cat'].includes(token) ? { userId: token } : null),
})

const FRESH = { supportsScopeDisjunction: true, lastDeliverySequence: 0 } as Partial<SyncMessage>
const SCHOOLS = ['s1', 's2', 's3'] as const
const ROLES = ['view', 'edit', 'manage'] as const
type School = (typeof SCHOOLS)[number]

type Action =
	| { kind: 'grant'; school: School; role: (typeof ROLES)[number] }
	| { kind: 'revoke'; school: School }
	| { kind: 'lesson'; school: School }
	| { kind: 'student'; school: School }
	| { kind: 'edit'; slot: number }
	| { kind: 'move'; slot: number; school: School }
	| { kind: 'drop'; slot: number }
	| { kind: 'transfer'; school: School; to: 'ann' | 'bob' | 'cat' }
	| { kind: 'removeSchool'; school: School }
	| { kind: 'reviveSchool'; school: School }

const schoolArb = fc.constantFrom(...SCHOOLS)
const actionArb: fc.Arbitrary<Action> = fc.oneof(
	{
		weight: 3,
		arbitrary: fc.record({
			kind: fc.constant('grant' as const),
			school: schoolArb,
			role: fc.constantFrom(...ROLES),
		}),
	},
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant('revoke' as const), school: schoolArb }) },
	{ weight: 4, arbitrary: fc.record({ kind: fc.constant('lesson' as const), school: schoolArb }) },
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant('student' as const), school: schoolArb }) },
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant('edit' as const), slot: fc.nat(8) }) },
	{
		weight: 3,
		arbitrary: fc.record({
			kind: fc.constant('move' as const),
			slot: fc.nat(8),
			school: schoolArb,
		}),
	},
	{ weight: 1, arbitrary: fc.record({ kind: fc.constant('drop' as const), slot: fc.nat(8) }) },
	{
		weight: 2,
		arbitrary: fc.record({
			kind: fc.constant('transfer' as const),
			school: schoolArb,
			to: fc.constantFrom('ann', 'bob', 'cat'),
		}),
	},
	{
		weight: 1,
		arbitrary: fc.record({ kind: fc.constant('removeSchool' as const), school: schoolArb }),
	},
	{
		weight: 1,
		arbitrary: fc.record({ kind: fc.constant('reviveSchool' as const), school: schoolArb }),
	},
)

/** What the generated actions have done so far, so each one is a valid write. */
class Model {
	private readonly schools = new Map<School, { deleted: boolean }>()
	private readonly lessons: Array<{ id: string; school: School; deleted: boolean }> = []
	private members = new Set<School>()
	private counter = 0

	constructor(
		private readonly harness: Harness,
		private readonly ctx: ReturnType<Harness['server']['getKoraContext']>,
	) {}

	private async school(id: School, ownerId = 'ann'): Promise<void> {
		if (this.schools.has(id)) return
		this.schools.set(id, { deleted: false })
		await this.ctx.apply({
			collection: 'schools',
			type: 'insert',
			recordId: id,
			data: { name: `school ${id}`, ownerId },
		})
	}

	/** Plays one action. Invalid ones (nothing to edit yet) do nothing, the same in every run. */
	async play(action: Action): Promise<void> {
		switch (action.kind) {
			case 'grant':
				await this.school(action.school)
				await this.harness.server.access.grant({
					userId: 'bob',
					group: ['schools', action.school],
					role: action.role,
				})
				this.members.add(action.school)
				return
			case 'revoke':
				if (!this.members.has(action.school)) return
				await this.harness.server.access.revoke({
					userId: 'bob',
					group: ['schools', action.school],
				})
				this.members.delete(action.school)
				return
			case 'lesson': {
				await this.school(action.school)
				this.counter += 1
				const id = `l${this.counter}`
				this.lessons.push({ id, school: action.school, deleted: false })
				await this.ctx.apply({
					collection: 'lessons',
					type: 'insert',
					recordId: id,
					data: { schoolId: action.school, title: `lesson ${id}` },
				})
				return
			}
			case 'student': {
				await this.school(action.school)
				this.counter += 1
				await this.ctx.apply({
					collection: 'students',
					type: 'insert',
					recordId: `st${this.counter}`,
					data: { schoolId: action.school, name: `student ${this.counter}` },
				})
				return
			}
			case 'edit':
			case 'move':
			case 'drop': {
				const live = this.lessons.filter((l) => !l.deleted)
				const target = live[action.slot % Math.max(live.length, 1)]
				if (!target) return
				if (action.kind === 'drop') {
					target.deleted = true
					await this.ctx.apply({
						collection: 'lessons',
						type: 'delete',
						recordId: target.id,
						data: null,
					})
					return
				}
				if (action.kind === 'move') {
					await this.school(action.school)
					target.school = action.school
				}
				await this.ctx.apply({
					collection: 'lessons',
					type: 'update',
					recordId: target.id,
					data:
						action.kind === 'move'
							? { schoolId: action.school }
							: { title: `edited ${this.counter++}` },
				})
				return
			}
			case 'transfer':
				await this.school(action.school)
				await this.ctx.apply({
					collection: 'schools',
					type: 'update',
					recordId: action.school,
					data: { ownerId: action.to },
				})
				return
			case 'removeSchool': {
				await this.school(action.school)
				const state = this.schools.get(action.school)
				if (!state || state.deleted) return
				state.deleted = true
				await this.ctx.apply({
					collection: 'schools',
					type: 'delete',
					recordId: action.school,
					data: null,
				})
				return
			}
			case 'reviveSchool': {
				const state = this.schools.get(action.school)
				if (!state?.deleted) return
				state.deleted = false
				await this.ctx.apply({
					collection: 'schools',
					type: 'update',
					recordId: action.school,
					data: { name: `revived ${action.school}` },
				})
				return
			}
		}
	}
}

const COLLECTIONS = ['schools', 'lessons', 'students', 'members'] as const

/** The records a device holds after applying the whole stream, in client order. */
function held(messages: SyncMessage[]): Set<string> {
	const records = new Map<string, Record<string, unknown>>()
	for (const m of messages) {
		if (m.type !== 'operation-batch') continue
		const b = m as unknown as {
			operations: Array<{
				type: string
				collection: string
				recordId: string
				data: Record<string, unknown> | null
			}>
			retractions?: Array<{ collection: string; recordId: string }>
			accessNarrowing?: Record<string, Record<string, unknown> | null>
		}
		for (const [collection, scope] of Object.entries(b.accessNarrowing ?? {})) {
			for (const [key, values] of records) {
				if (!key.startsWith(`${collection}/`)) continue
				if (scope !== null && recordMatchesCollectionScope(values, scope)) continue
				records.delete(key)
			}
		}
		for (const r of b.retractions ?? []) records.delete(`${r.collection}/${r.recordId}`)
		for (const op of b.operations) {
			const key = `${op.collection}/${op.recordId}`
			if (op.type === 'delete') records.delete(key)
			else records.set(key, { ...(records.get(key) ?? {}), ...(op.data ?? {}), id: op.recordId })
		}
	}
	return new Set(records.keys())
}

async function readAll(
	harness: Harness,
	token: string,
): Promise<{ response: ReadResponse; keys: Set<string> }> {
	const answer = await harness.server.handleReadRequest({
		method: 'POST',
		authorization: `Bearer ${token}`,
		contentType: 'application/json',
		body: JSON.stringify({
			v: 1,
			schemaVersion: schema.version,
			queries: COLLECTIONS.map((collection) => ({
				key: collection,
				collection,
				where: {},
				orderBy: [],
			})),
		}),
	})
	expect(answer.status, answer.body).toBe(200)
	const response = JSON.parse(answer.body ?? '') as ReadResponse
	const keys = new Set<string>()
	for (const result of response.results) {
		// The invariant is about answers the server computed; `unsupported` is a client-SQL
		// superset by design and holds nothing the stream would not (checked the same way).
		for (const record of result.records) keys.add(`${result.key}/${record.id}`)
		for (const record of result.refreshed) keys.add(`${result.key}/${record.id}`)
	}
	return { response, keys }
}

const kinds = [
	{ name: 'memory', handle: null as { make: () => Promise<DeliveryStoreHandle> } | null },
	...deliveryStoreKinds()
		.filter((k) => k.name !== 'memory')
		.map((k) => ({ name: k.name, handle: k })),
]

const USERS = ['bob', 'ann'] as const

describe('a read is never more than the delivery stream would hold', () => {
	for (const kind of kinds) {
		test(`${kind.name}: after every action, read is a subset of the caught-up stream`, async () => {
			let reads = 0
			let nonEmpty = 0
			await fc.assert(
				fc.asyncProperty(fc.array(actionArb, { minLength: 1, maxLength: 14 }), async (actions) => {
					const handle = kind.handle ? await kind.handle.make() : null
					try {
						const harness = await createHarness(
							schema,
							auth,
							{},
							handle ? (handle.store as unknown as MemoryServerStore) : undefined,
						)
						const model = new Model(harness, harness.server.getKoraContext())
						for (const action of actions) {
							await model.play(action)
							await harness.settle()
							for (const user of USERS) {
								const { response, keys } = await readAll(harness, user)
								const device = await harness.login(user, `${user}-node-${reads}`, FRESH)
								const reference = held(device.messages)
								for (const key of keys) {
									expect(reference.has(key), `${user} read ${key} the stream does not hold`).toBe(
										true,
									)
								}
								expect(response.frontier).toBe(await harness.store.getMaxDeliverySequence())
								reads += 1
								if (keys.size > 0) nonEmpty += 1
							}
						}
					} finally {
						await handle?.done()
					}
				}),
				{ numRuns: kind.handle ? 10 : 30 },
			)
			// The property did not pass on empty answers alone.
			expect(reads).toBeGreaterThan(0)
			expect(nonEmpty).toBeGreaterThan(0)
		}, 480_000)

		test(`${kind.name}: no returned row reflects an operation after the frontier`, async () => {
			let checked = 0
			await fc.assert(
				fc.asyncProperty(
					fc.array(actionArb, { minLength: 1, maxLength: 8 }),
					fc.array(actionArb, { minLength: 1, maxLength: 8 }),
					async (before, during) => {
						const handle = kind.handle ? await kind.handle.make() : null
						try {
							const harness = await createHarness(
								schema,
								auth,
								{},
								handle ? (handle.store as unknown as MemoryServerStore) : undefined,
							)
							const model = new Model(harness, harness.server.getKoraContext())
							for (const action of before) await model.play(action)
							// The log changes right after the rows are read and before the frontier is.
							const store = harness.store as unknown as Record<string, unknown>
							const original = store.queryCollection as (...args: unknown[]) => Promise<unknown>
							let landed = false
							store.queryCollection = async (...args: unknown[]) => {
								const rows = await original.apply(harness.store, args)
								if (!landed) {
									landed = true
									for (const action of during) await model.play(action)
								}
								return rows
							}
							const { response } = await readAll(harness, 'bob')
							store.queryCollection = original
							const log = await harness.store.getOperationsAfterDelivery(0, 100_000)
							for (const result of response.results) {
								for (const record of [...result.records, ...result.refreshed]) {
									const newest = log.filter(
										(d) =>
											d.operation.collection === result.key &&
											d.operation.recordId === record.id &&
											d.operation.timestamp.wallTime === record.latest.wallTime &&
											d.operation.timestamp.logical === record.latest.logical &&
											d.operation.timestamp.nodeId === record.latest.nodeId,
									)
									expect(newest.length).toBeGreaterThan(0)
									for (const d of newest)
										expect(d.deliverySequence).toBeLessThanOrEqual(response.frontier)
									checked += 1
								}
							}
							expect(response.frontier).toBeLessThanOrEqual(
								await harness.store.getMaxDeliverySequence(),
							)
						} finally {
							await handle?.done()
						}
					},
				),
				{ numRuns: kind.handle ? 10 : 30 },
			)
			expect(checked).toBeGreaterThan(0)
		}, 480_000)
	}
})
