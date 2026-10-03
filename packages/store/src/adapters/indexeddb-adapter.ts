import type { KoraEventEmitter, SchemaDefinition } from '@korajs/core'
import { AdapterError, PersistenceError, StorageBackendMismatchError } from '../errors'
import type { MigrationPlan, StorageAdapter, StorageOpenState, Transaction } from '../types'
import { type DatabaseDump, exportDump, restoreDumpStatements } from './database-dump'
import { IndexedDbPersistenceScheduler } from './indexeddb-persistence-scheduler'
import { SqliteWasmAdapter } from './sqlite-wasm-adapter'
import type { WorkerBridge } from './sqlite-wasm-channel'
import {
	deleteSnapshotFromIndexedDB,
	isIndexedDbQuotaError,
	loadDumpFromIndexedDB,
	loadFromIndexedDB,
	saveDumpToIndexedDB,
	saveToIndexedDB,
} from './sqlite-wasm-persistence'
import { isManifestAvailable, readManifestRecord, recordDatabase } from './storage-manifest'

/**
 * Options for creating an IndexedDbAdapter.
 */
export interface IndexedDbAdapterOptions {
	/**
	 * Database name used as the IndexedDB key for persistence.
	 * Defaults to 'kora-db'.
	 */
	dbName?: string

	/**
	 * Injected WorkerBridge for testing. If omitted, a WebWorkerBridge is created
	 * in browser environments.
	 */
	bridge?: WorkerBridge

	/**
	 * URL to the sqlite-wasm-worker script. Required in browsers if no bridge is provided.
	 */
	workerUrl?: string | URL

	/** Timeout for worker / follower RPC responses. Defaults to 30000ms. */
	workerResponseTimeoutMs?: number

	/**
	 * Debounce interval (ms) before writing snapshots to IndexedDB. Defaults to 500.
	 */
	persistenceDebounceMs?: number

	/**
	 * When set, persistence failures and quota errors are emitted on this emitter.
	 */
	emitter?: KoraEventEmitter
}

/**
 * IndexedDB-backed adapter that uses SQLite WASM in-memory and serializes
 * the entire database to IndexedDB after mutations (coalesced/debounced).
 *
 * This is the fallback adapter for browsers where OPFS is not available.
 * It provides the same SQL interface as SqliteWasmAdapter, but persists by
 * serializing the full SQLite database to a single IndexedDB blob.
 *
 * @example
 * ```typescript
 * const adapter = new IndexedDbAdapter({ workerUrl: '/sqlite-wasm-worker.js' })
 * ```
 */
export class IndexedDbAdapter implements StorageAdapter {
	private inner: SqliteWasmAdapter
	private readonly dbName: string
	private readonly emitter: KoraEventEmitter | undefined
	private readonly scheduler: IndexedDbPersistenceScheduler
	private storageOpenState: StorageOpenState | null = null
	private readonly options: IndexedDbAdapterOptions
	/** True in browsers (a real worker), where the backend choice is recorded. */
	private readonly usesRealWorker: boolean

	constructor(options: IndexedDbAdapterOptions = {}) {
		this.options = options
		this.dbName = options.dbName ?? 'kora-db'
		this.emitter = options.emitter
		this.usesRealWorker = !options.bridge && options.workerUrl !== undefined
		this.inner = new SqliteWasmAdapter({
			bridge: options.bridge,
			workerUrl: options.workerUrl,
			dbName: this.dbName,
			workerResponseTimeoutMs: options.workerResponseTimeoutMs,
			// The inner SQLite database is in memory by design: this adapter makes it
			// durable by persisting snapshots to IndexedDB, so the inner adapter must
			// not refuse writes as non-durable, and must never touch OPFS (which would
			// create a second, disjoint copy of the data).
			allowNonDurable: true,
			storage: 'memory',
			skipBackendRecord: true,
			// A browser leader restores the snapshot into its own fresh worker database
			// before serving other tabs (first open and promotion, STORE-6).
			onLeaderWorkerOpened: (tx) => this.restoreDumpIfFresh(tx),
		})
		this.scheduler = new IndexedDbPersistenceScheduler({
			debounceMs: options.persistenceDebounceMs,
			flush: () => this.writeSnapshot(),
			onError: (error) => this.handlePersistenceError(error),
		})
	}

