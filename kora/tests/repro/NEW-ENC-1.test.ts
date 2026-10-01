/**
 * NEW-ENC-1 repro: with E2E encryption enabled, a server that has the app schema
 * (every scaffolded server.ts calls store.setSchema(schema)) rejects EVERY uploaded
 * operation non-retriably: validateOperationShape sees the ciphertext envelope field
 * "__kora_e2e_encrypted" as an undeclared field (SCHEMA_VALIDATION_ERROR). Nothing ever
 * syncs. Asserts CORRECT behavior: encrypted ops are stored and relayed.
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

type Coll = {
	insert: (d: Record<string, unknown>) => Promise<{ id: string }>
	findById: (id: string) => Promise<Record<string, unknown> | null>
}

describe('NEW-ENC-1: schema-aware server rejects all encrypted ops', () => {
	test('an encrypted insert is accepted by a schema-aware server', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'enc1-'))
		server = new TestServer(schema)
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
		for (let i = 0; i < 40 && !server.getAllOperations().some((o) => o.recordId === row.id); i++)
			await tick()
		expect(await appA.sync?.getRejectedOperations(), 'server rejected the encrypted op').toEqual([])
		expect(server.getAllOperations().some((o) => o.recordId === row.id)).toBe(true)
		await appA.close()
		await appB.close()
		await server.close()
		rmSync(dir, { recursive: true, force: true })
	}, 20000)
})
