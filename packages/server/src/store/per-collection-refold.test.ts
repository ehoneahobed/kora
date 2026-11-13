/**
 * A schema change re-folds the records of the collections it re-planned, and nothing else
 * (per-collection fold plans, plan-stamps.ts). The oracle is a store that took the same
 * operations under the new schema from the start: after the change, the re-planned
 * collections must hold exactly its rows, fold states and scope snapshots, and the other
 * collections must not have been touched at all. Postgres runs with KORA_PG_TEST_URL.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fc } from '@fast-check/vitest'
import {
	type Operation,
	type SchemaDefinition,
	anyone,
	defineSchema,
	member,
	memberOfKey,
	owner,
	t,
} from '@korajs/core'
import Database from 'better-sqlite3'
import { type SQL, sql } from 'drizzle-orm'
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { dropTrackedPgSchemas, trackPgSchema } from '../../tests/fixtures/pg-test-schemas'
import {
	FOLD_PLAN_FINGERPRINTS_KEY,
	decideReplan,
	outdatedPlanCondition,
	serverPlanStamps,
} from './plan-stamps'
import { PostgresServerStore } from './postgres-server-store'
import { FOLD_PLAN_FINGERPRINT_KEY } from './record-fold'
import {
	SCOPE_SNAPSHOT_FINGERPRINTS_KEY,
	SCOPE_SNAPSHOT_FINGERPRINT_KEY,
	decideScopeSnapshotRefresh,
	scopeSnapshotFingerprint,
} from './scope-snapshot'
import { SqliteServerStore, createSqliteServerStore } from './sqlite-server-store'

afterAll(dropTrackedPgSchemas)

/** Version 1: two collections. */
const v1 = defineSchema({
	version: 1,
	collections: {
		docs: { fields: { title: t.string(), views: t.number().default(0) } },
		notes: { fields: { body: t.string(), tags: t.array(t.string()).default([]) } },
	},
})

/** Version 2 re-plans `docs` only: views become a counter. */
const v2 = defineSchema({
	version: 2,
	collections: {
		docs: { fields: { title: t.string(), views: t.number().merge('counter').default(0) } },
		notes: { fields: { body: t.string(), tags: t.array(t.string()).default([]) } },
	},
})

/** Version 3 changes what `notes` snapshots capture (and its plan); `docs` as in v2. */
const v3 = defineSchema({
	version: 3,
	collections: {
		docs: { fields: { title: t.string(), views: t.number().merge('counter').default(0) } },
		notes: {
			fields: {
				body: t.string(),
				tags: t.array(t.string()).default([]),
				priority: t.number().optional(),
			},
		},
	},
})

const access = {
	memberships: 'members',
	roles: ['view', 'edit', 'manage'],
	groups: { boards: { owner: 'ownerId', role: 'manage' } },
} as const

/** With access rules: the membership index's sources and an unrelated collection. */
const withAccess = (counter: boolean, boardCounter: boolean): SchemaDefinition =>
	defineSchema({
		version: counter || boardCounter ? 2 : 1,
		access,
		collections: {
			members: {
				fields: { userId: t.string(), group: t.string(), role: t.string() },
				access: { read: memberOfKey('group') },
			},
			boards: {
				fields: {
					title: t.string(),
					ownerId: t.string().stamp('userId'),
					score: boardCounter ? t.number().merge('counter').default(0) : t.number().default(0),
				},
				access: { read: member('id'), create: owner('ownerId'), update: member('id', 'edit') },
			},
			stats: {
				fields: { hits: counter ? t.number().merge('counter').default(0) : t.number().default(0) },
				access: { read: anyone() },
			},
		},
	})

// ---------------------------------------------------------------------------------------
// Decisions (pure)
// ---------------------------------------------------------------------------------------

