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
			const data = op.data ?? {}
			const { done, ...rest } = data as { done?: boolean; title?: string }
			return {
				...op,
				schemaVersion: 2,
				data: { ...rest, completed: done ?? false },
			}
		},
	},
]

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
			{ schemaVersion: 2, supportedSchemaVersions: { min: 1, max: 2 } },
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
			{ schemaVersion: 2, supportedSchemaVersions: { min: 1, max: 2 } },
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
})
