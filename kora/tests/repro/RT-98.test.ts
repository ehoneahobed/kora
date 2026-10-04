/**
 * RT-98 repro (final RC red team, STORE-10 / STORE-12): row changes that the syncing tab
 * makes WITHOUT a new operation never reach the other tabs' reactive queries. The local
 * operation bus broadcasts only `operation:created` and `operation:applied`. A terminal
 * rejection re-folds the record (Store.refoldRecordsOf), a scope retraction removes it,
 * provisional cascades settle, and an authority change re-folds: each invalidates only
 * the syncing tab's own subscriptions (store.ts invalidate calls). Every other tab on the
 * same database keeps showing the old result until an unrelated write to the collection,
 * even though its own `findById` already reads the new row.
 *
 * Two apps on one better-sqlite3 file stand in for two tabs (the bus is a real
 * BroadcastChannel). The syncing app writes a todo the server's validator refuses.
 *
 * Asserts CORRECT behaviour: the other tab's live query drops the refused todo.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { KoraSyncServer, MemoryServerStore } from '../../../packages/server/src/index'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), completed: t.boolean().default(false) } },
	},
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

type Row = { id: string; title: string }
type Todos = {
	insert: (d: Record<string, unknown>) => Promise<Row>
	findById: (id: string) => Promise<Row | null>
	where: (w: Record<string, unknown>) => {
		subscribe: (cb: (rows: Row[]) => void) => () => void
	}
}

describe('RT-98: re-folds in the syncing tab do not refresh other tabs', () => {
	test("a refused write disappears from the other tab's live query", async () => {
		const dir = mkdtempSync(join(tmpdir(), 'rt98-'))
		const file = join(dir, 'shared.db')
		server = new KoraSyncServer({
			store: new MemoryServerStore(),
			validateOperation: (op) =>
				op.collection === 'todos' &&
				op.type === 'insert' &&
				(op.data as { title?: string } | null)?.title === 'forbidden'
					? { action: 'reject', code: 'FORBIDDEN', message: 'no' }
					: { action: 'accept' },
		})
		// Tab A syncs; tab B shares the database and only renders.
		const tabA = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: file },
			sync: { url: 'ws://memory' },
		})
		await tabA.ready
		const tabB = createApp({ schema, store: { adapter: 'better-sqlite3', name: file } })
		await tabB.ready
		const todosA = (tabA as unknown as { todos: Todos }).todos
		const todosB = (tabB as unknown as { todos: Todos }).todos

		let seenOnB: Row[] = []
		const stop = todosB.where({}).subscribe((rows) => {
			seenOnB = rows
		})
		await tabA.sync?.connect()
		const refused = await todosA.insert({ title: 'forbidden' })
		// B's live query first shows the local write (bus: operation:created).
		for (let i = 0; i < 40 && seenOnB.length === 0; i++) await tick()
		expect(seenOnB.map((r) => r.id)).toContain(refused.id)

		// The server refuses it; tab A re-folds the record away.
		for (let i = 0; i < 60 && (await todosA.findById(refused.id)) !== null; i++) await tick()
		expect(await todosA.findById(refused.id)).toBeNull()
		// Tab B's own read agrees...
		expect(await todosB.findById(refused.id)).toBeNull()
		for (let i = 0; i < 10; i++) await tick()
		// ...but its live query must too.
		expect(seenOnB.map((r) => r.id)).not.toContain(refused.id)

		stop()
		await tabA.close()
		await tabB.close()
		await server.stop()
		rmSync(dir, { recursive: true, force: true })
	}, 30000)
})