	async open(schema: SchemaDefinition): Promise<void> {
		// The backend choice is recorded per database. If OPFS holds the
		// authoritative copy, carry it over explicitly before this session starts,
		// so OPFS and IndexedDB never hold two disjoint copies (NEW-STORE-5).
		const tracksBackend = this.usesRealWorker && isManifestAvailable()
		const recorded = tracksBackend ? await readManifestRecord(this.dbName).catch(() => null) : null
		const carried = recorded?.backend === 'opfs' ? await this.readOpfsCopy(schema) : null

		await this.inner.open(schema)
		this.storageOpenState = { persistent: true, mode: 'indexeddb' }

		if (carried && this.inner.isLeader()) {
			// The fresh worker database is marked restored, then receives the OPFS copy.
			await this.inner.transaction(async (tx) => {
				await markRestored(tx)
			})
			await this.applyDump(carried)
			await this.scheduler.flushNow()
			await recordDatabase({ dbName: this.dbName, backend: 'indexeddb' })
			this.emitter?.emit({
				type: 'store:storage-migrated',
				dbName: this.dbName,
				from: 'opfs',
				to: 'indexeddb',
				message: `Database "${this.dbName}" moved from OPFS into IndexedDB because OPFS is not usable in this session.`,
			})
			return
		}

		// Only the storage leader restores, and only into a database no snapshot was
		// restored into yet: a follower tab (or a second adapter on the same worker)
		// opening must never rewrite the leader's live database (STORE-6).
		if (this.inner.isLeader()) {
			await this.restoreIfFresh()
		}
		if (tracksBackend) {
			await recordDatabase({ dbName: this.dbName, backend: 'indexeddb' }).catch((error: unknown) =>
				console.warn(`[kora] Could not record the storage backend of "${this.dbName}":`, error),
			)
		}
	}

	/**
	 * Read the OPFS copy of this database through a short-lived SQLite WASM
	 * adapter (as leader, or as a follower of a tab that has it open). Refuses
	 * loudly when OPFS cannot be read, instead of starting an empty copy.
	 */
	private async readOpfsCopy(schema: SchemaDefinition): Promise<DatabaseDump> {
		const reader = new SqliteWasmAdapter({
			dbName: this.dbName,
			workerUrl: this.options.workerUrl,
			workerResponseTimeoutMs: this.options.workerResponseTimeoutMs,
			skipBackendRecord: true,
			releaseOnFreeze: false,
		})
		try {
			await reader.open(schema)
			if (reader.getStorageOpenState()?.persistent !== true) {
				throw new StorageBackendMismatchError(
					this.dbName,
					'OPFS',
					'IndexedDB',
					`OPFS reported ${reader.getStorageOpenState()?.fallbackReason ?? 'no durable storage'}`,
				)
			}
			let dump: DatabaseDump = { tables: [] }
			await reader.transaction(async (tx) => {
				dump = await exportDump((sql, params) => tx.query(sql, params))
			})
			return dump
		} catch (error) {
			if (error instanceof StorageBackendMismatchError) throw error
			throw new StorageBackendMismatchError(
				this.dbName,
				'OPFS',
				'IndexedDB',
				error instanceof Error ? error.message : String(error),
			)
		} finally {
			await reader.close().catch(() => undefined)
		}
	}

	private async applyDump(dump: DatabaseDump): Promise<void> {
		await this.inner.transaction(async (tx) => {
			for (const statement of restoreDumpStatements(dump)) {
				await tx.execute(statement.sql, statement.params)
			}
		})
	}

	async close(): Promise<void> {
		await this.scheduler.flushNow()
		this.scheduler.dispose()
		await this.inner.close()
	}

	async execute(sql: string, params?: unknown[]): Promise<void> {
		await this.inner.execute(sql, params)
		this.scheduler.schedule()
	}

