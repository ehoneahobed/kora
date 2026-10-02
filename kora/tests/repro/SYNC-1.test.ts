/**
 * SYNC-1 repro: a local edit that moves a record OUT of an active reactive-query
 * subset must still be uploaded. Query subsets narrow the DOWNLINK (server docs and
 * server code: "Upload authorization is independent from the client's downloaded/query
 * view"), but the client applies them to its own outbound ops.
 *
 * Asserts CORRECT behavior: fails today, passes once fixed.
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

const dir = mkdtempSync(join(tmpdir(), 'sync1-'))
afterEach(() => {
	/* per-test cleanup below */
})

type Todos = {
	insert: (d: Record<string, unknown>) => Promise<{ id: string }>
	update: (id: string, d: Record<string, unknown>) => Promise<unknown>
	findById: (id: string) => Promise<Record<string, unknown> | null>
	where: (w: Record<string, unknown>) => { subscribe: (cb: (r: unknown[]) => void) => () => void }
}

const settle = () => new Promise((r) => setTimeout(r, 50))
async function until(cond: () => boolean | Promise<boolean>, label: string): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (await cond()) return
		await settle()
	}
	throw new Error(`condition never held: ${label}`)
}

describe('SYNC-1: edits leaving a reactive query subset are never uploaded', () => {
	test('A marks a todo completed under where({completed:false}); server and B must eventually see completed=true, including after reconnect', async () => {
		server = new TestServer(schema)
		const appA = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: join(dir, 'a.db') },
			sync: { url: 'ws://memory' },
		})
		await appA.ready
		const todosA = (appA as unknown as { todos: Todos }).todos
		await appA.sync?.connect()
		const serverOps = () => server.getAllOperations()

		const { id } = await todosA.insert({ title: 'Ship' })
		await until(() => serverOps().some((op) => op.recordId === id), 'insert uploaded')

		// Reactive query: auto-registers sync subset {todos, where:{completed:false}}.
		const unsubscribe = todosA.where({ completed: false }).subscribe(() => {})
		await appA.sync?.reconnect() // apply the new view now (skip the 500ms debounce)
		await until(() => appA.sync?.getStatus().status === 'synced', 'A streaming')

		await todosA.update(id, { completed: true })
		// A later local write that IS inside the subset; its ack advances the local
		// node's acknowledged sequence past the dropped update.
		const { id: id2 } = await todosA.insert({ title: 'Next' })
		await until(() => serverOps().some((op) => op.recordId === id2), 'second insert uploaded')

		const serverHasUpdate = () =>
			serverOps().some(
				(op) => op.recordId === id && op.type === 'update' && op.data?.completed === true,
			)
		const statusA = appA.sync?.getStatus()
		// Today: status says synced with 0 pending while the server lacks the update.
		if (statusA?.status === 'synced' && statusA.pendingOperations === 0) {
			expect(serverHasUpdate(), 'A reports synced/0 pending but server lacks the update').toBe(true)
		}

		// Reconnect (handshake delta + op-log reconcile) must recover it.
		await appA.sync?.reconnect()
		await until(() => appA.sync?.getStatus().status === 'synced', 'A re-streaming')
		await settle()
		expect(serverHasUpdate(), 'update never reached the server, even after reconnect').toBe(true)

		// Device B (no subsets) must converge to completed=true.
		const appB = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: join(dir, 'b.db') },
			sync: { url: 'ws://memory' },
		})
		await appB.ready
		await appB.sync?.connect()
		const todosB = (appB as unknown as { todos: Todos }).todos
		await until(async () => (await todosB.findById(id2)) !== null, 'B received data')
		expect((await todosB.findById(id))?.completed).toBe(true)

		unsubscribe()
		await appA.close()
		await appB.close()
		await server.close()
		rmSync(dir, { recursive: true, force: true })
	}, 30000)
})
