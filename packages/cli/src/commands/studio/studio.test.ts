import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { StudioDbReader, parseVersionStamp } from './db-reader'
import type { StudioServer } from './studio-server'
import { startStudioServer } from './studio-server'

/**
 * Studio contract: read a REAL Kora database (seeded through the actual Store
 * API, not hand-inserted rows) and expose records, per-field last writers,
 * operation history, and sync state — strictly read-only.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				completed: t.boolean().default(false),
			},
		},
	},
})

describe('Kora Studio', () => {
	let dir: string
	let dbPath: string
	let recordId: string
	let deletedId: string
	let reader: StudioDbReader
	let server: StudioServer

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'kora-studio-test-'))
		dbPath = join(dir, 'studio.db')

		// Seed through the real Store so every invariant (op log, field versions,
		// version vector) is authentic.
		const store = new Store({ schema, adapter: new BetterSqlite3Adapter(dbPath) })
		await store.open()
		const created = await store.collection('todos').insert({ title: 'first' })
		recordId = created.id
		await store.collection('todos').update(recordId, { completed: true })
		const doomed = await store.collection('todos').insert({ title: 'doomed' })
		deletedId = doomed.id
		await store.collection('todos').delete(deletedId)
		await store.close()

		reader = await StudioDbReader.open(dbPath)
		server = await startStudioServer({ port: 0, dbPath })
	})

	afterAll(async () => {
		await server.close()
		reader.close()
		rmSync(dir, { recursive: true, force: true })
	})

	test('rejects non-Kora databases', async () => {
		const strayPath = join(dir, 'not-kora.db')
		const Database = (await import('better-sqlite3')).default
		const stray = new Database(strayPath)
		stray.exec('CREATE TABLE plain (id TEXT)')
		stray.close()
		await expect(StudioDbReader.open(strayPath)).rejects.toThrow(/not look like a Kora database/)
	})

	test('overview reports collections, counts, and version vector', () => {
		const overview = reader.overview()
		expect(overview.dbPath).toBe(dbPath)
		const todos = overview.collections.find((c) => c.name === 'todos')
		expect(todos?.liveRecords).toBe(1)
		expect(todos?.tombstones).toBe(1)
		expect(todos?.operations).toBe(4) // 2 inserts + 1 update + 1 delete
		expect(todos?.columns).toEqual(['title', 'completed'])
		expect(overview.versionVector.length).toBeGreaterThan(0)
	})

	test('records hides tombstones by default and includes them on request', () => {
		const live = reader.records('todos')
		expect(live.total).toBe(1)
		expect(live.records[0]?.id).toBe(recordId)

		const all = reader.records('todos', { includeDeleted: true })
		expect(all.total).toBe(2)
		const tombstone = all.records.find((r) => r.id === deletedId)
		expect(tombstone?.deleted).toBe(true)
	})

	test('record detail exposes per-field last writers from _field_versions', () => {
		const record = reader.record('todos', recordId)
		expect(record?.fields.title).toBe('first')
		expect(record?.fields.completed).toBe(1) // raw column value (read-only view)

		// title was written by the insert; completed by the LATER update — their
		// per-field stamps must differ and completed's must be newer.
		const title = record?.fieldVersions.title
		const completed = record?.fieldVersions.completed
		expect(title).toBeDefined()
		expect(completed).toBeDefined()
		if (title && completed) {
			expect(completed.wallTime).toBeGreaterThanOrEqual(title.wallTime)
			expect(completed).not.toEqual(title)
		}
	})

	test('record operation history is newest-first and complete', () => {
		const ops = reader.recordOperations('todos', recordId)
		expect(ops.map((o) => o.type)).toEqual(['update', 'insert'])
		expect(ops[0]?.data).toEqual({ completed: true })
		expect(ops[0]?.previousData).toEqual({ completed: false })
		expect(ops[1]?.causalDeps).toEqual([])
		expect(ops[0]?.timestamp).not.toBeNull()
	})

	test('HTTP API serves overview, records, detail, and ops', async () => {
		const base = server.url

		const overview = (await (await fetch(`${base}/api/overview`)).json()) as {
			collections: Array<{ name: string }>
		}
		expect(overview.collections.map((c) => c.name)).toContain('todos')

		const records = (await (await fetch(`${base}/api/collections/todos/records`)).json()) as {
			total: number
		}
		expect(records.total).toBe(1)

		const detail = (await (
			await fetch(`${base}/api/collections/todos/records/${recordId}`)
		).json()) as { record: { id: string }; operations: unknown[] }
		expect(detail.record.id).toBe(recordId)
		expect(detail.operations).toHaveLength(2)

		const ops = (await (await fetch(`${base}/api/collections/todos/ops`)).json()) as {
			total: number
		}
		expect(ops.total).toBe(4)

		const missing = await fetch(`${base}/api/collections/nope/records`)
		expect(missing.status).toBe(404)
	})

	test('HTTP API is strictly read-only: non-GET methods are rejected', async () => {
		const post = await fetch(`${server.url}/api/overview`, { method: 'POST' })
		expect(post.status).toBe(405)
		const del = await fetch(`${server.url}/api/collections/todos/records/${recordId}`, {
			method: 'DELETE',
		})
		expect(del.status).toBe(405)
	})

	test('serves the UI shell, stylesheet, and application', async () => {
		const page = await fetch(server.url)
		expect(page.status).toBe(200)
		expect(await page.text()).toContain('Kora Studio')

		const app = await fetch(`${server.url}/app.js`)
		expect(app.status).toBe(200)
		expect(await app.text()).toContain('last writer')

		const css = await fetch(`${server.url}/style.css`)
		expect(css.status).toBe(200)
		expect(await css.text()).toContain('--accent')
	})

	test('parseVersionStamp round-trips serialized HLC stamps and rejects junk', () => {
		const parsed = parseVersionStamp('000001784407191895:00003:node-abc')
		expect(parsed).toEqual({ wallTime: 1784407191895, logical: 3, nodeId: 'node-abc' })
		expect(parseVersionStamp('')).toBeNull()
		expect(parseVersionStamp(null)).toBeNull()
		expect(parseVersionStamp('garbage')).toBeNull()
	})
})
