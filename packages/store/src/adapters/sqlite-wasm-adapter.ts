import { generateFullDDL } from '@korajs/core'
import type { KoraEventEmitter, SchemaDefinition } from '@korajs/core'
import { AdapterError, StoreNotOpenError } from '../errors'
import {
	FollowerBroadcastBridge,
	TransactionSerializingWorkerBridge,
	acquireTabStorageSession,
	startLeaderRpcRelay,
} from '../multi-tab/tab-storage'
import type {
	MigrationPlan,
	StorageAdapter,
	StorageFallbackReason,
	StorageOpenState,
	Transaction,
} from '../types'
import { Mutex } from './sqlite-wasm-channel'
import type { WorkerBridge, WorkerRequest, WorkerResponse } from './sqlite-wasm-channel'

type WorkerSuccessResponse = Extract<WorkerResponse, { type: 'success' }>
let warnedSharedWorkerDeprecated = false

/**
 * Options for creating a SqliteWasmAdapter.
 */
export interface SqliteWasmAdapterOptions {
	/**
	 * Injected WorkerBridge for testing. If omitted, a WebWorkerBridge is created
	 * in browser environments.
	 */
	bridge?: WorkerBridge

	/**
	 * Database name for persistence. Used as the OPFS file name or IDB key.
	 */
	dbName?: string

	/**
	 * URL to the sqlite-wasm-worker script. Required in browsers if no bridge is provided.
	 */
	workerUrl?: string | URL

	/** Timeout for worker / follower RPC responses. Defaults to 30000ms. */
	workerResponseTimeoutMs?: number

	/**
	 * @deprecated SharedWorker-hosted SQLite cannot use OPFS SyncAccessHandle and
	 * is never durable. Kora ignores this option and uses the dedicated-worker
	 * leader/follower path for durable multi-tab storage.
	 */
	sharedWorkerUrl?: string | URL

	/**
	 * When false, the adapter records a non-persistent open without emitting
	 * `store:opfs-unavailable`. `createApp()` uses this while it promotes the store
	 * to durable IndexedDB; direct adapter users keep the diagnostic by default.
	 */
	emitNonPersistentDiagnostic?: boolean

	/**
	 * When set, storage diagnostics are emitted here: `store:opfs-unavailable` when
	 * persistence silently degraded to a non-persistent in-memory database, and
	 * `store:db-name-collision` when another runtime on this origin was already
	 * using this database name.
	 */
	emitter?: KoraEventEmitter
}

/**
 * SQLite WASM adapter that communicates with a SQLite instance through a WorkerBridge.
 *
 * In browsers, the bridge is backed by a Web Worker running SQLite WASM with OPFS persistence.
 * In Node.js tests, the bridge is backed by MockWorkerBridge wrapping better-sqlite3.
 *
 * @example
 * ```typescript
 * // Browser usage
 * const adapter = new SqliteWasmAdapter({ workerUrl: '/sqlite-wasm-worker.js' })
 *
 * // Test usage with MockWorkerBridge
 * import { MockWorkerBridge } from './sqlite-wasm-mock-bridge'
 * const adapter = new SqliteWasmAdapter({ bridge: new MockWorkerBridge() })
 * ```
 */
export class SqliteWasmAdapter implements StorageAdapter {
	private bridge: WorkerBridge | null = null
	private opened = false
	private readonly mutex = new Mutex()
	private readonly injectedBridge: WorkerBridge | undefined
	private readonly workerUrl: string | URL | undefined
	private readonly sharedWorkerUrl: string | URL | undefined
	private readonly workerResponseTimeoutMs: number
	private readonly dbName: string
	private readonly emitter: KoraEventEmitter | undefined
	private tabSession: Awaited<ReturnType<typeof acquireTabStorageSession>> | null = null
	private readonly emitNonPersistentDiagnostic: boolean
	private storageOpenState: StorageOpenState | null = null
	/** Retained so a follower promoted to leader can re-open its own worker. */
	private schema: SchemaDefinition | null = null
	private promoting = false

