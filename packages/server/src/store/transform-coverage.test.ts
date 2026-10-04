import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type Operation,
	type OperationTransform,
	OperationTransformCoverageError,
	type SchemaDefinition,
	defineSchema,
	t,
} from '@korajs/core'
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { describe, expect, test } from 'vitest'
import { KoraSyncServer } from '../server/kora-sync-server'
import { MemoryServerStore } from './memory-server-store'
import { PostgresServerStore } from './postgres-server-store'
import type { ServerStore } from './server-store'
import { createSqliteServerStore } from './sqlite-server-store'

/**
 * RT-103: a server store refuses to start with transforms that cannot read operations
 * it stores, instead of folding them as absent (silent erasure).
 */
const schema = defineSchema({
	version: 3,
	collections: { notes: { fields: { title: t.string(), body: t.string().optional() } } },
}) as SchemaDefinition

const v1ToV2: OperationTransform = {
	fromVersion: 1,
	toVersion: 2,
	transform: (op) => {
		if (!op.data || !('name' in op.data)) return { ...op, schemaVersion: 2 }
		const { name, ...rest } = op.data
		return { ...op, data: { ...rest, title: name }, schemaVersion: 2 }
	},
}
const v2ToV3: OperationTransform = {
	fromVersion: 2,
	toVersion: 3,
	transform: (op) => ({ ...op, schemaVersion: 3 }),
}

function v1Insert(): Operation {
	return {
		id: 'rt103-cov-1',
		nodeId: 'device-a',
		type: 'insert',
		collection: 'notes',
		recordId: 'r1',
		data: { name: 'written under v1' },
		previousData: null,
		timestamp: { wallTime: 1_700_000_000_000, logical: 0, nodeId: 'device-a' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
	}
}

async function expectRefusal(run: () => Promise<unknown>): Promise<void> {
	const error = await run().then(
		() => null,
		(e: unknown) => e,
	)
	expect(error).toBeInstanceOf(OperationTransformCoverageError)
	const coverage = error as OperationTransformCoverageError
	expect(coverage.code).toBe('OPERATION_TRANSFORM_MISSING')
	expect(coverage.versions).toEqual([1])
	expect(coverage.message).toContain('v1')
	expect(coverage.message).toContain('no transform from v1')
}

/** Checks one store: refuses retired transforms, keeps its records, accepts the full chain. */
async function exercise(open: () => Promise<ServerStore>): Promise<void> {
	const first = await open()
	await first.setSchema(schema, { operationTransforms: [v1ToV2, v2ToV3] })
	await first.applyRemoteOperation(v1Insert())
	expect(await first.findRecord('notes', 'r1')).toMatchObject({ title: 'written under v1' })
	// Retiring v1->v2 at runtime is refused too, and changes nothing.
	await expectRefusal(() => first.setOperationTransforms?.([v2ToV3]) ?? Promise.resolve())
	expect(first.getOperationTransforms?.()).toHaveLength(2)
	await first.close()

	const next = await open()
	await expectRefusal(() => next.setSchema(schema, { operationTransforms: [v2ToV3] }))
	await next.close()

	// No transforms at all: operations fold as written (an explicit choice), accepted.
	const bare = await open()
	await bare.setSchema(schema, { operationTransforms: [] })
	await bare.close()

	// The full chain still reads the record.
	const again = await open()
	await again.setSchema(schema, { operationTransforms: [v1ToV2, v2ToV3] })
	expect(await again.findRecord('notes', 'r1')).toMatchObject({ title: 'written under v1' })
	await again.close()
}

describe('RT-103: stores refuse transforms that cannot read the stored log', () => {
	test('SQLite server store', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'rt103-cov-'))
		try {
			await exercise(async () => createSqliteServerStore({ filename: join(dir, 'server.db') }))
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test('memory server store (runtime retirement)', async () => {
		const store = new MemoryServerStore()
		await store.setSchema(schema, { operationTransforms: [v1ToV2, v2ToV3] })
		await store.applyRemoteOperation(v1Insert())
		await expectRefusal(() => store.setOperationTransforms([v2ToV3]))
		await expectRefusal(() => store.setSchema(schema, { operationTransforms: [v2ToV3] }))
		expect(await store.findRecord('notes', 'r1')).toMatchObject({ title: 'written under v1' })
	})

	test('KoraSyncServer.start() surfaces the refusal', async () => {
		const store = new MemoryServerStore()
		await store.setSchema(schema, { operationTransforms: [v1ToV2, v2ToV3] })
		await store.applyRemoteOperation(v1Insert())
		const server = new KoraSyncServer({ store, port: 0, operationTransforms: [v2ToV3] })
		await expectRefusal(() => server.start())
		await server.stop().catch(() => {})
	})

	test.skipIf(!process.env.KORA_PG_TEST_URL)('Postgres server store', async () => {
		const schemaName = `kora_rt103_${process.pid}`
		const admin = postgres(process.env.KORA_PG_TEST_URL as string, {
			max: 1,
			onnotice: () => {},
		})
		await admin.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
		await admin.unsafe(`CREATE SCHEMA ${schemaName}`)
		const clients: Array<ReturnType<typeof postgres>> = []
		try {
			await exercise(async () => {
				const client = postgres(process.env.KORA_PG_TEST_URL as string, {
					max: 4,
					onnotice: () => {},
					connection: { search_path: schemaName },
				})
				clients.push(client)
				return new PostgresServerStore(drizzlePg(client), 'server-1')
			})
		} finally {
			for (const client of clients) await client.end()
			await admin.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
			await admin.end()
		}
	})
})
