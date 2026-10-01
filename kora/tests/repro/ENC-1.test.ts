/**
 * ENC-1 repro: createApp derives the E2E key with SyncEncryptor.create(config) and no
 * salt, so every process generates a random PBKDF2 salt. Two devices (or one device
 * after a reload) with the SAME passphrase derive different keys and cannot decrypt
 * each other's operations. Docs (guide/sync-encryption.md) promise the opposite.
 * Asserts CORRECT behavior.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import { KoraSyncServer, MemoryServerStore } from '../../../packages/server/src/index'
import { afterEach, describe, expect, test, vi } from 'vitest'

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

describe('ENC-1: same passphrase, different devices', () => {
	test('device B decrypts device A operations', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'enc1-'))
		// Schema-less server so server-side shape validation (see NEW-ENC-1) does not
		// mask the key problem.
		serverStore = new MemoryServerStore()
		server = new KoraSyncServer({ store: serverStore })
		const encryption = { enabled: true, key: 'correct horse battery staple' }
		const appA = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: join(dir, 'a.db') },
			sync: { url: 'ws://memory', encryption },
		})
		const appB = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: join(dir, 'b.db') },
			sync: { url: 'ws://memory', encryption },
		})
		await appA.ready
		await appB.ready
		const failures: string[] = []
		appB.events?.on?.('sync:disconnected', (e: { reason: string }) => failures.push(e.reason))
		await appA.sync?.connect()
		const row = await (appA as unknown as { todos: Coll }).todos.insert({ title: 'secret' })
		for (let i = 0; i < 40 && !serverStore.getAllOperations().some((o) => o.recordId === row.id); i++)
			await tick()
		const stored = serverStore.getAllOperations().find((o) => o.recordId === row.id)
		// Control: the server only ever sees ciphertext.
		expect(JSON.stringify(stored?.data)).not.toContain('secret')

		await appB.sync?.connect()
		let onB: Record<string, unknown> | null = null
		for (let i = 0; i < 40 && !onB; i++) {
			await tick()
			onB = await (appB as unknown as { todos: Coll }).todos.findById(row.id)
		}
		expect(onB?.title, `B could not decrypt A's op (${failures[0] ?? 'no event'})`).toBe('secret')

		await appA.close()
		await appB.close()
		await server.close()
		rmSync(dir, { recursive: true, force: true })
	}, 20000)
})
