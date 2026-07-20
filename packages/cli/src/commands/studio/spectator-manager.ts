import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SchemaDefinition } from '@korajs/core'

/**
 * Kora Studio SPECTATOR: live, read-only inspection of a production sync
 * server.
 *
 * The spectator is a REAL Kora client — its own store, merge pipeline, and
 * sync engine — connected to the target server over the real WebSocket
 * protocol. It materializes its own replica into a throwaway database, which
 * every Studio view (records, per-field writers, op log, DAG, time travel,
 * merge audit) then reads. Nothing is simulated: what Studio shows is exactly
 * what any device syncing against that server computes.
 *
 * Read-only by construction: the spectator exposes NO mutation API, so it can
 * never push an operation to the server. It only receives, applies, and
 * observes. The server sees an ordinary client whose version vector starts
 * empty (so it receives the full history — which is what makes production
 * time travel possible) and which never sends operations.
 */

export interface SpectatorStatus {
	url: string
	connected: boolean
	operationsReceived: number
	lastEventAt: number | null
	dbPath: string
}

export interface SpectatorEvent {
	seq: number
	at: number
	type: string
	summary: string
}

export interface SpectatorOptions {
	url: string
	schema: SchemaDefinition
	/** Bearer token forwarded through the sync auth handshake. */
	token?: string
	/** Client schema version override. Defaults to schema.version. */
	schemaVersion?: number
}

// NOTE: 'operation:applied' is in the event spec but not yet emitted by the
// store — received-op counting uses 'sync:received' batches instead.
const FORWARDED_EVENTS = [
	'merge:started',
	'merge:conflict',
	'merge:completed',
	'sync:connected',
	'sync:disconnected',
	'sync:received',
	'sync:apply-failed',
] as const

const MAX_EVENT_BUFFER = 500

/** Structural types for the lazily-imported runtime packages. */
interface SpectatorRuntime {
	store: {
		open(): Promise<void>
		close(): Promise<void>
		setLocalMutationHandler(handler: unknown): void
	}
	engine: { start(): Promise<void>; stop(): Promise<void> }
	unsubscribers: Array<() => void>
}

export class SpectatorManager {
	private runtime: SpectatorRuntime | null = null
	private tmpDir: string | null = null
	private connected = false
	private operationsReceived = 0
	private lastEventAt: number | null = null
	private eventSeq = 0
	private readonly eventBuffer: SpectatorEvent[] = []
	private readonly eventListeners = new Set<(event: SpectatorEvent) => void>()
	readonly dbPath: string

	constructor(private readonly options: SpectatorOptions) {
		this.tmpDir = mkdtempSync(join(tmpdir(), 'kora-studio-spectator-'))
		this.dbPath = join(this.tmpDir, 'spectator-replica.db')
	}

	async start(): Promise<void> {
		let mods: {
			Store: typeof import('@korajs/store').Store
			BetterSqlite3Adapter: typeof import('@korajs/store/better-sqlite3').BetterSqlite3Adapter
			MergeEngine: typeof import('@korajs/merge').MergeEngine
			SyncEngine: typeof import('@korajs/sync').SyncEngine
			WebSocketTransport: typeof import('@korajs/sync').WebSocketTransport
			testing: typeof import('korajs/testing')
			SimpleEventEmitter: typeof import('@korajs/core/internal').SimpleEventEmitter
		}
		try {
			mods = {
				Store: (await import('@korajs/store')).Store,
				BetterSqlite3Adapter: (await import('@korajs/store/better-sqlite3')).BetterSqlite3Adapter,
				MergeEngine: (await import('@korajs/merge')).MergeEngine,
				SyncEngine: (await import('@korajs/sync')).SyncEngine,
				WebSocketTransport: (await import('@korajs/sync')).WebSocketTransport,
				testing: await import('korajs/testing'),
				SimpleEventEmitter: (await import('@korajs/core/internal')).SimpleEventEmitter,
			}
		} catch (error) {
			throw new Error(
				`Spectator mode needs the Kora runtime packages installed (pnpm add -D korajs @korajs/store @korajs/merge @korajs/sync better-sqlite3). Underlying error: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}

		const emitter = new mods.SimpleEventEmitter()
		const adapter = new mods.BetterSqlite3Adapter(this.dbPath)
		const store = new mods.Store({ schema: this.options.schema, adapter, emitter })
		await store.open()

		const mergeEngine = new mods.MergeEngine()
		const pipeline = new mods.testing.ApplyPipeline({ store, mergeEngine, emitter })
		store.setLocalMutationHandler(pipeline)

		// Production parity: merge decisions persist to the audit trail.
		const unsubscribeAudit = mods.testing.wireAuditPersistence(store, emitter)

		const syncStore = new mods.testing.MergeAwareSyncStore(store, mergeEngine, emitter)
		const engine = new mods.SyncEngine({
			transport: new mods.WebSocketTransport(),
			store: syncStore,
			queueStorage: new mods.testing.StoreQueueStorage(adapter),
			syncState: new mods.testing.StoreSyncStatePersistence(store),
			config: {
				url: this.options.url,
				schemaVersion: this.options.schemaVersion ?? this.options.schema.version,
				...(this.options.token
					? { auth: async () => ({ token: this.options.token as string }) }
					: {}),
			},
			emitter,
		})

		const unsubscribers = FORWARDED_EVENTS.map((type) =>
			emitter.on(type, (event: Record<string, unknown>) => {
				this.lastEventAt = Date.now()
				if (type === 'sync:connected') {
					this.connected = true
				}
				if (type === 'sync:disconnected') {
					this.connected = false
				}
				if (type === 'sync:received' && Array.isArray(event.operations)) {
					this.operationsReceived += event.operations.length
				}
				this.pushEvent(type, event)
			}),
		)
		unsubscribers.push(unsubscribeAudit)

		this.runtime = { store, engine, unsubscribers }
		await engine.start()
	}

	status(): SpectatorStatus {
		return {
			url: this.options.url,
			connected: this.connected,
			operationsReceived: this.operationsReceived,
			lastEventAt: this.lastEventAt,
			dbPath: this.dbPath,
		}
	}

	recentEvents(): SpectatorEvent[] {
		return [...this.eventBuffer]
	}

	onEvent(listener: (event: SpectatorEvent) => void): () => void {
		this.eventListeners.add(listener)
		return () => this.eventListeners.delete(listener)
	}

	async close(): Promise<void> {
		if (this.runtime) {
			for (const unsub of this.runtime.unsubscribers) {
				unsub()
			}
			await this.runtime.engine.stop().catch(() => {})
			await this.runtime.store.close().catch(() => {})
			this.runtime = null
		}
		if (this.tmpDir) {
			rmSync(this.tmpDir, { recursive: true, force: true })
			this.tmpDir = null
		}
	}

	private pushEvent(type: string, payload: Record<string, unknown>): void {
		const summary =
			type === 'sync:received' && Array.isArray(payload.operations)
				? `received ${payload.operations.length} op(s)`
				: type.replace('sync:', '').replace('merge:', 'merge ')
		const event: SpectatorEvent = {
			seq: ++this.eventSeq,
			at: Date.now(),
			type,
			summary,
		}
		this.eventBuffer.push(event)
		if (this.eventBuffer.length > MAX_EVENT_BUFFER) {
			this.eventBuffer.shift()
		}
		for (const listener of this.eventListeners) {
			listener(event)
		}
	}
}
