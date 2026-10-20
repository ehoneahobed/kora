/**
 * `kora doctor --db` against real server databases: each bad state is produced the way
 * production produced it (a real store, real operations, or the raw row an old release
 * wrote), the check is asserted to fire, and a healthy database (just written by the
 * current server) must pass with no warning. SQLite always runs; Postgres runs with
 * KORA_PG_TEST_URL, each test in its own schema, dropped afterwards.
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	HybridLogicalClock,
	type Operation,
	type SchemaDefinition,
	createOperation,
	defineSchema,
	t,
} from '@korajs/core'
import { createPostgresServerStore, createSqliteServerStore } from '@korajs/server'
import Database from 'better-sqlite3'
import postgres from 'postgres'
import { afterAll, describe, expect, test } from 'vitest'
import { parseDoctorDatabaseUrl, withDoctorDatabase } from '../../src/commands/doctor/db/database'
import { runDatabaseChecks } from '../../src/commands/doctor/db/db-checks'
import { scopeSnapshotFingerprint } from '../../src/commands/doctor/db/server-meta'
import type { DoctorCheckResult } from '../../src/commands/doctor/doctor-checks'
import { doctorHasFailures } from '../../src/commands/doctor/doctor-checks'

const PG_URL = process.env.KORA_PG_TEST_URL

const base = {
	notes: {
		fields: {
			title: t.string(),
			status: t.enum(['draft', 'live']).default('draft'),
			meta: t.json().optional(),
			views: t.number().default(0),
		},
	},
}
const schemaV1 = defineSchema({ version: 1, collections: base }) as unknown as SchemaDefinition

/** Where a test's database lives, and how to reach it as the server and as the doctor. */
interface Backend {
	name: 'sqlite' | 'postgres'
	/** A fresh database (file or schema) and its `--db` value. */
	fresh(): Promise<{ url: string; open(): Promise<StoreHandle>; raw(sql: string): Promise<void> }>
	cleanup(): Promise<void>
}

interface StoreHandle {
	setSchema(schema: SchemaDefinition): Promise<void>
	applyRemoteOperation(op: Operation): Promise<unknown>
	claimNode?(nodeId: string, userId: string): Promise<boolean>
	close(): Promise<void>
}

const tempDirs: string[] = []

const sqliteBackend: Backend = {
	name: 'sqlite',
	async fresh() {
		const dir = await mkdtemp(join(tmpdir(), 'kora-test-doctor-'))
		tempDirs.push(dir)
		const file = join(dir, 'kora-server.db')
		return {
			url: file,
			async open() {
				return createSqliteServerStore({ filename: file }) as unknown as StoreHandle
			},
			async raw(sql) {
				const db = new Database(file)
				db.exec(sql)
				db.close()
			},
		}
	},
	async cleanup() {},
}

