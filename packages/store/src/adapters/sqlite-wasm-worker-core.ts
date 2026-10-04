/// <reference lib="webworker" />
/**
 * Reusable SQLite WASM core, decoupled from any specific worker global.
 *
 * The dedicated worker ({@link file://./sqlite-wasm-worker.ts}) wires one core to
 * `self.onmessage`/`self.postMessage`. Each worker serves exactly one database
 * and owns that database's OPFS SyncAccessHandle pool (one pool per database,
 * W8a). Pool ownership, the pool Web Lock and the beta.12 legacy-pool migration
 * live in {@link file://./opfs-pool-ownership.ts}.
 *
 * This file cannot be unit-tested in Node (no WASM/OPFS); it is exercised through
 * the real-browser suite.
 */

import {
	STORED_SCHEMA_VERSION_SQL,
	parseSchemaCeiling,
	schemaAheadMessage,
	storedSchemaVersion,
} from '../migrations/schema-ceiling'
import { opfsPoolLockName, opfsPoolNameFor, opfsPoolPath } from './opfs-names'
import {
	type BlockingReporter,
	type OpfsPool,
	PoolUnavailableError,
	type Sqlite3Api,
	type SqliteDb,
	ensurePoolCapacity,
	holdExclusiveLock,
	installPool,
	migrateFromLegacyPool,
	opfsSahSupported,
	pausePool,
} from './opfs-pool-ownership'
import type { WorkerRequest, WorkerResponse, WorkerStatusEvent } from './sqlite-wasm-channel'

/** Minimum gap between progress heartbeats sent from inside a long statement. */
const PROGRESS_HEARTBEAT_MS = 500
/** SQLite VM instructions between progress-handler callbacks. */
const PROGRESS_HANDLER_OPS = 20_000

let sqlite3Promise: Promise<Sqlite3Api> | null = null

async function loadSqlite3(): Promise<Sqlite3Api> {
	const sqlite3InitModule = (await import('@sqlite.org/sqlite-wasm')).default
	// In production builds, Vite hashes asset filenames (e.g. sqlite3-[hash].wasm).
	// The sqlite3 module's default locateFile resolves the unhashed name, causing a
	// 404. The worker/host entry sets __KORA_SQLITE_WASM_URL via a `?url` import so
	// we can override locateFile with the correct hashed URL.
	const wasmUrl = (globalThis as Record<string, unknown>).__KORA_SQLITE_WASM_URL as
		| string
		| undefined
	const initOptions = wasmUrl
		? {
				locateFile: (file: string): string => (file.endsWith('.wasm') ? wasmUrl : file),
			}
		: undefined
	const initFn = sqlite3InitModule as unknown as (
		opts?: Record<string, unknown>,
	) => Promise<unknown>
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return (await Promise.race([
			initFn(initOptions),
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error('SQLite3 module init timed out after 60000ms')),
					60_000,
				)
			}),
		])) as Sqlite3Api
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}

function getSqlite3(): Promise<Sqlite3Api> {
	if (!sqlite3Promise) {
		sqlite3Promise = loadSqlite3()
	}
	return sqlite3Promise
}

/** Options for {@link createSqliteWasmCore}. */
export interface SqliteWasmCoreOptions {
	/** Posts unsolicited status (blocking state) to the tab that owns this worker. */
	postEvent?: (event: WorkerStatusEvent) => void
	/**
	 * Called from inside long-running statements (sqlite progress handler) so the
	 * worker can keep announcing liveness to follower tabs while it is busy.
	 */
	onProgress?: () => void
}

/** Handle to a single database, dispatching the worker protocol for it. */
export interface SqliteWasmCore {
	handle(request: WorkerRequest): Promise<WorkerResponse>
}

/**
 * Creates a core bound to one database. `handle` resolves with the response for
 * each request; the caller routes it back through the dedicated worker's
 * `postMessage`.
 */
