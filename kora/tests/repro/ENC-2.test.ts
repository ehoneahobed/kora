/**
 * ENC-2 repro: SyncEngine.handleOperationBatch calls encryptor.decryptBatch outside the
 * per-op try/catch. One undecryptable operation (wrong/rotated key, corrupted
 * ciphertext) rejects the whole message handler, which handleMessageFailure turns into a
 * fake transport close; auto-reconnect re-handshakes, the server resends the same batch,
 * and the client loops forever with no apply-failure surfaced and no other op applied.
 * Asserts CORRECT behavior: the session stays up and the op is reported as a failure.
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
		todos: { fields: { title: t.string(), completed: t.boolean().default(false) } },
	},
})

let server: KoraSyncServer
let serverStore: MemoryServerStore
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

type Coll = {
	insert: (d: Record<string, unknown>) => Promise<{ id: string }>
	findById: (id: string) => Promise<Record<string, unknown> | null>
}

describe('ENC-2: decrypt failure handled as a transport close', () => {
	test('one undecryptable op does not tear down and loop the session', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'enc2-'))
		serverStore = new MemoryServerStore()
		server = new KoraSyncServer({ store: serverStore })
		const appA = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: join(dir, 'a.db') },
			sync: { url: 'ws://memory', encryption: { enabled: true, key: 'someone-elses-key' } },
		})
		const appB = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: join(dir, 'b.db') },
			sync: { url: 'ws://memory', encryption: { enabled: true, key: 'my-key' } },
		})
		await appA.ready
		await appB.ready
		await appA.sync?.connect()
		const row = await (appA as unknown as { todos: Coll }).todos.insert({ title: 'x' })
		for (
			let i = 0;
			i < 40 && !serverStore.getAllOperations().some((o) => o.recordId === row.id);
			i++
		)
			await tick()

		const disconnects: string[] = []
		const failures: string[] = []
		appB.events.on('sync:disconnected', (e) => disconnects.push(e.reason))
		appB.events.on('sync:apply-failed', (e) => failures.push(e.operationId))
		await appB.sync?.connect()
		await new Promise((r) => setTimeout(r, 2_500)) // > 2 default reconnect intervals

		expect(disconnects, 'decrypt failure tore down the session (and loops)').toEqual([])
		expect(failures.length, 'undecryptable op never surfaced as an apply failure').toBeGreaterThan(
			0,
		)

		await appA.close()
		await appB.close()
		await server.stop()
		rmSync(dir, { recursive: true, force: true })
	}, 20000)
})
