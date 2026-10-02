/// <reference lib="webworker" />
/**
 * Worker-side OPFS pool ownership (W8a, NEW-STORE-5/7/8/10).
 *
 * Durable storage on the web is a protocol between tabs, workers and the
 * SyncAccessHandle (SAH) pool, not a single open call:
 *
 * - One pool per database ({@link opfsPoolNameFor}); the tab leader lock already
 *   makes one tab the owner of each database.
 * - The worker that installs a pool holds the Web Lock named after it for the
 *   pool's whole life. Termination of that worker releases both the lock and the
 *   file handles, so the next owner waits on the lock instead of racing.
 * - The lock can be released a few milliseconds before the browser finishes
 *   closing the old worker's handles (measured ~90ms). Before installing, the
 *   new owner therefore probes every pool file for a free handle and waits.
 *   This matters for correctness, not just speed: when sqlite-wasm's install
 *   fails half-way it calls `removeVfs()`, which recursively deletes the pool
 *   directory's files that are not locked. Installing only once every handle is
 *   free keeps that path unreachable.
 * - Contention with a live holder is a wait plus a reported blocking state,
 *   never a fallback to non-durable storage.
 *
 * This file runs inside the dedicated SQLite worker; it is exercised by the
 * real-browser suite (tests/repro/browser), not by Node unit tests.
 */

import { LEGACY_OPFS_POOL_NAME, opfsPoolDirectory, opfsPoolLockName } from './opfs-names'

/** The subset of sqlite-wasm's oo1.DB the worker uses. */
export interface SqliteDb {
	exec(opts: {
		sql: string
		bind?: unknown[]
		returnValue?: string
		rowMode?: string
		callback?: (row: Record<string, unknown>) => void
	}): unknown
	close(): void
	pointer?: number
	deserialize?: (data: Uint8Array) => void
}

/** The subset of sqlite-wasm's OpfsSAHPoolUtil the worker uses. */
export interface OpfsPool {
	OpfsSAHPoolDb: new (filename: string) => SqliteDb
	getFileCount(): number
	getFileNames(): string[]
	getCapacity(): number
	reserveMinimumCapacity(min: number): Promise<number>
	exportFile(name: string): Uint8Array
	importDb(name: string, bytes: Uint8Array): number | Promise<number>
	unlink(name: string): boolean
	removeVfs(): Promise<boolean>
	pauseVfs(): unknown
	unpauseVfs(): Promise<unknown>
	isPaused(): boolean
}

/** The subset of the sqlite3 namespace the worker uses. */
export interface Sqlite3Api {
	oo1: { DB: new (opts: { filename: string }) => SqliteDb }
	installOpfsSAHPoolVfs?: (opts: {
		name: string
		forceReinitIfPreviouslyFailed?: boolean
	}) => Promise<OpfsPool>
	capi?: {
		sqlite3_deserialize?: unknown
		sqlite3_progress_handler?: (
			db: number,
			nOps: number,
			handler: (() => number) | 0,
			ctx: number,
		) => void
	}
}

/** Reports the start and end of a wait on another holder. */
export interface BlockingReporter {
	blocked(): void
	unblocked(waitedMs: number): void
}

/** Free slots kept beyond the database being opened (other journals, imports). */
const OPFS_POOL_HEADROOM = 2

/** How long a wait stays silent before it is reported as a blocking state. */
const BLOCKED_REPORT_AFTER_MS = 750

/** Install attempts after the handle probe said "free" (covers the release race). */
const INSTALL_RACE_ATTEMPTS = 20

/** Headless browsers and some profiles hang on OPFS VFS install. */
const OPFS_INIT_TIMEOUT_MS = 10_000

const OPAQUE_DIR_NAME = '.opaque'

/** Why a durable pool could not be obtained. Contention is never a reason: it waits. */
export class PoolUnavailableError extends Error {
	constructor(
		message: string,
		readonly reason: 'unsupported' | 'timeout' | 'lock-conflict',
	) {
		super(message)
		this.name = 'PoolUnavailableError'
	}
}

/** True when this worker has every API the SAH pool needs. */
export function opfsSahSupported(sqlite3: Sqlite3Api): boolean {
	const g = globalThis as Record<string, unknown>
	const fileHandle = g.FileSystemFileHandle as { prototype?: Record<string, unknown> } | undefined
	return (
		typeof sqlite3.installOpfsSAHPoolVfs === 'function' &&
		typeof g.FileSystemDirectoryHandle !== 'undefined' &&
		typeof fileHandle?.prototype?.createSyncAccessHandle === 'function' &&
		typeof navigator !== 'undefined' &&
		typeof navigator.storage?.getDirectory === 'function'
	)
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(new PoolUnavailableError(`${label} timed out after ${timeoutMs}ms`, 'timeout')),
					timeoutMs,
				)
			}),
		])
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}

