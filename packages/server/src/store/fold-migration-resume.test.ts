/**
 * The startup re-materialization and the scope snapshot rebuild commit in bounded
 * batches of whole records, so a process killed part-way (a startup probe) resumes at
 * the records still to do instead of starting over, and the result is the same as an
 * uninterrupted run. The kill is simulated by a batch that throws.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Operation, defineSchema, t } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterEach, describe, expect, test } from 'vitest'
import { PostgresServerStore } from './postgres-server-store'
import { FOLD_MIGRATION_BATCH } from './record-fold'
import { type SqliteServerStore, createSqliteServerStore } from './sqlite-server-store'

const schema = defineSchema({
	version: 1,
	collections: { docs: { fields: { title: t.string(), owner: t.string() } } },
})

let seq = 0
function op(recordId: string, type: Operation['type'], data: Record<string, unknown>): Operation {
	seq += 1
	return {
		id: `resume-${seq}`,
		nodeId: 'device',
		type,
		collection: 'docs',
		recordId,
		data,
		previousData: null,
		timestamp: { wallTime: 1_000 + seq, logical: 0, nodeId: 'device' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		hashVersion: 2,
	}
}

/** Interrupts the `nth` call of a private batch method of `store` (a killed process). */
function killAt(
	store: SqliteServerStore | PostgresServerStore,
	method: string,
	nth: number,
): { calls: () => number } {
	const target = store as unknown as Record<string, (...args: unknown[]) => unknown>
	const original = target[method]
	if (typeof original !== 'function') throw new Error(`no method ${method}`)
	let calls = 0
	target[method] = (...args: unknown[]) => {
		calls++
		if (calls === nth) throw new Error('killed')
		return original.apply(store, args)
	}
	return { calls: () => calls }
}

/** Counts calls of a private batch method of `store`. */
function countCalls(store: SqliteServerStore | PostgresServerStore, method: string): () => number {
	const target = store as unknown as Record<string, (...args: unknown[]) => unknown>
	const original = target[method]
	if (typeof original !== 'function') throw new Error(`no method ${method}`)
	let calls = 0
	target[method] = (...args: unknown[]) => {
		calls++
		return original.apply(store, args)
	}
	return () => calls
}

describe('sqlite: an interrupted migration resumes', () => {
	const dirs: string[] = []
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
	})

	function file(): string {
		const dir = mkdtempSync(join(tmpdir(), 'kora-test-resume-'))
		dirs.push(dir)
		return join(dir, 'server.db')
	}

	test('re-folding: committed batches are not redone after a kill', async () => {
		const filename = file()
		const first = createSqliteServerStore({ filename, nodeId: 'server' })
		const ops: Operation[] = []
		// 900 operations per record: two records per 2,000-operation transaction.
		for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) {
			ops.push(op(id, 'insert', { title: `${id}-0`, owner: 'alice' }))
			for (let i = 1; i < 900; i++) ops.push(op(id, 'update', { title: `${id}-${i}` }))
		}
		for (const operation of ops) await first.applyRemoteOperation(operation)
		killAt(first, 'refoldRecords', 2)
		await expect(first.setSchema(schema)).rejects.toThrow('killed')
		await first.close()

		const second = createSqliteServerStore({ filename, nodeId: 'server' })
		const batches = countCalls(second, 'refoldRecords')
		await second.setSchema(schema)
		// [r1, r2] committed before the kill; [r3, r4] and [r5] remain.
		expect(second.getFoldMigrationReport().records).toBe(3)
		expect(batches()).toBe(2)
		for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) {
			expect((await second.findRecord('docs', id))?.title).toBe(`${id}-899`)
		}
		const snapshots = await second.getOperationScopeSnapshots(ops.map((o) => o.id))
		expect(snapshots.size).toBe(ops.length)
		expect(snapshots.get(ops[ops.length - 1]?.id ?? '')?.post?.title).toBe('r5-899')
		await second.close()
	}, 60_000)

	test('scope snapshot rebuild: snapshots rebuilt before a kill are kept', async () => {
		const filename = file()
		const first = createSqliteServerStore({ filename, nodeId: 'server' })
		const records = FOLD_MIGRATION_BATCH + 200
		const ops: Operation[] = []
		for (let i = 0; i < records; i++)
			ops.push(op(`s${i}`, 'insert', { title: `t${i}`, owner: 'bob' }))
		for (const operation of ops) await first.applyRemoteOperation(operation)
		killAt(first, 'backfillScopeSnapshotChunk', 2)
		await expect(first.setSchema(schema)).rejects.toThrow('killed')
		await first.close()

		const second = createSqliteServerStore({ filename, nodeId: 'server' })
		const chunks = countCalls(second, 'backfillScopeSnapshotChunk')
		await second.setSchema(schema)
		// The first chunk's snapshots survived the restart: only the rest is rebuilt.
		expect(chunks()).toBe(1)
		const snapshots = await second.getOperationScopeSnapshots(ops.map((o) => o.id))
		expect(snapshots.size).toBe(ops.length)
		for (const [index, operation] of ops.entries()) {
			expect(snapshots.get(operation.id)?.post?.title).toBe(`t${index}`)
		}
		await second.close()

		// The rebuild completed: a later start rebuilds nothing.
		const third = createSqliteServerStore({ filename, nodeId: 'server' })
		const none = countCalls(third, 'backfillScopeSnapshotChunk')
		await third.setSchema(schema)
		expect(none()).toBe(0)
		await third.close()
	}, 60_000)
})

const PG_URL = process.env.KORA_PG_TEST_URL

describe.skipIf(!PG_URL)('postgres: an interrupted re-materialization resumes', () => {
	test('committed batches are not redone after a kill', async () => {
		const name = `kora_resume_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
		const admin = postgres(PG_URL ?? '', { max: 1, onnotice: () => {} })
		await admin.unsafe(`CREATE SCHEMA ${name}`)
		const clients: ReturnType<typeof postgres>[] = []
		const connect = (): PostgresServerStore => {
			const client = postgres(PG_URL ?? '', {
				max: 4,
				onnotice: () => {},
				connection: { search_path: name },
			})
			clients.push(client)
			return new PostgresServerStore(drizzle(client), 'server-pg')
		}
		try {
			const first = connect()
			const ops: Operation[] = []
			for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) {
				ops.push(op(id, 'insert', { title: `${id}-0`, owner: 'alice' }))
				for (let i = 1; i < 900; i++) ops.push(op(id, 'update', { title: `${id}-${i}` }))
			}
			for (const operation of ops) await first.applyRemoteOperation(operation)
			killAt(first, 'refoldRecords', 2)
			await expect(first.setSchema(schema)).rejects.toThrow('killed')
			await first.close()

			const second = connect()
			const batches = countCalls(second, 'refoldRecords')
			await second.setSchema(schema)
			expect(second.getFoldMigrationReport().records).toBe(3)
			expect(batches()).toBe(2)
			for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) {
				expect((await second.findRecord('docs', id))?.title).toBe(`${id}-899`)
			}
			const snapshots = await second.getOperationScopeSnapshots(ops.map((o) => o.id))
			expect(snapshots.size).toBe(ops.length)
			await second.close()
		} finally {
			await Promise.all(clients.map((client) => client.end()))
			await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
			await admin.end()
		}
	}, 120_000)
})