	async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		return this.inner.query<T>(sql, params)
	}

	async transaction(fn: (tx: Transaction) => Promise<void>): Promise<void> {
		await this.inner.transaction(fn)
		this.scheduler.schedule()
	}

	async migrate(from: number, to: number, migration: MigrationPlan): Promise<void> {
		await this.inner.migrate(from, to, migration)
		this.scheduler.schedule()
	}

	getStorageOpenState(): StorageOpenState | null {
		return this.storageOpenState
	}

	/**
	 * Force an immediate snapshot write to IndexedDB (skips debounce).
	 * Useful before tab unload or in tests.
	 */
	async flushPersistence(): Promise<void> {
		await this.scheduler.flushNow()
	}

	/**
	 * Durability barrier (RT-35): resolves once every write committed before the call is
	 * in a snapshot persisted to IndexedDB, and rejects when the snapshot cannot be
	 * written. Sync calls it before an operation leaves the device, so the server never
	 * holds an operation this device could lose on reload.
	 */
	async ensureDurable(): Promise<void> {
		await this.scheduler.flushBarrier()
	}

	private async writeSnapshot(): Promise<void> {
		const dump = await this.exportDump()
		await saveDumpToIndexedDB(this.dbName, dump)

		try {
			const data = await this.inner.exportDatabase()
			await saveToIndexedDB(this.dbName, data)
		} catch (error) {
			if (!isUnsupportedWorkerExport(error)) {
				throw error
			}
			await deleteSnapshotFromIndexedDB(this.dbName)
		}
	}

	private handlePersistenceError(error: unknown): void {
		const message = error instanceof Error ? error.message : 'IndexedDB persistence failed'
		const code = error instanceof PersistenceError ? error.code : 'PERSISTENCE_FAILED'
		const quotaExceeded = isIndexedDbQuotaError(error)

		if (quotaExceeded) {
			this.emitter?.emit({
				type: 'store:quota-exceeded',
				dbName: this.dbName,
				message,
			})
		}

		this.emitter?.emit({
			type: 'store:persistence-error',
			dbName: this.dbName,
			message,
			code: quotaExceeded ? 'QUOTA_EXCEEDED' : code,
		})
	}

	/**
	 * Restore the persisted snapshot into the worker database unless one was restored
	 * into it already (this adapter or another one sharing the worker). The binary
	 * snapshot (Node / test workers that support export) is imported whole; the JSON dump
	 * (browsers) is restored in one transaction.
	 */
	private async restoreIfFresh(): Promise<void> {
		const persisted = await loadFromIndexedDB(this.dbName)
		if (persisted) {
			const fresh = { value: false }
			await this.inner.transaction(async (tx) => {
				fresh.value = !(await isRestored(tx))
			})
			if (!fresh.value) return
			try {
				await this.inner.importDatabase(persisted)
				await this.inner.transaction(markRestored)
				return
			} catch {
				// Fall through to the JSON dump.
			}
		}
		await this.inner.transaction((tx) => this.restoreDumpIfFresh(tx))
	}

	/** In `tx`: restore the JSON dump when no snapshot was restored into this database. */
	private async restoreDumpIfFresh(tx: Transaction): Promise<void> {
		if (await isRestored(tx)) return
		await markRestored(tx)
		const dump = await loadDumpFromIndexedDB<DatabaseDump>(this.dbName)
		if (!dump) return
		for (const statement of restoreDumpStatements(dump)) {
			await tx.execute(statement.sql, statement.params)
		}
	}

	/** A consistent snapshot: every table is read inside one transaction (STORE-7). */
	private async exportDump(): Promise<DatabaseDump> {
		let dump: DatabaseDump = { tables: [] }
		await this.inner.transaction(async (tx) => {
			dump = await exportDump((sql, params) => tx.query(sql, params))
		})
		return dump
	}
}

/**
 * Connection-local marker (a TEMP table: never part of the database file or of a dump)
 * recording that a snapshot was restored into this worker database (STORE-6).
 */
const RESTORED_MARKER = '_kora_idb_restored'

async function isRestored(tx: Transaction): Promise<boolean> {
	const rows = await tx.query<{ name: string }>(
		"SELECT name FROM sqlite_temp_master WHERE type = 'table' AND name = ?",
		[RESTORED_MARKER],
	)
	return rows.length > 0
}

async function markRestored(tx: Transaction): Promise<void> {
	await tx.execute(`CREATE TEMP TABLE IF NOT EXISTS ${RESTORED_MARKER} (restored INTEGER)`)
}

function isUnsupportedWorkerExport(error: unknown): boolean {
	return error instanceof AdapterError && error.context?.code === 'EXPORT_NOT_SUPPORTED'
}
