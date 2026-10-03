import { type OperationTransform, defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { type TestNetwork, createMixedTestNetwork } from '../src/index'

const schemaV1 = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				done: t.boolean().default(false),
			},
		},
	},
})

const schemaV2 = defineSchema({
	version: 2,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				completed: t.boolean().default(false),
			},
		},
	},
})

const v1ToV2Transforms: OperationTransform[] = [
	{
		fromVersion: 1,
		toVersion: 2,
		transform(op) {
			return {
				...op,
				schemaVersion: 2,
				data: transformTodoRecord(op.data),
				previousData: transformTodoRecord(op.previousData),
			}
		},
	},
]

function transformTodoRecord(
	record: Record<string, unknown> | null,
): Record<string, unknown> | null {
	if (!record) {
		return null
	}
	const { done, ...rest } = record
	return 'done' in record ? { ...rest, completed: done } : rest
}

/**
 * Plan 2.3.5: v1 client ops sync through a v2 server; v2 client transforms and converges.
 */
describe('schema version cross-version sync', () => {
	let network: TestNetwork | null = null

	afterEach(async () => {
		if (network) {
			await network.close()
			network = null
		}
	})

	test('v1 insert on A materializes as v2 completed on B after sync', async () => {
		network = await createMixedTestNetwork(
			schemaV2,
			{
				schemaVersion: 2,
				supportedSchemaVersions: { min: 1, max: 2 },
				operationTransforms: v1ToV2Transforms,
			},
			[
				{ name: 'legacy-client', schema: schemaV1, syncSchemaVersion: 1 },
				{
					name: 'modern-client',
					schema: schemaV2,
					syncSchemaVersion: 2,
					operationTransforms: v1ToV2Transforms,
				},
			],
		)

		const [deviceA, deviceB] = network.devices
		await deviceA.collection('todos').insert({ title: 'Legacy task', done: true })
		await deviceA.sync()
		await deviceB.sync()

		const todosOnA = await deviceA.getState('todos')
		expect(todosOnA).toHaveLength(1)
		expect(todosOnA[0]?.done).toBe(true)

		const todosOnB = await deviceB.getState('todos')
		expect(todosOnB).toHaveLength(1)
		expect(todosOnB[0]?.completed).toBe(true)
		expect(todosOnB[0]?.title).toBe('Legacy task')
		expect('done' in (todosOnB[0] ?? {})).toBe(false)
	})

	test('CONCURRENT conflicting edits across schema versions converge without data loss', async () => {
		network = await createMixedTestNetwork(
			schemaV2,
			{
				schemaVersion: 2,
				supportedSchemaVersions: { min: 1, max: 2 },
				operationTransforms: v1ToV2Transforms,
			},
			[
				{ name: 'legacy-client', schema: schemaV1, syncSchemaVersion: 1 },
				{
					name: 'modern-client',
					schema: schemaV2,
					syncSchemaVersion: 2,
					operationTransforms: v1ToV2Transforms,
				},
			],
		)

		const [legacy, modern] = network.devices

		// Seed from the legacy device and get both clients onto the record.
		const created = await legacy.collection('todos').insert({ title: 'shared', done: false })
		await legacy.sync()
		await modern.sync()
		await legacy.sync()

		const seededOnModern = await modern.collection('todos').findById(created.id)
		expect(seededOnModern?.title).toBe('shared')

		// Concurrent CONFLICTING edits: legacy contends on title AND flips its
		// renamed boolean; modern contends on title. The transform runs on the
		// modern side while the conflict is live — a transformed op must still
		// resolve per-field like a native one.
		await legacy.collection('todos').update(created.id, { title: 'from legacy', done: true })
		await modern.collection('todos').update(created.id, { title: 'from modern' })

		await legacy.sync()
		await modern.sync()
		await legacy.sync()
		await modern.sync()

		// Both devices agree on the title winner (each in its own schema's shape).
		const onLegacy = await legacy.collection('todos').findById(created.id)
		const onModern = await modern.collection('todos').findById(created.id)
		expect(onLegacy?.title).toBe(onModern?.title)
		expect(['from legacy', 'from modern']).toContain(onModern?.title)

		// The boolean flip (renamed done -> completed by the transform) was only
		// touched by the legacy device — it must survive regardless of who won
		// the title contest.
		expect(onLegacy?.done).toBe(true)
		expect(onModern?.completed).toBe(true)
	}, 30000)

	test("RT-84: old-schema clients receive each other's operations exactly as written", async () => {
		network = await createMixedTestNetwork(
			schemaV2,
			{
				schemaVersion: 2,
				supportedSchemaVersions: { min: 1, max: 2 },
				operationTransforms: v1ToV2Transforms,
			},
			[
				{ name: 'legacy-a', schema: schemaV1, syncSchemaVersion: 1 },
				{ name: 'legacy-b', schema: schemaV1, syncSchemaVersion: 1 },
				{
					name: 'modern',
					schema: schemaV2,
					syncSchemaVersion: 2,
					operationTransforms: v1ToV2Transforms,
				},
			],
		)
		const [legacyA, legacyB, modern] = network.devices
		const created = await legacyA.collection('todos').insert({ title: 'from a', done: true })
		await legacyA.collection('todos').update(created.id, { done: false, title: 'edited' })
		await legacyA.sync()
		await legacyB.sync()
		await modern.sync()

		// Before transforms ran at fold time the server stored (and delivered) the v2
		// rewrite, which a v1 client cannot read; now it delivers the original.
		expect(await legacyB.collection('todos').findById(created.id)).toMatchObject({
			title: 'edited',
			done: false,
		})
		expect(await modern.collection('todos').findById(created.id)).toMatchObject({
			title: 'edited',
			completed: false,
		})
		const written = await legacyA.store.getOperationsForRecord('todos', created.id)
		const stored = await network.server.store.getRecordOperations?.('todos', created.id)
		expect(stored?.map((op) => op.id).sort()).toEqual(written.map((op) => op.id).sort())
		for (const op of written) {
			expect(stored?.find((candidate) => candidate.id === op.id)?.data).toEqual(op.data)
		}
		// Nothing was quarantined or refused anywhere.
		for (const device of network.devices) {
			expect(await device.getSyncEngine()?.getQuarantinedOperations()).toEqual([])
		}
	}, 30000)
})