	constructor(options: SqliteWasmAdapterOptions = {}) {
		this.injectedBridge = options.bridge
		this.workerUrl = options.workerUrl
		this.sharedWorkerUrl = options.sharedWorkerUrl
		this.workerResponseTimeoutMs = options.workerResponseTimeoutMs ?? 30_000
		this.dbName = options.dbName ?? 'kora-db'
		this.emitter = options.emitter
		this.emitNonPersistentDiagnostic = options.emitNonPersistentDiagnostic ?? true
	}

	async open(schema: SchemaDefinition): Promise<void> {
		if (this.opened) return

		const ddlStatements = generateFullDDL(schema)
		if (this.injectedBridge) {
			this.bridge = this.injectedBridge
			const response = await this.openCurrentBridge(ddlStatements)
			this.reportStorageMode(response.data)
			this.opened = true
			return
		}
		if (this.workerUrl) {
			this.warnSharedWorkerDeprecated()
			await this.openDurableWorkerBridge(schema)
			const response = await this.openCurrentBridge(ddlStatements)
			this.reportStorageMode(response.data)
			this.opened = true
			return
		}
		throw new AdapterError(
			'SqliteWasmAdapter requires either a bridge (for testing) or a workerUrl (for browsers). ' +
				'Pass { bridge: new MockWorkerBridge() } for tests, or { workerUrl: "/worker.js" } for browsers.',
		)
	}

	private async openDurableWorkerBridge(schema: SchemaDefinition): Promise<void> {
		if (!this.workerUrl) {
			throw new AdapterError('Durable SQLite WASM storage requires workerUrl.')
		}

		this.schema = schema
		this.tabSession = await acquireTabStorageSession(this.dbName, {
			onPromote: () => {
				void this.promoteToLeader()
			},
		})
		const { WebWorkerBridge } = await import('./sqlite-wasm-channel')

		if (this.tabSession.role === 'leader') {
			const workerBridge = new TransactionSerializingWorkerBridge(
				new WebWorkerBridge(this.workerUrl, this.workerResponseTimeoutMs),
			)
			this.tabSession.stopRelay = startLeaderRpcRelay(this.tabSession.channelName, workerBridge)
			this.bridge = workerBridge
			return
		}

		const followerBridge = new FollowerBroadcastBridge(
			this.tabSession.channelName,
			this.workerResponseTimeoutMs,
		)
		this.bridge = followerBridge
		// Another runtime on this origin already owns this database name. That is
		// expected for multiple tabs of the same app (they share one leader),
		// but a bug if these are logically separate apps, so surface it so the
		// developer can give them distinct store names.
		this.emitter?.emit({
			type: 'store:db-name-collision',
			dbName: this.dbName,
			message: `Another runtime on this origin is already using database "${this.dbName}"; this runtime is sharing it as a follower. If these are separate apps, give each a distinct store name.`,
		})
		// Readiness handshake: give the leader relay a moment to answer before the
		// first RPC, so a follower opened during a leader's startup race retries the
		// handshake instead of firing into the void and waiting out the full timeout.
		await followerBridge.waitForLeader()
	}

	private async openCurrentBridge(ddlStatements: string[]): Promise<WorkerSuccessResponse> {
		const response = await this.sendRequest({
			id: 0,
			type: 'open',
			ddlStatements,
			dbName: this.dbName,
		})
		if (response.type === 'error') {
			throw new AdapterError(`Failed to open database: ${response.message}`, {
				code: response.code,
				dbName: this.dbName,
			})
		}
		return response
	}

