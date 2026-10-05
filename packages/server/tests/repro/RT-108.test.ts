/**
 * RT-108 repro (final verification round, RT-101 value-domain evolution on Postgres):
 * a beta.12 Postgres server table keeps the enum CHECK of a SINGLE-VALUE enum.
 *
 * beta.12 generated `CHECK ("status" IN ('active'))`. Postgres stores a one-element IN
 * list as `CHECK ((status = 'active'::text))`, not `= ANY (ARRAY[...])`, so
 * `isPostgresEnumCheckDefinition` (core/src/schema/constraint-relaxation.ts:166) does not
 * recognise it and `planPostgresConstraintRelaxation` leaves it in place. The usual story
 * of "start with one status, add another later" then fails exactly as RT-101 did: the
 * upgraded server cannot store the new value (the write is refused terminally and undone
 * on its author).
 *
 * Asserts CORRECT behaviour: after setSchema(v2) the legacy single-value CHECK is gone and
 * a write with the added value is stored.
 */
import {
	HybridLogicalClock,
	type Operation,
	type SchemaDefinition,
	createOperation,
	defineSchema,
	t,
} from '@korajs/core'
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { describe, expect, test } from 'vitest'
import { PostgresServerStore } from '../../src/store/postgres-server-store'

const v1 = defineSchema({
	version: 1,
	collections: {
		projects: {
			fields: { name: t.string(), status: t.enum(['active']).default('active') },
		},
	},
}) as SchemaDefinition
const v2 = defineSchema({
	version: 2,
	collections: {
		projects: {
			fields: { name: t.string(), status: t.enum(['active', 'archived']).default('active') },
		},
	},
}) as SchemaDefinition

let seq = 0
async function project(data: Record<string, unknown>, schemaVersion: number): Promise<Operation> {
	seq += 1
	return createOperation(
		{
			nodeId: 'device-a',
			type: 'insert',
			collection: 'projects',
			recordId: `project-${seq}`,
			data,
			previousData: null,
			sequenceNumber: seq,
			causalDeps: [],
			schemaVersion,
		},
		new HybridLogicalClock('device-a'),
	)
}

describe('RT-108: single-value enum CHECK survives the Postgres relaxation', () => {
	test.skipIf(!process.env.KORA_PG_TEST_URL)(
		'beta.12 CHECK ("status" IN (\'active\')) is dropped and the added value stored',
		async () => {
			const schemaName = `kora_rt108_${process.pid}`
			const admin = postgres(process.env.KORA_PG_TEST_URL as string, {
				max: 1,
				onnotice: () => {},
			})
			await admin.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
			await admin.unsafe(`CREATE SCHEMA ${schemaName}`)
			const client = postgres(process.env.KORA_PG_TEST_URL as string, {
				max: 4,
				onnotice: () => {},
				connection: { search_path: schemaName },
			})
			try {
				const first = new PostgresServerStore(drizzlePg(client), 'server-1')
				await first.setSchema(v1)
				await first.applyRemoteOperation(await project({ name: 'old', status: 'active' }, 1))
				// The beta.12 DDL for this field (enumCheckConstraint of beta.12).
				await client.unsafe(`ALTER TABLE projects ADD CHECK ("status" IN ('active'))`)

				const upgraded = new PostgresServerStore(drizzlePg(client), 'server-1')
				await upgraded.setSchema(v2)
				const checks = await client.unsafe(
					`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype = 'c' AND conrelid = 'projects'::regclass`,
				)
				expect(checks.map((row) => row.def)).toEqual([])

				const archived = await project({ name: 'new', status: 'archived' }, 2)
				const outcome = await upgraded.applyRemoteOperation(archived).catch((e: unknown) => e)
				expect(outcome).toBe('applied')
				expect(await upgraded.findRecord('projects', archived.recordId)).toMatchObject({
					status: 'archived',
				})
			} finally {
				await client.end()
				await admin.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
				await admin.end()
			}
		},
	)
})
