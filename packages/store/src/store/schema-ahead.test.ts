import 'fake-indexeddb/auto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type KoraEvent, defineSchema, migrate, t } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { IndexedDbAdapter } from '../adapters/indexeddb-adapter'
import { SqliteWasmAdapter } from '../adapters/sqlite-wasm-adapter'
import type { WorkerBridge, WorkerRequest, WorkerResponse } from '../adapters/sqlite-wasm-channel'
import { MockWorkerBridge } from '../adapters/sqlite-wasm-mock-bridge'
import { SchemaVersionAheadError } from '../errors'
import { parseSchemaAhead, schemaAheadMessage } from '../migrations/schema-ceiling'
import { Store } from './store'

/**
 * RT-109 (b): a build never opens a database a NEWER build already migrated. The store
 * refuses with `SchemaVersionAheadError` and `store:schema-ahead`, and nothing in the
 * database changes (not even this build's additive DDL).
 */

const v1 = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), done: t.boolean().default(false) } } },
})
const v2 = defineSchema({
	version: 2,
	collections: { todos: { fields: { name: t.string(), done: t.boolean().default(false) } } },
	migrations: { 2: migrate().renameField('todos', 'title', 'name') },
})

let tmpDir: string
beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'kora-schema-ahead-'))
})
afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true })
})

function recorder(): { emitter: SimpleEventEmitter; events: KoraEvent[] } {
	const emitter = new SimpleEventEmitter()
	const events: KoraEvent[] = []
	emitter.on('store:schema-ahead', (event) => events.push(event))
	return { emitter, events }
}

async function columns(adapter: BetterSqlite3Adapter): Promise<string[]> {
	const rows = await adapter.query<{ name: string }>("SELECT name FROM pragma_table_info('todos')")
	return rows.map((row) => row.name).sort()
}

describe('Store refuses a database a newer build migrated (RT-109)', () => {
	test('native SQLite: refused before any DDL, typed error and event, database unchanged', async () => {
		const path = join(tmpDir, 'native.db')
		const old = new Store({ schema: v1, adapter: new BetterSqlite3Adapter(path), nodeId: 'n1' })
		await old.open()
		await old.collection('todos').insert({ title: 'from v1' })
		await old.close()
		const upgraded = new Store({
			schema: v2,
			adapter: new BetterSqlite3Adapter(path),
			nodeId: 'n1',
		})
		await upgraded.open()
		await upgraded.close()

		const probe = new BetterSqlite3Adapter(path)
		await probe.open(v2)
		const before = await columns(probe)
		await probe.close()
		expect(before).toContain('name')
		expect(before).not.toContain('title')

		const { emitter, events } = recorder()
		const stale = new Store({
			schema: v1,
			adapter: new BetterSqlite3Adapter(path),
			nodeId: 'n1',
			emitter,
		})
		const error = await stale.open().then(
			() => null,
			(e: unknown) => e,
		)
		expect(error).toBeInstanceOf(SchemaVersionAheadError)
		expect(error).toMatchObject({ code: 'SCHEMA_VERSION_AHEAD', storedVersion: 2, codeVersion: 1 })
		expect(events).toEqual([
			expect.objectContaining({
				type: 'store:schema-ahead',
				dbName: 'kora-db',
				storedVersion: 2,
				codeVersion: 1,
			}),
		])

		// Not even v1's additive DDL ran: no `title` column came back.
		const after = new BetterSqlite3Adapter(path)
		await after.open(v2)
		expect(await columns(after)).toEqual(before)
		await after.close()
		// The newer build still opens it.
		const again = new Store({ schema: v2, adapter: new BetterSqlite3Adapter(path), nodeId: 'n1' })
		await again.open()
		expect((await again.collection('todos').where({}).exec()).map((r) => r.name)).toEqual([
			'from v1',
		])
		await again.close()
	})

	test('IndexedDB fallback: the restored snapshot is refused and not rewritten', async () => {
		const dbName = `schema-ahead-idb-${process.pid}`
		const upgraded = new Store({
			schema: v2,
			adapter: new IndexedDbAdapter({ bridge: new MockWorkerBridge(), dbName }),
			nodeId: 'n1',
			dbName,
		})
		await upgraded.open()
		await upgraded.collection('todos').insert({ name: 'from v2' })
		await upgraded.close()

		const { emitter, events } = recorder()
		const stale = new Store({
			schema: v1,
			adapter: new IndexedDbAdapter({ bridge: new MockWorkerBridge(), dbName }),
			nodeId: 'n1',
			dbName,
			emitter,
		})
		await expect(stale.open()).rejects.toBeInstanceOf(SchemaVersionAheadError)
		expect(events).toHaveLength(1)

		const again = new Store({
			schema: v2,
			adapter: new IndexedDbAdapter({ bridge: new MockWorkerBridge(), dbName }),
			nodeId: 'n1',
			dbName,
		})
		await again.open()
		expect((await again.collection('todos').where({}).exec()).map((r) => r.name)).toEqual([
			'from v2',
		])
		await again.close()
	})

	test('a refusal from the SQLite WASM worker is mapped to the typed error', async () => {
		class AheadBridge implements WorkerBridge {
			private readonly inner = new MockWorkerBridge()
			async send(request: WorkerRequest): Promise<WorkerResponse> {
				if (request.type === 'open') {
					return {
						id: request.id,
						type: 'error',
						message: schemaAheadMessage(3, 1),
						code: 'INIT_ERROR',
					}
				}
				return this.inner.send(request)
			}
			terminate(): void {
				this.inner.terminate()
			}
		}
		const { emitter, events } = recorder()
		const stale = new Store({
			schema: v1,
			adapter: new SqliteWasmAdapter({ bridge: new AheadBridge() }),
			nodeId: 'n1',
			emitter,
		})
		await expect(stale.open()).rejects.toMatchObject({
			name: 'SchemaVersionAheadError',
			storedVersion: 3,
			codeVersion: 1,
		})
		expect(events).toHaveLength(1)
	})

	test('parseSchemaAhead reads the marker through wrapping errors', () => {
		const inner = new Error(schemaAheadMessage(5, 4))
		const outer = new Error('Worker initialization failed', { cause: inner })
		expect(parseSchemaAhead(outer)).toEqual({ stored: 5, code: 4 })
		expect(parseSchemaAhead(new Error('other'))).toBeNull()
	})
})
