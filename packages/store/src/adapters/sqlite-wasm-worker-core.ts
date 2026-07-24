/// <reference lib="webworker" />
/**
 * Reusable SQLite WASM core, decoupled from any specific worker global.
 *
 * The dedicated worker ({@link file://./sqlite-wasm-worker.ts}) wires one core to
 * `self.onmessage`/`self.postMessage`.
 *
 * The WASM module and the OPFS SyncAccessHandle pool are cached at module scope
 * and shared across every core in the same worker: the pool holds
 * multiple database files keyed by filename, so installing it once and opening
 * each database within it avoids the single-writer conflict that installing the
 * pool twice in one scope would cause.
 *
 * This file cannot be unit-tested in Node (no WASM/OPFS); it is exercised through
 * the browser E2E suite.
 */

import type { WorkerRequest, WorkerResponse } from './sqlite-wasm-channel'

interface SqliteDb {
	exec(opts: {
		sql: string
		bind?: unknown[]
		returnValue?: string
		rowMode?: string
		callback?: (row: Record<string, unknown>) => void
	}): void
	close(): void
	deserialize?: (data: Uint8Array) => void
}

interface OpfsPool {
	OpfsSAHPoolDb: new (filename: string) => SqliteDb
}

interface Sqlite3Api {
	oo1: { DB: new (opts: { filename: string }) => SqliteDb }
	installOpfsSAHPoolVfs?: (opts: { name: string }) => Promise<OpfsPool>
	capi?: { sqlite3_deserialize?: unknown }
}

/** OPFS SAH pool name. Shared across all databases on the origin (the pool holds
 * multiple db files keyed by filename), so it must NOT be namespaced per database
 * or existing persisted data would be orphaned. */
const OPFS_POOL_NAME = 'kora-opfs'

/** Headless browsers and some profiles hang on OPFS VFS install; fall back to memory. */
const OPFS_INIT_TIMEOUT_MS = 10_000

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
					timeoutMs,
				)
			}),
		])
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}

function opfsDatabaseFilename(dbName: string): string {
	const base = dbName.replace(/[^a-zA-Z0-9._-]/g, '_')
	return base.endsWith('.db') ? base : `${base}.db`
}

/**
 * Classify why the OPFS SyncAccessHandle pool could not be installed, so the
 * fallback to in-memory is explainable rather than silent.
 */
function classifyOpfsFailure(error: unknown): 'lock-conflict' | 'timeout' | 'unsupported' {
	const message = error instanceof Error ? error.message : String(error)
	if (/timed out|timeout/i.test(message)) {
		return 'timeout'
	}
	if (
		/lock|already|in use|in-use|NoModificationAllowed|acquire|SyncAccessHandle|being created/i.test(
			message,
		)
	) {
		return 'lock-conflict'
	}
	return 'unsupported'
}

// Scope-global caches shared by every core in this worker.
let sqlite3Promise: Promise<Sqlite3Api> | null = null
let opfsPoolPromise: Promise<OpfsPool | null> | null = null
let opfsFallbackReason: 'lock-conflict' | 'timeout' | 'unsupported' | undefined

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
	return (await withTimeout(initFn(initOptions), 60_000, 'SQLite3 module init')) as Sqlite3Api
}

function getSqlite3(): Promise<Sqlite3Api> {
	if (!sqlite3Promise) {
		sqlite3Promise = loadSqlite3()
	}
	return sqlite3Promise
}

async function installOpfsPool(sqlite3: Sqlite3Api): Promise<OpfsPool | null> {
	if (!sqlite3.installOpfsSAHPoolVfs) {
		opfsFallbackReason = 'unsupported'
		return null
	}
	try {
		return await withTimeout(
			sqlite3.installOpfsSAHPoolVfs({ name: OPFS_POOL_NAME }),
			OPFS_INIT_TIMEOUT_MS,
			'OPFS VFS install',
		)
	} catch (error) {
		opfsFallbackReason = classifyOpfsFailure(error)
		return null
	}
}

function getOpfsPool(sqlite3: Sqlite3Api): Promise<OpfsPool | null> {
	if (!opfsPoolPromise) {
		opfsPoolPromise = installOpfsPool(sqlite3)
	}
	return opfsPoolPromise
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
export function createSqliteWasmCore(): SqliteWasmCore {
	let db: SqliteDb | null = null
	let sqlite3Api: Sqlite3Api | null = null
	let persistent = false

	async function open(
		id: number,
		ddlStatements: string[],
		dbName?: string,
	): Promise<WorkerResponse> {
		try {
			// Re-run idempotent DDL on the existing handle rather than opening the
			// database a second time.
			if (db) {
				applyDdl(db, ddlStatements)
				return { id, type: 'success', data: buildOpenData() }
			}

			const sqlite3 = await getSqlite3()
			sqlite3Api = sqlite3
			const pool = await getOpfsPool(sqlite3)

			if (pool) {
				db = new pool.OpfsSAHPoolDb(opfsDatabaseFilename(dbName ?? 'kora-db'))
				persistent = true
			} else {
				db = new sqlite3.oo1.DB({ filename: ':memory:' })
				persistent = false
			}

			db.exec({ sql: 'PRAGMA journal_mode = WAL' })
			db.exec({ sql: 'PRAGMA foreign_keys = ON' })

			applyDdl(db, ddlStatements)
			return { id, type: 'success', data: buildOpenData() }
		} catch (error) {
			return { id, type: 'error', message: (error as Error).message, code: 'INIT_ERROR' }
		}
	}

	function buildOpenData(): { persistent: boolean; fallbackReason?: string } {
		return {
			persistent,
			...(persistent ? {} : { fallbackReason: opfsFallbackReason ?? 'unsupported' }),
		}
	}

	function applyDdl(target: SqliteDb, ddlStatements: string[]): void {
		for (const sql of ddlStatements) {
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

	function close(id: number): WorkerResponse {
		if (db) {
			db.close()
			db = null
		}
		return { id, type: 'success' }
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
		const dbWithDeserialize = db as SqliteDb & { deserialize?: (bytes: Uint8Array) => void }
		if (typeof dbWithDeserialize.deserialize === 'function') {
			try {
				dbWithDeserialize.deserialize(data)
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
					return await open(request.id, request.ddlStatements, request.dbName)
				case 'close':
					return close(request.id)
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
