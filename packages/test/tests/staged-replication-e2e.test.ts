/**
 * First-visit parity S3 against a real sync server: a device that joins a large history
 * through the staged path ends exactly as one that joins through the direct path, with
 * encrypted operations, schema transforms, deletes and concurrent writes. Both joiners
 * receive the same delivery stream from the same server.
 */
import { type OperationTransform, defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import {
	type TestDevice,
	type TestNetwork,
	createMixedTestNetwork,
	createTestNetwork,
} from '../src/index'

let network: TestNetwork | null = null
afterEach(async () => {
	await network?.close()
	network = null
})

interface JoinerState {
	rows: Record<string, unknown>[]
	versionVector: Array<[string, number]>
	watermark: number
	quarantine: string[]
	foldStates: number
}

async function joinerState(device: TestDevice, collection: string): Promise<JoinerState> {
	const rows = (await device.getState(collection)).sort((a, b) =>
		String((a as { id: string }).id).localeCompare(String((b as { id: string }).id)),
	)
	return {
		rows,
		versionVector: [...device.store.getVersionVector()].sort((a, b) => a[0].localeCompare(b[0])),
		watermark: await device.store.loadDeliveryWatermark(''),
		quarantine: (await device.store.loadInboundQuarantine()).map((e) => e.operation.id).sort(),
		foldStates: (
			await (
				device.store as unknown as { adapter: { query<T>(sql: string): Promise<T[]> } }
			).adapter.query<{ n: number }>('SELECT COUNT(*) AS n FROM _kora_fold_state')
		)[0]?.n as number,
	}
}

function stagingEvents(device: TestDevice): string[] {
	const seen: string[] = []
	device.emitter.on('sync:staging-started', () => seen.push('started'))
	device.emitter.on('sync:staging-merged', () => seen.push('merged'))
	device.emitter.on('sync:staging-discarded', () => seen.push('discarded'))
	return seen
}

const schema = defineSchema({
	version: 1,
	collections: {
		notes: { fields: { title: t.string(), body: t.string().optional(), rank: t.number() } },
		tags: { fields: { label: t.string() } },
	},
})

const encryption = {
	config: { enabled: true, key: 'correct horse battery staple' },
	salt: new Uint8Array(16).fill(7),
	iterations: 1_000,
}

describe('a staged joiner equals a direct joiner on a real server', () => {
	test('encrypted history with deletes and concurrent writes', async () => {
		network = await createTestNetwork(schema, {
			devices: 4,
			encryption,
			bulkReplication: (name) => (name === 'device-2' ? { minOperations: 0 } : false),
		})
		const [a, b, staged, direct] = network.devices as [
			TestDevice,
			TestDevice,
			TestDevice,
			TestDevice,
		]
		await a.sync()
		await b.sync()
		const notes = a.collection('notes')
		const ids: string[] = []
		for (let i = 0; i < 150; i++) {
			const note = (await notes.insert({ title: `n${i}`, rank: i })) as { id: string }
			ids.push(note.id)
		}
		await a.collection('tags').insert({ label: 'x' })
		await a.sync()
		await b.sync()
		// Concurrent edits to the same records from both devices, then deletes.
		for (let i = 0; i < 150; i += 3) {
			await a.collection('notes').update(ids[i] as string, { title: `a-${i}`, rank: i + 1000 })
			await b.collection('notes').update(ids[i] as string, { title: `b-${i}`, body: `b${i}` })
		}
		for (let i = 1; i < 150; i += 10) await b.collection('notes').delete(ids[i] as string)
		await a.sync()
		await b.sync()
		await a.sync()
		await b.sync()

		const events = stagingEvents(staged)
		await staged.sync()
		await direct.sync()
		await staged.sync()
		await direct.sync()
		expect(events).toEqual(['started', 'merged'])
		const [s, d] = [await joinerState(staged, 'notes'), await joinerState(direct, 'notes')]
		expect(s.rows.length).toBeGreaterThan(100)
		expect(s).toEqual(d)
		expect(await joinerState(staged, 'tags')).toEqual(await joinerState(direct, 'tags'))
		// And both equal the authors (the stream is the whole history).
		expect((await a.getState('notes')).length).toBe(s.rows.length)
	}, 120_000)

	test('operations of an older schema version are transformed at fold time on both paths', async () => {
		const schemaV1 = defineSchema({
			version: 1,
			collections: { todos: { fields: { title: t.string(), done: t.boolean().default(false) } } },
		})
		const schemaV2 = defineSchema({
			version: 2,
			collections: {
				todos: { fields: { title: t.string(), completed: t.boolean().default(false) } },
			},
		})
		const transforms: OperationTransform[] = [
			{
				fromVersion: 1,
				toVersion: 2,
				transform(op) {
					const rename = (
						record: Record<string, unknown> | null,
					): Record<string, unknown> | null => {
						if (!record) return null
						const { done, ...rest } = record
						return 'done' in record ? { ...rest, completed: done } : rest
					}
					return {
						...op,
						schemaVersion: 2,
						data: rename(op.data),
						previousData: rename(op.previousData),
					}
				},
			},
		]
		network = await createMixedTestNetwork(
			schemaV2,
			{
				schemaVersion: 2,
				supportedSchemaVersions: { min: 1, max: 2 },
				operationTransforms: transforms,
			},
			[
				{ name: 'legacy', schema: schemaV1, syncSchemaVersion: 1 },
				{ name: 'modern', schema: schemaV2, syncSchemaVersion: 2, operationTransforms: transforms },
				{
					name: 'staged',
					schema: schemaV2,
					syncSchemaVersion: 2,
					operationTransforms: transforms,
					bulkReplication: { minOperations: 0 },
				},
				{
					name: 'direct',
					schema: schemaV2,
					syncSchemaVersion: 2,
					operationTransforms: transforms,
					bulkReplication: false,
				},
			],
		)
		const [legacy, modern, staged, direct] = network.devices as [
			TestDevice,
			TestDevice,
			TestDevice,
			TestDevice,
		]
		const ids: string[] = []
		for (let i = 0; i < 130; i++) {
			const todo = (await legacy
				.collection('todos')
				.insert({ title: `t${i}`, done: i % 2 === 0 })) as {
				id: string
			}
			ids.push(todo.id)
		}
		await legacy.sync()
		await modern.sync()
		for (let i = 0; i < 130; i += 4)
			await modern.collection('todos').update(ids[i] as string, { completed: true })
		await modern.sync()
		await legacy.sync()
		const events = stagingEvents(staged)
		await staged.sync()
		await direct.sync()
		await staged.sync()
		await direct.sync()
		expect(events).toEqual(['started', 'merged'])
		const [s, d] = [await joinerState(staged, 'todos'), await joinerState(direct, 'todos')]
		expect(s.rows).toHaveLength(130)
		expect(s).toEqual(d)
		expect(s.rows.some((row) => (row as { completed: boolean }).completed === true)).toBe(true)
	}, 120_000)
})