/**
 * Acquire an exclusive Web Lock and hold it until the returned release function
 * is called (or this worker terminates). Waits for a live holder, reporting the
 * wait once it lasts long enough to matter. Without the Web Locks API (very old
 * engines that also lack the SAH pool) it returns a no-op release.
 */
export async function holdExclusiveLock(
	name: string,
	reporter?: BlockingReporter,
): Promise<() => void> {
	const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
	if (!locks || typeof locks.request !== 'function') {
		return () => {}
	}
	const grab = (ifAvailable: boolean): Promise<(() => void) | null> =>
		new Promise<(() => void) | null>((resolve, reject) => {
			locks
				.request(name, { mode: 'exclusive', ifAvailable }, (lock) => {
					if (lock === null) {
						resolve(null)
						return undefined
					}
					return new Promise<void>((release) => {
						resolve(() => release())
					})
				})
				.catch(reject)
		})

	const immediate = await grab(true)
	if (immediate) return immediate
	const start = Date.now()
	reporter?.blocked()
	const release = await grab(false)
	if (!release) {
		throw new PoolUnavailableError(`Web Lock "${name}" was not granted`, 'lock-conflict')
	}
	reporter?.unblocked(Date.now() - start)
	return release
}

interface DirHandle {
	getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirHandle>
	removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
	entries(): AsyncIterable<[string, { kind: string }]>
}

interface FileHandleWithSah {
	kind: 'file'
	createSyncAccessHandle(): Promise<{ close(): void }>
}

async function opfsRoot(): Promise<DirHandle> {
	return (await navigator.storage.getDirectory()) as unknown as DirHandle
}

async function childDirectory(parent: DirHandle, name: string): Promise<DirHandle | null> {
	try {
		return await parent.getDirectoryHandle(name)
	} catch {
		return null
	}
}

/** Whether a pool's directory exists in OPFS (it may still be empty). */
export async function poolDirectoryExists(poolName: string): Promise<boolean> {
	return (await childDirectory(await opfsRoot(), opfsPoolDirectory(poolName))) !== null
}

function isHandleBusy(error: unknown): boolean {
	const name = (error as { name?: string } | null)?.name
	return name === 'NoModificationAllowedError' || name === 'InvalidStateError'
}

/**
 * True when some file of the pool still has an open SyncAccessHandle elsewhere
 * (a live owner, or a terminated owner whose handles are still being released).
 */
async function poolHandlesBusy(poolName: string): Promise<boolean> {
	const dir = await childDirectory(await opfsRoot(), opfsPoolDirectory(poolName))
	if (!dir) return false
	const opaque = await childDirectory(dir, OPAQUE_DIR_NAME)
	if (!opaque) return false
	for await (const [, handle] of opaque.entries()) {
		if (handle.kind !== 'file') continue
		try {
			const access = await (handle as unknown as FileHandleWithSah).createSyncAccessHandle()
			access.close()
		} catch (error) {
			if (isHandleBusy(error)) return true
			throw error
		}
	}
	return false
}

/**
 * Wait until every file in the pool can be opened by this worker. Waits as long
 * as a holder exists (a beta.12 tab that never takes the pool lock, or a raw
 * user of the pool), reporting the blocking state; never gives up and falls back.
 */
async function waitForPoolHandles(poolName: string, reporter?: BlockingReporter): Promise<void> {
	const start = Date.now()
	let reported = false
	let delay = 15
	while (await poolHandlesBusy(poolName)) {
		if (!reported && Date.now() - start >= BLOCKED_REPORT_AFTER_MS) {
			reported = true
			reporter?.blocked()
		}
		await sleep(delay)
		delay = Math.min(delay * 2, 500)
	}
	if (reported) reporter?.unblocked(Date.now() - start)
}

/**
 * Install (or resume) a pool this worker already holds the pool lock for. The
 * bounded retry with `forceReinitIfPreviouslyFailed` covers only the residual
 * handle-release window; sqlite-wasm otherwise caches a failed install forever.
 */
