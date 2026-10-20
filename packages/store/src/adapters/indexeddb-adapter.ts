import type { KoraEventEmitter, SchemaDefinition } from '@korajs/core'
import {
	AdapterError,
	BridgeTerminatedError,
	PersistenceError,
	SchemaVersionAheadError,
	StorageBackendMismatchError,
} from '../errors'
import { STORED_SCHEMA_VERSION_SQL, storedSchemaVersion } from '../migrations/schema-ceiling'
import type { MigrationPlan, StorageAdapter, StorageOpenState, Transaction } from '../types'
import { type DatabaseDump, exportDump, restoreDumpStatements } from './database-dump'
import { IndexedDbPersistenceScheduler } from './indexeddb-persistence-scheduler'
import { SqliteWasmAdapter } from './sqlite-wasm-adapter'
import type { WorkerBridge } from './sqlite-wasm-channel'
import {
	type PreservedSnapshot,
	SNAPSHOT_DIVERGED,
	SNAPSHOT_SUPERSEDED,
	type SnapshotAncestor,
	type SnapshotReconciliation,
	type SnapshotSaveResult,
	type SnapshotVersion,
	type StartedSnapshotLineage,
	isIndexedDbQuotaError,
	loadPreservedSnapshotsFromIndexedDB,
	saveLegacySnapshotToIndexedDB,
	saveSnapshotToIndexedDB,
	startSnapshotLineage,
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
	/**
	 * This tab's writes not yet in a saved snapshot, per worker database (lineage): the
	 * highest commit count among them and the lineage's epoch. A write is durable only once
	 * a snapshot of the SAME worker database at that count or later is saved.
	 */
	private readonly unconfirmedWrites = new Map<string, { epoch: number; seq: number }>()
	/**
	 * Worker databases this tab wrote to that were replaced (the storage leader changed)
	 * before those writes were saved: the writes are gone. Every durability barrier rejects
	 * while one is listed (each covers every write committed before it, the lost ones
	 * included), until {@link acknowledgeLostWrites} clears them.
	 */
	private readonly lostLineages = new Set<string>()

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
			// The fresh worker database is marked restored, then receives the OPFS copy. It
			// starts a new snapshot lineage, so its snapshot replaces any older IndexedDB copy.
			// Its data comes from OPFS, so it claims none of the IndexedDB snapshot's writes.
			const lineage = newLineageId()
			const { epoch } = await startSnapshotLineage(this.dbName, lineage, 'replace')
			let counted: CountedWrite | undefined
			// One transaction: the lineage, the data and its count land in the same worker
			// database, or none of them does.
			await this.inner.transaction(async (tx) => {
				await markRestored(tx, epoch, lineage)
				for (const statement of restoreDumpStatements(carried)) {
					await tx.execute(statement.sql, statement.params)
				}
				counted = await countCommit(tx)
			})
			this.recordWrite(counted)
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
		// A snapshot a newer build migrated (RT-109): refuse it before anything writes, and
		// without the snapshot a close() would write (the in-memory copy ran this build's
		// DDL before the restore).
		const stored = storedSchemaVersion(
			await this.inner.query<{ value: unknown }>(STORED_SCHEMA_VERSION_SQL),
		)
		if (stored > schema.version) {
			this.scheduler.dispose()
			await this.inner.close().catch(() => undefined)
			throw new SchemaVersionAheadError(this.dbName, stored, schema.version)
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

	async close(): Promise<void> {
		await this.scheduler.flushNow()
		this.scheduler.dispose()
		await this.inner.close()
	}

	async execute(sql: string, params?: unknown[]): Promise<void> {
		if (OUTSIDE_TRANSACTION.test(sql)) {
			// A statement that cannot run in a transaction (PRAGMA foreign_keys is a silent
			// no-op inside one) changes connection settings, not the rows a snapshot holds.
			await this.inner.execute(sql, params)
			this.scheduler.schedule()
			return
		}
		// The write and its count run in one transaction span, which is pinned to one worker
		// database: if the storage leader changes in between, the span fails (nothing is
		// applied or counted on the new worker) instead of counting the write under a
		// database it never reached.
		let counted: CountedWrite | undefined
		await this.inner.transaction(async (tx) => {
			await tx.execute(sql, params)
			counted = await countCommit(tx)
		})
		this.recordWrite(counted)
		this.scheduler.schedule()
	}

	async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		return this.inner.query<T>(sql, params)
	}

	async transaction(fn: (tx: Transaction) => Promise<void>): Promise<void> {
		let counted: CountedWrite | undefined
		await this.inner.transaction(async (tx) => {
			await fn(tx)
			counted = await countCommit(tx)
		})
		this.recordWrite(counted)
		this.scheduler.schedule()
	}

	async migrate(from: number, to: number, migration: MigrationPlan): Promise<void> {
		// The migration and its count commit in one span on one worker database (as in
		// `execute`), so the count is the migration's own.
		let counted: CountedWrite | undefined
		try {
			await this.inner.transaction(async (tx) => {
				for (const sql of migration.statements) {
					await tx.execute(sql)
				}
				counted = await countCommit(tx)
			})
		} catch (error) {
			if (error instanceof BridgeTerminatedError) throw error
			throw new AdapterError(
				`Migration from v${from} to v${to} failed: ${error instanceof Error ? error.message : String(error)}`,
				{ from, to },
			)
		}
		this.recordWrite(counted)
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
	 *
	 * A write counts as persisted only when a snapshot of the worker database it was made
	 * in is saved. When that database was replaced first (the storage leader changed and
	 * the new leader restored an older snapshot), the write is gone and the barrier rejects
	 * with a {@link PersistenceError} (`context.code` `SNAPSHOT_SUPERSEDED`, `context.lineages`)
	 * instead of resolving on a snapshot of the new database.
	 *
	 * A lost write stays lost: every later barrier also covers it (it was committed before
	 * them) and rejects the same way, so a retry never reports it saved. The snapshot is
	 * still written first, so later writes are persisted meanwhile. Once the loss is handled
	 * (re-made or given up), {@link acknowledgeLostWrites} clears it and barriers judge the
	 * remaining writes only.
	 */
	async ensureDurable(): Promise<void> {
		const needed = [...this.unconfirmedWrites.keys()]
		await this.scheduler.flushBarrier()
		this.throwIfWritesLost()
		let unsaved = needed.filter((lineage) => this.unconfirmedWrites.has(lineage))
		if (unsaved.length > 0) {
			// A snapshot the scheduler counted may have been taken just before a write's count
			// was read back: take one more, then decide.
			await this.scheduler.flushNow()
			unsaved = needed.filter((lineage) => this.unconfirmedWrites.has(lineage))
		}
		if (unsaved.length > 0) {
			throw new PersistenceError(
				`Writes to database "${this.dbName}" are not in a saved snapshot yet`,
				{ dbName: this.dbName, code: 'SNAPSHOT_PENDING', lineages: unsaved },
			)
		}
	}

	/**
	 * Clear the writes this tab lost to a leader change, after the app handled them. Until
	 * then every {@link ensureDurable} rejects with `SNAPSHOT_SUPERSEDED`.
	 *
	 * @returns the worker databases (lineages) whose lost writes were acknowledged
	 */
	acknowledgeLostWrites(): string[] {
		const lineages = [...this.lostLineages]
		this.lostLineages.clear()
		return lineages
	}

	/**
	 * Copies of this database a tab running an earlier release saved, kept aside because
	 * they held operations the restored copy lacks (`store:persistence-error` with code
	 * `SNAPSHOT_DIVERGED`). Never deleted by Kora; recover from them as needed.
	 */
	async preservedSnapshots(): Promise<Array<PreservedSnapshot<DatabaseDump>>> {
		return loadPreservedSnapshotsFromIndexedDB<DatabaseDump>(this.dbName)
	}

	private throwIfWritesLost(): void {
		if (this.lostLineages.size === 0) return
		throw new PersistenceError(
			`Writes to database "${this.dbName}" were lost before they were saved: the copy of the database they were made in was replaced (the storage leader tab changed). They are not in the database any more and must not be treated as saved. Every durability barrier rejects until acknowledgeLostWrites() is called.`,
			{ dbName: this.dbName, code: SNAPSHOT_SUPERSEDED, lineages: [...this.lostLineages] },
		)
	}

	/** Remember a write this tab committed, by the worker database and count it got. */
	private recordWrite(counted: CountedWrite | undefined): void {
		// No row: a worker database opened by an earlier build, which has no lineage until
		// its first snapshot from this build; such writes are covered as before.
		if (!counted) return
		const previous = this.unconfirmedWrites.get(counted.lineage)
		if (!previous || counted.seq > previous.seq) {
			this.unconfirmedWrites.set(counted.lineage, { epoch: counted.epoch, seq: counted.seq })
		}
	}

	/**
	 * Settle this tab's unsaved writes against the snapshot IndexedDB now holds (`stored`,
	 * and the worker databases it descends from, `ancestors`). A write is durable when the
	 * stored snapshot, or the snapshot an ancestor was saved at before it was replaced,
	 * holds its commit count. A write in a worker database that was replaced before a
	 * snapshot holding it was saved is lost: no snapshot can hold it any more (later saves
	 * of that database are refused). `refused` is the lineage whose save was just refused.
	 */
	private settleWrites(
		stored: SnapshotVersion | null,
		ancestors: SnapshotAncestor[],
		refused: string | null,
	): void {
		for (const [lineage, pending] of this.unconfirmedWrites) {
			if (stored && lineage === stored.lineage && lineage !== refused) {
				if (pending.seq <= stored.seq) this.unconfirmedWrites.delete(lineage)
				continue
			}
			const ancestor = ancestors.find((entry) => entry.lineage === lineage)
			if (ancestor) {
				if (pending.seq <= ancestor.seq) this.unconfirmedWrites.delete(lineage)
				else this.markLost(lineage)
				continue
			}
			// Not in the (bounded) ancestry: replaced when a later database started.
			if (lineage === refused || stored === null || pending.epoch < stored.epoch) {
				this.markLost(lineage)
			}
		}
	}

	/** This tab's unsaved writes in `lineage` are gone; barriers report it until acknowledged. */
	private markLost(lineage: string): void {
		if (!this.unconfirmedWrites.delete(lineage)) return
		this.lostLineages.add(lineage)
		this.emitter?.emit({
			type: 'store:persistence-error',
			dbName: this.dbName,
			message: `Writes to database "${this.dbName}" were lost before they were saved: the copy of the database they were made in was replaced when the storage leader tab changed.`,
			code: SNAPSHOT_SUPERSEDED,
		})
	}

	/**
	 * Save a snapshot of the worker database. Every tab's adapter snapshots the same worker
	 * database (a follower's export runs on the leader's worker), so two tabs' saves can
	 * reach IndexedDB in either order. Each snapshot carries the version it was read at,
	 * and the save is a compare-and-put that never lets an older snapshot replace a newer
	 * one; a save the stored snapshot already covers succeeds without writing.
	 */
	private async writeSnapshot(): Promise<void> {
		const { dump, version } = await this.exportDump()

		if (version === null) {
			// A worker database an earlier release opened (a tab still running it leads): it
			// has no lineage, so it is saved the way that release saves it, in the legacy
			// layout only, never over the versioned snapshot. The next lineage to start
			// compares the two copies by their operations. The dump alone: with no lineage, an
			// image exported by a separate request could not be proven to come from the same
			// worker database.
			const { stored, ancestors } = await saveLegacySnapshotToIndexedDB(this.dbName, dump, null)
			// This tab's writes were counted in worker databases that had a lineage, so those
			// were replaced by this one: each is saved if a versioned snapshot holds it, else lost.
			this.settleWrites(stored, ancestors, null)
			for (const lineage of [...this.unconfirmedWrites.keys()]) this.markLost(lineage)
			return
		}

		let data: Uint8Array | null = null
		try {
			data = await this.inner.exportDatabase()
		} catch (error) {
			if (!isUnsupportedWorkerExport(error)) {
				throw error
			}
		}
		if (data !== null) {
			// The binary image is a separate request, so another tab may have committed in
			// between, or the leader changed and it came from another worker database. Keep it
			// only when the same database still has the same count (a lineage is unique per
			// worker database), so the image a restore prefers holds the same counted writes
			// as the dump stored with it; otherwise store the dump alone (it restores fully).
			const after = (await this.inner.query<SnapshotStateRow>(SNAPSHOT_STATE_SQL))[0]
			if (after?.lineage !== version.lineage || after.seq !== version.seq) {
				data = null
			}
		}

		let saved: SnapshotSaveResult
		try {
			saved = await saveSnapshotToIndexedDB(this.dbName, { dump, data, version })
		} catch (error) {
			if (error instanceof PersistenceError && error.context?.code === SNAPSHOT_SUPERSEDED) {
				// This snapshot's worker database was replaced: settle this tab's writes against
				// what IndexedDB holds (an earlier save by another tab may hold them).
				const stored = error.context.stored as SnapshotVersion | null
				const ancestors = (error.context.storedAncestors as SnapshotAncestor[] | undefined) ?? []
				this.settleWrites(stored, ancestors, version.lineage)
			}
			throw error
		}
		this.settleWrites(version, saved.ancestors, null)
	}

	/** Report a restore that had to keep a legacy-layout copy aside ({@link SNAPSHOT_DIVERGED}). */
	private reportReconciliation(reconciliation: SnapshotReconciliation): void {
		const where = `"${reconciliation.source !== 'none' ? (reconciliation.preservedKey ?? '') : ''}" (see preservedSnapshots())`
		let message: string | null = null
		if (reconciliation.source === 'v2' && reconciliation.legacy === 'diverged') {
			message = `Database "${this.dbName}" has two IndexedDB copies that each hold operations the other lacks: a tab running an earlier Kora release saved one while this release saved the other. The copy this release saved was restored; the other was kept aside under ${where} and was not deleted.`
		} else if (reconciliation.source === 'legacy' && reconciliation.reason === 'recreated') {
			message = `Database "${this.dbName}" was deleted and created again by a tab running an earlier Kora release. That database was restored; this release's copy of the deleted one was kept aside under ${where} and was not deleted.`
		}
		if (message === null) return
		this.emitter?.emit({
			type: 'store:persistence-error',
			dbName: this.dbName,
			message,
			code: SNAPSHOT_DIVERGED,
		})
	}

	private handlePersistenceError(error: unknown): void {
		const message = error instanceof Error ? error.message : 'IndexedDB persistence failed'
		// A refused snapshot save is reported with its own code (it is in the error's context:
		// `PersistenceError.code` is always PERSISTENCE_ERROR); other errors as before.
		const detail = error instanceof PersistenceError ? error.context?.code : undefined
		const code =
			detail === SNAPSHOT_SUPERSEDED
				? SNAPSHOT_SUPERSEDED
				: error instanceof PersistenceError
					? error.code
					: 'PERSISTENCE_FAILED'
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
		const fresh = { value: false }
		await this.inner.transaction(async (tx) => {
			fresh.value = !(await isRestored(tx))
		})
		if (!fresh.value) return
		// One IndexedDB transaction claims the new lineage's epoch, reads the snapshot to
		// restore (binary image, dump) and fences it: no save of an older worker database
		// can land between what is restored here and this lineage's first save.
		const lineage = newLineageId()
		const started = await startSnapshotLineage<DatabaseDump>(this.dbName, lineage)
		this.reportReconciliation(started.reconciliation)
		if (started.data) {
			try {
				await this.inner.importDatabase(started.data)
				await this.inner.transaction((tx) => markRestored(tx, started.epoch, lineage))
				return
			} catch {
				// Fall through to the JSON dump.
			}
		}
		await this.inner.transaction((tx) => this.restoreDumpIfFresh(tx, { lineage, started }))
	}

	/**
	 * In `tx`: restore the JSON dump when no snapshot was restored into this database,
	 * starting its lineage first (or with the one `restoreIfFresh` started).
	 */
	private async restoreDumpIfFresh(
		tx: Transaction,
		begun?: { lineage: string; started: StartedSnapshotLineage<DatabaseDump> },
	): Promise<void> {
		if (await isRestored(tx)) return
		const lineage = begun?.lineage ?? newLineageId()
		let started = begun?.started
		if (!started) {
			started = await startSnapshotLineage<DatabaseDump>(this.dbName, lineage)
			this.reportReconciliation(started.reconciliation)
		}
		await markRestored(tx, started.epoch, lineage)
		if (!started.dump) return
		for (const statement of restoreDumpStatements(started.dump)) {
			await tx.execute(statement.sql, statement.params)
		}
	}

	/**
	 * A consistent snapshot: every table and the snapshot version are read inside one
	 * transaction (STORE-7), so the version names exactly the counted writes the dump holds.
	 * The version is null for a worker database an earlier release opened (no lineage).
	 */
	private async exportDump(): Promise<{
		dump: DatabaseDump
		version: SnapshotVersion | null
	}> {
		let dump: DatabaseDump = { tables: [] }
		let state: SnapshotStateRow | undefined
		await this.inner.transaction(async (tx) => {
			state = (await readSnapshotState(tx))[0]
			dump = await exportDump((sql, params) => tx.query(sql, params))
		})
		return {
			dump,
			version: state ? { epoch: state.epoch, lineage: state.lineage, seq: state.seq } : null,
		}
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

async function markRestored(tx: Transaction, epoch: number, lineage: string): Promise<void> {
	await tx.execute(`CREATE TEMP TABLE IF NOT EXISTS ${RESTORED_MARKER} (restored INTEGER)`)
	await setLineageState(tx, epoch, lineage)
}

/**
 * Connection-local snapshot version of the worker database (a TEMP table, like the
 * marker: never part of a dump or a binary image), shared by every tab using the worker.
 * `lineage` identifies this in-memory database, `epoch` was claimed for it by
 * {@link startSnapshotLineage}, and `seq` counts the write transactions committed in it.
 */
const SNAPSHOT_STATE = '_kora_idb_snapshot_state'
const SNAPSHOT_STATE_SQL = `SELECT epoch, lineage, seq FROM temp.${SNAPSHOT_STATE}`
const CREATE_SNAPSHOT_STATE_SQL = `CREATE TEMP TABLE IF NOT EXISTS ${SNAPSHOT_STATE} (epoch INTEGER NOT NULL, lineage TEXT NOT NULL, seq INTEGER NOT NULL)`
/**
 * Counts one committed write and returns the count it got. A no-op while the worker
 * database has no state row (a database opened by an earlier build: its first snapshot
 * from this build starts a lineage).
 */
const COUNT_COMMIT_SQL = `UPDATE temp.${SNAPSHOT_STATE} SET seq = seq + 1 RETURNING epoch, lineage, seq`

/**
 * Statements `execute` runs outside a transaction: SQLite refuses them in one, or (PRAGMA
 * foreign_keys) silently ignores them there. None changes the rows a snapshot holds.
 */
const OUTSIDE_TRANSACTION = /^\s*(PRAGMA|VACUUM|ATTACH|DETACH)\b/i

interface SnapshotStateRow {
	epoch: number
	lineage: string
	seq: number
}

/** The worker database and commit count a write was counted in. */
type CountedWrite = SnapshotStateRow

async function ensureSnapshotStateTable(tx: Transaction): Promise<void> {
	await tx.execute(CREATE_SNAPSHOT_STATE_SQL)
}

async function readSnapshotState(tx: Transaction): Promise<SnapshotStateRow[]> {
	await ensureSnapshotStateTable(tx)
	return tx.query<SnapshotStateRow>(SNAPSHOT_STATE_SQL)
}

async function countCommit(tx: Transaction): Promise<CountedWrite | undefined> {
	await ensureSnapshotStateTable(tx)
	return (await tx.query<CountedWrite>(COUNT_COMMIT_SQL))[0]
}

/**
 * Give this worker database the lineage {@link startSnapshotLineage} started for it (an
 * epoch higher than every one before), so its snapshots replace the one it was restored
 * from, and a snapshot of any older worker database (a tab that still relays to one) can
 * never replace them.
 */
async function setLineageState(tx: Transaction, epoch: number, lineage: string): Promise<void> {
	await ensureSnapshotStateTable(tx)
	await tx.execute(`DELETE FROM temp.${SNAPSHOT_STATE}`)
	await tx.execute(`INSERT INTO temp.${SNAPSHOT_STATE} (epoch, lineage, seq) VALUES (?, ?, 0)`, [
		epoch,
		lineage,
	])
}

function newLineageId(): string {
	const bytes = new Uint8Array(16)
	globalThis.crypto.getRandomValues(bytes)
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function isUnsupportedWorkerExport(error: unknown): boolean {
	return error instanceof AdapterError && error.context?.code === 'EXPORT_NOT_SUPPORTED'
}
