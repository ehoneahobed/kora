import {
	type Operation,
	type SchemaDefinition,
	defineSchema,
	foldRecord,
	isFoldStateLive,
	materialize,
	serializeFoldState,
	t,
} from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, describe, expect, test } from 'vitest'
import { applyServerOperation } from '../apply/apply-server-operation'
import { nextServerSequenceNumber } from '../apply/server-side-effect-operation'
import { MemoryServerStore } from '../store/memory-server-store'
import { PostgresServerStore } from '../store/postgres-server-store'
import { serverFoldOptions } from '../store/record-fold'
import type { ServerStore } from '../store/server-store'
import { createSqliteServerStore } from '../store/sqlite-server-store'
import { SERVER_RULE_PREFIX, enforceCrossRecordRules, timestampAfter } from './constraint-authority'

const PG_URL = process.env.KORA_PG_TEST_URL
const pgClients: Array<ReturnType<typeof postgres>> = []
let pgSchemaCounter = 0

afterAll(async () => {
	for (const client of pgClients) await client.end()
})

function uniqueSchema(onConflict: 'first-write-wins' | 'last-write-wins'): SchemaDefinition {
	return defineSchema({
		version: 1,
		collections: {
			tags: {
				fields: { name: t.string(), color: t.string().optional() },
				constraints: [{ type: 'unique', fields: ['name'], onConflict }],
			},
		},
	}) as SchemaDefinition
}

const relationSchema = (onDelete: 'cascade' | 'set-null' | 'restrict'): SchemaDefinition =>
	defineSchema({
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
				onDelete,
			},
		},
	}) as SchemaDefinition

let seq = 0
function op(
	node: string,
	wall: number,
	collection: string,
	recordId: string,
	partial: Partial<Operation>,
): Operation {
	seq += 1
	return {
		id: `ca-${node}-${wall}-${seq}`,
		nodeId: node,
		type: 'insert',
		collection,
		recordId,
		data: {},
		previousData: null,
		timestamp: { wallTime: wall, logical: 0, nodeId: node },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		...partial,
	}
}

type Maker = () => Promise<ServerStore>
const makers: Array<[string, Maker]> = [
	['memory', async () => new MemoryServerStore('server')],
	['sqlite', async () => createSqliteServerStore({ nodeId: 'server' })],
]
if (PG_URL) {
	makers.push([
		'postgres',
		async () => {
			pgSchemaCounter += 1
			const schemaName = `kora_ca_${process.pid}_${pgSchemaCounter}`
			const admin = postgres(PG_URL, { max: 1, onnotice: () => {} })
			await admin.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
			await admin.unsafe(`CREATE SCHEMA ${schemaName}`)
			await admin.end()
			const client = postgres(PG_URL, {
				max: 4,
				onnotice: () => {},
				connection: { search_path: schemaName },
			})
			pgClients.push(client)
			return new PostgresServerStore(drizzle(client), 'server')
		},
	])
}

/** Every stored operation (the log), via the delivery stream. */
async function log(store: ServerStore): Promise<Operation[]> {
	return (await store.getOperationsAfterDelivery(0, 100_000)).map((d) => d.operation)
}

/** Fold the log per record in a shuffled order, as a device holding all of it would. */
function deviceRows(
	ops: Operation[],
	schema: SchemaDefinition,
	collection: string,
	seed: number,
): Record<string, Record<string, unknown>> {
	let state = seed
	const shuffled = [...ops].sort(() => {
		state = (state * 1103515245 + 12345) % 2147483648
		return state / 2147483648 - 0.5
	})
	const byRecord = new Map<string, Operation[]>()
	for (const o of shuffled) {
		if (o.collection !== collection) continue
		byRecord.set(o.recordId, [...(byRecord.get(o.recordId) ?? []), o])
	}
	const rows: Record<string, Record<string, unknown>> = {}
	for (const [id, recordOps] of byRecord) {
		const folded = foldRecord(recordOps, schema, serverFoldOptions(['server'])).state
		if (folded && isFoldStateLive(folded)) rows[id] = materialize(folded) ?? {}
	}
	return rows
}