describe('decideReplan', () => {
	const now = serverPlanStamps(v2, [])
	const before = serverPlanStamps(v1, [])

	test('per-collection fingerprints recorded: only the collections that differ', () => {
		const decision = decideReplan(now, {
			fingerprints: JSON.stringify(before.fingerprints),
			globalFingerprint: before.globalFingerprint,
		})
		expect(decision.replanned).toEqual(['docs'])
		expect(decision.restampLegacy).toBe(false)
		expect(decision.write).toBe(true)
	})

	test('nothing changed: nothing to re-fold or write', () => {
		expect(
			decideReplan(now, {
				fingerprints: JSON.stringify(now.fingerprints),
				globalFingerprint: now.globalFingerprint,
			}),
		).toEqual({ replanned: [], restampLegacy: false, write: false })
	})

	test('a database from before per-collection plans, same plan: restamp, no re-fold', () => {
		expect(
			decideReplan(now, { fingerprints: undefined, globalFingerprint: now.globalFingerprint }),
		).toEqual({ replanned: [], restampLegacy: true, write: true })
	})

	test('a database from before per-collection plans, another plan: every collection', () => {
		expect(
			decideReplan(now, { fingerprints: undefined, globalFingerprint: before.globalFingerprint })
				.replanned,
		).toEqual(['docs', 'notes'])
		expect(
			decideReplan(now, { fingerprints: undefined, globalFingerprint: undefined }).replanned,
		).toEqual(['docs', 'notes'])
	})

	test('an unreadable record re-folds conservatively', () => {
		expect(
			decideReplan(now, { fingerprints: '{not json', globalFingerprint: before.globalFingerprint })
				.replanned,
		).toEqual(['docs', 'notes'])
	})

	test('explicit authorities re-plan every collection', () => {
		const authorities = serverPlanStamps(v2, ['server-1'])
		expect(
			decideReplan(authorities, {
				fingerprints: JSON.stringify(now.fingerprints),
				globalFingerprint: now.globalFingerprint,
			}).replanned,
		).toEqual(['docs', 'notes'])
	})
})

describe('decideScopeSnapshotRefresh', () => {
	test('only the collection whose captured fields changed', () => {
		const recorded = decideScopeSnapshotRefresh(v2, {
			fingerprints: undefined,
			fingerprint: undefined,
		})
		const refresh = decideScopeSnapshotRefresh(v3, {
			fingerprints: recorded.pendingValue,
			fingerprint: scopeSnapshotFingerprint(v2),
		})
		expect(refresh.changed).toEqual(['notes'])
	})

	test('a database from before per-collection snapshots, unchanged: nothing dropped', () => {
		expect(
			decideScopeSnapshotRefresh(v3, {
				fingerprints: undefined,
				fingerprint: scopeSnapshotFingerprint(v3),
			}).changed,
		).toEqual([])
	})
})

const hex = fc.string({ unit: fc.constantFrom(...'0123456789abcdef'), minLength: 1, maxLength: 4 })

describe('outdatedPlanCondition', () => {
	test('selects exactly the non-empty plans outside the active set', () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(hex, { minLength: 1, maxLength: 6 }),
				fc.array(fc.oneof(fc.constant(''), hex), {
					maxLength: 20,
				}),
				(active, plans) => {
					const db = drizzleSqlite(new Database(':memory:'))
					db.run(sql`CREATE TABLE f (id INTEGER PRIMARY KEY, plan TEXT NOT NULL)`)
					plans.forEach((plan, id) => db.run(sql`INSERT INTO f (id, plan) VALUES (${id}, ${plan})`))
					const selected = db
						.all<{ id: number }>(
							sql`SELECT id FROM f WHERE ${outdatedPlanCondition(sql`plan`, active)} ORDER BY id`,
						)
						.map((row) => row.id)
					const expected = plans
						.map((plan, id) => ({ plan, id }))
						.filter(({ plan }) => plan !== '' && !active.includes(plan))
						.map(({ id }) => id)
					expect(selected).toEqual(expected)
				},
			),
			{ numRuns: 200 },
		)
	})
})

