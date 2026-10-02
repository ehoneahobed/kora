/**
 * SYNC-5 repro: when the engine gives up on a session because of a transport error
 * (here: one undecodable frame) it transitions to 'disconnected' WITHOUT closing the
 * transport. Auto-reconnect then calls transport.connect() again, and
 * WebSocketTransport overwrites `this.ws` without closing the old socket: two live
 * server sessions feed one engine, and when the stale socket later closes its onclose
 * sets `this.ws = null`, silently severing the NEW session.
 * Asserts CORRECT behavior.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { createServerTransportPair } from '@korajs/server/internal'
import { JsonMessageSerializer, WebSocketTransport } from '@korajs/sync'
import { TestServer } from '@korajs/test'
import { describe, expect, test, vi } from 'vitest'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

let server: TestServer
const sockets: FakeWebSocket[] = []
const json = new JsonMessageSerializer()

/** Minimal browser-like WebSocket bridged to an in-memory KoraSyncServer session. */
class FakeWebSocket {
	readyState = 0
	onopen: (() => void) | null = null
	onmessage: ((e: { data: unknown }) => void) | null = null
	onclose: ((e: { reason: string; code: number }) => void) | null = null
	onerror: ((e: unknown) => void) | null = null
	private readonly pair = createServerTransportPair()
	constructor(_url: string) {
		sockets.push(this)
		this.pair.client.onMessage((m) => this.onmessage?.({ data: json.encode(m) as string }))
		this.pair.client.onClose(() => this.serverClosed())
		server.handleConnection(this.pair.server)
		queueMicrotask(() => {
			this.readyState = 1
			this.onopen?.()
		})
	}
	send(data: string): void {
		this.pair.client.send(json.decode(data))
	}
	close(): void {
		if (this.readyState === 3) return
		this.readyState = 3
		void this.pair.client.disconnect()
		this.onclose?.({ reason: 'closed', code: 1000 })
	}
	/** Server ended this session (e.g. it is shut down / times out). */
	serverClosed(): void {
		if (this.readyState === 3) return
		this.readyState = 3
		this.onclose?.({ reason: 'server closed', code: 1001 })
	}
	injectFrame(data: string): void {
		this.onmessage?.({ data })
	}
}

vi.mock('../../src/create-sync-transport', () => ({
	createSyncTransport: () =>
		new WebSocketTransport({
			WebSocketImpl: FakeWebSocket as unknown as ConstructorParameters<
				typeof WebSocketTransport
			>[0] extends infer O
				? O extends { WebSocketImpl?: infer W }
					? W
					: never
				: never,
		}),
}))

const { createApp } = await import('../../src/create-app')

const tick = () => new Promise((r) => setTimeout(r, 50))
async function until(cond: () => boolean, label: string, tries = 100): Promise<void> {
	for (let i = 0; i < tries; i++) {
		if (cond()) return
		await tick()
	}
	throw new Error(`condition never held: ${label}`)
}

describe('SYNC-5: engine/transport desync after a transport error', () => {
	test('a stale socket is closed before reconnecting and cannot sever the new session', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'sync5-'))
		server = new TestServer(schema)
		const app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: join(dir, 'a.db') },
			sync: { url: 'ws://fake' },
		})
		await app.ready
		await app.sync?.connect()
		await until(() => app.sync?.getStatus().status === 'synced', 'first session streaming')
		const first = sockets[0]
		if (!first) throw new Error('no socket')

		// One undecodable frame (e.g. a message type from a newer server).
		first.injectFrame('{"type":"from-the-future"}')
		await until(() => sockets.length === 2, 'auto-reconnect opened a second socket')
		await until(() => app.sync?.getStatus().status === 'synced', 'second session streaming')

		// Correct: the engine closed the first socket when it abandoned that session.
		expect(first.readyState, 'old socket left open after engine went disconnected').toBe(3)

		// Harm: the stale session ends server-side; the live session must keep working.
		first.serverClosed()
		await tick()
		expect(app.sync?.getStatus().status, 'stale socket close tore down the live session').toBe(
			'synced',
		)
		expect(sockets.length).toBe(2)
		const todo = await (
			app as unknown as {
				todos: { insert: (d: Record<string, unknown>) => Promise<{ id: string }> }
			}
		).todos.insert({ title: 'after' })
		await until(
			() => server.getAllOperations().some((op) => op.recordId === todo.id),
			'write uploaded on the live session',
			60,
		)

		await app.close()
		await server.close()
		rmSync(dir, { recursive: true, force: true })
	}, 30000)
})
