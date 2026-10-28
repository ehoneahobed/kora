/**
 * Partition derivation for the delivery visibility index (C2.1): `P(c)` covers every
 * field the scope and the access read filter can read, keys are stable, and an operation
 * is always filed where a session that may act on it looks.
 */
import { fc } from '@fast-check/vitest'
import type { AccessRule, SchemaDefinition } from '@korajs/core'
import {
	and,
	anyone,
	buildScopeMap,
	defineSchema,
	member,
	memberOfKey,
	or,
	owner,
	t,
	where,
} from '@korajs/core'
import {
	compileAccessGrant,
	createMembershipView,
	recordMatchesCollectionScope,
	scopeBranches,
	scopeFieldNames,
} from '@korajs/core/internal'
import type { CollectionScope } from '@korajs/core/internal'
import { afterAll, describe, expect, test } from 'vitest'
import { deliveryStoreKinds, removeDeliveryTempFiles } from '../../tests/fixtures/delivery-stores'
import {
	accessRuleFields,
	deliverySourcesForScope,
	deriveDeliveryPartitionPlan,
	mergeSequences,
	partitionKey,
	partitionKeysOf,
	unknownPartitionKey,
} from './delivery-partitions'
import type { OperationScopeSnapshot } from './server-store'

afterAll(removeDeliveryTempFiles)

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
		cards: {
			fields: { board: t.string(), title: t.string(), status: t.string().optional() },
			access: {
				read: or(member('board', 'view', { group: 'boards' }), where({ status: 'public' })),
			},
		},
		notes: {
			fields: { body: t.string(), schoolId: t.string() },
			scope: ['schoolId'],
		},
		logs: { fields: { line: t.string() } },
	},
})

describe('deriveDeliveryPartitionPlan', () => {
	test('collects scope fields, read-rule fields, memberships and group fields', () => {
		const plan = deriveDeliveryPartitionPlan(accessSchema)
		expect(plan.fields.get('members')).toEqual(['group', 'userId'])
		// The group collection: its `id` (deletion, restore, revival) and its owner field.
		expect(plan.fields.get('boards')).toEqual(['id', 'ownerId'])
		expect(plan.fields.get('cards')).toEqual(['board', 'status'])
		expect(plan.fields.get('notes')).toEqual(['schoolId'])
		// No partition field: read whole through idx_collection_delivery.
		expect(plan.fields.has('logs')).toBe(false)
	})

	test('sync rules name record fields through their bindings', () => {
		const schema = defineSchema({
			version: 1,
			collections: { lessons: { fields: { title: t.string(), school: t.string() } } },
			sync: { lessons: { where: { school: 'orgId' } } },
		})
		expect(deriveDeliveryPartitionPlan(schema).fields.get('lessons')).toEqual(['school'])
	})

	test('overrides add fields the schema does not declare, and change the fingerprint', () => {
		const base = deriveDeliveryPartitionPlan(accessSchema)
		const extended = deriveDeliveryPartitionPlan(accessSchema, {
			logs: ['tenant'],
			notes: ['grade'],
		})
		expect(extended.fields.get('logs')).toEqual(['tenant'])
		expect(extended.fields.get('notes')).toEqual(['grade', 'schoolId'])
		expect(extended.fingerprint).not.toBe(base.fingerprint)
		expect(deriveDeliveryPartitionPlan(accessSchema).fingerprint).toBe(base.fingerprint)
	})

	test('the fingerprint follows the scalar fields snapshots capture', () => {
		const wider = defineSchema({
			version: 1,
			collections: {
				notes: {
					fields: { body: t.string(), schoolId: t.string(), grade: t.string() },
					scope: ['schoolId'],
				},
			},
		})
		const narrower = defineSchema({
			version: 1,
			collections: {
				notes: { fields: { body: t.string(), schoolId: t.string() }, scope: ['schoolId'] },
			},
		})
		expect(deriveDeliveryPartitionPlan(wider).fingerprint).not.toBe(
			deriveDeliveryPartitionPlan(narrower).fingerprint,
		)
	})
})