// ---------------------------------------------------------------------------------------
// Stores (SQLite always, Postgres with KORA_PG_TEST_URL)
// ---------------------------------------------------------------------------------------

type Store = SqliteServerStore | PostgresServerStore

interface Backend {
	/** A fresh database. */
	create(): Promise<Database_>
}

interface Database_ {
	open(schema: SchemaDefinition): Promise<Store>
	rows<T>(store: Store, query: SQL): Promise<T[]>
	exec(store: Store, query: SQL): Promise<void>
	dispose(): Promise<void>
}

const sqliteBackend: Backend = {
	async create() {
		const dir = mkdtempSync(join(tmpdir(), 'kora-per-collection-'))
		const filename = join(dir, 'server.db')
		return {
			async open(schema) {
				const store = createSqliteServerStore({ filename })
				await store.setSchema(schema)
				return store
			},
			async rows<T>(store: Store, query: SQL) {
				return (store as unknown as { db: { all<R>(q: SQL): R[] } }).db.all<T>(query)
			},
			async exec(store: Store, query: SQL) {
				;(store as unknown as { db: { run(q: SQL): unknown } }).db.run(query)
			},
			async dispose() {
				rmSync(dir, { recursive: true, force: true })
			},
		}
	},
}

const PG_URL = process.env.KORA_PG_TEST_URL