const pgSchemas: string[] = []
const pgBackend: Backend = {
	name: 'postgres',
	async fresh() {
		const schema = `kora_doctor_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
		pgSchemas.push(schema)
		const admin = postgres(PG_URL ?? '', { max: 1, onnotice: () => {} })
		await admin.unsafe(`CREATE SCHEMA ${schema}`)
		await admin.end()
		const url = `${PG_URL}${PG_URL?.includes('?') ? '&' : '?'}search_path=${schema}`
		return {
			url,
			async open() {
				return (await createPostgresServerStore({
					connectionString: url,
				})) as unknown as StoreHandle
			},
			async raw(sql) {
				const client = postgres(url, { max: 1, onnotice: () => {} })
				await client.unsafe(sql)
				await client.end()
			},
		}
	},
	async cleanup() {
		if (pgSchemas.length === 0) return
		const admin = postgres(PG_URL ?? '', { max: 1, onnotice: () => {} })
		for (const schema of pgSchemas) await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
		await admin.end()
	},
}

afterAll(async () => {
	await pgBackend.cleanup()
	for (const dir of tempDirs) await rm(dir, { recursive: true, force: true })
})

let seq = 0
async function op(
	nodeId: string,
	input: Partial<Operation> & Pick<Operation, 'recordId' | 'data'>,
): Promise<Operation> {
	seq++
	return createOperation(
		{
			nodeId,
			type: input.type ?? 'insert',
			collection: input.collection ?? 'notes',
			recordId: input.recordId,
			data: input.data,
			previousData: input.previousData ?? null,
			sequenceNumber: seq,
			causalDeps: [],
			schemaVersion: input.schemaVersion ?? 1,
		},
		new HybridLogicalClock(nodeId),
	)
}

async function doctor(
	url: string,
	schema: SchemaDefinition | null,
	extra: { usesKoraAuth?: boolean; migrationsDir?: string } = {},
): Promise<DoctorCheckResult[]> {
	const target = parseDoctorDatabaseUrl(url, process.cwd())
	return withDoctorDatabase(target, process.cwd(), (db) =>
		runDatabaseChecks(db, {
			schema,
			usesKoraAuth: extra.usesKoraAuth ?? false,
			migrationsDir: extra.migrationsDir ?? join(tmpdir(), 'kora-test-doctor-no-migrations'),
		}),
	)
}

function find(results: DoctorCheckResult[], id: string): DoctorCheckResult {
	const result = results.find((r) => r.id === id)
	if (!result) throw new Error(`no ${id} result in ${JSON.stringify(results.map((r) => r.id))}`)
	return result
}

/** A database the current server wrote and started on, with ordinary traffic. */
async function healthy(backend: Backend) {
	const database = await backend.fresh()
	const store = await database.open()
	await store.setSchema(schemaV1)
	await store.claimNode?.('device-a', 'user-a')
	await store.applyRemoteOperation(
		await op('device-a', {
			recordId: 'n1',
			data: { title: 'One', status: 'live', meta: { a: 1 } },
		}),
	)
	await store.applyRemoteOperation(
		await op('device-a', {
			type: 'update',
			recordId: 'n1',
			data: { title: 'One!' },
			previousData: { title: 'One' },
		}),
	)
	await store.applyRemoteOperation(
		await op('device-a', { recordId: 'n2', data: { title: 'Two', meta: 'plain text' } }),
	)
	await store.close()
	return database
}

for (const backend of [sqliteBackend, pgBackend]) {
	describe.skipIf(backend.name === 'postgres' && !PG_URL)(
		`kora doctor --db (${backend.name})`,
		() => {
			test('a healthy database passes every check, without a warning', async () => {
				const database = await healthy(backend)
				const results = await doctor(database.url, schemaV1)
				const noisy = results.filter((r) => r.status !== 'pass' && r.status !== 'skip')
				expect(noisy).toEqual([])
				expect(find(results, 'db-startup-migration').message).toContain('re-folds nothing')
				expect(doctorHasFailures(results, true)).toBe(false)
			})

			test('the doctor never writes: the database is unchanged after a run', async () => {
				const database = await healthy(backend)
				const fingerprint = async (): Promise<string> => {
					const target = parseDoctorDatabaseUrl(database.url, process.cwd())
					return withDoctorDatabase(target, process.cwd(), async (db) => {
						const meta = await db.all('SELECT key, value FROM kora_server_meta ORDER BY key')
						const ops = await db.all('SELECT COUNT(*) AS n FROM operations')
						const folds = await db.all(
							'SELECT COUNT(*) AS n, MAX(covered_seq) AS m FROM kora_fold_state',
						)
						return JSON.stringify([meta, ops, folds])
					})
				}
				const before = await fingerprint()
				const sizeBefore = backend.name === 'sqlite' ? (await stat(database.url)).mtimeMs : 0
				await doctor(database.url, schemaV1)
				expect(await fingerprint()).toBe(before)
				if (backend.name === 'sqlite') expect((await stat(database.url)).mtimeMs).toBe(sizeBefore)
			})

			test('a write through the doctor connection is refused', async () => {
				const database = await healthy(backend)
				const target = parseDoctorDatabaseUrl(database.url, process.cwd())
				await expect(
					withDoctorDatabase(target, process.cwd(), (db) =>
						db.all(`INSERT INTO kora_server_meta (key, value) VALUES ('doctor', 'x')`),
					),
				).rejects.toThrow(/read.?only|readonly/i)
			})

			test('ownerless nodes: history with no claim, on an authenticated server', async () => {
				const database = await healthy(backend)
				// History written before node claims existed (a beta.12 server recorded none).
				const store = await database.open()
				await store.applyRemoteOperation(
					await op('device-old', { recordId: 'n9', data: { title: 'Old' } }),
				)
				await store.close()
				const custom = find(await doctor(database.url, schemaV1), 'db-ownerless-nodes')
				// Already served with node claims: reported, not warned about (nothing changes).
				expect(custom.status).toBe('pass')
				expect(custom.message).toContain('1 device node(s)')
				expect(custom.message).toContain('NODE_ID_CLAIMED')
				const auth = find(
					await doctor(database.url, schemaV1, { usesKoraAuth: true }),
					'db-ownerless-nodes',
				)
				expect(auth.status).toBe('pass')
				expect(auth.message).toContain('deviceNodeHandover')
			})

			test('ownerless nodes: a beta.12 database (no node_claims table)', async () => {
				const database = await backend.fresh()
				const store = await database.open()
				await store.setSchema(schemaV1)
				await store.applyRemoteOperation(
					await op('device-a', { recordId: 'n1', data: { title: 'A' } }),
				)
				await store.close()
				await database.raw('DROP TABLE node_claims')
				const result = find(
					await doctor(database.url, schemaV1, { usesKoraAuth: true }),
					'db-ownerless-nodes',
				)
				expect(result.status).toBe('warn')
				expect(result.message).toContain('beta.12 or earlier')
			})

			test('double-encoded JSON (F14): a json field holding an encoded object', async () => {
				const database = await healthy(backend)
				const store = await database.open()
				await store.setSchema(schemaV1)
				await store.applyRemoteOperation(
					await op('device-a', {
						recordId: 'n3',
						data: { title: 'Three', meta: '{"theme":"dark"}' },
					}),
				)
				await store.close()
				// Written by the current server: the app's own value, not an upgrade artifact.
				expect(find(await doctor(database.url, schemaV1), 'db-json-strings').status).toBe('pass')
				// The same row stored before the database's first beta.13+ start (F14).
				await database.raw(`UPDATE operations SET received_at = 1 WHERE record_id = 'n3'`)
				const result = find(await doctor(database.url, schemaV1), 'db-json-strings')
				expect(result.status).toBe('warn')
				expect(result.message).toContain('notes.meta: 1 row(s) (e.g. n3)')
			})

			test('constraint where clauses that can never match', async () => {
				const database = await healthy(backend)
				const constrained = defineSchema({
					version: 1,
					collections: {
						notes: {
							...base.notes,
							fields: { ...base.notes.fields, archived: t.boolean().default(false) },
							constraints: [
								{
									type: 'unique',
									fields: ['title'],
									where: { archived: false },
									onConflict: 'first-write-wins',
								},
								{
									type: 'unique',
									fields: ['title'],
									where: { status: 'published' },
									onConflict: 'first-write-wins',
								},
							],
						},
					},
				}) as unknown as SchemaDefinition
				const result = find(await doctor(database.url, constrained), 'db-constraint-where')
				expect(result.status).toBe('fail')
				expect(result.message).toContain('archived: false')
				expect(result.message).toContain('"published" is not one of')
				const ok = defineSchema({
					version: 1,
					collections: {
						notes: {
							...base.notes,
							constraints: [
								{
									type: 'unique',
									fields: ['title'],
									where: { status: 'live' },
									onConflict: 'first-write-wins',
								},
							],
						},
					},
				}) as unknown as SchemaDefinition
				expect(find(await doctor(database.url, ok), 'db-constraint-where').status).toBe('pass')
			})

			test('schema drift: a field whose kind changed without a migration fails', async () => {
				const database = await healthy(backend)
				const drifted = defineSchema({
					version: 2,
					collections: {
						notes: {
							fields: {
								...base.notes.fields,
								views: t.string().optional(),
								extra: t.string().optional(),
							},
						},
						tags: { fields: { name: t.string() } },
					},
				}) as unknown as SchemaDefinition
				const result = find(await doctor(database.url, drifted), 'db-schema-drift')
				expect(result.status).toBe('fail')
				expect(result.message).toContain('notes.views')
				// Additions the server makes itself are reported, never failed.
				expect(result.message).toContain('notes.extra')
				expect(result.message).toContain('tags')
			})

			test('schema drift: an older app schema than the log holds warns (rollback)', async () => {
				const database = await healthy(backend)
				const store = await database.open()
				await store.setSchema(schemaV1)
				await store.applyRemoteOperation(
					await op('device-a', { recordId: 'n7', data: { title: 'Newer' }, schemaVersion: 3 }),
				)
				await store.close()
				const result = find(await doctor(database.url, schemaV1), 'db-schema-drift')
				expect(result.status).toBe('warn')
				expect(result.message).toContain('schema v3')
			})

			test('protocol-1 clients: version-1 ids written after the upgrade', async () => {
				const database = await healthy(backend)
				const v1 = await createOperation(
					{
						nodeId: 'device-legacy',
						type: 'insert',
						collection: 'notes',
						recordId: 'n5',
						data: { title: 'From beta.12' },
						previousData: null,
						sequenceNumber: 1,
						causalDeps: [],
						schemaVersion: 1,
					},
					new HybridLogicalClock('device-legacy'),
					{ hashVersion: 1 },
				)
				const store = await database.open()
				await store.setSchema(schemaV1)
				await store.applyRemoteOperation(v1)
				await store.close()
				const result = find(await doctor(database.url, schemaV1), 'db-protocol-1')
				expect(result.status).toBe('warn')
				expect(result.message).toContain('1 device(s)')
				// Once the device upgraded and wrote again, the warning clears on its own.
				const again = await database.open()
				await again.setSchema(schemaV1)
				await again.applyRemoteOperation(
					await op('device-legacy', { recordId: 'n6', data: { title: 'After upgrade' } }),
				)
				await again.close()
				expect(find(await doctor(database.url, schemaV1), 'db-protocol-1').status).toBe('pass')
			})

			test('protocol-1 clients: judged by receipt time, not by a skewed device clock', async () => {
				const database = await healthy(backend)
				// A beta.12 device whose clock is years behind the server's writes after the
				// upgrade: its wall time predates the upgrade, its receipt does not.
				const slow = { now: () => 1_000_000 }
				const v1 = await createOperation(
					{
						nodeId: 'device-slow',
						type: 'insert',
						collection: 'notes',
						recordId: 'n7',
						data: { title: 'Behind' },
						previousData: null,
						sequenceNumber: 1,
						causalDeps: [],
						schemaVersion: 1,
					},
					new HybridLogicalClock('device-slow', slow),
					{ hashVersion: 1 },
				)
				const store = await database.open()
				await store.setSchema(schemaV1)
				await store.applyRemoteOperation(v1)
				await store.close()
				const result = find(await doctor(database.url, schemaV1), 'db-protocol-1')
				expect(result.status).toBe('warn')
				expect(result.message).toContain('1 device(s)')
				// It upgrades but its clock is still behind: a later receipt of a version-2
				// write still clears the warning.
				const again = await database.open()
				await again.setSchema(schemaV1)
				const v2 = await createOperation(
					{
						nodeId: 'device-slow',
						type: 'insert',
						collection: 'notes',
						recordId: 'n8',
						data: { title: 'Upgraded' },
						previousData: null,
						sequenceNumber: 2,
						causalDeps: [],
						schemaVersion: 1,
					},
					new HybridLogicalClock('device-slow', { now: () => 900_000 }),
				)
				await again.applyRemoteOperation(v2)
				await again.close()
				expect(find(await doctor(database.url, schemaV1), 'db-protocol-1').status).toBe('pass')
			})

			test('startup migration dry run: an interrupted snapshot rebuild resumes, not restarts', async () => {
				const database = await healthy(backend)
				const renamed = defineSchema({
					version: 1,
					collections: {
						notes: { fields: { ...base.notes.fields, rank: t.number().default(0) } },
					},
				}) as unknown as SchemaDefinition
				const fresh = find(await doctor(database.url, renamed), 'db-startup-migration')
				expect(fresh.message).toContain('rebuild the scope snapshot of every operation (3)')
				// A start under `renamed` dropped every snapshot, rebuilt all but one, and died.
				const target = scopeSnapshotFingerprint(renamed)
				await database.raw(
					`INSERT INTO kora_server_meta (key, value) VALUES ('scope_snapshot_fields_pending', '${target}'); UPDATE operations SET scope_snapshot = NULL WHERE record_id = 'n2'`,
				)
				const resumed = find(await doctor(database.url, renamed), 'db-startup-migration')
				expect(resumed.message).not.toContain('of every operation')
				expect(resumed.message).toContain(
					'finish an interrupted scope snapshot rebuild (1 operation(s) left)',
				)
			})

			test('startup migration dry run: a merge plan change re-folds, with an estimate', async () => {
				const database = await healthy(backend)
				const counter = defineSchema({
					version: 1,
					collections: {
						notes: {
							fields: { ...base.notes.fields, views: t.number().default(0).merge('counter') },
						},
					},
				}) as unknown as SchemaDefinition
				const result = find(await doctor(database.url, counter), 'db-startup-migration')
				expect(result.status).toBe('pass')
				expect(result.message).toContain('re-fold every record (2 record(s), 3 operation(s))')
				expect(result.message).toContain('the merge plan of notes changed')
				expect(result.message).toMatch(/Estimated (under a second|about \d+ s)/)
			})

			test('startup migration dry run: a beta.12 database re-folds everything', async () => {
				const database = await healthy(backend)
				await database.raw(
					'DELETE FROM kora_server_meta; DROP TABLE kora_fold_state; UPDATE operations SET scope_snapshot = NULL',
				)
				const result = find(await doctor(database.url, schemaV1), 'db-startup-migration')
				expect(result.message).toContain('first start of a release with fold states')
				expect(result.message).toContain('scope snapshot')
				expect(result.message).toContain('one-time passes over the whole log')
				// It is a first start of beta.13+, which also makes protocol 1 not determinable.
				expect(find(await doctor(database.url, schemaV1), 'db-protocol-1').status).toBe('skip')
			})

			test('pending migrations: an unapplied field kind change warns, additions do not', async () => {
				const database = await healthy(backend)
				const dir = await mkdtemp(join(tmpdir(), 'kora-test-doctor-mig-'))
				tempDirs.push(dir)
				const manifest = (id: string, up: string[]) =>
					writeFile(
						join(dir, `${id}.json`),
						JSON.stringify({
							id,
							fromVersion: 1,
							toVersion: 2,
							up,
							down: [],
							summary: [],
							containsBreakingChanges: false,
						}),
					)
				await mkdir(dir, { recursive: true })
				await writeFile(join(dir, '001-v1-to-v2.ts'), '')
				await manifest('001-v1-to-v2', [
					`--kora:evolve-table ${JSON.stringify({ table: 'notes', add: { extra: { kind: 'string' } }, drop: [], change: {}, addIndexes: [], removeIndexes: [] })}`,
				])
				const additive = find(
					await doctor(database.url, schemaV1, { migrationsDir: dir }),
					'db-pending-migrations',
				)
				expect(additive.status).toBe('pass')
				expect(additive.message).toContain('001-v1-to-v2')
				await writeFile(join(dir, '002-v2-to-v3.ts'), '')
				await manifest('002-v2-to-v3', [
					`--kora:evolve-table ${JSON.stringify({ table: 'notes', add: {}, drop: [], change: { views: { from: { kind: 'number' }, to: { kind: 'string' } } }, addIndexes: [], removeIndexes: [] })}`,
				])
				const kind = find(
					await doctor(database.url, schemaV1, { migrationsDir: dir }),
					'db-pending-migrations',
				)
				expect(kind.status).toBe('warn')
				expect(kind.message).toContain('notes.views number -> string')
			})

			test('a database that is not a Kora server database fails', async () => {
				const database = await backend.fresh()
				await database.raw('CREATE TABLE unrelated (id TEXT)')
				const results = await doctor(database.url, schemaV1)
				expect(find(results, 'db-layout').status).toBe('fail')
				expect(doctorHasFailures(results)).toBe(true)
			})
		},
	)
}

describe.skipIf(!PG_URL)('kora doctor --db credentials', () => {
	test('a refused connection never prints the password', async () => {
		const url = new URL(PG_URL ?? '')
		url.password = 'sup3r-s3cret-pw'
		const target = parseDoctorDatabaseUrl(url.toString(), process.cwd())
		expect(target.displayName).not.toContain('sup3r-s3cret-pw')
		const error = await withDoctorDatabase(target, process.cwd(), async () => 1).catch(
			(e: unknown) => e,
		)
		expect(error).toBeInstanceOf(Error)
		expect(String((error as Error).message)).not.toContain('sup3r-s3cret-pw')
		expect(String((error as Error).message)).toContain(target.displayName)
	})
})
