// Minimal scoped-auth harness for LMS-8 / LMS-9 reproductions.
// Mirrors TestDevice wiring (real Store + SQLite, MergeAwareSyncStore, SyncEngine,
// KoraSyncServer over in-memory transport) but lets each device present an auth
// token so the server applies scopes / directional scopes.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Operation, SchemaDefinition } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { MergeEngine } from '@korajs/merge'
import type { AuthContext } from '@korajs/server'
import { KoraSyncServer, MemoryServerStore } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { SyncEngine } from '@korajs/sync'
import type { SyncTransport } from '@korajs/sync'
import {
	ApplyPipeline,
	MergeAwareSyncStore,
	StoreQueueStorage,
	StoreSyncStatePersistence,
} from 'korajs/testing'

export const settle = async (n = 15) => {
	for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 20))
}

export class ScopedNet {
	readonly tmp = mkdtempSync(join(tmpdir(), 'lms-repro-'))
	readonly serverStore = new MemoryServerStore()
	readonly auth = new Map<string, AuthContext>()
	readonly server: KoraSyncServer
	readonly devices: ScopedDevice[] = []
	/** Every operation-rejected message the server sent, across sessions. */
	readonly rejections: Array<{ operationId: string; code: string }> = []

	constructor(readonly schema: SchemaDefinition) {
		this.server = new KoraSyncServer({
			store: this.serverStore,
			schemaVersion: schema.version,
			supportedSchemaVersions: { min: schema.version, max: schema.version },
			auth: { authenticate: async (token) => this.auth.get(token) ?? null },
		})
		void this.serverStore.setSchema(schema)
	}

	async device(
		name: string,
		token: string,
		patchEngine?: (engine: SyncEngine) => void,
	): Promise<ScopedDevice> {
		const d = new ScopedDevice(this, name, token, patchEngine)
		await d.open()
		this.devices.push(d)
		return d
	}

	async close() {
		for (const d of this.devices) await d.close().catch(() => {})
		await this.server.stop().catch(() => {})
		rmSync(this.tmp, { recursive: true, force: true })
	}
}

export class ScopedDevice {
	readonly emitter = new SimpleEventEmitter()
	readonly store: Store
	readonly adapter: BetterSqlite3Adapter
	readonly merge = new MergeEngine()
	engine: SyncEngine | null = null
	private unsub: (() => void) | null = null
	private client: SyncTransport | null = null

	constructor(
		private readonly net: ScopedNet,
		readonly name: string,
		private readonly token: string,
		private readonly patchEngine?: (engine: SyncEngine) => void,
	) {
		this.adapter = new BetterSqlite3Adapter(join(net.tmp, `${name}.db`))
		this.store = new Store({ schema: net.schema, adapter: this.adapter, emitter: this.emitter })
	}

	async open() {
		await this.store.open()
		const pipeline = new ApplyPipeline({
			store: this.store,
			mergeEngine: this.merge,
			emitter: this.emitter,
		})
		this.store.setLocalMutationHandler(pipeline)
	}

	collection(name: string) {
		return this.store.collection(name)
	}

	async sync() {
		if (this.engine && this.client?.isConnected()) {
			await settle()
			return
		}
		const pair = createServerTransportPair()
		this.client = pair.client as unknown as SyncTransport
		// Record server rejections for assertions.
		const origSend = pair.server.send.bind(pair.server)
		pair.server.send = (msg: never) => {
			const m = msg as { type?: string; operationId?: string; code?: string }
			if (m.type === 'operation-rejected')
				this.net.rejections.push({ operationId: m.operationId ?? '', code: m.code ?? '' })
			return origSend(msg)
		}
		const syncStore = new MergeAwareSyncStore(this.store, this.merge, this.emitter)
		this.engine = new SyncEngine({
			transport: this.client,
			store: syncStore,
			queueStorage: new StoreQueueStorage(this.adapter),
			syncState: new StoreSyncStatePersistence(this.store),
			config: {
				url: 'ws://test',
				schemaVersion: this.net.schema.version,
				auth: async () => ({ token: this.token }),
			},
			emitter: this.emitter,
		})
		const engine = this.engine
		this.patchEngine?.(engine)
		this.unsub = this.emitter.on('operation:created', (e: { operation: Operation }) => {
			if (this.engine === engine && this.client?.isConnected())
				engine.pushOperation(e.operation).catch(() => {})
		})
		this.net.server.handleConnection(pair.server)
		await this.engine.start()
		await settle()
	}

	async disconnect() {
		this.unsub?.()
		this.unsub = null
		await this.engine?.stop().catch(() => {})
		this.engine = null
		this.client = null
		await settle(3)
	}

	async rows(collection: string) {
		return (await this.store.collection(collection).where({}).exec()) as Array<
			Record<string, unknown>
		>
	}

	async close() {
		await this.disconnect()
		await this.store.close()
	}
}