describe('partition keys', () => {
	test('are signed 64-bit integers, stable and distinct per collection, field and value', () => {
		const a = partitionKey('notes', 'schoolId', 's1')
		expect(a).toBe(partitionKey('notes', 'schoolId', 's1'))
		expect(BigInt.asIntN(64, a)).toBe(a)
		const others = [
			partitionKey('notes', 'schoolId', 's2'),
			partitionKey('notes', 'grade', 's1'),
			partitionKey('cards', 'schoolId', 's1'),
			// A number and its string are different values.
			partitionKey('notes', 'schoolId', 1),
			partitionKey('notes', 'schoolId', '1'),
			unknownPartitionKey('notes'),
		]
		expect(new Set([a, ...others]).size).toBe(others.length + 1)
	})

	test('an operation is filed under its pre and post values, and unknown when it cannot be placed', () => {
		const plan = deriveDeliveryPartitionPlan(accessSchema)
		const move: OperationScopeSnapshot = {
			pre: { id: 'n1', schoolId: 'a' },
			post: { id: 'n1', schoolId: 'b' },
		}
		expect(partitionKeysOf(plan, 'notes', move).sort()).toEqual(
			[partitionKey('notes', 'schoolId', 'a'), partitionKey('notes', 'schoolId', 'b')].sort(),
		)
		// A first insert has no pre image: nothing to retract.
		expect(
			partitionKeysOf(plan, 'notes', { pre: null, post: { id: 'n1', schoolId: 'a' } }),
		).toEqual([partitionKey('notes', 'schoolId', 'a')])
		// No snapshot (a legacy row), an unknown post image, a snapshot gap.
		const unknown = unknownPartitionKey('notes')
		expect(partitionKeysOf(plan, 'notes', null)).toEqual([unknown])
		expect(partitionKeysOf(plan, 'notes', { pre: null, post: null })).toContain(unknown)
		expect(partitionKeysOf(plan, 'notes', { pre: null, post: { id: 'n1', body: 'x' } })).toEqual([
			unknown,
		])
		// An over-long string is recorded as null and indexed under null.
		expect(
			partitionKeysOf(plan, 'notes', { pre: null, post: { id: 'n1', schoolId: null } }),
		).toEqual([partitionKey('notes', 'schoolId', null)])
		// A collection without partition fields needs no rows.
		expect(partitionKeysOf(plan, 'logs', { pre: null, post: { id: 'l1' } })).toEqual([])
	})
})

