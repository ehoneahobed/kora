/**
 * NEW-SRV-2 repro (real Postgres; set KORA_PG_TEST_URL): the Postgres store checked
 * for a duplicate outside its append transaction, so the same delete applied
 * concurrently on two server instances was 'applied' twice and its referential
 * cascade ran twice, writing duplicate side-effect operations under the instances'
 * node ids. Asserts CORRECT behaviour: one 'applied', one cascade.
 */
import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { applyServerOperation } from '../../src/apply/apply-server-operation'
import { PostgresServerStore } from '../../src/store/postgres-server-store'

const PG_URL = process.env.KORA_PG_TEST_URL
const PG_SCHEMA = 'kora_repro_new_srv2'

const schema = defineSchema({
	version: 1,
	collections: {
		projects: { fields: { name: t.string() } },
		todos: { fields: { title: t.string(), projectId: t.string().optional() } },
	},
	relations: {
		todoProject: {
			from: 'todos',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'cascade',
		},
	},
})

let seq = 0
function op(overrides: Partial<Operation>): Operation {
	seq += 1
	return {
		id: `new-srv2-${seq}-${Math.random().toString(36).slice(2)}`,
		nodeId: 'client',
		type: 'insert',
		collection: 'todos',
		recordId: `r-${seq}`,
		data: { title: 'x' },
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: 0, nodeId: 'client' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

describe.skipIf(!PG_URL)('NEW-SRV-2: concurrent duplicate on Postgres', () => {
	const clients: Array<ReturnType<typeof postgres>> = []
	beforeAll(async () => {
		const admin = postgres(PG_URL as string, { max: 1 })
		await admin.unsafe(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`)
		await admin.unsafe(`CREATE SCHEMA ${PG_SCHEMA}`)
		await admin.end()
	})
	afterAll(async () => {
		for (const c of clients) await c.end()
	})
	async function instance(nodeId: string): Promise<PostgresServerStore> {
		const client = postgres(PG_URL as string, { max: 4, connection: { search_path: PG_SCHEMA } })
		clients.push(client)
		const store = new PostgresServerStore(drizzle(client), nodeId)
		await store.setSchema(schema)
		return store
	}

	test('the same delete applied on two instances at once cascades exactly once', async () => {
		const a = await instance('srv-a')
		const b = await instance('srv-b')
		let doubled = 0
		for (let round = 0; round < 10; round++) {
			const project = op({ collection: 'projects', recordId: `p-${round}`, data: { name: 'p' } })
			await applyServerOperation(a, project)
			for (let i = 0; i < 2; i++) {
				await applyServerOperation(a, op({ data: { title: 'x', projectId: `p-${round}` } }))
			}
			const del = op({ type: 'delete', collection: 'projects', recordId: `p-${round}`, data: null })
			const results = await Promise.all([
				applyServerOperation(a, del),
				applyServerOperation(b, del),
			])
			const applied = results.filter((r) => r.result === 'applied').length
			const cascades = results
				.filter((r) => r.result === 'applied')
				.reduce((n, r) => n + r.appliedOperations.length - 1, 0)
			if (applied !== 1 || cascades !== 2) doubled++
		}
		expect(doubled).toBe(0)
	})
})
