/**
 * The superset invariant of the delivery visibility index (C2.7), as a property over generated
 * logs: whatever the index leaves out, the session was not going to act on. A session that
 * reads through the index receives exactly the stream the global scan gives it, for the six
 * cases of `docs/design/fast-first-sync.md` ("What filterDeliveryChunk acts on"):
 *
 * 1. visible operations, 2. scope entries (a lesson moved into a school the user reads),
 * 3. retractions (moved out, or the school deleted), 4. own writes leaving the grant (the
 * source of the session's own node, covered by the access suites), 5. membership changes
 * (grants, revokes, a school transferred to or from the user, a school deleted or revived),
 * 6. the frontier (the delivered watermark is part of the compared stream).
 *
 * The access-rules fixture is a school system: schools are the groups, lessons and students
 * belong to a school, and a user reads the schools they are a member of. Every generated
 * scenario is played three ways, each once through the index and once through the global scan:
 * a device that catches up on the finished log; a device that stays connected while the log
 * changes (membership changes during sync); and a connected device whose push is in flight
 * when a whole burst of changes lands, so it reads a chunk under the previous grant.
 *
 * Runs on the memory store (or Postgres with KORA_REPRO_STORE=postgres) and on SQLite, whose
 * frontier persists, with a fourth mode where an older instance leaves the frontier stalled.
 */
import { fc } from '@fast-check/vitest'
import { defineSchema, member, memberOfKey, owner, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
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

/** What a client applies, in order, plus the watermark it ends at (case 6). */
function stream(messages: SyncMessage[]): string[] {
	const out: string[] = []
	let watermark = 0
	for (const m of messages) {
		if (m.type !== 'operation-batch') continue
		const batch = m as unknown as {
			operations: Array<{ type: string; collection: string; recordId: string }>
			retractions?: Array<{ collection: string; recordId: string }>
			accessNarrowing?: unknown
			maxDeliverySequence?: number
		}
		if (batch.accessNarrowing !== undefined)
			out.push(`narrow ${JSON.stringify(batch.accessNarrowing)}`)
		for (const r of batch.retractions ?? []) out.push(`retract ${r.collection}/${r.recordId}`)
		for (const op of batch.operations) out.push(`${op.type} ${op.collection}/${op.recordId}`)
		watermark = Math.max(watermark, batch.maxDeliverySequence ?? 0)
	}
	// The exact frontier the device ends at (case 6): an index read that skipped an
	// operation, or advanced past one, ends the stream at another sequence.
	out.push(`watermark ${watermark}`)
	return out
}

type Mode = 'catch-up' | 'live' | 'burst' | 'stalled'

/**
 * Plays the actions into a bob session, through the index or through the global scan.
 *
 * `stalled` (stores with a persistent frontier) lets an instance without the index append
 * the middle third of the actions, so the frontier stops there and the session reads the
 * index up to it and the global scan above it.
 */
async function run(
	mode: Mode,
	actions: Action[],
	useIndex: boolean,
	handle: DeliveryStoreHandle | null,
): Promise<{ lines: string[]; indexReads: number }> {
	const harness = await createHarness(
		schema,
		auth,
		{ batchSize: 2 },
		handle ? (handle.store as unknown as MemoryServerStore) : undefined,
	)
	const ctx = harness.server.getKoraContext()
	const model = new Model(harness, ctx)
	const store = harness.store as unknown as Record<string, unknown>
	const indexed = store.getOperationsAfterDeliveryIn as
		| ((...args: unknown[]) => Promise<unknown>)
		| undefined
	let indexReads = 0
	if (indexed) {
		store.getOperationsAfterDeliveryIn = useIndex
			? (...args: unknown[]) => {
					indexReads += 1
					return indexed.apply(harness.store, args)
				}
			: undefined
	}

	if (mode === 'stalled') {
		const plan = store.deliveryPlan
		const third = Math.floor(actions.length / 3)
		for (const [i, action] of actions.entries()) {
			store.deliveryPlan = i >= third && i < 2 * third ? null : plan
			await model.play(action)
		}
		store.deliveryPlan = plan
		const bob = await harness.login('bob', 'bob-node', FRESH)
		await harness.settle()
		return { lines: stream(bob.messages), indexReads }
	}

	if (mode === 'catch-up') {
		for (const action of actions) await model.play(action)
		const bob = await harness.login('bob', 'bob-node', FRESH)
		await harness.settle()
		return { lines: stream(bob.messages), indexReads }
	}

	const bob = await harness.login('bob', 'bob-node', FRESH)
	if (mode === 'live') {
		for (const action of actions) {
			await model.play(action)
			await harness.settle()
		}
		return { lines: stream(bob.messages), indexReads }
	}

	// burst: the session's push waits at its first read while every action lands.
	const method = useIndex ? 'getOperationsAfterDeliveryIn' : 'getOperationsAfterDelivery'
	const original = store[method] as (...args: unknown[]) => Promise<unknown>
	let release: () => void = () => {}
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})
	let reads = 0
	store[method] = async (...args: unknown[]) => {
		reads += 1
		if (reads === 1) await gate
		return original.apply(harness.store, args)
	}
	await ctx.apply({
		collection: 'lessons',
		type: 'insert',
		recordId: 'wake',
		data: { schoolId: 'none', title: 'x' },
	})
	await vi.waitFor(() => expect(reads).toBe(1))
	for (const action of actions) await model.play(action)
	release()
	await harness.settle()
	return { lines: stream(bob.messages), indexReads }
}

