/**
 * SYNC-10 repro: timers/async work outlive stop()/close().
 *  (a) After an UNREQUESTED transport close the engine is 'disconnected'; app.close()
 *      then calls engine.stop(), which returns early for 'disconnected' and never clears
 *      the awareness cleanup interval or the query-subset reconnect debounce.
 *  (b) With E2E encryption, a batch whose encryption is in flight when stop() runs is
 *      still sent afterwards: transport.send throws inside an un-awaited .then and
 *      surfaces as an unhandled promise rejection.
 * Asserts CORRECT behavior.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import { TestServer } from '@korajs/test'
import { afterEach, describe, expect, test, vi } from 'vitest'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), completed: t.boolean().default(false) } },
	},
})

let server: TestServer
const serverSides: Array<{ close(): void }> = []
/** A SyncTransport that opens a fresh in-memory session to `server` on every connect(). */
class ReconnectableMemoryTransport implements SyncTransport {
	private inner: ReturnType<typeof createServerTransportPair>['client'] | null = null
	private onMsg: (m: SyncMessage) => void = () => {}
	private onCls: (r: string) => void = () => {}
	private onErr: (e: Error) => void = () => {}
	async connect(): Promise<void> {
		const pair = createServerTransportPair()
		serverSides.push(pair.server)
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

type Todos = {
	insert: (d: Record<string, unknown>) => Promise<{ id: string }>
	where: (w: Record<string, unknown>) => { subscribe: (cb: (r: unknown[]) => void) => () => void }
}

describe('SYNC-10: timers and async sends outlive stop/close', () => {
	test('(a) close after an unrequested disconnect clears engine timers', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'sync10a-'))
		server = new TestServer(schema)
		const app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: join(dir, 'a.db') },
			sync: { url: 'ws://memory', autoReconnect: false },
		})
		await app.ready
		await app.sync?.connect()
		for (let i = 0; i < 40 && app.sync?.getStatus().status !== 'synced'; i++) await tick()
		const engine = app.getSyncEngine() as unknown as {
			querySubsetReconnectTimer: unknown
			getAwarenessManager(): { cleanupTimer: unknown }
		}
		expect(engine.getAwarenessManager().cleanupTimer).not.toBeNull()

		// Server drops the connection (not requested by the app).
		serverSides[serverSides.length - 1]?.close()
		// A query subscription change schedules the debounced reconnect.
		;(app as unknown as { todos: Todos }).todos.where({ completed: false }).subscribe(() => {})
		await tick()
		await app.close()

		expect(engine.getAwarenessManager().cleanupTimer, 'awareness interval leaked').toBeNull()
		expect(engine.querySubsetReconnectTimer, 'subset reconnect timer leaked').toBeNull()
		await server.close()
		rmSync(dir, { recursive: true, force: true })
	}, 20000)

	test('(b) stop() during batch encryption does not send or reject unhandled', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'sync10b-'))
		server = new TestServer(schema)
		const unhandled: unknown[] = []
		const onUnhandled = (reason: unknown) => unhandled.push(reason)
		process.on('unhandledRejection', onUnhandled)
		try {
			const app = createApp({
				schema,
				store: { adapter: 'better-sqlite3', name: join(dir, 'a.db') },
				sync: {
					url: 'ws://memory',
					autoReconnect: false,
					encryption: { enabled: true, key: 'pass', salt: new Uint8Array(16) } as never,
				},
			})
			await app.ready
			await app.sync?.connect()
			for (let i = 0; i < 40 && app.sync?.getStatus().status !== 'synced'; i++) await tick()
			const todos = (app as unknown as { todos: Todos }).todos
			const engine = app.getSyncEngine() as unknown as { currentBatch: unknown; stop(): Promise<void> }
			await todos.insert({ title: 'secret' }) // push -> flushQueue -> async encrypt
			// Stop exactly while the batch is being encrypted (in flight, not yet sent).
			for (let i = 0; i < 1000 && !engine.currentBatch; i++) await Promise.resolve()
			expect(engine.currentBatch, 'batch should be in flight').toBeTruthy()
			await engine.stop()
			await tick()
			await tick()
			expect(unhandled.map(String), 'send after stop rejected unhandled').toEqual([])
			await app.close()
		} finally {
			process.off('unhandledRejection', onUnhandled)
			await server.close()
			rmSync(dir, { recursive: true, force: true })
		}
	}, 20000)
})
