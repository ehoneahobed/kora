/**
 * SYNC-2 repro: inbound operations are filtered by the UPLINK scope instead of the
 * downlink scope. With directional scopes (read-only collection), operations the server
 * legitimately delivers are dropped while the delivery watermark advances past them.
 * Asserts CORRECT behavior: fails today, passes once fixed.
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

describe('SYNC-2: inbound filtered by uplink scope', () => {
	test('reader with read-only announcements (downlink yes, uplink no) must receive announcements', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'sync2-'))
		const store = new MemoryServerStore()
		await store.setSchema(schema)
		server = new KoraSyncServer({
			store,
			schemaVersion: 1,
			auth: {
				async authenticate(token: string) {
					if (token === 'admin')
						return { userId: 'admin', scopes: { todos: {}, announcements: {} } }
					// Reader: may READ announcements but only WRITE todos.
					return {
						userId: 'reader',
						downlinkScopes: { todos: {}, announcements: {} },
						uplinkScopes: { todos: {} },
					}
				},
			},
		})

		const admin = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: join(dir, 'admin.db') },
			sync: { url: 'ws://memory', auth: async () => ({ token: 'admin' }) },
		})
		await admin.ready
		await admin.sync?.connect()
		const ann = await (admin as unknown as { announcements: Coll }).announcements.insert({
			text: 'hello',
		})
		await until(() => store.getAllOperations().some((op) => op.recordId === ann.id), 'uploaded')

		const reader = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: join(dir, 'reader.db') },
			sync: { url: 'ws://memory', auth: async () => ({ token: 'reader' }) },
		})
		await reader.ready
		await reader.sync?.connect()
		await until(() => reader.sync?.getStatus().status === 'synced', 'reader synced')
		await settle()
		const status = reader.sync?.getStatus()
		const readerAnns = (reader as unknown as { announcements: Coll }).announcements
		// Watermark already covers the announcement (server frontier reached)...
		expect(status?.deliveryWatermark).toBe(status?.serverFrontier)
		// ...so it must be present locally.
		expect(await readerAnns.findById(ann.id), 'announcement dropped on ingest').not.toBeNull()

		// And reconnecting must not be required, but must not "fix" it silently either.
		await reader.sync?.reconnect()
		await until(() => reader.sync?.getStatus().status === 'synced', 'reader re-synced')
		await settle()
		expect(await readerAnns.findById(ann.id), 'still missing after reconnect').not.toBeNull()

		await admin.close()
		await reader.close()
		await server.close?.()
		rmSync(dir, { recursive: true, force: true })
	}, 30000)
})