function liveNames(rows: Record<string, Record<string, unknown>>): Record<string, string[]> {
	const byName: Record<string, string[]> = {}
	for (const [id, row] of Object.entries(rows)) {
		const name = String(row.name)
		byName[name] = [...(byName[name] ?? []), id].sort()
	}
	return byName
}

for (const [name, make] of makers) {
	describe(`${name}: cross-record rules have one authority (W7 step 3)`, () => {
		test('unique race across 3 devices: exactly one survivor (first write wins), every device converges', async () => {
			const schema = uniqueSchema('first-write-wins')
			const store = await make()
			await store.setSchema(schema)
			// Three devices insert the same name offline; all passed validation before any
			// committed (the race), so all three are stored.
			const inserts = [
				op('dev-b', 2000, 'tags', 'tag-b', { data: { name: 'kora', color: 'blue' } }),
				op('dev-a', 1000, 'tags', 'tag-a', { data: { name: 'kora', color: 'red' } }),
				op('dev-c', 3000, 'tags', 'tag-c', { data: { name: 'kora', color: 'green' } }),
			]
			for (const insert of inserts) expect(await store.applyRemoteOperation(insert)).toBe('applied')
			const corrections: Operation[] = []
			// Every session that committed one of them re-checks; duplicates dedup by id.
			for (const insert of inserts) {
				corrections.push(
					...(await enforceCrossRecordRules(store, insert, () => nextServerSequenceNumber(store))),
				)
			}
			expect(corrections).toHaveLength(2)
			for (const correction of corrections) {
				expect(correction.nodeId).toBe('server')
				expect(correction.type).toBe('delete')
			}
			const live = await store.queryCollection('tags', { where: { name: 'kora' } })
			expect(live.map((row) => row.id)).toEqual(['tag-a'])
			// A second detection round changes nothing (idempotent).
			for (const insert of inserts) {
				expect(
					await enforceCrossRecordRules(store, insert, () => nextServerSequenceNumber(store)),
				).toEqual([])
			}
			const all = await log(store)
			for (const seed of [1, 2, 3]) {
				const rows = deviceRows(all, schema, 'tags', seed)
				expect(liveNames(rows)).toEqual({ kora: ['tag-a'] })
			}
			await store.close()
		})

		test('unique, last-write-wins: the newest write survives', async () => {
			const schema = uniqueSchema('last-write-wins')
			const store = await make()
			await store.setSchema(schema)
			const a = op('dev-a', 1000, 'tags', 'tag-a', { data: { name: 'kora' } })
			const b = op('dev-b', 2000, 'tags', 'tag-b', { data: { name: 'kora' } })
			await store.applyRemoteOperation(a)
			await store.applyRemoteOperation(b)
			await enforceCrossRecordRules(store, b, () => nextServerSequenceNumber(store))
			const live = await store.queryCollection('tags', { where: { name: 'kora' } })
			expect(live.map((row) => row.id)).toEqual(['tag-b'])
			await store.close()
		})

		test('concurrent renames to one name: the loser goes back to its own previous name', async () => {
			const schema = uniqueSchema('first-write-wins')
			const store = await make()
			await store.setSchema(schema)
			const a = op('dev-a', 1000, 'tags', 'tag-a', { data: { name: 'alpha' } })
			const b = op('dev-b', 1001, 'tags', 'tag-b', { data: { name: 'beta' } })
			await store.applyRemoteOperation(a)
			await store.applyRemoteOperation(b)
			const renameA = op('dev-a', 5000, 'tags', 'tag-a', {
				type: 'update',
				data: { name: 'kora' },
				previousData: { name: 'alpha' },
			})
			const renameB = op('dev-b', 6000, 'tags', 'tag-b', {
				type: 'update',
				data: { name: 'kora' },
				previousData: { name: 'beta' },
			})
			await store.applyRemoteOperation(renameB)
			await store.applyRemoteOperation(renameA)
			const fromB = await enforceCrossRecordRules(store, renameB, () =>
				nextServerSequenceNumber(store),
			)
			const fromA = await enforceCrossRecordRules(store, renameA, () =>
				nextServerSequenceNumber(store),
			)
			expect([...fromA, ...fromB]).toHaveLength(1)
			expect((await store.findRecord('tags', 'tag-a'))?.name).toBe('kora')
			expect((await store.findRecord('tags', 'tag-b'))?.name).toBe('beta')
			const rows = deviceRows(await log(store), schema, 'tags', 7)
			expect(rows['tag-b']?.name).toBe('beta')
			await store.close()
		})

		test('applyServerOperation: concurrent ingests of a duplicate name leave exactly one', async () => {
			const schema = uniqueSchema('first-write-wins')
			const store = await make()
			await store.setSchema(schema)
			const now = Date.now()
			const inserts = ['a', 'b', 'c'].map((suffix, index) =>
				op(`dev-${suffix}`, now + index, 'tags', `tag-${suffix}`, { data: { name: 'kora' } }),
			)
			const results = await Promise.all(
				inserts.map((insert) => applyServerOperation(store, insert)),
			)
			// Refused at ingest or corrected after commit: one survivor either way.
			expect(results.some((r) => r.result === 'applied')).toBe(true)
			const live = await store.queryCollection('tags', { where: { name: 'kora' } })
			expect(live).toHaveLength(1)
			const rows = deviceRows(await log(store), schema, 'tags', 11)
			expect(Object.values(liveNames(rows)).map((ids) => ids.length)).toEqual([1])
			await store.close()
		})

		test('a child written under a parent deleted with cascade is deleted too', async () => {
			const schema = relationSchema('cascade')
			const store = await make()
			await store.setSchema(schema)
			await store.applyRemoteOperation(op('a', 1000, 'projects', 'p1', { data: { name: 'P' } }))
			const del = op('a', 2000, 'projects', 'p1', { type: 'delete', data: null })
			expect((await applyServerOperation(store, del)).result).toBe('applied')
			// An offline device created a todo under p1 (its HLC is later than the delete).
			const late = op('b', 3000, 'todos', 't1', { data: { title: 'late', projectId: 'p1' } })
			const result = await applyServerOperation(store, late)
			expect(result.result).toBe('applied')
			const correction = result.appliedOperations.find((o) => o.id !== late.id)
			expect(correction?.type).toBe('delete')
			expect(correction?.timestamp).toEqual(timestampAfter(late.timestamp, 'server'))
			expect(await store.findRecord('todos', 't1')).toBeNull()
			await store.close()
		})

		test('set-null: a late child loses its reference', async () => {
			const schema = relationSchema('set-null')
			const store = await make()
			await store.setSchema(schema)
			await store.applyRemoteOperation(op('a', 1000, 'projects', 'p1', { data: { name: 'P' } }))
			await applyServerOperation(
				store,
				op('a', 2000, 'projects', 'p1', { type: 'delete', data: null }),
			)
			await applyServerOperation(
				store,
				op('b', 3000, 'todos', 't1', { data: { title: 'late', projectId: 'p1' } }),
			)
			expect((await store.findRecord('todos', 't1'))?.projectId).toBeNull()
			await store.close()
		})

		test('restrict: a delete raced by a new child is revived (the delete loses)', async () => {
			const schema = relationSchema('restrict')
			const store = await make()
			await store.setSchema(schema)
			await store.applyRemoteOperation(op('a', 1000, 'projects', 'p1', { data: { name: 'P' } }))
			// Both validated against a state without the other: the child committed after
			// the delete was judged, the delete committed after the child was judged.
			const child = op('b', 1500, 'todos', 't1', { data: { title: 'x', projectId: 'p1' } })
			const del = op('a', 2000, 'projects', 'p1', { type: 'delete', data: null })
			await store.applyRemoteOperation(child)
			await store.applyRemoteOperation(del)
			const fromDelete = await enforceCrossRecordRules(store, del, () =>
				nextServerSequenceNumber(store),
			)
			const fromChild = await enforceCrossRecordRules(store, child, () =>
				nextServerSequenceNumber(store),
			)
			expect([...fromDelete, ...fromChild]).toHaveLength(1)
			expect(fromDelete[0]?.data).toEqual({})
			expect((await store.findRecord('projects', 'p1'))?.name).toBe('P')
			expect((await store.findRecord('todos', 't1'))?.projectId).toBe('p1')
			const rows = deviceRows(await log(store), schema, 'projects', 3)
			expect(rows.p1?.name).toBe('P')
			await store.close()
		})

		test('cascade side effects are deterministic: same id and content on every server', async () => {
			const schema = relationSchema('cascade')
			const run = async (): Promise<Operation[]> => {
				const store = await make()
				await store.setSchema(schema)
				await store.applyRemoteOperation(op('a', 1000, 'projects', 'p1', { data: { name: 'P' } }))
				await store.applyRemoteOperation(
					op('a', 1100, 'todos', 't1', { data: { title: 'x', projectId: 'p1' } }),
				)
				const del: Operation = {
					...op('a', 2000, 'projects', 'p1', { type: 'delete', data: null }),
					id: 'fixed-delete',
				}
				const result = await applyServerOperation(store, del)
				const effects = result.appliedOperations.filter((o) => o.id !== del.id)
				// The same effect again (a retry, another instance) is a duplicate.
				expect(await store.applyRemoteOperation({ ...(effects[0] as Operation) })).toBe('duplicate')
				await store.close()
				return effects
			}
			const first = await run()
			const second = await run()
			expect(first).toHaveLength(1)
			const strip = (o: Operation): Omit<Operation, 'sequenceNumber'> => {
				const { sequenceNumber: _sequence, ...rest } = o
				return rest
			}
			expect(first.map(strip)).toEqual(second.map(strip))
			expect(first[0]?.timestamp).toEqual({ wallTime: 2000, logical: 1, nodeId: 'server' })
			expect(first[0]?.mutationName).toBe('kora:side-effect:cascade')
			expect(SERVER_RULE_PREFIX).toBe('server/')
		})
	})
}