const postgresBackend: Backend = {
	async create() {
		const name = `kora_pcr_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
		const admin = postgres(PG_URL ?? '', { max: 1 })
		await admin.unsafe(`CREATE SCHEMA ${name}`)
		trackPgSchema(name)
		await admin.end()
		const mine: ReturnType<typeof postgres>[] = []
		return {
			async open(schema) {
				const client = postgres(PG_URL ?? '', {
					max: 2,
					connection: { search_path: name },
					onnotice: () => {},
				})
				mine.push(client)
				const store = new PostgresServerStore(drizzle(client), 'server-node')
				await store.setSchema(schema)
				return store
			},
			async rows<T>(store: Store, query: SQL) {
				return (await (
					store as unknown as { db: { execute(q: SQL): Promise<unknown> } }
				).db.execute(query)) as T[]
			},
			async exec(store: Store, query: SQL) {
				await (store as unknown as { db: { execute(q: SQL): Promise<unknown> } }).db.execute(query)
			},
			async dispose() {
				await Promise.all(mine.splice(0).map((client) => client.end()))
			},
		}
	},
}

let seq = 0
function op(
	collection: string,
	recordId: string,
	type: Operation['type'],
	data: Record<string, unknown> | null,
	previousData: Record<string, unknown> | null = null,
	node = 'device-a',
): Operation {
	seq += 1
	return {
		id: `pcr-${seq}-${Math.random().toString(36).slice(2, 8)}`,
		nodeId: node,
		type,
		collection,
		recordId,
		data,
		previousData,
		timestamp: { wallTime: 1_000 + seq, logical: 0, nodeId: node },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
	}
}

/** A small history across both collections: inserts, updates (views, tags) and a delete. */
function history(): Operation[] {
	const ops: Operation[] = []
	for (let i = 0; i < 4; i++) {
		ops.push(op('docs', `d${i}`, 'insert', { title: `doc ${i}`, views: i }))
		ops.push(op('notes', `n${i}`, 'insert', { body: `note ${i}`, tags: ['a'] }))
	}
	ops.push(op('docs', 'd1', 'update', { views: 5 }, { views: 1 }, 'device-b'))
	ops.push(op('docs', 'd1', 'update', { views: 7 }, { views: 5 }, 'device-c'))
	ops.push(op('notes', 'n2', 'update', { tags: ['a', 'b'] }, { tags: ['a'] }))
	ops.push(op('docs', 'd3', 'delete', null))
	return ops
}

/** What a collection holds: rows, fold states (with stamps) and its operations' snapshots. */
async function contents(db: Database_, store: Store, collection: string) {
	const rows = await db.rows<Record<string, unknown>>(
		store,
		sql`SELECT * FROM ${sql.raw(`"${collection}"`)} ORDER BY id`,
	)
	const states = await db.rows<{ record_id: string; state: string; plan: string }>(
		store,
		sql`SELECT record_id, state, plan FROM kora_fold_state WHERE collection = ${collection} ORDER BY record_id`,
	)
	const snapshots = await db.rows<{ id: string; scope_snapshot: string | null }>(
		store,
		sql`SELECT id, scope_snapshot FROM operations WHERE collection = ${collection} ORDER BY id`,
	)
	return {
		rows: rows.map(({ _updated_at, ...rest }) => rest),
		states: states.map(({ record_id, state }) => ({ record_id, state })),
		plans: states.map(({ plan }) => plan),
		snapshots: snapshots.map((row) =>
			withoutNulls(
				typeof row.scope_snapshot === 'string'
					? JSON.parse(row.scope_snapshot)
					: row.scope_snapshot,
			),
		),
	}
}

/**
 * A snapshot with its null field values dropped. A snapshot replayed from the log has no key
 * for a field no operation wrote; one taken at write time reads the column as null. Both
 * mean "no value" to scope filtering (and the full re-fold before per-collection plans
 * replayed the same way), so the comparison treats them alike.
 */
function withoutNulls(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutNulls)
	if (value === null || typeof value !== 'object') return value
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key, entry]) => entry !== null || key === 'pre' || key === 'post')
			.map(([key, entry]) => [key, withoutNulls(entry)]),
	)
}

/** The stamps a store folds with (its authorities included). */
function stampsOf(store: Store): ReturnType<typeof serverPlanStamps> {
	return (store as unknown as { planStamps(): ReturnType<typeof serverPlanStamps> }).planStamps()
}

async function applyAll(store: Store, ops: readonly Operation[]): Promise<void> {
	for (const operation of ops) await store.applyRemoteOperation(operation)
}

const backends: Array<[string, Backend, boolean]> = [
	['sqlite', sqliteBackend, true],
	['postgres', postgresBackend, PG_URL !== undefined],
]

for (const [name, backend, enabled] of backends) {
	describe.skipIf(!enabled)(`${name}: a schema change re-folds only what it re-planned`, () => {
		test('only the re-planned collection is re-folded, and it equals a store that always had the new plan', async () => {
			const db = await backend.create()
			const ops = history()
			const before = await db.open(v1)
			await applyAll(before, ops)
			const notesBefore = await contents(db, before, 'notes')
			await before.close()

			const after = await db.open(v2)
			const report = after.getFoldMigrationReport()
			expect(report.replanned).toEqual(['docs'])
			expect(report.fullRefold).toBe(false)
			// docs has 4 records (one deleted, still a record); notes none.
			expect(report.records).toBe(4)
			// notes was not touched at all: same rows, states, stamps and snapshots.
			const notesAfter = await contents(db, after, 'notes')
			expect(notesAfter).toEqual(notesBefore)

			const oracleDb = await backend.create()
			const oracle = await oracleDb.open(v2)
			await applyAll(oracle, ops)
			for (const collection of ['docs', 'notes']) {
				const migrated = await contents(db, after, collection)
				const fresh = await contents(oracleDb, oracle, collection)
				expect(migrated.rows).toEqual(fresh.rows)
				expect(migrated.states).toEqual(fresh.states)
				expect(migrated.snapshots).toEqual(fresh.snapshots)
			}
			// Every state carries its collection's own stamp.
			const stamps = stampsOf(after)
			expect(new Set((await contents(db, after, 'docs')).plans)).toEqual(
				new Set([stamps.byCollection.docs]),
			)
			await after.close()
			await oracle.close()
			await db.dispose()
			await oracleDb.dispose()
		})

		test('a restart with the same schema re-folds nothing', async () => {
			const db = await backend.create()
			const store = await db.open(v2)
			await applyAll(store, history())
			await store.close()
			const again = await db.open(v2)
			expect(again.getFoldMigrationReport()).toMatchObject({ records: 0, replanned: [] })
			await again.close()
			await db.dispose()
		})

		test('a database from before per-collection plans is restamped, then re-plans per collection', async () => {
			const db = await backend.create()
			const store = await db.open(v1)
			await applyAll(store, history())
			// As an older server leaves it: whole-schema stamps and no per-collection record.
			const legacy = stampsOf(store)
			await db.exec(store, sql`UPDATE kora_fold_state SET plan = ${legacy.global}`)
			await db.exec(
				store,
				sql`DELETE FROM kora_server_meta WHERE key = ${FOLD_PLAN_FINGERPRINTS_KEY}`,
			)
			await store.close()

			const same = await db.open(v1)
			expect(same.getFoldMigrationReport()).toMatchObject({ records: 0, replanned: [] })
			const plans = await db.rows<{ collection: string; plan: string }>(
				same,
				sql`SELECT DISTINCT collection, plan FROM kora_fold_state ORDER BY collection`,
			)
			expect(plans).toEqual([
				{ collection: 'docs', plan: legacy.byCollection.docs },
				{ collection: 'notes', plan: legacy.byCollection.notes },
			])
			await same.close()

			const changed = await db.open(v2)
			expect(changed.getFoldMigrationReport()).toMatchObject({ replanned: ['docs'], records: 4 })
			await changed.close()
			await db.dispose()
		})

		test('an older server that changed the plan meanwhile: every collection, conservatively', async () => {
			const db = await backend.create()
			const store = await db.open(v1)
			await applyAll(store, history())
			await db.exec(
				store,
				sql`DELETE FROM kora_server_meta WHERE key = ${FOLD_PLAN_FINGERPRINTS_KEY}`,
			)
			await store.close()
			const changed = await db.open(v2)
			expect(changed.getFoldMigrationReport()).toMatchObject({
				replanned: ['docs', 'notes'],
				fullRefold: true,
				records: 8,
			})
			await changed.close()
			await db.dispose()
		})

		test('a state an older-plan instance folded is still found and re-folded, whatever the decision', async () => {
			const db = await backend.create()
			const store = await db.open(v2)
			await applyAll(store, history())
			// notes/n0 as an instance on another plan left it.
			await db.exec(
				store,
				sql`UPDATE kora_fold_state SET plan = 'another-plan' WHERE collection = 'notes' AND record_id = 'n0'`,
			)
			await store.close()
			const again = await db.open(v2)
			expect(again.getFoldMigrationReport()).toMatchObject({ replanned: [], records: 1 })
			await again.close()
			await db.dispose()
		})

		test("only the changed collection's scope snapshots are dropped and rebuilt", async () => {
			const db = await backend.create()
			const ops = history()
			const store = await db.open(v2)
			await applyAll(store, ops)
			const docsBefore = await contents(db, store, 'docs')
			await store.close()
			const after = await db.open(v3)
			// docs: neither re-folded nor re-snapshotted (identical, stamps included).
			expect(await contents(db, after, 'docs')).toEqual(docsBefore)
			const oracleDb = await backend.create()
			const oracle = await oracleDb.open(v3)
			await applyAll(oracle, ops)
			expect((await contents(db, after, 'notes')).snapshots).toEqual(
				(await contents(oracleDb, oracle, 'notes')).snapshots,
			)
			const recorded = await db.rows<{ key: string }>(
				after,
				sql`SELECT key FROM kora_server_meta WHERE key IN (${SCOPE_SNAPSHOT_FINGERPRINTS_KEY}, ${SCOPE_SNAPSHOT_FINGERPRINT_KEY}, ${FOLD_PLAN_FINGERPRINT_KEY}, ${FOLD_PLAN_FINGERPRINTS_KEY}) ORDER BY key`,
			)
			expect(recorded).toHaveLength(4)
			await after.close()
			await oracle.close()
			await db.dispose()
			await oracleDb.dispose()
		})

		test('the access index waits for a rebuild only when one of its sources was re-planned', async () => {
			const proto = (name === 'sqlite' ? SqliteServerStore : PostgresServerStore)
				.prototype as unknown as {
				writeRebuildingMarker: (...args: unknown[]) => unknown
			}
			const db = await backend.create()
			const store = await db.open(withAccess(false, false))
			await applyAll(store, [
				op('boards', 'b1', 'insert', { title: 'Board', ownerId: 'u1', score: 1 }),
				op('members', 'm1', 'insert', { userId: 'u2', group: 'boards:b1', role: 'view' }),
				op('stats', 's1', 'insert', { hits: 3 }),
			])
			await store.close()

			const spy = vi.spyOn(proto, 'writeRebuildingMarker')
			const unrelated = await db.open(withAccess(true, false))
			expect(unrelated.getFoldMigrationReport().replanned).toEqual(['stats'])
			expect(spy).not.toHaveBeenCalled()
			expect((await unrelated.getAccessIndexState()).rebuilding).toBe(false)
			await unrelated.close()

			const source = await db.open(withAccess(true, true))
			expect(source.getFoldMigrationReport().replanned).toEqual(['boards'])
			expect(spy).toHaveBeenCalled()
			spy.mockRestore()
			// The rebuild finished with the schema install.
			expect((await source.getAccessIndexState()).rebuilding).toBe(false)
			await source.close()
			await db.dispose()
		})

		test('property: after any re-plan, every collection equals a store that always had the new plan', async () => {
			const valueArb = fc.integer({ min: 0, max: 9 })
			const opArb = fc.record({
				collection: fc.constantFrom('docs', 'notes'),
				record: fc.integer({ min: 0, max: 3 }),
				kind: fc.constantFrom('insert', 'update', 'update', 'delete'),
				node: fc.constantFrom('device-a', 'device-b', 'device-c'),
				value: valueArb,
			})
			await fc.assert(
				fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 25 }), async (steps) => {
					const ops = steps.map((step) => {
						const id = `${step.collection === 'docs' ? 'd' : 'n'}${step.record}`
						if (step.kind === 'delete')
							return op(step.collection, id, 'delete', null, null, step.node)
						const data =
							step.collection === 'docs'
								? step.kind === 'insert'
									? { title: `t${step.value}`, views: step.value }
									: { views: step.value }
								: step.kind === 'insert'
									? { body: `b${step.value}`, tags: [`x${step.value}`] }
									: { tags: [`x${step.value}`, 'y'] }
						return op(step.collection, id, step.kind as Operation['type'], data, null, step.node)
					})
					const db = await backend.create()
					const before = await db.open(v1)
					await applyAll(before, ops)
					await before.close()
					const after = await db.open(v3)
					const oracleDb = await backend.create()
					const oracle = await oracleDb.open(v3)
					await applyAll(oracle, ops)
					try {
						for (const collection of ['docs', 'notes']) {
							const migrated = await contents(db, after, collection)
							const fresh = await contents(oracleDb, oracle, collection)
							expect(migrated.rows).toEqual(fresh.rows)
							expect(migrated.states).toEqual(fresh.states)
							expect(migrated.plans).toEqual(fresh.plans)
							expect(migrated.snapshots).toEqual(fresh.snapshots)
						}
					} finally {
						await after.close()
						await oracle.close()
						await db.dispose()
						await oracleDb.dispose()
					}
				}),
				{ numRuns: name === 'sqlite' ? 40 : 12 },
			)
		}, 120_000)
	})
}