describe('mergeSequences', () => {
	test('merges ascending lists without duplicates up to the limit', () => {
		expect(mergeSequences([[1, 4, 9], [2, 4, 5], [], [9, 10]], 10)).toEqual([1, 2, 4, 5, 9, 10])
		expect(
			mergeSequences(
				[
					[1, 4, 9],
					[2, 4, 5],
				],
				3,
			),
		).toEqual([1, 2, 4])
		expect(mergeSequences([], 3)).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// Property: P(c) covers every field the filter reads
// ---------------------------------------------------------------------------

const FIELDS = ['f1', 'f2', 'f3', 'f4'] as const
const fieldArb = fc.constantFrom(...FIELDS)

/** Read rules over a collection `items` with string fields f1..f4 and a group collection `groups`. */
const ruleArb: fc.Arbitrary<AccessRule> = fc.letrec<{ rule: AccessRule }>((tie) => ({
	rule: fc.oneof(
		{ depthSize: 'small', maxDepth: 2 },
		fieldArb.map((f) => owner(f)),
		fieldArb.map((f) => member(f, 'view', { group: 'groups' })),
		fieldArb.map((f) => memberOfKey(f)),
		fc
			.array(fieldArb, { minLength: 1, maxLength: 2 })
			.map((fs) => where(Object.fromEntries(fs.map((f) => [f, 'v'])))),
		fc.constant(anyone()),
		fc.array(tie('rule'), { minLength: 1, maxLength: 2 }).map((rs) => or(...rs)),
		fc.array(tie('rule'), { minLength: 1, maxLength: 2 }).map((rs) => and(...rs)),
	),
})).rule

function schemaWithRule(rule: AccessRule): SchemaDefinition | null {
	try {
		return defineSchema({
			version: 1,
			access: {
				memberships: 'members',
				roles: ['view', 'edit'],
				groups: { groups: { owner: 'ownerId', role: 'edit' } },
			},
			collections: {
				members: {
					fields: { userId: t.string(), group: t.string(), role: t.string() },
					access: { read: memberOfKey('group') },
				},
				groups: {
					fields: { name: t.string(), ownerId: t.string().stamp('userId') },
					access: { read: member('id') },
				},
				items: {
					fields: Object.fromEntries(FIELDS.map((f) => [f, t.string().optional()])),
					access: { read: rule },
				},
			},
		})
	} catch {
		// A generated rule `defineSchema` refuses (too many branches): not a case to judge.
		return null
	}
}

describe('P(c) covers every field the read filter reads', () => {
	test('any access read rule, for any user and memberships', () => {
		let judged = 0
		fc.assert(
			fc.property(
				ruleArb,
				fc.array(fc.constantFrom('groups:g1', 'groups:g2', 'groups:g3'), { maxLength: 3 }),
				(rule, groupKeys) => {
					const schema = schemaWithRule(rule)
					if (!schema?.access) return true
					judged += 1
					const plan = deriveDeliveryPartitionPlan(schema)
					const rows = groupKeys.map((group) => ({ userId: 'u1', group, role: 'edit' }))
					const grant = compileAccessGrant(schema.access, {
						user: { userId: 'u1' },
						memberships: createMembershipView(rows, 'u1', schema.access.roles, 0),
					})
					for (const [collection, scope] of Object.entries(grant)) {
						const partitioned = new Set(plan.fields.get(collection) ?? [])
						for (const field of scopeFieldNames(scope as CollectionScope)) {
							if (!partitioned.has(field)) return false
						}
					}
					return true
				},
			),
			{ numRuns: 300 },
		)
		// Not vacuous: most generated rules are valid schemas.
		expect(judged).toBeGreaterThan(150)
	})

	test('the rule walker names exactly the fields a compiled scope can constrain', () => {
		fc.assert(
			fc.property(ruleArb, (rule) => {
				const named = new Set<string>()
				accessRuleFields(rule, named)
				// A grant with every group held is the widest scope the rule compiles to.
				const schema = schemaWithRule(rule)
				if (!schema?.access) return true
				const rows = ['groups:g1', 'groups:g2'].map((group) => ({
					userId: 'u1',
					group,
					role: 'edit',
				}))
				const scope = compileAccessGrant(schema.access, {
					user: { userId: 'u1' },
					memberships: createMembershipView(rows, 'u1', schema.access.roles, 0),
				}).items
				return (
					scope === undefined ||
					scopeFieldNames(scope as CollectionScope).every((f) => named.has(f))
				)
			}),
			{ numRuns: 300 },
		)
	})

	test('the memberships and group collections cover what the membership cases read', () => {
		const plan = deriveDeliveryPartitionPlan(accessSchema)
		// operationTouchesMemberships: a membership row naming the user (userId), a group the
		// user owns now or owned (owner pre/post), deletion or revival of a held group (id).
		expect(plan.fields.get('members')).toEqual(expect.arrayContaining(['userId', 'group']))
		expect(plan.fields.get('boards')).toEqual(expect.arrayContaining(['id', 'ownerId']))
	})

	test('provider scopes built from schema bindings and claims', () => {
		fc.assert(
			fc.property(fc.record({ schoolId: fc.string(), other: fc.string() }), (claims) => {
				const plan = deriveDeliveryPartitionPlan(accessSchema)
				const map = buildScopeMap(accessSchema, claims)
				for (const [collection, scope] of Object.entries(map)) {
					const partitioned = new Set(plan.fields.get(collection) ?? [])
					for (const field of Object.keys(scope)) {
						if (!partitioned.has(field)) return false
					}
				}
				return true
			}),
		)
	})

	test('a scope on a field outside P(c) is a reported miss and reads the collection whole', () => {
		const plan = deriveDeliveryPartitionPlan(accessSchema)
		const { sources, misses } = deliverySourcesForScope(plan, 'notes', { grade: 'g1' })
		expect(misses).toEqual([{ collection: 'notes', field: 'grade' }])
		expect(sources).toEqual({ partitionKeys: [], collections: ['notes'], nodeIds: [] })
		// Declared through `deliveryPartitions`, it is a partitioned read.
		const declared = deriveDeliveryPartitionPlan(accessSchema, { notes: ['grade'] })
		const fine = deliverySourcesForScope(declared, 'notes', { grade: 'g1' })
		expect(fine.misses).toEqual([])
		expect(fine.sources.collections).toEqual([])
		expect(fine.sources.partitionKeys).toContain(partitionKey('notes', 'grade', 'g1'))
	})
})

// ---------------------------------------------------------------------------
// Property: a record the scope admits is found through the sources
// ---------------------------------------------------------------------------

describe('sources derived from a scope find every operation the scope can act on', () => {
	const plan = deriveDeliveryPartitionPlan(accessSchema, { notes: ['grade'] })
	const valueArb = fc.constantFrom('a', 'b', 'c', null)
	const imageArb = fc.option(
		fc
			.record({ schoolId: valueArb, grade: valueArb }, { requiredKeys: [] })
			.map((v) => ({ id: 'n1', ...v })),
		{ nil: null },
	)
	const predicateArb = fc.oneof(
		fc.constantFrom('a', 'b'),
		fc
			.array(fc.constantFrom('a', 'b', 'c'), { minLength: 1, maxLength: 3 })
			.map((values) => ({ $in: values })),
	)
	const branchArb = fc.record({ schoolId: predicateArb, grade: predicateArb }, { requiredKeys: [] })
	const scopeArb: fc.Arbitrary<CollectionScope> = fc.oneof(
		branchArb,
		fc.array(branchArb, { minLength: 1, maxLength: 3 }).map((branches) => ({ $or: branches })),
	)

	test('pre image (retraction) or post image (visibility) inside the scope implies a source hit', () => {
		fc.assert(
			fc.property(imageArb, imageArb, scopeArb, (pre, post, scope) => {
				const snapshot: OperationScopeSnapshot = { pre, post }
				const keys = new Set(partitionKeysOf(plan, 'notes', snapshot).map(String))
				const { sources } = deliverySourcesForScope(plan, 'notes', scope)
				const found =
					sources.collections.includes('notes') ||
					sources.partitionKeys.some((key) => keys.has(String(key)))
				const acts =
					(post !== null && recordMatchesCollectionScope(post, scope)) ||
					(pre !== null && recordMatchesCollectionScope(pre, scope))
				return !acts || found
			}),
			{ numRuns: 1000 },
		)
	})

	test('a legacy operation without a snapshot is found by every partitioned read', () => {
		fc.assert(
			fc.property(scopeArb, (scope) => {
				const keys = new Set(partitionKeysOf(plan, 'notes', null).map(String))
				const { sources } = deliverySourcesForScope(plan, 'notes', scope)
				return (
					scopeBranches(scope).length === 0 ||
					sources.collections.includes('notes') ||
					sources.partitionKeys.some((key) => keys.has(String(key)))
				)
			}),
		)
	})
})

// ---------------------------------------------------------------------------
// The fingerprint reaches the store
// ---------------------------------------------------------------------------

for (const kind of deliveryStoreKinds()) {
	describe(`fingerprint in the store: ${kind.name}`, () => {
		test('is recorded with the schema and follows the deliveryPartitions overrides', async () => {
			const handle = await kind.make()
			try {
				await handle.store.setSchema(accessSchema)
				const plan = deriveDeliveryPartitionPlan(accessSchema)
				const state = await handle.store.getDeliveryPartitionState?.()
				expect(state?.planFingerprint).toBe(plan.fingerprint)
				expect(state?.fingerprint).toBe(plan.fingerprint)

				await handle.store.setDeliveryPartitions?.({ notes: ['grade'] })
				const changed = await handle.store.getDeliveryPartitionState?.()
				const extended = deriveDeliveryPartitionPlan(accessSchema, { notes: ['grade'] })
				expect(changed?.planFingerprint).toBe(extended.fingerprint)
				expect(changed?.fingerprint).toBe(extended.fingerprint)
			} finally {
				await handle.done()
			}
		})

		test('overrides given with the schema are part of the plan', async () => {
			const handle = await kind.make()
			try {
				await handle.store.setSchema(accessSchema, { deliveryPartitions: { logs: ['tenant'] } })
				expect((await handle.store.getDeliveryPartitionState?.())?.planFingerprint).toBe(
					deriveDeliveryPartitionPlan(accessSchema, { logs: ['tenant'] }).fingerprint,
				)
			} finally {
				await handle.done()
			}
		})
	})
}