test('timestampAfter carries a logical overflow into the wall time', () => {
	expect(timestampAfter({ wallTime: 5, logical: 99_999, nodeId: 'x' }, 'srv')).toEqual({
		wallTime: 6,
		logical: 0,
		nodeId: 'srv',
	})
})

test('fold-state serialization of a corrected record is identical on every replica', async () => {
	const schema = uniqueSchema('first-write-wins')
	const memory = new MemoryServerStore('server')
	const sqlite = createSqliteServerStore({ nodeId: 'server' })
	for (const store of [memory, sqlite]) await store.setSchema(schema)
	const inserts = [
		op('dev-a', 1000, 'tags', 'tag-x', { data: { name: 'dup' } }),
		op('dev-b', 2000, 'tags', 'tag-y', { data: { name: 'dup' } }),
	]
	for (const store of [memory, sqlite]) {
		for (const insert of inserts) await store.applyRemoteOperation(insert)
		for (const insert of inserts) {
			await enforceCrossRecordRules(store, insert, () => nextServerSequenceNumber(store))
		}
	}
	const states = await Promise.all(
		[memory, sqlite].map(async (store) => {
			const state = await store.getRecordFoldState('tags', 'tag-y')
			return state ? serializeFoldState(state) : null
		}),
	)
	expect(states[0]).toBe(states[1])
	expect(await memory.findRecord('tags', 'tag-y')).toBeNull()
})