	/**
	 * Surface a `store:opfs-unavailable` diagnostic when the worker reported that
	 * persistence silently degraded to an in-memory database, so a data-loss
	 * condition is observable instead of failing silently. A persistent open (or a
	 * bridge that does not report a mode, e.g. the Node mock) emits nothing.
	 */
	private reportStorageMode(data: unknown): void {
		this.storageOpenState = parseStorageOpenState(data)
		if (!this.emitNonPersistentDiagnostic || !this.emitter || !this.storageOpenState) {
			return
		}
		if (this.storageOpenState.persistent === false) {
			const reason = this.storageOpenState.fallbackReason ?? 'unsupported'
			this.emitter.emit({
				type: 'store:opfs-unavailable',
				dbName: this.dbName,
				reason,
				message: `OPFS persistence is unavailable (${reason}) for database "${this.dbName}"; the store is running in memory and data will not survive a reload.`,
			})
		}
	}

	getStorageOpenState(): StorageOpenState | null {
		return this.storageOpenState
	}

	private warnSharedWorkerDeprecated(): void {
		if (!this.sharedWorkerUrl || warnedSharedWorkerDeprecated) {
			return
		}
		warnedSharedWorkerDeprecated = true
		console.warn(
			'[kora] sharedWorkerUrl is deprecated and ignored: SharedWorker-hosted SQLite ' +
				'cannot use OPFS and is never durable. Kora uses the durable dedicated-worker ' +
				'leader/follower path for multi-tab storage.',
		)
	}

	async close(): Promise<void> {
		if (!this.bridge) return

		try {
			await this.sendRequest({ id: 0, type: 'close' })
		} finally {
			this.tabSession?.stopRelay?.()
			this.tabSession?.cancelPromotionWatch?.()
			if (this.tabSession?.releaseLock) {
				await this.tabSession.releaseLock()
			}
			this.tabSession = null
			this.bridge.terminate()
			this.bridge = null
			this.opened = false
		}
	}

	/**
	 * Promotes a follower to leader after the previous leader released the storage
	 * lock (its tab closed or crashed). The lock is only granted once the old leader
	 * is gone, so opening our own worker here is safe from the OPFS single-writer
	 * rule. In-flight follower RPCs are rejected and left to the caller / reactive
	 * layer to retry against the new leader.
	 */
	private async promoteToLeader(): Promise<void> {
		if (this.promoting || !this.opened || this.workerUrl === undefined || this.schema === null) {
			return
		}
		this.promoting = true

		const { WebWorkerBridge } = await import('./sqlite-wasm-channel')
		const workerBridge = new TransactionSerializingWorkerBridge(
			new WebWorkerBridge(this.workerUrl, this.workerResponseTimeoutMs),
		)

		const previousBridge = this.bridge
		this.bridge = workerBridge
		if (this.tabSession) {
			this.tabSession.role = 'leader'
			this.tabSession.stopRelay = startLeaderRpcRelay(this.tabSession.channelName, workerBridge)
		}
		previousBridge?.terminate()

		// Re-open against our own worker. DDL is idempotent, and the OPFS data the old
		// leader persisted is now readable by this worker.
		const ddlStatements = generateFullDDL(this.schema)
		await this.sendRequest({ id: 0, type: 'open', ddlStatements, dbName: this.dbName })
	}

	async execute(sql: string, params?: unknown[]): Promise<void> {
		this.guardOpen()
		const response = await this.sendRequest({ id: 0, type: 'execute', sql, params })
		if (response.type === 'error') {
			throw new AdapterError(`Execute failed: ${response.message}`, { sql, params })
		}
	}

