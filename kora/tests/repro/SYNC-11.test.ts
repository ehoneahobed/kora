/**
 * SYNC-11 repro: the server's accepted scope replaces activeScope after the handshake,
 * which changes the delivery-view signature without switching watermarks. On the next
 * handshake the client still sends its configured (undefined) scope, the server sees a
 * scope mismatch and restarts the stream from 0, and the client (watermark > 0) treats the
 * final batch as a duplicate: initial sync never completes and the engine is wedged in
 * 'syncing' (outbound queue never flushes). Asserts CORRECT behavior.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { KoraSyncServer, MemoryServerStore } from '../../../packages/server/src/index'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string() } },
		announcements: { fields: { text: t.string() } },
	},
})

let server: KoraSyncServer
/** A SyncTransport that opens a fresh in-memory session to `server` on every connect(). */
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

const settle = () => new Promise((r) => setTimeout(r, 50))
async function until(cond: () => boolean | Promise<boolean>, label: string): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (await cond()) return
		await settle()
	}
	throw new Error(`condition never held: ${label}`)
}

type Coll = {
	insert: (d: Record<string, unknown>) => Promise<{ id: string }>
	findById: (id: string) => Promise<Record<string, unknown> | null>
}

describe('SYNC-11: server-accepted scope differs from requested scope', () => {
	test('after reconnect the client returns to streaming and uploads new writes', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'sync11-'))
		const store = new MemoryServerStore()
		await store.setSchema(schema)
		server = new KoraSyncServer({
			store,
			schemaVersion: 1,
			// Ordinary (non-directional) server-auth scope: user sees all todos/announcements.
			auth: {
				async authenticate() {
					return { userId: 'u1', scopes: { todos: {}, announcements: {} } }
				},
			},
		})
		const app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: join(dir, 'a.db') },
			sync: { url: 'ws://memory', auth: async () => ({ token: 't' }) },
		})
		await app.ready
		await app.sync?.connect()
		const todos = (app as unknown as { todos: Coll }).todos
		const first = await todos.insert({ title: 'one' })
		await until(
			() => store.getAllOperations().some((op) => op.recordId === first.id),
			'first uploaded',
		)
		await until(() => (app.sync?.getStatus().deliveryWatermark ?? 0) > 0, 'watermark advanced')

		await app.sync?.reconnect()
		await settle()
		await settle()
		expect(app.sync?.getStatus().phase, 'engine wedged after reconnect').toBe('streaming')

		const second = await todos.insert({ title: 'two' })
		await until(
			() => store.getAllOperations().some((op) => op.recordId === second.id),
			'write after reconnect uploaded',
		)

		await app.close()
		rmSync(dir, { recursive: true, force: true })
	}, 30000)
})