export async function installPool(
	sqlite3: Sqlite3Api,
	poolName: string,
	reporter?: BlockingReporter,
): Promise<OpfsPool> {
	const install = sqlite3.installOpfsSAHPoolVfs
	if (!install || !opfsSahSupported(sqlite3)) {
		throw new PoolUnavailableError('OPFS SyncAccessHandle pool is not supported', 'unsupported')
	}
	let lastError: unknown = null
	for (let attempt = 0; attempt < INSTALL_RACE_ATTEMPTS; attempt += 1) {
		await waitForPoolHandles(poolName, reporter)
		try {
			const pool = await withTimeout(
				install({ name: poolName, forceReinitIfPreviouslyFailed: true }),
				OPFS_INIT_TIMEOUT_MS,
				'OPFS VFS install',
			)
			if (pool.isPaused()) {
				await pool.unpauseVfs()
			}
			return pool
		} catch (error) {
			if (error instanceof PoolUnavailableError) throw error
			lastError = error
			if (!isHandleBusy(error)) break
			await sleep(Math.min(25 * 2 ** attempt, 250))
		}
	}
	const message = lastError instanceof Error ? lastError.message : String(lastError)
	if (isHandleBusy(lastError)) {
		throw new PoolUnavailableError(
			`OPFS pool "${poolName}" stayed busy: ${message}`,
			'lock-conflict',
		)
	}
	throw new PoolUnavailableError(
		`OPFS pool "${poolName}" could not be installed: ${message}`,
		'unsupported',
	)
}

/**
 * Grow the pool to fit the database about to be opened plus its journal before
 * opening it (NEW-STORE-7). Slots are empty pre-allocated files, so this is
 * cheap; files are never evicted.
 */
export async function ensurePoolCapacity(pool: OpfsPool): Promise<void> {
	await pool.reserveMinimumCapacity(pool.getFileCount() + 2 + OPFS_POOL_HEADROOM)
}

/** Runs `PRAGMA quick_check` and throws unless the database reports `ok`. */
export function assertDatabaseHealthy(db: SqliteDb, label: string): void {
	const rows = db.exec({
		sql: 'PRAGMA quick_check',
		returnValue: 'resultRows',
		rowMode: 'array',
	}) as unknown[][]
	const verdict = rows?.[0]?.[0]
	if (verdict !== 'ok') {
		throw new Error(`${label} failed integrity check: ${String(verdict)}`)
	}
}

/** Release the pool's handles (database files must already be closed). */
export function pausePool(pool: OpfsPool): void {
	if (!pool.isPaused()) {
		pool.pauseVfs()
	}
}

/**
 * Move a database file from the origin-wide beta.12 pool (`kora-opfs`) into its
 * own pool, the first time the database opens under W8a.
 *
 * - Runs only when the legacy pool directory exists. Holders of the legacy pool
 *   (another migrating worker, or a beta.12 tab still open) are waited for, never
 *   raced: a beta.12 tab keeps the new tab in the reported blocking state.
 * - Opening the legacy file first lets SQLite roll back a hot journal, so the
 *   exported image is consistent. The imported copy must pass `quick_check`
 *   before the legacy copy is removed.
 * - The legacy pool is kept while it still holds other databases and removed
 *   once its last one has moved.
 *
 * @returns true when this call moved the database.
 */
export async function migrateFromLegacyPool(
	sqlite3: Sqlite3Api,
	target: OpfsPool,
	poolPath: string,
	reporter?: BlockingReporter,
): Promise<boolean> {
	if (!(await poolDirectoryExists(LEGACY_OPFS_POOL_NAME))) {
		return false
	}
	const releaseLegacyLock = await holdExclusiveLock(
		opfsPoolLockName(LEGACY_OPFS_POOL_NAME),
		reporter,
	)
	try {
		// Another worker may have finished the last migration while we waited.
		if (!(await poolDirectoryExists(LEGACY_OPFS_POOL_NAME))) {
			return false
		}
		const legacy = await installPool(sqlite3, LEGACY_OPFS_POOL_NAME, reporter)
		try {
			if (!legacy.getFileNames().includes(poolPath)) {
				return false
			}
			const legacyDb = new legacy.OpfsSAHPoolDb(poolPath)
			try {
				assertDatabaseHealthy(legacyDb, `Legacy database ${poolPath}`)
			} finally {
				legacyDb.close()
			}
			const bytes = legacy.exportFile(poolPath)
			if (bytes.byteLength === 0) {
				// An empty file left by a failed beta.12 open holds no data.
				legacy.unlink(poolPath)
				return false
			}
			await ensurePoolCapacity(target)
			await target.importDb(poolPath, bytes)
			let migratedDb: SqliteDb | null = null
			try {
				migratedDb = new target.OpfsSAHPoolDb(poolPath)
				assertDatabaseHealthy(migratedDb, `Migrated database ${poolPath}`)
			} catch (error) {
				migratedDb?.close()
				migratedDb = null
				// Keep the legacy copy as the source of truth; drop the bad import.
				target.unlink(poolPath)
				throw error
			}
			migratedDb.close()
			legacy.unlink(poolPath)
			legacy.unlink(`${poolPath}-journal`)
			return true
		} finally {
			if (legacy.getFileCount() === 0) {
				await legacy.removeVfs()
			} else {
				pausePool(legacy)
			}
		}
	} finally {
		releaseLegacyLock()
	}
}