	async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		this.guardOpen()
		const response = await this.sendRequest({ id: 0, type: 'query', sql, params })
		if (response.type === 'error') {
			throw new AdapterError(`Query failed: ${response.message}`, { sql, params })
		}
		return (response.data as T[]) ?? []
	}

	async transaction(fn: (tx: Transaction) => Promise<void>): Promise<void> {
		this.guardOpen()

		const release = await this.mutex.acquire()
		try {
			await this.sendChecked({ id: 0, type: 'begin' }, 'BEGIN transaction')

			const tx: Transaction = {
				execute: async (sql: string, params?: unknown[]): Promise<void> => {
					const response = await this.sendRequest({ id: 0, type: 'execute', sql, params })
					if (response.type === 'error') {
						throw new AdapterError(`Transaction execute failed: ${response.message}`, {
							sql,
							params,
						})
					}
				},
				query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
					const response = await this.sendRequest({ id: 0, type: 'query', sql, params })
					if (response.type === 'error') {
						throw new AdapterError(`Transaction query failed: ${response.message}`, { sql, params })
					}
					return (response.data as T[]) ?? []
				},
			}

			await fn(tx)
			await this.sendChecked({ id: 0, type: 'commit' }, 'COMMIT transaction')
		} catch (error) {
			// Attempt rollback, but don't mask the original error
			try {
				await this.sendRequest({ id: 0, type: 'rollback' })
			} catch {
				// Rollback failure is secondary to the original error
			}
			throw error
		} finally {
			release()
		}
	}

	async migrate(from: number, to: number, migration: MigrationPlan): Promise<void> {
		this.guardOpen()

		const release = await this.mutex.acquire()
		try {
			await this.sendChecked({ id: 0, type: 'begin' }, 'BEGIN migration')

			for (const sql of migration.statements) {
				const response = await this.sendRequest({ id: 0, type: 'execute', sql })
				if (response.type === 'error') {
					throw new AdapterError(`Migration from v${from} to v${to} failed: ${response.message}`, {
						from,
						to,
					})
				}
			}

			await this.sendChecked({ id: 0, type: 'commit' }, 'COMMIT migration')
		} catch (error) {
			try {
				await this.sendRequest({ id: 0, type: 'rollback' })
			} catch {
				// Rollback failure is secondary
			}
			if (error instanceof AdapterError) throw error
			throw new AdapterError(
				`Migration from v${from} to v${to} failed: ${(error as Error).message}`,
				{ from, to },
			)
		} finally {
			release()
		}
	}

	/**
	 * Export the database as a Uint8Array (for IndexedDB persistence).
	 * Only available when the database is open.
	 */
	async exportDatabase(): Promise<Uint8Array> {
		this.guardOpen()
		const response = await this.sendRequest({ id: 0, type: 'export' })
		if (response.type === 'error') {
			throw new AdapterError(`Export failed: ${response.message}`)
		}
		return response.data as Uint8Array
	}

	/**
	 * Import a serialized database snapshot.
	 */
	async importDatabase(data: Uint8Array): Promise<void> {
		this.guardOpen()
		const response = await this.sendRequest({ id: 0, type: 'import', data })
		if (response.type === 'error') {
			throw new AdapterError(`Import failed: ${response.message}`)
		}
	}

	private guardOpen(): void {
		if (!this.opened || !this.bridge) {
			throw new StoreNotOpenError()
		}
	}

	private async sendRequest(request: WorkerRequest): Promise<WorkerResponse> {
		// guardOpen() is always called before sendRequest, so bridge is guaranteed non-null
		const bridge = this.bridge
		if (!bridge) {
			throw new StoreNotOpenError()
		}
		return bridge.send(request)
	}

	private async sendChecked(request: WorkerRequest, description: string): Promise<void> {
		const response = await this.sendRequest(request)
		if (response.type === 'error') {
			throw new AdapterError(`${description} failed: ${response.message}`)
		}
	}
}

function parseStorageOpenState(data: unknown): StorageOpenState | null {
	if (typeof data !== 'object' || data === null) {
		return null
	}
	const mode = data as {
		persistent?: boolean
		fallbackReason?: StorageFallbackReason
	}
	if (typeof mode.persistent !== 'boolean') {
		return null
	}
	return {
		persistent: mode.persistent,
		mode: mode.persistent ? 'opfs' : 'memory',
		...(mode.fallbackReason ? { fallbackReason: mode.fallbackReason } : {}),
	}
}
