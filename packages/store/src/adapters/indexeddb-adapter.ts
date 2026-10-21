import type { KoraEventEmitter, SchemaDefinition } from '@korajs/core'
import {
	AdapterError,
	BridgeTerminatedError,
	NoLeaderError,
	PersistenceError,
	SchemaVersionAheadError,
	StorageBackendMismatchError,
	StoreNotOpenError,
} from '../errors'
import { STORED_SCHEMA_VERSION_SQL, storedSchemaVersion } from '../migrations/schema-ceiling'
import { type SupersededInfo, VersionGate } from '../multi-tab/version-gate'
import { WriteGate } from '../multi-tab/write-gate'
import type { MigrationPlan, StorageAdapter, StorageOpenState, Transaction } from '../types'
import { type DatabaseDump, exportDump, restoreDumpStatements } from './database-dump'
import { IndexedDbPersistenceScheduler } from './indexeddb-persistence-scheduler'
import { SqliteWasmAdapter } from './sqlite-wasm-adapter'
import type { WorkerBridge } from './sqlite-wasm-channel'
import {
	SNAPSHOT_SUPERSEDED,
	type SnapshotAncestor,
	type SnapshotSaveResult,
	type SnapshotVersion,
	type StartedSnapshotLineage,
	isIndexedDbQuotaError,
	loadSnapshotVersionRecord,
	saveSnapshotToIndexedDB,
	setSnapshotLineagePins,
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

	/**
	 * The version gate of this database (one build writes it at a time). In a browser
	 * (worker path) the adapter creates one when omitted; `false` disables it.
	 */
	versionGate?: VersionGate | false

	/** Build id for the version gate the adapter creates. */
	build?: string

	/** Open single-tab in a browser without Web Locks (test environments). */
	allowUncoordinatedTabs?: boolean
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
	 * before those writes were saved: the writes are gone. While one is listed, every
	 * durability barrier of this tab rejects: each covers every write committed before it,
	 * the lost ones included, so a retry never reports them saved. The list lives as long
	 * as this adapter: a reload opens a new adapter (and the database in a new lineage), so
	 * the loss is reported for this session and clears on reload.
	 */
	private readonly lostLineages = new Set<string>()
	/** This adapter's id among the holders of lineage pins ({@link setSnapshotLineagePins}). */
	private readonly pinHolder = newLineageId()
	/** The lineages last pinned for this adapter (sorted, joined): skips unchanged updates. */
	private pinnedKey = ''
	/**
	 * The lineage this tab last wrote in. It stays pinned after its writes are saved, so the
	 * pin record is written once per lineage (once per leader change), not after every save.
	 */
	private currentLineage: string | null = null
	/** Pin updates run one at a time, in order. */
	private pinUpdate: Promise<void> = Promise.resolve()
	/** The version gate of this database, or null where it does not apply. */
	private readonly versionGate: VersionGate | null
	/** Admits this adapter's writes until the tab retires (version gate, section 5). */
	private readonly writes = new WriteGate()
	/** Page lifecycle: suspended while frozen or in the back/forward cache. */
	private lifecycle: 'running' | 'suspended' = 'running'
	private removeLifecycleListeners: (() => void) | null = null
	/** Set once this tab retired: no snapshot of this build is ever written again. */
	private retired = false

	constructor(options: IndexedDbAdapterOptions = {}) {
		this.options = options
		this.dbName = options.dbName ?? 'kora-db'
		this.emitter = options.emitter
		this.usesRealWorker = !options.bridge && options.workerUrl !== undefined
		this.versionGate =
			options.versionGate === false
				? null
				: (options.versionGate ??
					(this.usesRealWorker && typeof window !== 'undefined' && typeof document !== 'undefined'
						? new VersionGate({
								dbName: this.dbName,
								...(options.build !== undefined ? { build: options.build } : {}),
								...(options.emitter ? { emitter: options.emitter } : {}),
								...(options.allowUncoordinatedTabs ? { allowUncoordinatedTabs: true } : {}),
							})
						: null))
		const gate = this.versionGate
		this.inner = new SqliteWasmAdapter({
			// The inner adapter checks the gate before it leads and gives up its storage roles
			// when the tab retires; this adapter opens the gate, seals its own writes, makes
			// them durable and drives the page lifecycle.
			versionGate: gate ?? false,
			...(gate ? { versionGateManagedByParent: true, releaseOnFreeze: false } : {}),
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
		if (gate) {
			gate.addRetireStep('durability', (info) => this.retireDurably(info))
			gate.setRecoveryExporter(() => this.exportRecoveryDump())
		}
	}

	/** The version gate this adapter's tab declares (null where it does not apply). */
	getVersionGate(): VersionGate | null {
		return this.versionGate
	}

	/**
	 * Version gate, steps 3 and 4 for the IndexedDB fallback: refuse new writes, wait for
	 * every started one, then make everything this tab committed durable. A failed barrier
	 * keeps the gate closed: the tab keeps its tab lock and retries (backoff, the user's
	 * Retry, `visibilitychange`) until a snapshot holds every committed write, reporting
	 * `store:persistence-error` and `unsaved-writes`. `SNAPSHOT_SUPERSEDED` (this tab's
	 * lineage was replaced; its lost writes already rejected) does not hold it.
	 *
	 * When no snapshot can be taken (storage full, or no storage worker left: the leader
	 * this tab relayed to closed), the tab's writes are settled against the snapshot
	 * IndexedDB holds, read without a worker: when another tab's save holds them all (or
	 * they are known lost, already reported), retirement continues.
	 */
	private async retireDurably(info: SupersededInfo): Promise<void> {
		this.writes.close({ currentBuild: info.current.build, newerBuild: info.newer.build })
		await this.writes.drain()
		const gate = this.versionGate
		const onVisible = (): void => {
			if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
				gate?.retryNow()
			}
		}
		if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
		try {
			for (let attempt = 0; ; attempt += 1) {
				// Closed meanwhile (the app closed this tab's database): nothing to hand over.
				if (gate?.getState() === 'closed') return
				// A snapshot another tab stored may already hold every unsaved write of this tab (a
				// follower whose leader saved on close): settled without a worker, which this tab
				// may no longer have.
				if (this.unconfirmedWrites.size > 0 && (await this.settleAgainstStoredSnapshot())) break
				try {
					await this.ensureDurable()
					break
				} catch (error) {
					if (error instanceof PersistenceError && error.context?.code === SNAPSHOT_SUPERSEDED) {
						break
					}
					if (await this.settleAgainstStoredSnapshot()) break
					const code = unsavedWritesCode(error)
					const because =
						code === 'QUOTA_EXCEEDED'
							? ' (storage is full)'
							: code === 'STORAGE_UNAVAILABLE'
								? ' (this tab has no storage worker left to save them from)'
								: ''
					this.emitter?.emit({
						type: 'store:persistence-error',
						dbName: this.dbName,
						message: `Your latest changes to "${this.dbName}" are not saved yet${because}; this tab keeps them until they are saved. ${error instanceof Error ? error.message : String(error)}`,
						code,
					})
					gate?.reportUnsavedWrites(true)
					if (!gate) break
					await gate.waitForRetry(attempt)
				}
			}
		} finally {
			if (typeof document !== 'undefined') {
				document.removeEventListener('visibilitychange', onVisible)
			}
		}
		gate?.reportUnsavedWrites(false)
		// No snapshot of this build is written after this point.
		this.retired = true
		this.scheduler.dispose()
		this.removeLifecycleListeners?.()
		this.removeLifecycleListeners = null
	}

	/**
	 * Settle this tab's unsaved writes against the snapshot version IndexedDB holds (and its
	 * ancestors), read without a worker. True when none is left unsettled: each is in a
	 * stored snapshot, or known lost (reported by `markLost`, as a refused save would).
	 */
	private async settleAgainstStoredSnapshot(): Promise<boolean> {
		try {
			const { stored, ancestors } = await loadSnapshotVersionRecord(this.dbName)
			this.settleWrites(stored, ancestors, null)
			await this.syncPins()
		} catch (error) {
			console.warn(`[kora] Could not read the stored snapshot version of "${this.dbName}":`, error)
			return false
		}
		return this.unconfirmedWrites.size === 0
	}

	/**
	 * The explicit recovery path while a failed barrier holds retirement (storage full): a
	 * dump of the database as this tab's worker holds it, for the prompt's Export button.
	 */
	async exportRecoveryDump(): Promise<DatabaseDump> {
		let dump: DatabaseDump = { tables: [] }
		await this.inner.transaction(async (tx) => {
			dump = await exportDump((sql, params) => tx.query(sql, params))
		})
		return dump
	}

	/**
	 * Page lifecycle (`freeze`, bfcache `pagehide`), as before the version gate: a frozen page
	 * cannot finish a snapshot, so it never keeps other tabs waiting on its storage. The
	 * storage roles are released at once (the snapshot scheduler already flushed when the
	 * page was hidden); writes made after the last stored snapshot stay only in this tab's
	 * worker database and are lost if another tab takes over (reported as
	 * `SNAPSHOT_SUPERSEDED`). No write a stored snapshot confirmed is ever lost.
	 *
	 * The tab lock is released only when the storage roles were: a tab still opening,
	 * promoting or closing keeps both, so a newer build never opens behind its worker.
	 */
	private suspendForLifecycle(): void {
		// A retiring tab keeps its storage until its retirement steps release it.
		if (this.lifecycle !== 'running' || this.retired || this.versionGate?.isSuperseded()) return
		if (!this.inner.suspendForLifecycle()) return
		this.lifecycle = 'suspended'
		this.versionGate?.suspend()
	}

	private async resumeFromLifecycle(): Promise<void> {
		if (this.lifecycle !== 'suspended') return
		this.lifecycle = 'running'
		const gate = this.versionGate
		if (gate) {
			let mayResume = false
			try {
				mayResume = await gate.resume()
			} catch (error) {
				console.warn(`[kora] Resuming the version gate of "${this.dbName}" failed:`, error)
			}
			if (!mayResume) {
				// A newer build opened meanwhile: never re-attach. Requests queued behind the
				// suspension fail retriably, so the retirement's drain completes (as on OPFS).
				this.inner.abandonLifecycleSuspension()
				return
			}
		}
		await this.inner.resumeForLifecycle()
	}

	private installLifecycleListeners(): void {
		if (!this.versionGate || this.removeLifecycleListeners) return
		if (typeof addEventListener !== 'function' || typeof document === 'undefined') return
		const onSuspend = (): void => this.suspendForLifecycle()
		const onResume = (): void => {
			void this.resumeFromLifecycle()
		}
		const onPageShow = (event: Event): void => {
			if ((event as PageTransitionEvent).persisted) onResume()
		}
		document.addEventListener('freeze', onSuspend)
		document.addEventListener('resume', onResume)
		addEventListener('pagehide', onSuspend)
		addEventListener('pageshow', onPageShow)
		this.removeLifecycleListeners = () => {
			document.removeEventListener('freeze', onSuspend)
			document.removeEventListener('resume', onResume)
			removeEventListener('pagehide', onSuspend)
			removeEventListener('pageshow', onPageShow)
		}
	}

	/** @internal Tests: the page lifecycle events this adapter handles. */
	handleLifecycleEvent(event: 'freeze' | 'resume'): Promise<void> {
		if (event === 'freeze') {
			this.suspendForLifecycle()
			return Promise.resolve()
		}
		return this.resumeFromLifecycle()
	}

	async open(schema: SchemaDefinition): Promise<void> {
		// The backend choice is recorded per database. If OPFS holds the
		// authoritative copy, carry it over explicitly before this session starts,
		// so OPFS and IndexedDB never hold two disjoint copies (NEW-STORE-5).
		const gate = this.versionGate
		if (gate) {
			// Storage open waits for the version gate (rule 3): no restore, DDL or migration of
			// this build while a tab of another build may still write the database.
			gate.useSchemaFingerprint(schema)
			await gate.open()
		}
		try {
			await this.openStorage(schema)
			// After the storage opened: a freeze during the open keeps the tab lock (the
			// storage roles cannot be released mid-open either).
			this.installLifecycleListeners()
		} catch (error) {
			// A failed open (format or schema ahead, OPFS carry-over, a worker error) releases
			// everything it took, the tab lock last, so no other tab waits on a tab that never
			// opened.
			this.removeLifecycleListeners?.()
			this.removeLifecycleListeners = null
			this.scheduler.dispose()
			await this.inner.close().catch(() => undefined)
			gate?.close()
			throw error
		}
	}

	private async openStorage(schema: SchemaDefinition): Promise<void> {
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
			let counted: CommitCount = NO_WRITE
			// One transaction: the lineage, the data and its count land in the same worker
			// database, or none of them does.
			await this.inner.transaction(async (tx) => {
				await markRestored(tx, epoch, lineage)
				for (const statement of restoreDumpStatements(carried)) {
					await tx.execute(statement.sql, statement.params)
				}
				counted = await countCommit(tx, null)
			})
			this.recordWrite(counted.counted)
			await this.scheduler.flushNow()
			await this.syncPins()
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
			// A short-lived reader inside this tab's open, not a tab of its own.
			versionGate: false,
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
		this.removeLifecycleListeners?.()
		this.removeLifecycleListeners = null
		if (!this.retired) await this.scheduler.flushNow()
		this.scheduler.dispose()
		// Writes still unsaved now can never be asked about again: release their pins.
		this.unconfirmedWrites.clear()
		this.currentLineage = null
		await this.syncPins()
		try {
			await this.inner.close()
		} finally {
			// The tab lock last, after the inner adapter released the leader lock.
			this.versionGate?.close()
		}
	}

	execute(sql: string, params?: unknown[]): Promise<void> {
		return this.writes.run({ operation: 'execute' }, () => this.executeNow(sql, params))
	}

	private async executeNow(sql: string, params?: unknown[]): Promise<void> {
		if (OUTSIDE_TRANSACTION.test(sql)) {
			// A statement that cannot run in a transaction (PRAGMA foreign_keys is a silent
			// no-op inside one) changes connection settings, not the rows a snapshot holds.
			await this.inner.execute(sql, params)
			this.scheduler.schedule()
			return
		}
		// The write and its count run in one transaction span, which the multi-tab layer binds
		// to the worker that answered BEGIN: if the storage leader changes in between, the
		// span fails with a retriable BridgeTerminatedError (nothing applied or counted on the
		// new worker) instead of counting the write under a database it never reached.
		let counted: CommitCount = NO_WRITE
		await this.inner.transaction(async (tx) => {
			const before = await readWriteMark(tx)
			await tx.execute(sql, params)
			counted = await countCommit(tx, before)
		})
		await this.recordCommit(counted)
	}

	async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		return this.inner.query<T>(sql, params)
	}

	transaction(fn: (tx: Transaction) => Promise<void>): Promise<void> {
		return this.writes.run({ operation: 'transaction' }, () => this.transactionNow(fn))
	}

	private async transactionNow(fn: (tx: Transaction) => Promise<void>): Promise<void> {
		// Only a transaction that changed the database is a write: a read-only one (a backup
		// snapshot, a fold-state read) gets no count, so it never needs a saved snapshot and
		// can never be reported lost when the storage leader changes.
		let counted: CommitCount = NO_WRITE
		await this.inner.transaction(async (tx) => {
			const before = await readWriteMark(tx)
			await fn(tx)
			counted = await countCommit(tx, before)
		})
		await this.recordCommit(counted)
	}

	migrate(from: number, to: number, migration: MigrationPlan): Promise<void> {
		return this.writes.run({ operation: 'migrate' }, () => this.migrateNow(from, to, migration))
	}

	private async migrateNow(from: number, to: number, migration: MigrationPlan): Promise<void> {
		// The migration and its count commit in one span on one worker database (as in
		// `execute`), so the count is the migration's own.
		let counted: CommitCount = NO_WRITE
		try {
			await this.inner.transaction(async (tx) => {
				const before = await readWriteMark(tx)
				for (const sql of migration.statements) {
					await tx.execute(sql)
				}
				counted = await countCommit(tx, before)
			})
		} catch (error) {
			if (error instanceof BridgeTerminatedError) throw error
			throw new AdapterError(
				`Migration from v${from} to v${to} failed: ${error instanceof Error ? error.message : String(error)}`,
				{ from, to },
			)
		}
		await this.recordCommit(counted)
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
	 * A lost write stays lost for the rest of this tab's session: every later barrier also
	 * covers it and rejects the same way, so a retry never reports it saved (the snapshot is
	 * still written first, so later writes keep being persisted). Sync then uploads in its
	 * degraded mode (`localDurability: 'degraded'`, RT-49), so the server keeps a copy. A
	 * reload opens the database in a new lineage with a new adapter: the loss is cleared
	 * there, and sync starts durable again.
	 */
	async ensureDurable(): Promise<void> {
		const needed = [...this.unconfirmedWrites.keys()]
		await this.scheduler.flushBarrier()
		if (this.lostLineages.size > 0) {
			throw new PersistenceError(
				`Writes to database "${this.dbName}" were lost before they were saved: the copy of the database they were made in was replaced (the storage leader tab changed). They are not in the database any more and must not be treated as saved. Every durability barrier of this tab reports it until the page is reloaded.`,
				{ dbName: this.dbName, code: SNAPSHOT_SUPERSEDED, lineages: [...this.lostLineages] },
			)
		}
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

	/** After a committed transaction: remember it and schedule a snapshot, if it wrote. */
	private async recordCommit(commit: CommitCount): Promise<void> {
		if (!commit.wrote) return
		this.recordWrite(commit.counted)
		this.scheduler.schedule()
		// Pinned before the write returns, so no later lineage can drop its ancestry entry.
		// Only a change of the pinned set writes the pin record (the first write in a new
		// lineage, i.e. after a leader change); every other write finds it unchanged.
		await this.syncPins()
	}

	/**
	 * Pin the lineages this tab has unsaved writes in, so their ancestry entries survive any
	 * number of leader changes until this tab settles them (see `MAX_ANCESTORS`), and the
	 * lineage it writes in now (see `currentLineage`). A tab that dies leaves at most those
	 * behind, and only the most recent holders' pins are kept. A failed
	 * update is reported, not thrown: the write it follows is committed, and without the pin
	 * a lineage beyond the recent ancestry is judged by its epoch, as before.
	 */
	private syncPins(): Promise<void> {
		const run = async (): Promise<void> => {
			const pinned = new Set(this.unconfirmedWrites.keys())
			if (this.currentLineage !== null) pinned.add(this.currentLineage)
			const lineages = [...pinned].sort()
			const key = lineages.join(',')
			if (key === this.pinnedKey) return
			try {
				await setSnapshotLineagePins(this.dbName, this.pinHolder, lineages)
				this.pinnedKey = key
			} catch (error) {
				console.warn(
					`[kora] Could not pin the unsaved snapshot lineages of "${this.dbName}":`,
					error,
				)
			}
		}
		this.pinUpdate = this.pinUpdate.then(run, run)
		return this.pinUpdate
	}

	/** Remember a write this tab committed, by the worker database and count it got. */
	private recordWrite(counted: CountedWrite | undefined): void {
		// No row: a worker database opened by an earlier build, which has no lineage until
		// its first snapshot from this build; such writes are covered as before.
		if (!counted) return
		this.currentLineage = counted.lineage
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
			// Not in the ancestry, which keeps every lineage this tab pinned (unless the pin
			// could not be recorded): replaced when a later database started.
			if (lineage === refused || stored === null || pending.epoch < stored.epoch) {
				this.markLost(lineage)
			}
		}
	}

	/** This tab's unsaved writes in `lineage` are gone; barriers report it until reload. */
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
			// between. Keep it only when no write was counted since the dump, so the image a
			// restore prefers holds the same counted writes as the dump stored with it;
			// otherwise store the dump alone (it restores fully).
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
				await this.syncPins()
			}
			throw error
		}
		this.settleWrites(version, saved.ancestors, null)
		await this.syncPins()
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
		const started =
			begun?.started ?? (await startSnapshotLineage<DatabaseDump>(this.dbName, lineage))
		await markRestored(tx, started.epoch, lineage)
		if (!started.dump) return
		for (const statement of restoreDumpStatements(started.dump)) {
			await tx.execute(statement.sql, statement.params)
		}
	}

	/**
	 * A consistent snapshot: every table and the snapshot version are read inside one
	 * transaction (STORE-7), so the version names exactly the counted writes the dump holds.
	 */
	private async exportDump(): Promise<{ dump: DatabaseDump; version: SnapshotVersion }> {
		let dump: DatabaseDump = { tables: [] }
		let state: SnapshotStateRow | undefined
		await this.inner.transaction(async (tx) => {
			state = (await readSnapshotState(tx))[0]
			if (!state) {
				// A worker database opened by an earlier build (a tab still running it leads):
				// start a lineage for it, newer than the stored snapshot, since this live
				// database holds the latest writes. Inside this transaction, which holds the
				// worker for every tab, so only one tab starts it.
				const lineage = newLineageId()
				const { epoch } = await startSnapshotLineage(this.dbName, lineage)
				await setLineageState(tx, epoch, lineage)
				state = (await readSnapshotState(tx))[0]
			}
			dump = await exportDump((sql, params) => tx.query(sql, params))
		})
		if (!state) {
			throw new PersistenceError(`Snapshot of database "${this.dbName}" has no version`, {
				dbName: this.dbName,
				code: 'SNAPSHOT_UNVERSIONED',
			})
		}
		return {
			dump,
			version: { epoch: state.epoch, lineage: state.lineage, seq: state.seq },
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

/**
 * What a committed transaction did: `wrote` when it changed the database, and the count it
 * got then (undefined in a worker database opened by an earlier build, which has no state).
 */
interface CommitCount {
	wrote: boolean
	counted?: CountedWrite
}

const NO_WRITE: CommitCount = { wrote: false }

/**
 * Where the connection stood when a transaction began: its total change count, the main
 * schema's version and its user_version, as one string. Every tab's request goes through
 * one serialized worker connection, and a transaction span holds it, so a difference at
 * the end is this transaction's own write: rows (by any statement, `query` with RETURNING
 * included), schema (which `total_changes()` does not count) or the user_version header.
 * Changes to TEMP tables count too; they can only make a transaction count as a write,
 * never hide one.
 */
type WriteMark = string

const WRITE_MARK_SQL =
	'SELECT total_changes() AS changes, (SELECT schema_version FROM pragma_schema_version) AS schema, (SELECT user_version FROM pragma_user_version) AS user'

async function readMark(tx: Transaction): Promise<WriteMark> {
	const row = (
		await tx.query<{ changes: unknown; schema: unknown; user: unknown }>(WRITE_MARK_SQL)
	)[0]
	return `${String(row?.changes)}:${String(row?.schema)}:${String(row?.user)}`
}

async function ensureSnapshotStateTable(tx: Transaction): Promise<void> {
	await tx.execute(CREATE_SNAPSHOT_STATE_SQL)
}

async function readSnapshotState(tx: Transaction): Promise<SnapshotStateRow[]> {
	await ensureSnapshotStateTable(tx)
	return tx.query<SnapshotStateRow>(SNAPSHOT_STATE_SQL)
}

async function readWriteMark(tx: Transaction): Promise<WriteMark> {
	// The TEMP state table is created here, before the mark, so creating it is never
	// mistaken for this transaction's write (TEMP DDL changes no main schema version anyway).
	await ensureSnapshotStateTable(tx)
	return readMark(tx)
}

/**
 * Count the transaction's commit when it wrote since `before` (null: count it regardless).
 * The count is taken only then, so a read-only transaction leaves the commit count as it
 * was and claims no write a snapshot must hold.
 */
async function countCommit(tx: Transaction, before: WriteMark | null): Promise<CommitCount> {
	if (before === null) await ensureSnapshotStateTable(tx)
	else if ((await readMark(tx)) === before) return NO_WRITE
	return { wrote: true, counted: (await tx.query<CountedWrite>(COUNT_COMMIT_SQL))[0] }
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

function isQuotaPersistenceError(error: unknown): boolean {
	return error instanceof PersistenceError && error.context?.quotaExceeded === true
}

/**
 * Why a retiring tab's snapshot failed, as the `store:persistence-error` code its prompt
 * names: storage full, no storage worker left (the leader it relayed to closed, or it gave
 * up its roles), or another persistence failure.
 */
function unsavedWritesCode(
	error: unknown,
): 'QUOTA_EXCEEDED' | 'STORAGE_UNAVAILABLE' | 'PERSISTENCE_FAILED' {
	if (isIndexedDbQuotaError(error) || isQuotaPersistenceError(error)) return 'QUOTA_EXCEEDED'
	if (
		error instanceof StoreNotOpenError ||
		error instanceof NoLeaderError ||
		error instanceof BridgeTerminatedError ||
		(error instanceof Error && (error as { code?: unknown }).code === 'BUILD_SUPERSEDED')
	) {
		return 'STORAGE_UNAVAILABLE'
	}
	return 'PERSISTENCE_FAILED'
}

function isUnsupportedWorkerExport(error: unknown): boolean {
	return error instanceof AdapterError && error.context?.code === 'EXPORT_NOT_SUPPORTED'
}
