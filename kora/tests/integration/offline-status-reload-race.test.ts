/**
 * The offline status after a reload (store, sync engine and status reducer together).
 *
 * A query that subscribes while the sync engine's start is still reading the stored delivery
 * watermarks used to save the engine's initial 0 over the stored position. The completion mark
 * (recorded at that position) then disagreed with the view's watermark and the status stayed
 * `data-incomplete` for good. It surfaced only in real browsers, and only sometimes.
 */
import 'fake-indexeddb/auto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { KoraSyncServer, MemoryServerStore } from '../../../packages/server/src/index'
import { createServerTransportPair } from '../../../packages/server/src/internal'

let server: KoraSyncServer
let reachable = true

class MemoryTransport implements SyncTransport {
	private inner: ReturnType<typeof createServerTransportPair>['client'] | null = null
	private onMsg: (m: SyncMessage) => void = () => {}
	private onCls: (r: string) => void = () => {}
	private onErr: (e: Error) => void = () => {}
	async connect(): Promise<void> {
		if (!reachable) throw new Error('offline')
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
	createSyncTransport: () => new MemoryTransport(),
}))

const { createApp } = await import('../../src/create-app')
type App = ReturnType<typeof createApp>

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

interface Todos {
	insert(data: { title: string }): Promise<{ id: string }>
	where(conditions: Record<string, unknown>): {
		subscribe(cb: (rows: unknown[]) => void): () => void
	}
}
const todos = (app: App): Todos => (app as unknown as { todos: Todos }).todos

let dir: string
const apps: App[] = []

async function until(check: () => boolean, label: string): Promise<void> {
	for (let i = 0; i < 400; i++) {
		if (check()) return
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error(`timed out waiting for ${label}`)
}

const open = (file = 'app.db'): App => {
	const app = createApp({
		schema,
		store: { adapter: 'better-sqlite3', name: join(dir, file) },
		sync: { url: 'ws://memory' },
	})
	apps.push(app)
	return app
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'kora-offline-reload-'))
	reachable = true
	server = new KoraSyncServer({ store: new MemoryServerStore('offline-reload') })
})

afterEach(async () => {
	for (const app of apps.splice(0)) await app.close().catch(() => undefined)
	await server.stop()
	rmSync(dir, { recursive: true, force: true })
	vi.restoreAllMocks()
})

describe('offline data status after a reload', () => {
	test('a query that subscribes while the start reads the stored watermarks keeps the data complete', async () => {
		// Another device put a record on the server, so this device's view has a delivery position.
		const other = open('other.db')
		await other.ready
		await todos(other).insert({ title: 'from another device' })
		await other.sync?.connect()
		await until(
			() => other.getSyncEngine()?.getStatus().pendingOperations === 0,
			'the other device to upload',
		)
		await other.close()

		// Session 1, online: sync the data down and up until the device proves it holds the view.
		const first = open()
		await first.ready
		// The app shows the list, so the view the device syncs is the one that query asks for.
		const unsubscribeFirst = todos(first)
			.where({})
			.subscribe(() => {})
		await todos(first).insert({ title: 'kept offline' })
		await first.sync?.connect()
		await until(() => first.offline.status().data.state === 'complete', 'the first mark')
		unsubscribeFirst()
		await first.close()

		// Session 2: reload with the network gone. The query subscribes in the same tick as the
		// connect attempt, while the engine's start is awaiting the stored watermarks.
		reachable = false
		const second = open()
		await second.ready
		const connecting = second.sync?.connect().catch(() => undefined)
		const unsubscribe = todos(second)
			.where({})
			.subscribe(() => {})
		await connecting
		await until(
			() => second.offline.status().data.state === 'complete',
			'the data mark after reload',
		)
		expect(second.offline.status().data.state).toBe('complete')
		unsubscribe()
	})
})