export function createSqliteWasmCore(options: SqliteWasmCoreOptions = {}): SqliteWasmCore {
	let db: SqliteDb | null = null
	let sqlite3Api: Sqlite3Api | null = null
	let persistent = false
	let fallbackReason: 'timeout' | 'unsupported' | 'lock-conflict' | undefined
	let pool: OpfsPool | null = null
	let poolName: string | null = null
	let releasePoolLock: (() => void) | null = null
	let openInfo: { created: boolean; migratedFromLegacy: boolean } = {
		created: false,
		migratedFromLegacy: false,
	}
	let lastProgressBeat = 0

	function reporterFor(resource: 'pool' | 'legacy-pool', name: string): BlockingReporter {
		return {
			blocked: () => options.postEvent?.({ kind: 'storage-blocked', resource, poolName: name }),
			unblocked: (waitedMs) =>
				options.postEvent?.({ kind: 'storage-unblocked', resource, poolName: name, waitedMs }),
		}
	}

	/** Close the database and give the pool back: handles first, then the lock. */
	async function releaseStorage(mode: 'pause' | 'remove'): Promise<void> {
		if (db) {
			detachProgressHandler(db)
			try {
				db.close()
			} finally {
				db = null
			}
		}
		if (pool) {
			if (mode === 'remove') {
				await pool.removeVfs()
			} else {
				pausePool(pool)
			}
			pool = null
		}
		releasePoolLock?.()
		releasePoolLock = null
	}

	function attachProgressHandler(target: SqliteDb): void {
		const register = sqlite3Api?.capi?.sqlite3_progress_handler
		if (!options.onProgress || typeof register !== 'function' || !target.pointer) return
		register(
			target.pointer,
			PROGRESS_HANDLER_OPS,
			() => {
				const now = Date.now()
				if (now - lastProgressBeat >= PROGRESS_HEARTBEAT_MS) {
					lastProgressBeat = now
					options.onProgress?.()
				}
				return 0
			},
			0,
		)
	}

	function detachProgressHandler(target: SqliteDb): void {
		const register = sqlite3Api?.capi?.sqlite3_progress_handler
		if (typeof register !== 'function' || !target.pointer) return
		try {
			register(target.pointer, 0, 0, 0)
		} catch {
			// Closing the database releases the handler binding anyway.
		}
	}

	async function openOpfs(
		sqlite3: Sqlite3Api,
		dbName: string,
		mustExist: boolean,
	): Promise<WorkerResponse | null> {
		const name = opfsPoolNameFor(dbName)
		const path = opfsPoolPath(dbName)
		poolName = name
		releasePoolLock = await holdExclusiveLock(opfsPoolLockName(name), reporterFor('pool', name))
		pool = await installPool(sqlite3, name, reporterFor('pool', name))

		let migratedFromLegacy = false
		if (!pool.getFileNames().includes(path)) {
			migratedFromLegacy = await migrateFromLegacyPool(
				sqlite3,
				pool,
				path,
				reporterFor('legacy-pool', name),
			)
		}
		const existedBefore = pool.getFileNames().includes(path)
		if (!existedBefore && mustExist) {
			// Do not leave behind the empty pool this probe just created.
			await releaseStorage(pool.getFileCount() === 0 ? 'remove' : 'pause')
			return { id: 0, type: 'error', message: `Database file ${path} not found`, code: 'NOT_FOUND' }
		}
		await ensurePoolCapacity(pool)
		try {
			db = new pool.OpfsSAHPoolDb(path)
		} catch (error) {
			if (!existedBefore) pool.unlink(path)
			throw error
		}
		persistent = true
		openInfo = { created: !existedBefore, migratedFromLegacy }
		return null
	}

	async function open(
		id: number,
		ddlStatements: string[],
		dbName: string,
		storage: 'opfs' | 'memory',
		mustExist: boolean,
	): Promise<WorkerResponse> {
		// Re-run idempotent DDL on the existing handle rather than opening the
		// database a second time (a follower's open lands here on the leader).
		if (db) {
			try {
				applyDdl(db, ddlStatements)
				return { id, type: 'success', data: buildOpenData() }
			} catch (error) {
				return { id, type: 'error', message: (error as Error).message, code: 'INIT_ERROR' }
			}
		}

		let createdPath: string | null = null
		try {
			const sqlite3 = await getSqlite3()
			sqlite3Api = sqlite3
			if (storage === 'opfs' && opfsSahSupported(sqlite3)) {
				try {
					const early = await openOpfs(sqlite3, dbName, mustExist)
					if (early) return { ...early, id }
					if (openInfo.created) createdPath = opfsPoolPath(dbName)
				} catch (error) {
					if (!(error instanceof PoolUnavailableError) || error.reason === 'lock-conflict') {
						throw error
					}
					// Only an unsupported or hung OPFS selects memory here; the adapter
					// then reports it (and refuses writes unless the app opted in).
					await releaseStorage('pause')
					fallbackReason = error.reason
				}
			} else {
				fallbackReason = 'unsupported'
			}
			if (!db) {
				db = new sqlite3.oo1.DB({ filename: ':memory:' })
				persistent = false
			}

			// NEW-STORE-11: no `PRAGMA journal_mode = WAL` here. WAL needs the VFS's
			// shared-memory methods, which opfs-sahpool does not implement, so the pragma
			// was a silent no-op (the mode stayed `delete`). The OPFS database uses
			// SQLite's default rollback journal (DELETE), the in-memory fallback uses
			// `memory`; the actual mode is reported in the open result (`journalMode`).
			db.exec({ sql: 'PRAGMA foreign_keys = ON' })
			applyDdl(db, ddlStatements)
			attachProgressHandler(db)
			return { id, type: 'success', data: buildOpenData() }
		} catch (error) {
			// A failed open removes only the file this open created (never existing
			// or migrated data) and gives the pool and its lock back (NEW-STORE-8).
			const currentPool = pool
			if (db) {
				try {
					db.close()
				} catch {
					// Already failing; the original error is what matters.
				}
				db = null
			}
			if (createdPath && currentPool) {
				try {
					currentPool.unlink(createdPath)
					currentPool.unlink(`${createdPath}-journal`)
				} catch {
					// Best effort: an empty leftover slot is harmless.
				}
			}
			try {
				await releaseStorage('pause')
			} catch {
				// The worker is about to be terminated by the adapter anyway.
			}
			const reason = error instanceof PoolUnavailableError ? error.reason : undefined
			return {
				id,
				type: 'error',
				message: (error as Error).message,
				code: 'INIT_ERROR',
				context: {
					...(reason ? { reason } : {}),
					...(createdPath ? { removedCreatedFile: createdPath } : {}),
				},
			}
		}
	}

	function readJournalMode(): string | undefined {
		if (!db) return undefined
		try {
			let mode: string | undefined
			db.exec({
				sql: 'PRAGMA journal_mode',
				rowMode: 'object',
				callback: (row: Record<string, unknown>) => {
					if (typeof row.journal_mode === 'string') mode = row.journal_mode
				},
			})
			return mode
		} catch {
			// Diagnostic only: an unreadable mode must not fail the open.
			return undefined
		}
	}

	function buildOpenData(): Record<string, unknown> {
		const journalMode = readJournalMode()
		return {
			...(journalMode ? { journalMode } : {}),
			persistent,
			...(persistent ? {} : { fallbackReason: fallbackReason ?? 'unsupported' }),
			...(poolName && persistent ? { poolName } : {}),
			created: openInfo.created,
			migratedFromLegacy: openInfo.migratedFromLegacy,
		}
	}

	function applyDdl(target: SqliteDb, ddlStatements: string[]): void {
		for (const sql of ddlStatements) {
			const ceiling = parseSchemaCeiling(sql)
			if (ceiling !== null) {
				// A database a newer build migrated gets none of this build's DDL (RT-109).
				const rows: Array<{ value: unknown }> = []
				target.exec({
					sql: STORED_SCHEMA_VERSION_SQL,
					rowMode: 'object',
					callback: (row: Record<string, unknown>) => {
						rows.push({ value: row.value })
					},
				})
				const stored = storedSchemaVersion(rows)
				if (stored > ceiling) throw new Error(schemaAheadMessage(stored, ceiling))
				continue
			}
			if (sql.startsWith('--kora:safe-alter')) {
				try {
					target.exec({ sql: sql.replace('--kora:safe-alter\n', '') })
				} catch (error) {
					const msg = (error as Error).message || ''
					if (!msg.includes('duplicate column name')) {
						throw error
					}
				}
			} else {
				target.exec({ sql })
			}
		}
	}

	function execute(id: number, sql: string, params?: unknown[]): WorkerResponse {
		if (!db) {
			return { id, type: 'error', message: 'Database is not open', code: 'DB_NOT_OPEN' }
		}
		try {
			db.exec({ sql, bind: params })
			return { id, type: 'success' }
		} catch (error) {
			return { id, type: 'error', message: (error as Error).message, code: 'EXEC_ERROR' }
		}
	}

	function query(id: number, sql: string, params?: unknown[]): WorkerResponse {
		if (!db) {
			return { id, type: 'error', message: 'Database is not open', code: 'DB_NOT_OPEN' }
		}
		try {
			const rows: Record<string, unknown>[] = []
			db.exec({
				sql,
				bind: params,
				rowMode: 'object',
				callback: (row: Record<string, unknown>) => {
					rows.push({ ...row })
				},
			})
			return { id, type: 'success', data: rows }
		} catch (error) {
			return { id, type: 'error', message: (error as Error).message, code: 'QUERY_ERROR' }
		}
	}

	async function close(id: number, mode: 'pause' | 'remove'): Promise<WorkerResponse> {
		try {
			await releaseStorage(mode)
			return { id, type: 'success' }
		} catch (error) {
			return { id, type: 'error', message: (error as Error).message, code: 'CLOSE_ERROR' }
		}
	}

	function migrate(id: number, statements: string[]): WorkerResponse {
		if (!db) {
			return { id, type: 'error', message: 'Database is not open', code: 'DB_NOT_OPEN' }
		}
		try {
			for (const sql of statements) {
				db.exec({ sql })
			}
			return { id, type: 'success' }
		} catch (error) {
			return { id, type: 'error', message: (error as Error).message, code: 'MIGRATE_ERROR' }
		}
	}

	function importData(id: number, data: Uint8Array): WorkerResponse {
		if (!db) {
			return { id, type: 'error', message: 'Database is not open', code: 'DB_NOT_OPEN' }
		}
		if (typeof db.deserialize === 'function') {
			try {
				db.deserialize(data)
				return { id, type: 'success' }
			} catch (error) {
				return { id, type: 'error', message: (error as Error).message, code: 'IMPORT_ERROR' }
			}
		}
		if (!sqlite3Api || typeof sqlite3Api.capi?.sqlite3_deserialize === 'undefined') {
			return {
				id,
				type: 'error',
				message: 'Import not supported in this SQLite WASM runtime',
				code: 'IMPORT_NOT_SUPPORTED',
			}
		}
		return {
			id,
			type: 'error',
			message:
				'Import requires runtime-specific deserialize wiring and is unavailable in this worker build',
			code: 'IMPORT_NOT_SUPPORTED',
		}
	}

	async function handle(request: WorkerRequest): Promise<WorkerResponse> {
		try {
			switch (request.type) {
				case 'open':
					return await open(
						request.id,
						request.ddlStatements,
						request.dbName ?? 'kora-db',
						request.storage ?? 'opfs',
						request.mustExist === true,
					)
				case 'close':
					return await close(request.id, 'pause')
				case 'destroy':
					return await close(request.id, 'remove')
				case 'execute':
					return execute(request.id, request.sql, request.params)
				case 'query':
					return query(request.id, request.sql, request.params)
				case 'begin':
					return execute(request.id, 'BEGIN')
				case 'commit':
					return execute(request.id, 'COMMIT')
				case 'rollback':
					return execute(request.id, 'ROLLBACK')
				case 'migrate':
					return migrate(request.id, request.statements)
				case 'import':
					return importData(request.id, request.data)
				case 'export':
					return {
						id: request.id,
						type: 'error',
						message: 'Export not yet supported in browser worker',
						code: 'EXPORT_NOT_SUPPORTED',
					}
				case 'serve':
					// Handled by the worker entry, which owns the BroadcastChannel.
					return { id: request.id, type: 'success' }
				default:
					return {
						id: (request as WorkerRequest).id,
						type: 'error',
						message: 'Unknown request type',
						code: 'UNKNOWN_REQUEST',
					}
			}
		} catch (error) {
			return {
				id: request.id,
				type: 'error',
				message: (error as Error).message,
				code: 'WORKER_ERROR',
			}
		}
	}

	return { handle }
}
