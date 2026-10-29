/**
 * The source set of an indexed read (C2.5): collapsing keeps it a superset, and the
 * membership sources name one key per case of `operationTouchesMemberships`.
 */
import { defineSchema, member, memberOfKey, t } from '@korajs/core'
import { groupKey } from '@korajs/core/internal'
import { describe, expect, test } from 'vitest'
import {
	DeliverySourceBuilder,
	MAX_DELIVERY_SOURCES,
	addMembershipSources,
	addScopeSources,
	deriveDeliveryPartitionPlan,
	partitionKey,
	tombstonePartitionKeysOf,
	unknownPartitionKey,
} from './delivery-partitions'

const schema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'edit'],
		groups: { schools: { owner: 'ownerId', role: 'edit' } },
	},
	collections: {
		members: {
			fields: { userId: t.string(), group: t.string(), role: t.string() },
			access: { read: memberOfKey('group') },
		},
		schools: {
			fields: { name: t.string(), ownerId: t.string().stamp('userId') },
			access: { read: member('id') },
		},
		lessons: {
			fields: { schoolId: t.string(), title: t.string() },
			access: { read: member('schoolId', 'view', { group: 'schools' }) },
		},
		logs: { fields: { line: t.string() } },
	},
})
if (!schema.access) throw new Error('the fixture schema declares access rules')
const access = schema.access
const plan = deriveDeliveryPartitionPlan(schema)

const keysOf = (b: DeliverySourceBuilder): string[] =>
	(b.build()?.partitionKeys ?? []).map((k) => k.toString()).sort()

describe('DeliverySourceBuilder', () => {
	test('deduplicates keys and drops the keys of a collection read whole', () => {
		const builder = new DeliverySourceBuilder()
		builder.addKey('lessons', 1n)
		builder.addKey('lessons', 1n)
		builder.addKey('lessons', 2n)
		builder.addNode('n1')
		builder.addNode('n1')
		expect(builder.build()).toEqual({
			partitionKeys: [1n, 2n],
			collections: [],
			nodeIds: ['n1'],
		})
		builder.addCollection('lessons')
		builder.addKey('lessons', 3n)
		expect(builder.build()).toEqual({
			partitionKeys: [],
			collections: ['lessons'],
			nodeIds: ['n1'],
		})
	})

	test('collapses the widest collection to a whole read until the sources fit', () => {
		const builder = new DeliverySourceBuilder()
		for (let i = 0; i < 300; i++) builder.addKey('lessons', BigInt(i))
		for (let i = 0; i < 10; i++) builder.addKey('schools', BigInt(1000 + i))
		builder.addNode('n1')
		const sources = builder.build(MAX_DELIVERY_SOURCES)
		// Lessons collapse (still a superset of their keys); the narrower schools keep theirs.
		expect(sources?.collections).toEqual(['lessons'])
		expect(sources?.partitionKeys).toHaveLength(10)
		expect(sources?.nodeIds).toEqual(['n1'])
	})

	test('gives up (the global scan) when whole collections alone are too many', () => {
		const builder = new DeliverySourceBuilder()
		for (let i = 0; i < 5; i++) builder.addCollection(`c${i}`)
		expect(builder.build(4)).toBeNull()
	})
})

describe('addScopeSources', () => {
	test('files a field the plan lacks as a collection read and reports the miss', () => {
		const builder = new DeliverySourceBuilder()
		const misses = addScopeSources(builder, plan, 'logs', { line: 'x' })
		expect(misses).toEqual([{ collection: 'logs', field: 'line' }])
		expect(builder.build()?.collections).toEqual(['logs'])
	})

	test('an $in grant gives one key per value plus the unknown key', () => {
		const builder = new DeliverySourceBuilder()
		addScopeSources(builder, plan, 'lessons', { schoolId: { $in: ['a', 'b'] } })
		expect(keysOf(builder)).toEqual(
			[
				partitionKey('lessons', 'schoolId', 'a'),
				partitionKey('lessons', 'schoolId', 'b'),
				unknownPartitionKey('lessons'),
			]
				.map((k) => k.toString())
				.sort(),
		)
	})
})

describe('tombstonePartitionKeysOf', () => {
	const lesson = (schoolId: string, deleted?: boolean) => ({
		pre: { id: 'l1', schoolId },
		post: { id: 'l1', schoolId },
		...(deleted === undefined ? {} : { deleted }),
	})
	const keyStrings = (keys: bigint[]): string[] => keys.map((k) => k.toString()).sort()

	test('a delete is also filed under the partitions the record was in before', () => {
		const keys = tombstonePartitionKeysOf(plan, 'lessons', lesson('s1', true), [
			lesson('s2', false),
			null,
		])
		const expected = [
			partitionKey('lessons', 'schoolId', 's1'),
			partitionKey('lessons', 'schoolId', 's2'),
			unknownPartitionKey('lessons'),
		]
		expect(keyStrings(keys)).toEqual(keyStrings(expected))
	})

	test('an operation after which the record is live keeps only its own keys', () => {
		const keys = tombstonePartitionKeysOf(plan, 'lessons', lesson('s1', false), [lesson('s2')])
		expect(keyStrings(keys)).toEqual(keyStrings([partitionKey('lessons', 'schoolId', 's1')]))
	})
})

describe('addMembershipSources', () => {
	test('names one key per case of operationTouchesMemberships', () => {
		const builder = new DeliverySourceBuilder()
		addMembershipSources(builder, plan, access, 'bob', [groupKey('schools', 's1')])
		const expected = [
			// a membership row naming the user
			partitionKey('members', 'userId', 'bob'),
			unknownPartitionKey('members'),
			// a group the user owns, or is made owner of (transferred to a user who held nothing)
			partitionKey('schools', 'ownerId', 'bob'),
			unknownPartitionKey('schools'),
			// the deletion, restore or revival of a group the user holds
			partitionKey('schools', 'id', 's1'),
		]
		expect(keysOf(builder)).toEqual(expected.map((k) => k.toString()).sort())
	})

	test('an anonymous session has no user keys, only the groups of its capability grants', () => {
		const builder = new DeliverySourceBuilder()
		addMembershipSources(builder, plan, access, null, [groupKey('schools', 's9')])
		expect(keysOf(builder)).toEqual(
			[partitionKey('schools', 'id', 's9'), unknownPartitionKey('schools')]
				.map((k) => k.toString())
				.sort(),
		)
	})

	test('ignores group keys of collections that are not groups', () => {
		const builder = new DeliverySourceBuilder()
		addMembershipSources(builder, plan, access, 'bob', [groupKey('lessons', 'x'), 'not-a-key'])
		expect(keysOf(builder)).not.toContain(partitionKey('lessons', 'id', 'x').toString())
	})
})
