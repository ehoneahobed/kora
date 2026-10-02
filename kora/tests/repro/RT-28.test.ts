/**
 * RT-28 repro: status accuracy after the server has a device's operations.
 *  (a) Operations made while offline stay counted as pending after the server stored
 *      them: the pending count was computed against min(handshake-advertised own
 *      sequence, acknowledged own sequence), and the handshake value is the server's
 *      state BEFORE this session's uploads, so nothing below it moved until the next
 *      handshake.
 *  (b) `app.sync.waitForSettled()` resolves late (on an unrelated later event, about the
 *      5s diagnostics tick) because an upload ack and the move to streaming emit no
 *      status event (plan §6 observation).
 * Asserts CORRECT behavior.
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
	collections: { todos: { fields: { title: t.string() } } },
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
const tick = () => new Promise((r) => setTimeout(r, 25))

type Todos = { insert: (d: Record<string, unknown>) => Promise<{ id: string }> }

describe('RT-28: pending count and settlement after the server has the operations', () => {
	test('offline writes stop counting as pending once the server stores them', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'rt28a-'))
		const store = new MemoryServerStore()
		server = new KoraSyncServer({ store })
		const app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: join(dir, 'a.db') },
			sync: { url: 'ws://memory', autoReconnect: false },
		})
		try {
			await app.ready
			const todos = (app as unknown as { todos: Todos }).todos
			// The server already holds this device's first write, so its handshake vector
			// advertises a non-zero own sequence below the offline writes that follow.
			const first = await todos.insert({ title: 'online' })
			await app.sync?.connect()
			for (let i = 0; i < 80; i++) {
				if (store.getAllOperations().some((op) => op.recordId === first.id)) break
				await tick()
			}
			await app.sync?.disconnect()
			// Written while offline, uploaded in the next session's handshake delta.
			const rows = [await todos.insert({ title: 'one' }), await todos.insert({ title: 'two' })]
			await app.sync?.connect()
			for (let i = 0; i < 80; i++) {
				const stored = new Set(store.getAllOperations().map((op) => op.recordId))
				if (rows.every((r) => stored.has(r.id))) break
				await tick()
			}
			const stored = new Set(store.getAllOperations().map((op) => op.recordId))
			expect(
				rows.every((r) => stored.has(r.id)),
				'precondition: server stored both',
			).toBe(true)
			for (let i = 0; i < 20 && (app.sync?.getStatus().pendingOperations ?? 0) > 0; i++) {
				await tick()
			}
			expect(
				app.sync?.getStatus().pendingOperations,
				'server has the ops, but they are still counted as pending',
			).toBe(0)
			expect(app.sync?.getStatus().status).toBe('synced')
		} finally {
			await app.close()
			await server.stop()
			rmSync(dir, { recursive: true, force: true })
		}
	}, 20000)

	test('waitForSettled resolves promptly once uploads are acknowledged', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'rt28b-'))
		const store = new MemoryServerStore()
		server = new KoraSyncServer({ store })
		const app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: join(dir, 'b.db') },
			sync: { url: 'ws://memory', autoReconnect: false },
		})
		try {
			await app.ready
			const todos = (app as unknown as { todos: Todos }).todos
			await todos.insert({ title: 'offline' })
			await app.sync?.connect()
			const started = Date.now()
			const result = await app.sync?.waitForSettled({ timeoutMs: 4000 })
			const elapsed = Date.now() - started
			expect(result?.outcome, `outcome after ${elapsed}ms`).toBe('settled')
			expect(elapsed, 'settlement noticed only at a later unrelated event').toBeLessThan(1500)

			// Already settled: resolves immediately, not at the next diagnostics tick.
			const again = Date.now()
			const second = await app.sync?.waitForSettled({ timeoutMs: 4000 })
			expect(second?.outcome).toBe('settled')
			expect(Date.now() - again).toBeLessThan(500)

			// A write while streaming: settles as soon as its ack arrives.
			await todos.insert({ title: 'live' })
			const live = Date.now()
			const third = await app.sync?.waitForSettled({ timeoutMs: 4000 })
			expect(third?.outcome).toBe('settled')
			expect(Date.now() - live).toBeLessThan(1500)
		} finally {
			await app.close()
			await server.stop()
			rmSync(dir, { recursive: true, force: true })
		}
	}, 20000)
})
