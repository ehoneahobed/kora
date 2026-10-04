/**
 * RT-101 repro (final RC red team, value domain): extending an enum in a schema upgrade
 * leaves the old `CHECK (col IN (...))` on every existing table. The value domain says
 * the new value is valid (`validateRecord` accepts it on every replica), but:
 * - an upgraded device's own insert of the new value throws (SQLite CHECK constraint);
 * - the upgraded server store refuses a fresh device's write of it terminally
 *   (`UNSTORABLE_VALUE`, class 23 / SQLITE_CONSTRAINT_CHECK), so the write is undone on
 *   its author.
 * There is no migration step that changes an enum's values (addField, removeField,
 * renameField, addIndex, removeIndex, backfill), so an app cannot repair it short of
 * dropping the column. Adding an enum value is one of the most common schema changes.
 *
 * Asserts CORRECT behaviour: a value the schema accepts is stored by every replica.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, migrate, t } from '@korajs/core'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { KoraSyncServer, createSqliteServerStore } from '../../../packages/server/src/index'

const v1 = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), priority: t.enum(['low', 'high']).default('low') } },
	},
})
const v2 = defineSchema({
	version: 2,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				priority: t.enum(['low', 'high', 'urgent']).default('low'),
				// A real migration step, so the version bump is well-formed.
				note: t.string().optional(),
			},
		},
	},
	migrations: { 2: migrate().addField('todos', 'note', t.string().optional()) },
})

let server: KoraSyncServer
class ReconnectableMemoryTransport implements SyncTransport {
	private inner: ReturnType<typeof createServerTransportPair>['client'] | null = null
	private onMsg: (m: SyncMessage) => void = () => {}
	private onCls: (r: string) => void = () => {}
	private onErr: (e: Error) => void = () => {}
	async connect(): Promise<void> {
		const pair = createServerTransportPair()
		this.inner = pair.client
		pair.client.onMessage((m) => this.onMsg(m))
		pair.client.onClose((r) => this.onCls(r))
		pair.client.onError((e) => this.onErr(e))
		server.handleConnection(pair.server)
	}
	async disconnect(): Promise<void> {
		await this.inner?.disconnect()
	}
	send(message: SyncMessage): void {
		if (!this.inner) throw new Error('not connected')
		this.inner.send(message)
	}
	onMessage(h: (m: SyncMessage) => void): void {
		this.onMsg = h
	}
	onClose(h: (r: string) => void): void {
		this.onCls = h
	}
	onError(h: (e: Error) => void): void {
		this.onErr = h
	}
	isConnected(): boolean {
		return this.inner?.isConnected() ?? false
	}
}

vi.mock('../../src/create-sync-transport', () => ({
	createSyncTransport: () => new ReconnectableMemoryTransport(),
}))

const { createApp } = await import('../../src/create-app')
const tick = () => new Promise((r) => setTimeout(r, 50))

type Row = { id: string; priority: string }
type Todos = {
	insert: (d: Record<string, unknown>) => Promise<Row>
	findById: (id: string) => Promise<Row | null>
}

describe('RT-101: enum values added by a schema upgrade are refused by existing tables', () => {
	test('an upgraded device stores the new enum value', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'rt101-'))
		const file = join(dir, 'a.db')
		const before = createApp({ schema: v1, store: { adapter: 'better-sqlite3', name: file } })
		await before.ready
		await (before as unknown as { todos: Todos }).todos.insert({ title: 'old' })
		await before.close()

		const after = createApp({ schema: v2, store: { adapter: 'better-sqlite3', name: file } })
		await after.ready
		const outcome = await (after as unknown as { todos: Todos }).todos
			.insert({ title: 'new', priority: 'urgent' })
			.then(
				(row) => row.priority,
				(error: Error) => `threw: ${error.message}`,
			)
		expect(outcome).toBe('urgent')
		await after.close()
		rmSync(dir, { recursive: true, force: true })
	}, 20000)

	test("an upgraded server keeps a fresh device's write of the new enum value", async () => {
		const dir = mkdtempSync(join(tmpdir(), 'rt101-'))
		const serverFile = join(dir, 'server.db')
		const first = createSqliteServerStore({ filename: serverFile })
		first.setSchema(v1)
		server = new KoraSyncServer({ store: first })
		// The v1 deployment ran and created its tables.
		const old = createApp({
			schema: v1,
			store: { adapter: 'better-sqlite3', name: join(dir, 'old.db') },
			sync: { url: 'ws://memory' },
		})
		await old.ready
		await old.sync?.connect()
		await (old as unknown as { todos: Todos }).todos.insert({ title: 'v1 row' })
		for (let i = 0; i < 40 && first.getAllOperations?.().length === 0; i++) await tick()
		await old.close()
		await server.stop()

		// Deploy v2: same database file, new schema.
		const upgraded = createSqliteServerStore({ filename: serverFile })
		upgraded.setSchema(v2)
		server = new KoraSyncServer({ store: upgraded })
		const fresh = createApp({
			schema: v2,
			store: { adapter: 'better-sqlite3', name: join(dir, 'fresh.db') },
			sync: { url: 'ws://memory' },
		})
		await fresh.ready
		const rejections: string[] = []
		fresh.events?.on?.('sync:operation-rejected', (e: { code?: string }) =>
			rejections.push(String(e.code)),
		)
		await fresh.sync?.connect()
		const row = await (fresh as unknown as { todos: Todos }).todos.insert({
			title: 'v2 row',
			priority: 'urgent',
		})
		for (let i = 0; i < 60 && rejections.length === 0; i++) await tick()
		expect(rejections).toEqual([])
		expect((await (fresh as unknown as { todos: Todos }).todos.findById(row.id))?.priority).toBe(
			'urgent',
		)
		await fresh.close()
		await server.stop()
		rmSync(dir, { recursive: true, force: true })
	}, 30000)
})
