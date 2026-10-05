/**
 * RT-89 investigation (Phase 4 integration): "with token auth, no data is uploaded even
 * with encryption off, because the server accepted an empty scope" (ENC-1 engineer).
 * Drives createApp + the real SyncEngine against a KoraSyncServer with a
 * TokenAuthProvider, with encryption off and on.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
	KoraSyncServer,
	MemoryServerStore,
	TokenAuthProvider,
} from '../../../packages/server/src/index'
import { createServerTransportPair } from '../../../packages/server/src/internal'

let server: KoraSyncServer
let serverStore: MemoryServerStore
/** Explicit scopes the token provider grants (undefined: claims only). */
let explicitGrant: Record<string, Record<string, unknown>> | undefined

class MemoryTransport implements SyncTransport {
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
	createSyncTransport: () => new MemoryTransport(),
}))

const { createApp } = await import('../../src/create-app')
type App = ReturnType<typeof createApp>
type Notes = {
	insert: (d: Record<string, unknown>) => Promise<{ id: string }>
	findById: (id: string) => Promise<Record<string, unknown> | null>
}
const notes = (app: App): Notes => (app as unknown as { notes: Notes }).notes

// No `scope` on the collection: an app-wide collection, the common case.
const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { body: t.string() } } },
})

let dir: string
const apps: App[] = []

beforeEach(() => {
	explicitGrant = undefined
	dir = mkdtempSync(join(tmpdir(), 'kora-rt89-'))
	serverStore = new MemoryServerStore()
	server = new KoraSyncServer({
		store: serverStore,
		auth: new TokenAuthProvider({
			validate: async (token) =>
				token.startsWith('user:')
					? { userId: token.slice(5), ...(explicitGrant ? { scopes: explicitGrant } : {}) }
					: null,
		}),
	})
})

afterEach(async () => {
	for (const app of apps.splice(0)) await app.close()
	await server.stop()
	rmSync(dir, { recursive: true, force: true })
	vi.restoreAllMocks()
})

function device(name: string, user: string, encryptionKey?: string): App {
	const app = createApp({
		schema,
		store: { adapter: 'better-sqlite3', name: join(dir, `${name}.db`) },
		sync: {
			url: 'ws://memory',
			auth: async () => ({ token: `user:${user}` }),
			...(encryptionKey !== undefined
				? { encryption: { enabled: true, key: encryptionKey, kdfIterations: 1000 } }
				: {}),
		},
	})
	apps.push(app)
	return app
}

async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
	for (let i = 0; i < 150; i++) {
		if (await check()) return
		await new Promise((r) => setTimeout(r, 20))
	}
	throw new Error(`timed out waiting for ${what}`)
}

async function connected(app: App): Promise<void> {
	await app.ready
	await app.sync?.connect()
	await until(() => app.getSyncEngine()?.getState() === 'streaming', 'streaming')
}

const stored = (recordId: string) =>
	serverStore.getAllOperations().filter((op) => op.recordId === recordId)

describe('RT-89: token-auth servers and uploads (createApp, real engine)', () => {
	test('encryption off: a write uploads and reaches a second device of the same user', async () => {
		const a1 = device('a1', 'alice')
		const a2 = device('a2', 'alice')
		await connected(a1)
		const row = await notes(a1).insert({ body: 'plain' })
		await until(() => stored(row.id).length > 0, 'upload')
		await connected(a2)
		await until(async () => (await notes(a2).findById(row.id)) !== null, 'a2 receives')
		expect((await notes(a2).findById(row.id))?.body).toBe('plain')
	}, 20000)

	test('encryption on: a write uploads as ciphertext and decrypts on the second device', async () => {
		const a1 = device('e1', 'alice', 'alice words')
		const a2 = device('e2', 'alice', 'alice words')
		await connected(a1)
		const row = await notes(a1).insert({ body: 'secret' })
		await until(() => stored(row.id).length > 0, 'encrypted upload')
		expect(JSON.stringify(stored(row.id))).not.toContain('secret')
		await connected(a2)
		await until(async () => (await notes(a2).findById(row.id)) !== null, 'a2 decrypts')
		expect((await notes(a2).findById(row.id))?.body).toBe('secret')
	}, 20000)

	test('a grant that omits a synced collection surfaces the refusal (never a silent "synced")', async () => {
		explicitGrant = { other: {} }
		const a1 = device('g1', 'alice')
		const rejected: string[] = []
		a1.events.on('sync:operation-rejected', (event) => rejected.push(event.code))
		await connected(a1)
		const row = await notes(a1).insert({ body: 'not granted' })
		await until(() => rejected.length > 0, 'a visible refusal')
		expect(rejected).toEqual(['OUT_OF_UPLINK_SCOPE'])
		expect(stored(row.id)).toHaveLength(0)
		expect((await a1.sync?.getRejectedOperations())?.map((r) => r.recordId)).toContain(row.id)
	}, 20000)
})
