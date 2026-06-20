import { type OperationTransform, defineSchema, t } from '@korajs/core'
import { createMixedTestNetwork } from '@korajs/test'
import { afterEach, describe, expect, test } from 'vitest'

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
 * PRODUCTION_PATH: v1 client + v2 server + transforms on modern client.
 */
describe('PRODUCTION_PATH schema version sync', () => {
	let network: Awaited<ReturnType<typeof createMixedTestNetwork>> | null = null

	afterEach(async () => {
		if (network) {
			await network.close()
			network = null
		}
	})

	test('v1 legacy insert converges on v2 peer with operation transforms', async () => {
		network = await createMixedTestNetwork(
			schemaV2,
			{ schemaVersion: 2, supportedSchemaVersions: { min: 1, max: 2 } },
			[
				{ name: 'legacy', schema: schemaV1, syncSchemaVersion: 1 },
				{
					name: 'modern',
					schema: schemaV2,
					syncSchemaVersion: 2,
					operationTransforms: v1ToV2Transforms,
				},
			],
		)

		const legacy = network.devices[0]
		const modern = network.devices[1]
		if (!legacy || !modern) {
			throw new Error('expected legacy and modern devices')
		}
		await legacy.collection('todos').insert({ title: 'Ship v2', done: true })
		await legacy.sync()
		await modern.sync()

		const todos = await modern.getState('todos')
		expect(todos).toHaveLength(1)
		expect(todos[0]?.completed).toBe(true)
		expect(todos[0]?.title).toBe('Ship v2')
	})
})