/**
 * Logs that once failed, replayed on every run whatever the seed. A lesson moved out of the
 * school bob reads and then deleted there: the global scan sends bob the delete (the lesson
 * was in his view earlier), so the index must file a delete under the partitions the record
 * was in before, not only under the one the delete's pre-image names.
 */
const REGRESSIONS: Action[][] = [
	[
		{ kind: 'grant', school: 's2', role: 'view' },
		{ kind: 'lesson', school: 's2' },
		{ kind: 'move', slot: 0, school: 's1' },
		{ kind: 'drop', slot: 0 },
	],
	// The same record moved through three schools before the delete, and bob reads the middle one.
	[
		{ kind: 'grant', school: 's2', role: 'view' },
		{ kind: 'lesson', school: 's1' },
		{ kind: 'move', slot: 0, school: 's2' },
		{ kind: 'move', slot: 0, school: 's3' },
		{ kind: 'drop', slot: 0 },
	],
]

const kinds = [
	{ name: process.env.KORA_REPRO_STORE === 'postgres' ? 'postgres' : 'memory', handle: null },
	...deliveryStoreKinds()
		.filter((k) => k.name === 'sqlite')
		.map((k) => ({ name: k.name, handle: k })),
]

interface Kind {
	name: string
	handle: { make: () => Promise<DeliveryStoreHandle> } | null
}

/** Plays the actions through the index and through the global scan, on fresh stores. */
async function playBoth(
	kind: Kind,
	mode: Mode,
	actions: Action[],
): Promise<{ through: { lines: string[]; indexReads: number }; scan: { lines: string[] } }> {
	const first = kind.handle ? await kind.handle.make() : null
	const second = kind.handle ? await kind.handle.make() : null
	try {
		return {
			through: await run(mode, actions, true, first),
			scan: await run(mode, actions, false, second),
		}
	} finally {
		await first?.done()
		await second?.done()
	}
}

describe('regression logs are served by the index and keep the delete', () => {
	// The logs that once failed, per mode: each asserts that the index served the read (a
	// fallback to the global scan would pass the comparison trivially) and that bob is sent the
	// delete of the lesson he once saw.
	for (const kind of kinds) {
		for (const mode of ['catch-up', 'live', 'burst', 'stalled'] as const) {
			if (mode === 'stalled' && kind.handle === null && kind.name === 'memory') continue
			for (const [i, actions] of REGRESSIONS.entries()) {
				test(`${kind.name} ${mode}: regression log ${i + 1}`, async () => {
					const { through, scan } = await playBoth(kind, mode, actions)
					expect(through.indexReads).toBeGreaterThan(0)
					expect(through.lines).toEqual(scan.lines)
					// Only a device that catches up is sent the delete of a lesson it saw (a connected
					// one was retracted it live), and only on a store whose live-view summary is
					// unknown for the record (the memory store keeps none): SQLite and Postgres
					// know the record had left bob's view before the delete and send nothing, so
					// the index omitting it there is correct. The comparison guards the rest.
					if (mode === 'catch-up' && kind.name === 'memory') {
						expect(scan.lines).toContain('delete lessons/l1')
						expect(through.lines).toContain('delete lessons/l1')
					}
				}, 120_000)
			}
		}
	}
})

describe('the delivery index is a superset of what a session acts on', () => {
	for (const kind of kinds) {
		for (const mode of ['catch-up', 'live', 'burst', 'stalled'] as const) {
			// A stalled frontier needs a store that keeps one between writes.
			if (mode === 'stalled' && kind.handle === null && kind.name === 'memory') continue
			test(`${kind.name} ${mode}: the stream equals the global scan's for generated logs`, async () => {
				let indexReads = 0
				const compare = async (actions: Action[]): Promise<void> => {
					const { through, scan } = await playBoth(kind, mode, actions)
					expect(through.lines).toEqual(scan.lines)
					indexReads += through.indexReads
				}
				await fc.assert(
					fc.asyncProperty(fc.array(actionArb, { minLength: 1, maxLength: 14 }), compare),
					{
						numRuns: kind.handle ? 15 : 40,
						examples: REGRESSIONS.map((actions) => [actions] as [Action[]]),
					},
				)
				// The property did not pass by never using the index.
				expect(indexReads).toBeGreaterThan(0)
			}, 480_000)
		}
	}
})
