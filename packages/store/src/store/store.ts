import {
	CausalTracker,
	HybridLogicalClock,
	KoraError,
	assertOperationTransformCoverage,
	createVersionVector,
	deriveSideEffectOpId,
	deserializeFoldState,
	expandFieldVersionedOperations,
	foldPlanFingerprints,
	generateUUIDv7,
	isReservedNodeId,
	isServerNodeId,
	mismatchedFoldFields,
	operationSchemaView,
	quoteIdent,
	replayOperationsForRecord,
} from '@korajs/core'
import type {
	FoldState,
	HLCTimestamp,
	KoraEventEmitter,
	MergeTrace,
	Operation,
	OperationLog,
	OperationTransform,
	SchemaDefinition,
	SecretKeyProvider,
	VersionVector,
} from '@korajs/core'
import { recordMatchesCollectionScope } from '@korajs/core/internal'
import { readBackupManifest as readManifest } from '../backup/backup'
import type { BackupManifest, BackupOptions, RestoreOptions, RestoreResult } from '../backup/types'
import { Collection } from '../collection/collection'
import { compactOperationLog } from '../compaction/compact-operation-log'
import type { CompactionResult, CompactionStrategy } from '../compaction/types'
import {
	NodeOwnedByAnotherUserError,
	OptimisticLockError,
	SchemaVersionAheadError,
	StoreNotOpenError,
} from '../errors'
import { compactFoldedLog } from '../fold/compact-folded-log'
import { LEGACY_BODIES_META_KEY, canonicalizeLegacyLogBodies } from '../fold/legacy-bodies'
import {
	COMPACTED_THROUGH_TABLE,
	FOLD_MATERIALIZATION_CURRENT,
	FOLD_MATERIALIZATION_LEGACY,
	FOLD_MATERIALIZATION_META_KEY,
	FOLD_STATE_TABLE,
	FOLD_TABLES_DDL,
	RecordFolder,
	isCompacted,
} from '../fold/record-folder'
import {
	type KeptRecords,
	type RematerializationMode,
	rematerializeDatabase,
} from '../fold/rematerialize'
import {
	LOG_QUARANTINE_TABLE,
	type LogIntegrityReport,
	scanLogIntegrity,
} from '../log-integrity/log-integrity'
import {
	type FieldVersions,
	effectiveFieldVersion,
	fieldVersionsForFields,
	parseFieldVersions,
	resolvePerFieldLww,
	serializeFieldVersions,
} from '../lww/field-versions'
import { isIncomingNewerThanRow, serializeRowVersion } from '../lww/row-version'
import { runSchemaMigrations } from '../migrations/run-migrations'
import {
	STORED_SCHEMA_VERSION_SQL,
	parseSchemaAhead,
	storedSchemaVersion,
} from '../migrations/schema-ceiling'
import type { LocalMutationContext } from '../mutations/types'
import { isStorageFullError } from '../mutations/write-context'
import { QueryBuilder } from '../query/query-builder'
import {
	buildFieldFastForwardUpdateQuery,
	buildInsertQuery,
	buildLwwSoftDeleteQuery,
	buildSoftDeleteQuery,
} from '../query/sql-builder'
import { RelationEnforcer } from '../relations/relation-enforcer'
import { buildReplaySnapshot } from '../replay/replay-to'
import type { ReplaySnapshot } from '../replay/replay-to'
import { SequenceManager } from '../sequences/sequence-manager'
import {
	deserializeOperationWithCollection,
	deserializeRecord,
	serializeOperation,
	serializeRecord,
} from '../serialization/serializer'
import { ensureStoredTextCodec } from '../serialization/stored-text-migration'
import {
	type RecordsChangeListener,
	SubscriptionManager,
} from '../subscription/subscription-manager'
import {
	type AdoptionSchedule,
	type LocalNodeRecord,
	type TerminalRejection,
	assignLocalNodePrincipal,
	confirmLocalNodePrincipal,
	dropLocalNode,
	findTerminalRejections,
	forgetLocalNode,
	listLocalNodes,
	loadAcceptedCycle,
	loadAdoptionSchedule,
	markLocalNodeAccepted,
	markLocalNodeRefused,
	recordLocalNodeRefusedFor,
	recordTerminalRejections,
	registerLocalNode,
	saveAdoptionSchedule,
	seedTerminalRejectionsOnce,
	setLocalNodePrincipal,
} from '../sync/local-sync-records'
import type { ClockRebaseResult } from '../sync/rebase-unsynced-operations'
import { rebaseUnsyncedOperationsInLog } from '../sync/rebase-unsynced-operations'
import { renumberOperationRow, rewriteDependentsInTx } from '../sync/rehash-operation'
import type { ResequenceResult } from '../sync/rehash-operation'
import type { NodeRotationResult } from '../sync/rotate-node-id'
import { rotateUnsyncedOperationsInLog } from '../sync/rotate-node-id'
import type { UnappliedOperation } from '../sync/sync-durability'
import {
	loadAcceptedDownlinkScope,
	loadOwnAckedThrough,
	loadUnappliedOperations,
	removeUnappliedOperations,
	saveAcceptedDownlinkScope,
	saveOwnAckedThrough,
	saveUnappliedOperations,
} from '../sync/sync-durability'
import {
	DELIVERY_WATERMARK_META_KEY,
	DELTA_CURSOR_META_KEY,
	NODE_TOKEN_META_KEY,
	collectOperationsAheadOfServer,
	deleteDeliveryWatermark,
	loadAllDeliveryWatermarks,
	loadAuthoritativeNodeIds,
	loadDeliveryWatermark,
	loadDeltaCursor,
	loadLastAckedServerVector,
	loadNodeToken,
	loadRevokedAuthoritativeNodeIds,
	mergeVersionVectors,
	nodeTokenKey,
	saveAuthoritativeNodeIds,
	saveDeliveryWatermark,
	saveDeltaCursor,
	saveLastAckedServerVector,
	saveNodeToken,
	saveRevokedAuthoritativeNodeIds,
} from '../sync/sync-state'
import { TransactionContext } from '../transaction/transaction-context'
import type {
	ApplyRemoteOptions,
	ApplyResult,
	LocalMutationHandler,
	MaterializedRowSnapshot,
	MetaRow,
	OperationRow,
	RawCollectionRow,
	RowVersionState,
	StorageAdapter,
	StoreConfig,
	StoreIsolation,
	Transaction,
	VersionVectorRow,
} from '../types'
import { dropLegacyIndexes } from './legacy-indexes'
import { acquireNodeLock, isNodeLockHeld, nodeLockName, tryAcquireNodeLock } from './node-lock'
import { relaxValueDomainConstraints } from './relax-constraints'
import { allocateNextSequenceInTransaction } from './sequence-allocator'
import {
	SEQ_CONFLICTS_TABLE,
	insertConflictRow,
	isOperationLogged,
	loadRetainedConflictRows,
	repairSequenceUniqueness,
} from './sequence-repair'
import { savePerTabNodeId } from './tab-node-id'
import { resolvePerTabNodeId } from './tab-node-id'

/**
 * Store is the main orchestrator. It owns a schema, a storage adapter,
 * a clock, and a subscription manager. It creates Collection instances
 * for each schema collection, and provides the sync contract via
 * applyRemoteOperation and getOperationRange.
 *
 * @example
 * ```typescript
 * const store = new Store({ schema, adapter })
 * await store.open()
 * const todo = await store.collection('todos').insert({ title: 'Hello' })
 * await store.close()
 * ```
 */
/** `_kora_meta` key: per-collection fold plan fingerprints the rows were folded with (RT-63). */
const FOLD_PLAN_META_KEY = 'fold_plan_fingerprints'
/** `_kora_meta` key: a full resync was requested to settle row snapshots (RT-68). */
const SNAPSHOT_RESYNC_META_KEY = 'fold_snapshot_resync'
/**
 * Node id of provisional side effects (RT-69). In the reserved `kora:` namespace: no
 * device authors under it, and its effects never enter the log or the upload queue.
 */
const PROVISIONAL_NODE_ID = 'kora:provisional'

/** A node id this client must never author under (RT-61): Kora's reserved namespace. */
export class ReservedNodeIdError extends KoraError {
	constructor(nodeId: string, source: string) {
		super(
			`Node id "${nodeId}" (${source}) is in Kora's reserved "kora:" namespace; devices never author under it.`,
			'RESERVED_NODE_ID',
			{ nodeId, source, fix: 'Configure a node id that does not start with "kora:".' },
		)
		this.name = 'ReservedNodeIdError'
	}
}

/**
 * Per collection, the record ids that own quarantined log rows (RT-68); a
 * quarantined row whose record id cannot be read keeps its whole collection.
 */
async function loadQuarantinedRecords(adapter: StorageAdapter): Promise<KeptRecords> {
	const records = new Map<string, Set<string>>()
	const collections = new Set<string>()
	const exists = await adapter.query<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
		[LOG_QUARANTINE_TABLE],
	)
	if (exists.length === 0) return { records, collections }
	const rows = await adapter.query<{ collection: string; row_json: string }>(
		`SELECT collection, row_json FROM ${LOG_QUARANTINE_TABLE}`,
	)
	for (const row of rows) {
		let recordId: unknown = null
		try {
			recordId = (JSON.parse(row.row_json) as { record_id?: unknown }).record_id
		} catch {
			recordId = null
		}
		if (typeof recordId === 'string' && recordId.length > 0) {
			const set = records.get(row.collection) ?? new Set<string>()
			set.add(recordId)
			records.set(row.collection, set)
		} else {
			collections.add(row.collection)
		}
	}
	return { records, collections }
}

/** Collections whose stored fold states hold a field of another fold kind than the schema's. */
async function collectionsWithMismatchedStates(
	adapter: StorageAdapter,
	schema: SchemaDefinition,
): Promise<string[]> {
	const out: string[] = []
	for (const collection of Object.keys(schema.collections)) {
		const rows = await adapter.query<{ state: string }>(
			`SELECT state FROM ${FOLD_STATE_TABLE} WHERE collection = ?`,
			[collection],
		)
		for (const row of rows) {
			let state: FoldState
			try {
				state = deserializeFoldState(row.state)
			} catch {
				continue
			}
			if (mismatchedFoldFields(state, schema).length > 0) {
				out.push(collection)
				break
			}
		}
	}
	return out
}

/**
 * Make `nodeId` the database's node id (`_kora_meta.node_id`). The unkeyed legacy node
 * token belongs to the node id it replaces, so it moves to that node's own key first:
 * it must never be presented as the new node's token.
 */
async function moveDatabaseNodeId(tx: Transaction, nodeId: string): Promise<void> {
	const meta = await tx.query<MetaRow>("SELECT value FROM _kora_meta WHERE key = 'node_id'")
	const previous = meta[0]?.value
	if (previous === nodeId) return
	const legacy = await tx.query<MetaRow>('SELECT value FROM _kora_meta WHERE key = ?', [
		NODE_TOKEN_META_KEY,
	])
	if (legacy[0] && previous) {
		await tx.execute('INSERT OR IGNORE INTO _kora_meta (key, value) VALUES (?, ?)', [
			nodeTokenKey(previous),
			legacy[0].value,
		])
	}
	await tx.execute('DELETE FROM _kora_meta WHERE key = ?', [NODE_TOKEN_META_KEY])
	await tx.execute("INSERT OR REPLACE INTO _kora_meta (key, value) VALUES ('node_id', ?)", [nodeId])
}

/** Result of {@link Store.bindPrincipal} (RT-42). */
export interface PrincipalBinding {
	/** The node id local writes use from now on. */
	nodeId: string
	/** The node id in use before the call. */
	previousNodeId: string
	/** The store moved to another node id. */
	switched: boolean
	/** The node id is pinned and belongs to another user: nothing may upload it now. */
	conflict: boolean
}

/** `_kora_meta` key prefix of the records an access narrowing kept (per collection). */
const ACCESS_NARROWING_META_PREFIX = 'access_narrowing_kept:'

export class Store implements OperationLog {
	private opened = false
	private nodeId = ''
	/** Records an access narrowing kept for their unsent writes (loaded lazily). */
	private keptOutsideNarrowing: Map<
		string,
		{ scope: Record<string, unknown> | null; kept: string[] }
	> | null = null
	private sequenceNumber = 0
	private versionVector: VersionVector = createVersionVector()
	private clock: HybridLogicalClock | null = null
	private collections = new Map<string, Collection>()
	private subscriptionManager: SubscriptionManager
	private sequenceManager: SequenceManager | null = null

	private readonly schema: SchemaDefinition
	private readonly adapter: StorageAdapter
	private readonly configNodeId: string | undefined
	/** The owner of the pinned node while it belongs to another user than the signed-in one (F9). */
	private pinnedNodeOwnedBy: string | null = null
	/** The sync server refused the pinned node as another user's (F9). */
	private pinnedNodeRefusedByServer = false
	/** The user of the last {@link bindPrincipal}. */
	private signedInPrincipal: string | null = null
	private readonly dbName: string
	private readonly isolation: StoreIsolation
	private readonly emitter: KoraEventEmitter | null
	private localMutationHandler: LocalMutationHandler | null
	private relationEnforcer: RelationEnforcer | null = null
	private causalTracker: CausalTracker | null = null
	private readonly secretKeyProvider: SecretKeyProvider | undefined
	/** Releases the per-tab node lock (RT-40); null when none is held. */
	private releaseNodeLock: (() => void) | null = null
	/** How rows are materialized ({@link StoreConfig.materialization}). */
	private readonly materialization: 'fold' | 'legacy'
	/** The W7 record fold; null under legacy materialization. */
	private readonly folder: RecordFolder | null
	/** True once every row of the database is a materialization of its fold state. */
	private foldActive = false
	/** Schema transforms applied at fold time (RT-84); never to stored operations. */
	private readonly operationTransforms: readonly OperationTransform[]
	/** Largest operation a local write may produce (RT-86); default in the write path. */
	private readonly maxOperationBytes: number | undefined

	constructor(config: StoreConfig) {
		this.materialization = config.materialization ?? 'fold'
		this.operationTransforms = config.operationTransforms ?? []
		this.maxOperationBytes = config.maxOperationBytes
		this.folder =
			this.materialization === 'fold'
				? new RecordFolder(config.schema, this.operationTransforms)
				: null
		this.schema = config.schema
		this.adapter = config.adapter
		this.configNodeId = config.nodeId
		this.dbName = config.dbName ?? 'kora-db'
		this.isolation = config.isolation ?? 'shared'
		this.emitter = config.emitter ?? null
		this.localMutationHandler = config.localMutationHandler ?? null
		this.secretKeyProvider = config.secretKeyProvider
		this.subscriptionManager = new SubscriptionManager({
			onQuerySubscribed: config.onQuerySubscribed,
			// STORE-12: every subscription failure is observable (DevTools, app listeners).
			onQueryError: (failure) => {
				const code =
					failure.error instanceof KoraError ? failure.error.code : failure.error.name || 'Error'
				this.emitter?.emit({
					type: 'query:error',
					queryId: failure.queryId,
					collection: failure.collection,
					phase: failure.phase,
					code,
					message: failure.error.message,
				})
			},
		})
	}

	/**
	 * Open the store: initialize the database, load or generate a node ID,
	 * restore the sequence number and version vector, and create Collection instances.
	 */
	async open(): Promise<void> {
		this.keptOutsideNarrowing = null
		try {
			await this.adapter.open(this.schema)
		} catch (error) {
			const ahead =
				error instanceof SchemaVersionAheadError
					? { stored: error.storedVersion, code: error.codeVersion }
					: parseSchemaAhead(error)
			if (ahead !== null) throw this.schemaAhead(ahead.stored)
			throw error
		}
		// A database a newer build already migrated is refused before anything here writes
		// to it (RT-109). The DDL executors refuse it before their DDL; this also covers
		// adapters that restore their data after it (the IndexedDB fallback).
		const stored = storedSchemaVersion(
			await this.adapter.query<{ value: unknown }>(STORED_SCHEMA_VERSION_SQL),
		)
		if (stored > this.schema.version) {
			await this.adapter.close().catch(() => undefined)
			throw this.schemaAhead(stored)
		}
		await this.adapter.execute(
			'CREATE TABLE IF NOT EXISTS _kora_scope_retractions (collection TEXT NOT NULL, record_id TEXT NOT NULL, PRIMARY KEY (collection, record_id))',
		)
		for (const ddl of FOLD_TABLES_DDL) await this.adapter.execute(ddl)
		this.foldActive = false

		// Tables created before beta.13 restate enum membership and requiredness as CHECK /
		// NOT NULL constraints that cannot evolve with the schema: rebuild them once without
		// (RT-101). Validation is the single authority for the value domain.
		await relaxValueDomainConstraints(this.adapter, this.schema)
		// Indexes named under the old, colliding scheme are replaced (STORE-15).
		await dropLegacyIndexes(this.adapter, this.schema)

		// Load or generate node ID
		const persistedNodeId = await this.readPersistedNodeId()
		this.nodeId = await this.loadOrGenerateNodeId()
		// Every node id this database authors under is registered (RT-38, RT-40).
		await registerLocalNode(this.adapter, this.nodeId)
		await this.registerUnregisteredAuthors(persistedNodeId)

		// Log integrity first (W8 step 0): repair rows an earlier release damaged and
		// quarantine the unrecoverable ones, before anything reads or folds the log.
		await this.scanLog('quick')

		// (node_id, sequence_number) is unique in the operation log: repair any
		// duplicates an earlier version wrote, then enforce it with an index (W6).
		await repairSequenceUniqueness(this.adapter, this.schema, this.nodeId)
		// The terminal rejections an earlier release kept only in the app's list become
		// durable markers (RT-36).
		await seedTerminalRejectionsOnce(this.adapter)
		// Raw-string columns use the lossless stored-text codec (RT-65); rows written
		// before it get their U+FFFF re-encoded once, before anything reads them.
		await ensureStoredTextCodec(this.adapter, this.schema)
		if (this.isolation === 'per-tab' && !this.configNodeId) {
			// A live tab holds its node's lock, so a later tab adopts the node's unsynced
			// writes only after this tab is gone (RT-40).
			this.releaseNodeLock = acquireNodeLock(nodeLockName(this.dbName, this.nodeId))
		}
		this.clock = new HybridLogicalClock(this.nodeId)
		this.causalTracker = new CausalTracker()

		// The fold is active for writes as soon as the database's rows are known to be
		// fold materializations (W7); a pre-W7 database is re-materialized after its
		// schema migrations, whose backfills then write the legacy way.
		if (this.folder) {
			this.folder.setAuthoritativeNodeIds((await loadAuthoritativeNodeIds(this.adapter)) ?? [])
			this.foldActive =
				(await this.readMeta(FOLD_MATERIALIZATION_META_KEY)) === FOLD_MATERIALIZATION_CURRENT
		}

		// Run schema migrations if needed. Backfills write operations through the local
		// write path, so the node id and clock must exist first (STORE-13).
		try {
			// Transforms that cannot read the stored log would fold those operations as
			// absent and erase them from their records: refuse to open instead (RT-103).
			await this.assertTransformCoverage()
			await this.runMigrationsIfNeeded()
			await this.ensureLegacyBodiesCanonical()
			await this.ensureMaterialization()
		} catch (error) {
			this.releaseNodeLock?.()
			this.releaseNodeLock = null
			throw error
		}

		// Initialize sequence manager
		this.sequenceManager = new SequenceManager(this.adapter, this.nodeId)

		// Load sequence number and version vector
		this.sequenceNumber = await this.loadSequenceNumber()
		this.versionVector = await this.loadVersionVector()

		// Create RelationEnforcer if the schema has relations.
		// The enforcer is shared across all Collection instances so that
		// cascading deletes can cross collection boundaries.
		const hasRelations = Object.keys(this.schema.relations).length > 0
		this.relationEnforcer = hasRelations ? new RelationEnforcer({ schema: this.schema }) : null

		// Create collection instances
		for (const [name, definition] of Object.entries(this.schema.collections)) {
			const col = new Collection(
				name,
				definition,
				this.schema,
				this.adapter,
				this.clock,
				this.nodeId,
				(collectionName, operation) => this.publishLocalOperation(collectionName, operation),
				this.relationEnforcer,
				this.localMutationHandler,
				this.causalTracker,
				this.secretKeyProvider,
				(error) => this.reportStorageError(error),
				() => this.activeFold(),
				this.maxOperationBytes,
				() => this.assertLocalWriteAllowed(),
			)
			this.collections.set(name, col)
		}

		this.opened = true
	}

	/**
	 * Close the store: clear subscriptions and close the adapter.
	 */
	async close(): Promise<void> {
		this.subscriptionManager.clear()
		this.collections.clear()
		this.opened = false
		try {
			await this.adapter.close()
		} finally {
			this.releaseNodeLock?.()
			this.releaseNodeLock = null
		}
	}

	/**
	 * Check the operation log (W8 step 0): every row must round-trip through the
	 * canonical operation serializer. Rows an earlier release damaged in a recoverable
	 * way (a JSON-encoded timestamp written by a beta.12 backup restore) are repaired;
	 * unrecoverable rows move to the quarantine table, where no fold reads them. Also
	 * reports sequence gaps in this database's own nodes (compaction, a lost tail).
	 *
	 * The store runs a quick variant (SQL prefilter) on every open. Rebuilding state from
	 * the log must only run on a `clean` report.
	 *
	 * @param options - `repair: false` only reports; `mode: 'quick'` checks only the rows
	 *   a SQL prefilter flags (default `'full'`: every row)
	 * @returns The integrity report; emits `store:log-integrity` when rows changed
	 */
	async verifyLogIntegrity(options?: {
		repair?: boolean
		mode?: 'full' | 'quick'
	}): Promise<LogIntegrityReport> {
		this.ensureOpen()
		return this.scanLog(options?.mode ?? 'full', options?.repair ?? true)
	}

	private async scanLog(mode: 'full' | 'quick', repair = true): Promise<LogIntegrityReport> {
		const localNodeIds = (await listLocalNodes(this.adapter)).map((node) => node.nodeId)
		const report = await scanLogIntegrity(this.adapter, this.schema, {
			mode,
			repair,
			localNodeIds,
		})
		if (repair && (report.repaired.length > 0 || report.newlyQuarantined.length > 0)) {
			this.emitter?.emit({
				type: 'store:log-integrity',
				dbName: this.dbName,
				repaired: report.repaired.length,
				quarantined: report.newlyQuarantined.length,
				gaps: report.gaps.length,
				clean: report.clean,
				message: `Operation log of "${this.dbName}": ${report.repaired.length} row(s) repaired, ${report.newlyQuarantined.length} row(s) quarantined (${LOG_QUARANTINE_TABLE}).`,
			})
		}
		return report
	}

	/**
	 * Get a Collection instance for CRUD operations.
	 * @throws {StoreNotOpenError} If the store is not open
	 * @throws {Error} If the collection name is not in the schema
	 */
	collection(name: string): CollectionAccessor {
		this.ensureOpen()
		const col = this.collections.get(name)
		if (!col) {
			throw new Error(
				`Unknown collection "${name}". Available: ${[...this.collections.keys()].join(', ')}`,
			)
		}

		const definition = this.schema.collections[name]
		if (!definition) {
			throw new Error(`Collection definition not found for "${name}"`)
		}

		return {
			insert: (data: Record<string, unknown>) => col.insert(data),
			findById: (id: string) => col.findById(id),
			update: (id: string, data: Record<string, unknown>) => col.update(id, data),
			delete: (id: string) => col.delete(id),
			where: (conditions) =>
				new QueryBuilder(
					name,
					definition,
					this.adapter,
					this.subscriptionManager,
					conditions,
					this.schema,
				),
		}
	}

	/**
	 * Get the current version vector.
	 */
	getVersionVector(): VersionVector {
		this.ensureOpen()
		return new Map(this.versionVector)
	}

	/**
	 * Get the node ID for this store instance.
	 */
	/**
	 * Records the offset between server time and this device's clock
	 * (serverTime - localTime), learned at sync handshake. Lets the store's HLC
	 * validate remote timestamps correctly even when the local clock is wrong.
	 */
	setClockReferenceOffset(offsetMs: number): void {
		this.clock?.setReferenceOffset(offsetMs)
	}

	getNodeId(): string {
		this.ensureOpen()
		return this.nodeId
	}

	/** The schema transforms the fold applies (transforms at fold time, RT-84). */
	getOperationTransforms(): readonly OperationTransform[] {
		return this.operationTransforms
	}

	/**
	 * Apply a remote operation received from sync.
	 * Checks for duplicates, applies to the data table, persists the operation,
	 * and updates the version vector.
	 */
	async applyRemoteOperation(
		stored: Operation,
		options?: ApplyRemoteOptions,
	): Promise<ApplyResult> {
		const result = await this.applyRemoteOperationUnmarked(stored, options)
		// The server sent this record: it is readable again, so a narrowing that kept it
		// only for its unsent writes no longer applies to it.
		if (result !== 'skipped')
			await this.forgetKeptOutsideNarrowing(stored.collection, stored.recordId)
		return result
	}

	private async applyRemoteOperationUnmarked(
		stored: Operation,
		options?: ApplyRemoteOptions,
	): Promise<ApplyResult> {
		this.ensureOpen()

		const collection = stored.collection
		const definition = this.schema.collections[collection]
		if (!definition) {
			return 'skipped'
		}
		const fold = this.activeFold()
		if (fold) {
			// The fold reads the operation through the schema transforms itself (RT-84).
			return this.applyRemoteFolded(stored, fold, options)
		}
		// Legacy materialization writes rows directly: it materializes the operation as
		// this schema reads it, and logs the operation exactly as written (RT-84).
		const view = operationSchemaView(stored, this.schema.version, this.operationTransforms)
		if (view === null) return 'skipped'
		const op = view

		// Materialization may use overridden data/timestamp (authoritative merge
		// results), but the LOG below always stores the canonical operation:
		// operations are immutable and content-addressed, so merged values must
		// never be persisted under the original operation's id.
		const materializeTimestamp = options?.materializeTimestamp ?? op.timestamp
		const remoteVersion = serializeRowVersion(materializeTimestamp)
		const wallTime = materializeTimestamp.wallTime
		const materializeSource = options?.materializeData ?? op.data
		// Duration is reported to DevTools only; it never orders anything.
		const startedAt = Date.now()
		const outcome = { duplicate: false, revived: false }

		// Apply the operation to the data table (LWW-guarded; op log always appended below)
		try {
			await this.adapter.transaction(async (tx) => {
				// Content-addressed dedup INSIDE the write transaction: two concurrent
				// deliveries of one operation serialize here, and the second sees the
				// first's row instead of failing on the primary key (STORE-15).
				if (await isOperationLogged(tx, collection, op.id)) {
					outcome.duplicate = true
					const retracted = await tx.query<{ record_id: string }>(
						'SELECT record_id FROM _kora_scope_retractions WHERE collection = ? AND record_id = ?',
						[collection, op.recordId],
					)
					if (retracted.length > 0) {
						await tx.execute(`UPDATE ${quoteIdent(collection)} SET _deleted = 0 WHERE id = ?`, [
							op.recordId,
						])
						await tx.execute(
							'DELETE FROM _kora_scope_retractions WHERE collection = ? AND record_id = ?',
							[collection, op.recordId],
						)
						outcome.revived = true
					}
					return
				}

				// Advance the local HLC; severe clock drift throws ClockDriftError (surfaced as sync:apply-failed).
				if (this.clock) {
					// A scope entry's newest field version can be later than its timestamp (the
					// record's creation, RT-27): the clock must move past every version it carries.
					this.clock.receive(op.fieldVersions ? newestFieldVersion(op) : op.timestamp)
				}

				// Optimistic-concurrency guard: if the caller computed its data from a
				// snapshot, verify the row hasn't changed since. Throwing rolls the
				// whole transaction back (nothing written, op NOT logged) so the caller
				// can recompute against fresh state and retry.
				const checkGuard = (row: RawCollectionRow | undefined): void => {
					const guard = options?.guardRowState
					if (!guard) {
						return
					}
					const version = typeof row?._version === 'string' ? row._version : null
					const fieldVersions =
						typeof row?._field_versions === 'string' ? row._field_versions : null
					if (version !== guard.version || fieldVersions !== guard.fieldVersions) {
						throw new OptimisticLockError(collection, op.recordId)
					}
				}

				if (options?.logOnly) {
					// Append-only: the caller (after folding the record's log) determined
					// this op does not change the authoritative row. Persist it for future
					// folds but leave the row untouched. Fall through to op-log insert + VV.
				} else if (
					op.type === 'insert' &&
					op.data &&
					op.fieldVersions &&
					!options?.materializeData &&
					!options?.forceMaterialize &&
					!options?.materializeTimestamp
				) {
					// Server scope-entry insert (RT-27): every field carries its own version.
					await this.applyFieldVersionedInsert(tx, op, definition, op.data, checkGuard)
				} else if (op.type === 'insert' && materializeSource) {
					const serializedData = serializeRecord(materializeSource, definition.fields)
					const existing = await tx.query<RawCollectionRow>(
						`SELECT _updated_at, _version, _field_versions, _deleted FROM ${collection} WHERE id = ?`,
						[op.recordId],
					)
					const row = existing[0]
					checkGuard(row)

					if (!row) {
						const record: Record<string, unknown> = {
							id: op.recordId,
							...serializedData,
							_created_at: wallTime,
							_updated_at: wallTime,
							_version: remoteVersion,
							// Stamp every inserted field so per-field LWW has a real baseline.
							_field_versions: serializeFieldVersions(
								fieldVersionsForFields(Object.keys(serializedData), remoteVersion),
							),
						}
						const insertQuery = buildInsertQuery(collection, record)
						await tx.execute(insertQuery.sql, insertQuery.params)

						// Catch up on operations delivered BEFORE this insert (transports may
						// reorder): any update/delete already logged for this record was
						// applied while no row existed, so it never materialized. The row is
						// a fold of the log — fold the orphans now, in timestamp order,
						// inside this same transaction. Per-field LWW makes the result
						// identical to what an in-order device computed.
						await this.foldOrphanedOperations(tx, collection, definition, op.recordId, op)
					} else if (
						row._deleted === 1 &&
						(
							await tx.query<{ record_id: string }>(
								'SELECT record_id FROM _kora_scope_retractions WHERE collection = ? AND record_id = ?',
								[collection, op.recordId],
							)
						).length > 0
					) {
						// The row is hidden by a scope retraction (a view change, not a domain
						// delete) and the record is entering the scope again, typically through
						// a server scope-entry insert (RT-19). Show it again and merge per field,
						// exactly like an insert collision on a live row: fields this device
						// holds newer versions of are kept.
						const { winners, merged } = resolvePerFieldLww(
							parseFieldVersions(row._field_versions),
							Object.keys(serializedData),
							remoteVersion,
							typeof row._version === 'string' ? row._version : undefined,
						)
						const fieldChanges: Record<string, unknown> = {
							_deleted: 0,
							_field_versions: serializeFieldVersions(merged),
						}
						for (const field of winners) {
							fieldChanges[field] = serializedData[field]
						}
						// `_created_at` is left alone: the record was created long before it
						// re-entered this device's view.
						const reactivate = buildFieldFastForwardUpdateQuery(
							collection,
							op.recordId,
							fieldChanges,
							remoteVersion,
							wallTime,
						)
						await tx.execute(reactivate.sql, reactivate.params)
						await tx.execute(
							'DELETE FROM _kora_scope_retractions WHERE collection = ? AND record_id = ?',
							[collection, op.recordId],
						)
					} else if (row._deleted === 1) {
						// Insert vs tombstone: a strictly newer insert resurrects the record
						// with its full field set; an older one is stale (delete wins).
						if (isIncomingNewerThanRow(materializeTimestamp, row)) {
							const fieldChanges: Record<string, unknown> = {
								...serializedData,
								_deleted: 0,
								_field_versions: serializeFieldVersions(
									fieldVersionsForFields(Object.keys(serializedData), remoteVersion),
								),
							}
							const upsert = buildFieldFastForwardUpdateQuery(
								collection,
								op.recordId,
								fieldChanges,
								remoteVersion,
								wallTime,
								{ maxCreatedAt: wallTime },
							)
							await tx.execute(upsert.sql, upsert.params)
						}
					} else {
						// Insert collision on a LIVE row (relayed insert racing a local one,
						// or an insert-vs-insert merge). A plain INSERT would violate the
						// primary key; resolve per-field instead, exactly like an update, so
						// every node converges no matter which insert (or interleaved
						// update) it saw first. `_created_at` converges to the max insert
						// wall time seen, applied even when every field loses.
						const currentVersions = parseFieldVersions(row._field_versions)
						const rowVersion = typeof row._version === 'string' ? row._version : undefined
						const fieldChanges: Record<string, unknown> = {}
						let fieldVersionsJson: string
						if (options?.forceMaterialize) {
							// Authoritative merged insert: every field is written.
							const merged = { ...currentVersions }
							for (const field of Object.keys(serializedData)) {
								fieldChanges[field] = serializedData[field]
								merged[field] = remoteVersion
							}
							fieldVersionsJson = serializeFieldVersions(merged)
						} else {
							const { winners, merged } = resolvePerFieldLww(
								currentVersions,
								Object.keys(serializedData),
								remoteVersion,
								rowVersion,
							)
							for (const field of winners) {
								fieldChanges[field] = serializedData[field]
							}
							fieldVersionsJson = serializeFieldVersions(merged)
						}
						const upsert = buildFieldFastForwardUpdateQuery(
							collection,
							op.recordId,
							{ ...fieldChanges, _field_versions: fieldVersionsJson },
							remoteVersion,
							wallTime,
							{ maxCreatedAt: wallTime },
						)
						await tx.execute(upsert.sql, upsert.params)
					}
				} else if (op.type === 'update' && materializeSource) {
					const serializedChanges = serializeRecord(materializeSource, definition.fields)
					const changedFields = Object.keys(serializedChanges)

					// Read the current per-field versions INSIDE the transaction so the
					// resolve-then-write is atomic with respect to any concurrent local
					// mutation — this is what prevents a relayed remote op from clobbering
					// a newer local edit that lands between the read and the write.
					const currentRows = await tx.query<RawCollectionRow>(
						`SELECT _version, _field_versions FROM ${quoteIdent(collection)} WHERE id = ?`,
						[op.recordId],
					)
					const currentRow = currentRows[0]
					checkGuard(currentRow)

					if (currentRow) {
						const currentVersions = parseFieldVersions(currentRow._field_versions)
						const rowVersion =
							typeof currentRow._version === 'string' ? currentRow._version : undefined

						if (options?.forceMaterialize) {
							// Authoritative merged result (richtext / add-wins-set / constraint
							// resolution computed by the merge engine): write every changed
							// field and stamp its per-field version to this op's version, while
							// advancing the row watermark monotonically.
							const merged = { ...currentVersions }
							for (const field of changedFields) {
								merged[field] = remoteVersion
							}
							const fieldChanges: Record<string, unknown> = {
								...serializedChanges,
								_field_versions: serializeFieldVersions(merged),
							}
							if (options?.reactivateIfDeleted) {
								fieldChanges._deleted = 0
							}
							const forceQuery = buildFieldFastForwardUpdateQuery(
								collection,
								op.recordId,
								fieldChanges,
								remoteVersion,
								wallTime,
							)
							await tx.execute(forceQuery.sql, forceQuery.params)
						} else {
							// Deterministic field-level LWW: write only the fields this op
							// wins (strictly newer than the field's stored version). Same
							// result on every node regardless of arrival order.
							const { winners, merged } = resolvePerFieldLww(
								currentVersions,
								changedFields,
								remoteVersion,
								rowVersion,
							)
							if (winners.length > 0 || options?.reactivateIfDeleted) {
								const winningChanges: Record<string, unknown> = {
									_field_versions: serializeFieldVersions(merged),
								}
								for (const field of winners) {
									winningChanges[field] = serializedChanges[field]
								}
								if (options?.reactivateIfDeleted) {
									winningChanges._deleted = 0
								}
								const forceQuery = buildFieldFastForwardUpdateQuery(
									collection,
									op.recordId,
									winningChanges,
									remoteVersion,
									wallTime,
								)
								await tx.execute(forceQuery.sql, forceQuery.params)
							}
						}
					}
					// currentRow absent: nothing materialized to update (insert not yet
					// applied, or hard-absent). The op is still appended to the log below;
					// the pipeline handles tombstone reactivation separately.
				} else if (op.type === 'delete') {
					const deleteQuery = buildLwwSoftDeleteQuery(
						collection,
						op.recordId,
						wallTime,
						remoteVersion,
					)
					await tx.execute(deleteQuery.sql, deleteQuery.params)
				}

				// Persist the operation
				await this.appendRemoteOperationRow(tx, stored)

				// Version vector: MAX with the stored value, never a value computed outside
				// this transaction (another tab may have advanced it). The in-memory
				// vector is updated only after commit.
				await tx.execute(
					`INSERT INTO _kora_version_vector (node_id, sequence_number) VALUES (?, ?)
     ON CONFLICT(node_id) DO UPDATE SET sequence_number = MAX(sequence_number, excluded.sequence_number)`,
					[op.nodeId, op.sequenceNumber],
				)
			})
		} catch (error) {
			this.reportStorageError(error)
			throw error
		}

		// Committed. A duplicate still advances this runtime's vector and refreshes
		// its queries: another tab sharing the database may have applied the
		// operation first, and this tab must not stay blind to it (STORE-10).
		this.recordOperationSequence(op)
		if (outcome.duplicate) {
			if (outcome.revived) {
				this.subscriptionManager.invalidate(collection)
			} else {
				this.subscriptionManager.notify(collection, op)
			}
			return 'duplicate'
		}

		this.subscriptionManager.notify(collection, op)
		this.emitter?.emit({
			type: 'operation:applied',
			operation: op,
			duration: Date.now() - startedAt,
		})

		return 'applied'
	}

	/**
	 * W7 remote apply: append the operation, then merge it into its record's fold
	 * state, which re-materializes the row, all in one write transaction. There is no
	 * read-decide-write race to guard: the state is read and written inside the
	 * transaction, and the merge does not depend on the order operations arrive in.
	 */
	private async applyRemoteFolded(
		op: Operation,
		fold: RecordFolder,
		options: ApplyRemoteOptions | undefined,
	): Promise<ApplyResult> {
		const collection = op.collection
		const startedAt = Date.now()
		const outcome = { duplicate: false, revived: false, traces: [] as MergeTrace[] }
		try {
			await this.adapter.transaction(async (tx) => {
				if ((await isOperationLogged(tx, collection, op.id)) || (await isCompacted(tx, op))) {
					outcome.duplicate = true
					const retracted = await tx.query<{ record_id: string }>(
						'SELECT record_id FROM _kora_scope_retractions WHERE collection = ? AND record_id = ?',
						[collection, op.recordId],
					)
					if (retracted.length > 0) {
						// The record re-enters the scope: show it again with every field of
						// its state (writes merged while it was hidden included).
						const state = await fold.loadState(tx, collection, op.recordId)
						if (state) {
							await fold.materializeRow(tx, state, 'all', { clearRetraction: true })
						} else {
							await tx.execute(
								'DELETE FROM _kora_scope_retractions WHERE collection = ? AND record_id = ?',
								[collection, op.recordId],
							)
						}
						outcome.revived = true
					}
					return
				}
				if (this.clock) {
					// A scope entry's newest field version can be later than its timestamp (the
					// record's creation, RT-27): the clock must move past every version it carries.
					this.clock.receive(op.fieldVersions ? newestFieldVersion(op) : op.timestamp)
				}
				await this.appendRemoteOperationRow(tx, op)
				const applied = await fold.applyInTx(tx, op, 'remote')
				outcome.traces = applied.traces
				await tx.execute(
					`INSERT INTO _kora_version_vector (node_id, sequence_number) VALUES (?, ?)
     ON CONFLICT(node_id) DO UPDATE SET sequence_number = MAX(sequence_number, excluded.sequence_number)`,
					[op.nodeId, op.sequenceNumber],
				)
			})
		} catch (error) {
			this.reportStorageError(error)
			throw error
		}

		this.recordOperationSequence(op)
		if (outcome.duplicate) {
			if (outcome.revived) {
				this.subscriptionManager.invalidate(collection)
			} else {
				this.subscriptionManager.notify(collection, op)
			}
			return 'duplicate'
		}
		this.subscriptionManager.notify(collection, op)
		this.emitMergeTraces(op, outcome.traces)
		options?.onMergeTraces?.(outcome.traces)
		this.emitter?.emit({
			type: 'operation:applied',
			operation: op,
			duration: Date.now() - startedAt,
		})
		return 'applied'
	}

	/** DevTools: every fold decision that was a conflict, plus one completion per merge. */
	private emitMergeTraces(op: Operation, traces: MergeTrace[]): void {
		if (!this.emitter || traces.length === 0) return
		const first = traces[0] as MergeTrace
		this.emitter.emit({ type: 'merge:started', operationA: first.operationA, operationB: op })
		for (const trace of traces) this.emitter.emit({ type: 'merge:conflict', trace })
		this.emitter.emit({ type: 'merge:completed', trace: first })
	}

	/** The record fold, once the database's rows are fold materializations. */
	private activeFold(): RecordFolder | undefined {
		return this.foldActive && this.folder ? this.folder : undefined
	}

	/**
	 * The record's W7 fold state (null under legacy materialization or when the
	 * record has none). For DevTools, tests and the server-comparison harness.
	 */
	async getFoldState(collection: string, recordId: string): Promise<FoldState | null> {
		this.ensureOpen()
		const fold = this.activeFold()
		if (!fold) return null
		let state: FoldState | null = null
		await this.adapter.transaction(async (tx) => {
			state = await fold.loadState(tx, collection, recordId)
		})
		return state
	}

	/** Whether rows are materialized by the W7 fold (false under `materialization: 'legacy'`). */
	isFoldMaterialized(): boolean {
		return this.activeFold() !== undefined
	}

	private async readMeta(key: string): Promise<string | null> {
		const rows = await this.adapter.query<MetaRow>('SELECT value FROM _kora_meta WHERE key = ?', [
			key,
		])
		return rows[0]?.value ?? null
	}

	private async writeMeta(key: string, value: string): Promise<void> {
		await this.adapter.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
			key,
			value,
		])
	}

	/**
	 * Write every genuine beta.12 clear of the op log into its logged body, once per
	 * database (RT-83, RT-85): the fold folds bodies as written, so the clear must be in
	 * the body. Records already materialized by the fold are re-folded.
	 */
	private async ensureLegacyBodiesCanonical(): Promise<void> {
		const folder = this.folder
		if (!folder) return
		if ((await this.readMeta(LEGACY_BODIES_META_KEY)) !== null) return
		const rewritten = await canonicalizeLegacyLogBodies(this.adapter, this.schema, this.nodeId)
		if (rewritten.length > 0 && this.foldActive) {
			const seen = new Set<string>()
			await this.adapter.transaction(async (tx) => {
				for (const { collection, recordId } of rewritten) {
					const key = `${collection}\u0000${recordId}`
					if (seen.has(key)) continue
					seen.add(key)
					await folder.refoldInTx(tx, collection, recordId)
				}
			})
		}
		await this.writeMeta(LEGACY_BODIES_META_KEY, String(rewritten.length))
	}

	/**
	 * Make every row a materialization of its record's fold state (W7), once per
	 * database and fold-state version. Runs after the W8 log-integrity scan: a
	 * clean log is rebuilt with the fold; an incomplete (compacted) log rebuilds on
	 * top of the rows as base snapshots; a log with quarantined rows is never
	 * rebuilt from (rows are kept and become base snapshots), and
	 * `store:rematerialized` reports which happened.
	 */
	private async ensureMaterialization(forceSnapshot = false): Promise<void> {
		const current = await this.readMeta(FOLD_MATERIALIZATION_META_KEY)
		if (!this.folder) {
			if (current !== FOLD_MATERIALIZATION_LEGACY) {
				await this.writeMeta(FOLD_MATERIALIZATION_META_KEY, FOLD_MATERIALIZATION_LEGACY)
			}
			return
		}
		if (current === FOLD_MATERIALIZATION_CURRENT) {
			this.foldActive = true
			await this.ensureFoldPlan()
			return
		}
		const report = await this.scanLog('full')
		// Only the records that own a quarantined row are kept as they are (RT-68); the
		// rest are rebuilt from a log that is complete for them unless it was compacted
		// or has holes.
		const kept = await loadQuarantinedRecords(this.adapter)
		// A hole in an own node's sequence that a quarantined row explains belongs to
		// that row's record (kept above), not to the whole log.
		const quarantinedSeqs = new Set(
			report.quarantined.map((row) => `${row.nodeId ?? ''}\u0000${row.sequenceNumber ?? ''}`),
		)
		const unexplainedGaps = report.gaps.filter((gap) => {
			for (let s = gap.from; s <= gap.to; s++) {
				if (!quarantinedSeqs.has(`${gap.nodeId}\u0000${s}`)) return true
			}
			return false
		})
		const mode: Exclude<RematerializationMode, 'kept'> =
			!forceSnapshot && unexplainedGaps.length === 0 && report.compactedAt === null
				? 'log'
				: 'snapshot+log'
		const result = await rematerializeDatabase(this.adapter, this.schema, this.folder, mode, kept)
		await this.writeMeta(FOLD_MATERIALIZATION_META_KEY, FOLD_MATERIALIZATION_CURRENT)
		await this.writeMeta(
			FOLD_PLAN_META_KEY,
			JSON.stringify(foldPlanFingerprints(this.schema, this.operationTransforms)),
		)
		this.foldActive = true
		if (result.snapshots > 0) await this.requestSnapshotResync()
		if (result.changedRows > 0) {
			// Other tabs on this database hear about it once the bus is wired (RT-98).
			for (const collection of Object.keys(this.schema.collections)) {
				this.subscriptionManager.invalidate(collection)
			}
		}
		if (result.records > 0) {
			this.emitter?.emit({
				type: 'store:rematerialized',
				dbName: this.dbName,
				mode: result.mode,
				records: result.records,
				changedRows: result.changedRows,
				message:
					result.mode === 'kept'
						? `Operation log of "${this.dbName}" has quarantined rows: the records that own them were kept as they were (row snapshots); ${result.records} record(s) re-materialized, ${result.changedRows} row(s) changed.`
						: `Re-materialized ${result.records} record(s) of "${this.dbName}" with the per-field fold (${result.mode}); ${result.changedRows} row(s) changed.`,
			})
		}
	}

	/**
	 * Refuse to open when a schema version in the local operation log has no transform
	 * path to the current schema (RT-103). Operations of a NEWER schema (authored by an
	 * upgraded peer) are not checked: they are kept aside until this device upgrades.
	 */
	private async assertTransformCoverage(): Promise<void> {
		const transforms = this.operationTransforms
		if (transforms === undefined || transforms.length === 0) return
		const versions = new Set<number>()
		for (const collection of Object.keys(this.schema.collections)) {
			const rows = await this.adapter.query<{ v: number }>(
				`SELECT DISTINCT schema_version AS v FROM ${quoteIdent(`_kora_ops_${collection}`)}`,
			)
			for (const row of rows) {
				const version = Number(row.v)
				if (version < this.schema.version) versions.add(version)
			}
		}
		assertOperationTransformCoverage(
			versions,
			this.schema.version,
			transforms,
			`local database "${this.dbName}"`,
		)
	}

	/**
	 * Re-fold the records of every collection whose fold plan changed since the rows
	 * were materialized (RT-63): a field that became `merge('counter')`, an array that
	 * became append-only, a new or edited resolver. Their stored states hold fields of
	 * the old kind, which the fold refuses (`FoldStateError`). Each record is rebuilt
	 * from its log with the new plan; compacted bases and row snapshots are adapted
	 * (a re-planned field restarts from its materialized value at its version). The
	 * client's equivalent of the server stores' `fold_plan_fingerprint`.
	 */
	private async ensureFoldPlan(): Promise<void> {
		const folder = this.folder
		if (!folder) return
		const current = foldPlanFingerprints(this.schema, this.operationTransforms)
		const storedRaw = await this.readMeta(FOLD_PLAN_META_KEY)
		let changed: string[]
		if (storedRaw === null) {
			// Materialized before the fingerprint was recorded: re-fold the collections
			// whose stored states actually hold a field of another kind.
			changed = await collectionsWithMismatchedStates(this.adapter, this.schema)
		} else {
			let stored: Record<string, unknown> = {}
			try {
				stored = JSON.parse(storedRaw) as Record<string, unknown>
			} catch {
				stored = {}
			}
			changed = Object.keys(current).filter((name) => stored[name] !== current[name])
		}
		if (changed.length > 0) {
			const result = await rematerializeDatabase(
				this.adapter,
				this.schema,
				folder,
				'log',
				undefined,
				changed,
			)
			if (result.snapshots > 0) await this.requestSnapshotResync()
			for (const collection of changed) this.subscriptionManager.invalidate(collection)
			this.emitter?.emit({
				type: 'store:rematerialized',
				dbName: this.dbName,
				mode: result.mode,
				records: result.records,
				changedRows: result.changedRows,
				message: `The fold plan of ${changed.map((name) => `"${name}"`).join(', ')} changed (schema): re-folded ${result.records} record(s) of "${this.dbName}"; ${result.changedRows} row(s) changed.`,
			})
		}
		await this.writeMeta(FOLD_PLAN_META_KEY, JSON.stringify(current))
	}

	/**
	 * Row snapshots were created (RT-68): ask the sync server for a full resync (the
	 * delivery watermarks restart at 0, as after a restore), so each such record gets
	 * its complete history back; {@link settleSnapshotRecords} then drops the
	 * snapshots once the resync has caught up.
	 */
	private async requestSnapshotResync(): Promise<void> {
		await this.adapter.transaction(async (tx) => {
			await tx.execute('UPDATE _kora_meta SET value = ? WHERE key = ? OR key LIKE ?', [
				'0',
				DELIVERY_WATERMARK_META_KEY,
				`${DELIVERY_WATERMARK_META_KEY}:%`,
			])
			await tx.execute('DELETE FROM _kora_meta WHERE key = ?', [DELTA_CURSOR_META_KEY])
			await tx.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
				SNAPSHOT_RESYNC_META_KEY,
				'pending',
			])
		})
	}

	/**
	 * Records whose state still folds against a row snapshot (approximate: a late
	 * concurrent write older than a field's version is not folded, RT-68).
	 */
	async getSnapshotRecords(): Promise<Array<{ collection: string; recordId: string }>> {
		this.ensureOpen()
		const folder = this.folder
		if (!folder) return []
		let out: Array<{ collection: string; recordId: string }> = []
		await this.adapter.transaction(async (tx) => {
			out = await folder.listSnapshotRecords(tx)
		})
		return out
	}

	/**
	 * Called by sync when a delivery stream has caught up (its final batch fully
	 * applied). After the full resync {@link requestSnapshotResync} asked for, every
	 * row-snapshot record whose insert is back in the log is re-folded from its
	 * complete history and stops being approximate (RT-68). Also retires the
	 * provisional cascades of remote deletes (RT-69): the server's own copies were
	 * delivered by now, and any it did not derive must not stay applied locally.
	 *
	 * With `provisionalOnly` only the provisional cascades are retired (RT-93: a stream
	 * batch from a server that derives no cascades, which is not the end of a resync).
	 *
	 * @param options - `provisionalOnly`: leave row snapshots for the next catch-up
	 * @returns How many snapshots were dropped
	 */
	async settleAfterCatchUp(options: { provisionalOnly?: boolean } = {}): Promise<number> {
		this.ensureOpen()
		const folder = this.activeFold()
		if (!folder) return 0
		const pending =
			options.provisionalOnly !== true &&
			(await this.readMeta(SNAPSHOT_RESYNC_META_KEY)) === 'pending'
		let settled = 0
		const touched = new Set<string>()
		await this.adapter.transaction(async (tx) => {
			for (const { collection, recordId } of await folder.listProvisionalRecords(tx)) {
				await folder.deleteProvisional(tx, collection, recordId, null)
				await folder.refoldInTx(tx, collection, recordId)
				touched.add(collection)
			}
			if (pending) {
				for (const { collection, recordId } of await folder.listSnapshotRecords(tx)) {
					if (await folder.settleSnapshotInTx(tx, collection, recordId)) {
						settled += 1
						touched.add(collection)
					}
				}
				await tx.execute('DELETE FROM _kora_meta WHERE key = ?', [SNAPSHOT_RESYNC_META_KEY])
			}
		})
		for (const collection of touched) this.subscriptionManager.invalidate(collection)
		return settled
	}

	/**
	 * Apply the cascades / set-nulls of a REMOTE delete as local-only provisional
	 * effects (RT-69): folded into the children like operations, but never logged,
	 * sequenced or queued for upload. The server derives and relays its own copy;
	 * when it arrives (same parent, same record) the provisional effect is retired.
	 *
	 * @param parent - The remote delete
	 * @param effects - Its side effects, as the referential check derived them
	 */
	async applyProvisionalSideEffects(
		parent: Operation,
		effects: ReadonlyArray<{
			type: 'delete' | 'update'
			collection: string
			recordId: string
			data: Record<string, unknown> | null
			previousData: Record<string, unknown> | null
			ruleId: string
		}>,
	): Promise<number> {
		this.ensureOpen()
		const folder = this.activeFold()
		if (!folder || effects.length === 0) return 0
		const touched = new Set<string>()
		let applied = 0
		// Stamped right after the parent (its HLC, next logical ticks), exactly like the
		// server's copy, so a write to the child later than the delete still wins.
		const clock = new HybridLogicalClock(PROVISIONAL_NODE_ID, {
			now: () => parent.timestamp.wallTime,
		})
		clock.advanceTo(parent.timestamp)
		const built: Operation[] = []
		for (const effect of effects) {
			if (!this.schema.collections[effect.collection]) continue
			const op: Operation = {
				id: await deriveSideEffectOpId(parent.id, `provisional/${effect.ruleId}`, effect.recordId),
				nodeId: PROVISIONAL_NODE_ID,
				type: effect.type,
				collection: effect.collection,
				recordId: effect.recordId,
				data: effect.type === 'delete' ? null : effect.data,
				previousData: effect.type === 'delete' ? null : effect.previousData,
				timestamp: clock.now(),
				sequenceNumber: 0,
				causalDeps: [parent.id],
				schemaVersion: this.schema.version,
			}
			built.push(op)
		}
		await this.adapter.transaction(async (tx) => {
			for (const op of built) {
				await folder.applyProvisionalInTx(tx, op, parent.id)
				touched.add(op.collection)
				applied += 1
			}
		})
		for (const collection of touched) this.subscriptionManager.invalidate(collection)
		return applied
	}

	/**
	 * Node ids whose writes win `merge('server-authoritative')` fields (the server's,
	 * from the sync handshake). Every `kora:server:` id is authoritative by prefix, so
	 * only explicit ids (legacy server node ids, configured extras) are kept: the device
	 * persists the UNION of every explicit id it has learned and never drops one (RT-75).
	 * Handshakes differ per server instance (each lists what it knows), so a list that
	 * omits an id is not a revocation.
	 *
	 * Revocation is explicit (RT-81): ids a handshake lists in `revokedAuthoritativeNodeIds`
	 * are removed from the union, persisted as revoked, and never learned again. Records
	 * of collections with such fields are re-folded only when the explicit set changes
	 * (grows, or loses a revoked id).
	 *
	 * @param nodeIds - The server's authoritative node ids (one handshake's list)
	 * @param revokedNodeIds - Explicit ids the server revoked (one handshake's list)
	 */
	async setAuthoritativeNodeIds(
		nodeIds: readonly string[],
		revokedNodeIds: readonly string[] = [],
	): Promise<void> {
		this.ensureOpen()
		const folder = this.folder
		const persisted = await loadAuthoritativeNodeIds(this.adapter)
		const persistedRevoked = await loadRevokedAuthoritativeNodeIds(this.adapter)
		const revoked = new Set(
			[...persistedRevoked, ...revokedNodeIds].filter((id) => !isServerNodeId(id)),
		)
		if (revoked.size > persistedRevoked.length) {
			await saveRevokedAuthoritativeNodeIds(this.adapter, [...revoked].sort())
		}
		const previous = new Set(
			[...(persisted ?? []), ...(folder ? folder.getAuthoritativeNodeIds() : [])].filter(
				(id) => !isServerNodeId(id),
			),
		)
		const known = new Set([...previous].filter((id) => !revoked.has(id)))
		const dropped = previous.size - known.size
		const learned = [...new Set(nodeIds)].filter(
			(id) => !isServerNodeId(id) && !known.has(id) && !revoked.has(id),
		)
		const next = [...known, ...learned].sort()
		const stored = persisted === null ? null : [...persisted].sort()
		if (stored === null || JSON.stringify(stored) !== JSON.stringify(next)) {
			// One persisted list (`sync_authoritative_node_ids`) serves the fold and the
			// sync engine's verification exemptions, so they can never disagree.
			await saveAuthoritativeNodeIds(this.adapter, next)
		}
		if (!folder) return
		folder.setAuthoritativeNodeIds(next)
		if (learned.length === 0 && dropped === 0) return
		const fold = this.activeFold()
		if (!fold) return
		for (const collection of Object.keys(this.schema.collections)) {
			if (!fold.hasAuthoritativeFields(collection)) continue
			const ids = await this.adapter.query<{ record_id: string }>(
				`SELECT record_id FROM ${FOLD_STATE_TABLE} WHERE collection = ?`,
				[collection],
			)
			await this.adapter.transaction(async (tx) => {
				for (const { record_id } of ids) await fold.refoldInTx(tx, collection, record_id)
			})
			this.subscriptionManager.invalidate(collection)
		}
	}

	/**
	 * Re-fold the records of these operations from base + log (W7 exclusion: an
	 * operation with a terminal-rejection marker is left out).
	 */
	private async refoldRecordsOf(operationIds: readonly string[]): Promise<void> {
		const fold = this.activeFold()
		if (!fold || operationIds.length === 0) return
		const touched = new Map<string, Set<string>>()
		for (const collection of Object.keys(this.schema.collections)) {
			const table = quoteIdent(`_kora_ops_${collection}`)
			for (let i = 0; i < operationIds.length; i += 500) {
				const chunk = operationIds.slice(i, i + 500)
				const rows = await this.adapter.query<{ record_id: string }>(
					`SELECT DISTINCT record_id FROM ${table} WHERE id IN (${chunk.map(() => '?').join(', ')})`,
					chunk,
				)
				for (const row of rows) {
					const set = touched.get(collection) ?? new Set<string>()
					set.add(row.record_id)
					touched.set(collection, set)
				}
			}
		}
		if (touched.size === 0) return
		await this.adapter.transaction(async (tx) => {
			for (const [collection, records] of touched) {
				for (const recordId of records) await fold.refoldInTx(tx, collection, recordId)
			}
		})
		for (const [collection, records] of touched) {
			this.subscriptionManager.invalidate(collection, [...records])
		}
	}

	/**
	 * Append a remote operation to the log. If another operation of the same node
	 * already holds its sequence number (a beta.12 device could produce such
	 * pairs), the log keeps the existing row and this one is recorded in the
	 * sequence-conflicts table, where dedup and record folds still see it.
	 */
	private async appendRemoteOperationRow(tx: Transaction, op: Operation): Promise<void> {
		const table = quoteIdent(`_kora_ops_${op.collection}`)
		const holder = await tx.query<{ id: string }>(
			`SELECT id FROM ${table} WHERE node_id = ? AND sequence_number = ?`,
			[op.nodeId, op.sequenceNumber],
		)
		const opRow = serializeOperation(op)
		if (holder.length > 0) {
			await insertConflictRow(
				tx,
				op.collection,
				opRow,
				'remote-sequence-conflict',
				null,
				null,
				Date.now(),
			)
			return
		}
		const opInsert = buildInsertQuery(
			`_kora_ops_${op.collection}`,
			opRow as unknown as Record<string, unknown>,
		)
		await tx.execute(opInsert.sql, opInsert.params)
	}

	/**
	 * Hide a record from this client's authorized materialized view. This writes no
	 * replicated operation and therefore cannot be mistaken for a domain deletion.
	 * The marker lets a later authoritative backfill reactivate the retained row.
	 */
	async applyScopeRetraction(collection: string, recordId: string): Promise<void> {
		this.ensureOpen()
		if (!this.schema.collections[collection]) return
		await this.adapter.transaction(async (tx) => {
			await tx.execute(`UPDATE ${quoteIdent(collection)} SET _deleted = 1 WHERE id = ?`, [recordId])
			await tx.execute(
				'INSERT OR REPLACE INTO _kora_scope_retractions (collection, record_id) VALUES (?, ?)',
				[collection, recordId],
			)
		})
		this.subscriptionManager.invalidate(collection, [recordId])
	}

	/**
	 * Hide every live row of `collection` outside `scope` (null: the whole collection),
	 * except the records in `keep` (records with unsent local operations). Judged on
	 * local values. Returns the ids hidden.
	 *
	 * A kept record outside the scope is remembered (in `_kora_meta`, so a restart keeps
	 * it): {@link recheckAccessNarrowing} hides it once its operations are refused.
	 */
	async applyCollectionNarrowing(
		collection: string,
		scope: Record<string, unknown> | null,
		keep: ReadonlySet<string>,
	): Promise<string[]> {
		this.ensureOpen()
		const definition = this.schema.collections[collection]
		if (!definition) return []
		const rows = await this.adapter.query<RawCollectionRow>(
			`SELECT * FROM ${quoteIdent(collection)} WHERE _deleted = 0`,
		)
		const retracted: string[] = []
		const kept: string[] = []
		for (const row of rows) {
			const record = deserializeRecord(row, definition.fields)
			const recordId = String(record.id)
			if (scope !== null && recordMatchesCollectionScope(record, scope)) continue
			if (keep.has(recordId)) {
				kept.push(recordId)
				continue
			}
			await this.applyScopeRetraction(collection, recordId)
			retracted.push(recordId)
		}
		await this.saveKeptOutsideNarrowing(collection, kept.length > 0 ? { scope, kept } : null)
		return retracted
	}

	/**
	 * Hide the records an access narrowing kept for their unsent operations once none of
	 * their operations is pending any more (refused, or quarantined) and they are still
	 * outside the narrowed scope. Returns the records hidden.
	 *
	 * @param pending - The record ids of a collection that still have unsent operations
	 */
	async recheckAccessNarrowing(
		pending: (collection: string) => ReadonlySet<string>,
	): Promise<Array<{ collection: string; recordId: string }>> {
		this.ensureOpen()
		const hidden: Array<{ collection: string; recordId: string }> = []
		for (const [collection, state] of await this.loadKeptOutsideNarrowing()) {
			const definition = this.schema.collections[collection]
			const stillPending = pending(collection)
			const kept: string[] = []
			for (const recordId of state.kept) {
				if (stillPending.has(recordId)) {
					kept.push(recordId)
					continue
				}
				if (!definition) continue
				const rows = await this.adapter.query<RawCollectionRow>(
					`SELECT * FROM ${quoteIdent(collection)} WHERE id = ? AND _deleted = 0`,
					[recordId],
				)
				const row = rows[0]
				if (!row) continue
				const record = deserializeRecord(row, definition.fields)
				if (state.scope !== null && recordMatchesCollectionScope(record, state.scope)) continue
				await this.applyScopeRetraction(collection, recordId)
				hidden.push({ collection, recordId })
			}
			if (kept.length !== state.kept.length) {
				await this.saveKeptOutsideNarrowing(
					collection,
					kept.length > 0 ? { scope: state.scope, kept } : null,
				)
			}
		}
		return hidden
	}

	/** Drop one record from the records an access narrowing kept (it was re-sent). */
	private async forgetKeptOutsideNarrowing(collection: string, recordId: string): Promise<void> {
		const states = await this.loadKeptOutsideNarrowing()
		const state = states.get(collection)
		if (!state?.kept.includes(recordId)) return
		const kept = state.kept.filter((id) => id !== recordId)
		await this.saveKeptOutsideNarrowing(collection, kept.length > 0 ? { ...state, kept } : null)
	}

	private async loadKeptOutsideNarrowing(): Promise<
		Map<string, { scope: Record<string, unknown> | null; kept: string[] }>
	> {
		if (this.keptOutsideNarrowing) return this.keptOutsideNarrowing
		const rows = await this.adapter.query<{ key: string; value: string }>(
			'SELECT key, value FROM _kora_meta WHERE key LIKE ?',
			[`${ACCESS_NARROWING_META_PREFIX}%`],
		)
		const out = new Map<string, { scope: Record<string, unknown> | null; kept: string[] }>()
		for (const row of rows) {
			try {
				const parsed = JSON.parse(row.value) as {
					scope?: Record<string, unknown> | null
					kept?: unknown
				}
				if (!Array.isArray(parsed.kept)) continue
				out.set(row.key.slice(ACCESS_NARROWING_META_PREFIX.length), {
					scope: parsed.scope ?? null,
					kept: parsed.kept.filter((id): id is string => typeof id === 'string'),
				})
			} catch {
				// A malformed entry cannot name a scope: drop it rather than guess.
				await this.adapter.execute('DELETE FROM _kora_meta WHERE key = ?', [row.key])
			}
		}
		this.keptOutsideNarrowing = out
		return out
	}

	private async saveKeptOutsideNarrowing(
		collection: string,
		state: { scope: Record<string, unknown> | null; kept: string[] } | null,
	): Promise<void> {
		const key = `${ACCESS_NARROWING_META_PREFIX}${collection}`
		const cache = await this.loadKeptOutsideNarrowing()
		if (state === null) cache.delete(collection)
		else cache.set(collection, state)
		if (state === null) {
			await this.adapter.execute('DELETE FROM _kora_meta WHERE key = ?', [key])
			return
		}
		await this.adapter.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
			key,
			JSON.stringify(state),
		])
	}

	/** Hide all live rows that no longer match a newly accepted server scope. */
	async applyScopeNarrowing(
		scopes: Record<string, Record<string, unknown>>,
	): Promise<Array<{ collection: string; recordId: string }>> {
		this.ensureOpen()
		const retractions: Array<{ collection: string; recordId: string }> = []
		for (const [collection, definition] of Object.entries(this.schema.collections)) {
			const rows = await this.adapter.query<RawCollectionRow>(
				`SELECT * FROM ${quoteIdent(collection)} WHERE _deleted = 0`,
			)
			const predicate = scopes[collection]
			for (const row of rows) {
				const record = deserializeRecord(row, definition.fields)
				// The one shared matcher (conjunction or `$or`, fails closed), so the device
				// hides exactly what the server stopped delivering.
				const matches = predicate !== undefined && recordMatchesCollectionScope(record, predicate)
				if (!matches) {
					await this.applyScopeRetraction(collection, String(record.id))
					retractions.push({ collection, recordId: String(record.id) })
				}
			}
		}
		return retractions
	}

	/**
	 * Materialize a server scope-entry insert (RT-19) whose fields each carry their
	 * own version (RT-27). The entry restates the record's current server values; a
	 * single whole-row stamp would let a field the server last wrote long ago
	 * overwrite this device's newer unsynced edit of it, after which the device's own
	 * operation uploads and wins on the server (divergence). So every field is resolved
	 * on its own, by last-write-wins against this row's `_field_versions`:
	 *
	 * - no row: inserted with each field stamped at its own version, `_created_at`
	 *   at the record's creation (the entry's `timestamp`), then any orphaned
	 *   updates/deletes are folded in as for any insert;
	 * - live row, or a row hidden by a scope retraction: per-field LWW (a retracted
	 *   row is shown again; `_created_at` is kept);
	 * - domain tombstone: revived only when the entry's newest field version is
	 *   newer than the tombstone, then per-field LWW.
	 *
	 * Deterministic and idempotent: the outcome depends only on the stored and
	 * incoming per-field versions, and a re-applied entry wins no field.
	 */
	private async applyFieldVersionedInsert(
		tx: Transaction,
		op: Operation,
		definition: NonNullable<SchemaDefinition['collections'][string]>,
		data: Record<string, unknown>,
		checkGuard: (row: RawCollectionRow | undefined) => void,
	): Promise<void> {
		const collection = op.collection
		const serialized = serializeRecord(data, definition.fields)
		const versions = op.fieldVersions ?? {}
		const latest = newestFieldVersion(op)
		const latestVersion = serializeRowVersion(latest)
		const incoming: FieldVersions = {}
		for (const field of Object.keys(serialized)) {
			// A field without its own version (renamed by a schema transform) falls back
			// to the entry's newest version: the single-stamp rule of RT-19.
			const version = versions[field]
			incoming[field] = version ? serializeRowVersion(version) : latestVersion
		}

		const rows = await tx.query<RawCollectionRow>(
			`SELECT _updated_at, _version, _field_versions, _deleted FROM ${quoteIdent(collection)} WHERE id = ?`,
			[op.recordId],
		)
		const row = rows[0]
		checkGuard(row)

		if (!row) {
			const record: Record<string, unknown> = {
				id: op.recordId,
				...serialized,
				_created_at: op.timestamp.wallTime,
				_updated_at: latest.wallTime,
				_version: latestVersion,
				_field_versions: serializeFieldVersions(incoming),
			}
			const insertQuery = buildInsertQuery(collection, record)
			await tx.execute(insertQuery.sql, insertQuery.params)
			await this.foldOrphanedOperations(tx, collection, definition, op.recordId, op)
			return
		}

		let retracted = false
		if (row._deleted === 1) {
			retracted =
				(
					await tx.query<{ record_id: string }>(
						'SELECT record_id FROM _kora_scope_retractions WHERE collection = ? AND record_id = ?',
						[collection, op.recordId],
					)
				).length > 0
			// A domain delete newer than everything the entry carries still wins.
			if (!retracted && !isIncomingNewerThanRow(latest, row)) return
		}

		const current = parseFieldVersions(row._field_versions)
		const rowVersion = typeof row._version === 'string' ? row._version : undefined
		const merged: FieldVersions = { ...current }
		const changes: Record<string, unknown> = {}
		for (const [field, version] of Object.entries(incoming)) {
			if (version > effectiveFieldVersion(current, field, rowVersion)) {
				changes[field] = serialized[field]
				merged[field] = version
			}
		}
		if (row._deleted === 1) {
			changes._deleted = 0
		}
		changes._field_versions = serializeFieldVersions(merged)
		const update = buildFieldFastForwardUpdateQuery(
			collection,
			op.recordId,
			changes,
			latestVersion,
			latest.wallTime,
		)
		await tx.execute(update.sql, update.params)
		if (retracted) {
			await tx.execute(
				'DELETE FROM _kora_scope_retractions WHERE collection = ? AND record_id = ?',
				[collection, op.recordId],
			)
		}
	}

	/**
	 * Materialize update/delete operations that were logged for a record BEFORE
	 * its insert arrived (reordered delivery). Runs inside the insert's write
	 * transaction, folding each orphan in timestamp order through the exact
	 * per-field LWW / LWW-delete rules the normal apply paths use, so the final
	 * row state equals what a device that received the operations in causal
	 * order computed. Called only when the insert created a previously-absent
	 * row — in that case every logged update/delete for the record is
	 * necessarily an orphan (rows are soft-deleted, never removed, so a row
	 * that is absent now was never materialized).
	 */
	private async foldOrphanedOperations(
		tx: Transaction,
		collection: string,
		definition: NonNullable<SchemaDefinition['collections'][string]>,
		recordId: string,
		insertOp: Operation,
	): Promise<void> {
		const orphanRows = [
			...(await tx.query<OperationRow>(
				`SELECT * FROM ${quoteIdent(`_kora_ops_${collection}`)} WHERE record_id = ? AND type IN ('update', 'delete')`,
				[recordId],
			)),
			...(await loadRetainedConflictRows(
				(sql, params) => tx.query(sql, params),
				collection,
				recordId,
				['update', 'delete'],
			)),
		]
		if (orphanRows.length === 0) {
			return
		}

		const orphans = orphanRows
			.map((r) => deserializeOperationWithCollection(r, collection))
			.sort((a, b) => HybridLogicalClock.compare(a.timestamp, b.timestamp))

		for (const orphan of orphans) {
			const orphanVersion = serializeRowVersion(orphan.timestamp)
			const orphanWall = orphan.timestamp.wallTime

			if (orphan.type === 'update' && orphan.data) {
				const orphanChanges = serializeRecord(orphan.data, definition.fields)
				const rows = await tx.query<RawCollectionRow>(
					`SELECT _version, _field_versions FROM ${quoteIdent(collection)} WHERE id = ?`,
					[recordId],
				)
				const current = rows[0]
				if (!current) {
					continue
				}
				const { winners, merged } = resolvePerFieldLww(
					parseFieldVersions(current._field_versions),
					Object.keys(orphanChanges),
					orphanVersion,
					typeof current._version === 'string' ? current._version : undefined,
				)
				if (winners.length > 0) {
					const winningChanges: Record<string, unknown> = {
						_field_versions: serializeFieldVersions(merged),
					}
					for (const field of winners) {
						winningChanges[field] = orphanChanges[field]
					}
					const query = buildFieldFastForwardUpdateQuery(
						collection,
						recordId,
						winningChanges,
						orphanVersion,
						orphanWall,
					)
					await tx.execute(query.sql, query.params)
				}
			} else if (orphan.type === 'delete') {
				const query = buildLwwSoftDeleteQuery(collection, recordId, orphanWall, orphanVersion)
				await tx.execute(query.sql, query.params)
			}
		}

		// Atomic-op fields need composition, not last-write-wins: the per-field LWW
		// loop above would keep only one concurrent increment's resolved value and drop
		// the rest. Re-materialize just the atomic fields by folding [insert, ...orphans]
		// in HLC order through the shared atomic-aware replay — the same fold the server
		// and the live apply path use — so an atomic op that arrived before its insert
		// (reordered delivery) composes correctly instead of losing deltas. Only the
		// field VALUES are overwritten; their per-field versions were already stamped to
		// the latest writer by the loop above, so future LWW stays correct.
		const atomicFields = new Set<string>()
		for (const orphan of orphans) {
			if (orphan.type === 'update' && orphan.atomicOps) {
				for (const field of Object.keys(orphan.atomicOps)) {
					atomicFields.add(field)
				}
			}
		}
		if (atomicFields.size > 0) {
			// A scope-entry insert expands into its per-field writes (RT-27).
			const ordered = expandFieldVersionedOperations([insertOp, ...orphans])
			const folded = replayOperationsForRecord(ordered)
			if (folded) {
				const composed: Record<string, unknown> = {}
				for (const field of atomicFields) {
					if (field in folded) {
						composed[field] = folded[field]
					}
				}
				const serialized = serializeRecord(composed, definition.fields)
				const cols = Object.keys(serialized)
				if (cols.length > 0) {
					const setClause = cols.map((c) => `${quoteIdent(c)} = ?`).join(', ')
					await tx.execute(`UPDATE ${quoteIdent(collection)} SET ${setClause} WHERE id = ?`, [
						...cols.map((c) => serialized[c]),
						recordId,
					])
				}
			}
		}
	}

	/**
	 * Get operations from a node within a sequence number range.
	 * Implements the OperationLog interface for computeDelta.
	 */
	async getRange(nodeId: string, fromSeq: number, toSeq: number): Promise<Operation[]> {
		return this.getOperationRange(nodeId, fromSeq, toSeq)
	}

	/**
	 * Get operations from a node within a sequence number range.
	 */
	async getOperationRange(nodeId: string, fromSeq: number, toSeq: number): Promise<Operation[]> {
		this.ensureOpen()
		const allOps: Operation[] = []

		for (const collectionName of Object.keys(this.schema.collections)) {
			const rows = await this.adapter.query<OperationRow>(
				`SELECT * FROM ${quoteIdent(`_kora_ops_${collectionName}`)} WHERE node_id = ? AND sequence_number >= ? AND sequence_number <= ? ORDER BY sequence_number ASC`,
				[nodeId, fromSeq, toSeq],
			)
			for (const row of rows) {
				allOps.push(deserializeOperationWithCollection(row, collectionName))
			}
		}

		// Sort by sequence number across collections
		allOps.sort((a, b) => a.sequenceNumber - b.sequenceNumber)
		return allOps
	}

	/**
	 * Load every operation from the local append-only log across all collections.
	 * Used by sync delta computation, backup export, and time-travel replay.
	 */
	async getAllOperations(): Promise<Operation[]> {
		this.ensureOpen()
		const allOps: Operation[] = []

		for (const collectionName of Object.keys(this.schema.collections)) {
			const rows = await this.adapter.query<OperationRow>(
				`SELECT * FROM ${quoteIdent(`_kora_ops_${collectionName}`)} ORDER BY sequence_number ASC`,
			)
			for (const row of rows) {
				allOps.push(deserializeOperationWithCollection(row, collectionName))
			}
		}

		return allOps
	}

	/**
	 * Rebuild an in-memory snapshot of materialized state at a causal cut in the op log.
	 * Does not mutate the live store — intended for DevTools time-travel inspection.
	 *
	 * @param operationId - Content-addressed id of the operation to replay through (inclusive)
	 * @throws {OperationError} When the operation id is not present in the local log
	 */
	async replayTo(operationId: string): Promise<ReplaySnapshot> {
		this.ensureOpen()
		const start = Date.now()
		const allOps = await this.getAllOperations()
		const aliasRows = await this.adapter.query<{ id: string; reemitted_as: string }>(
			`SELECT id, reemitted_as FROM ${SEQ_CONFLICTS_TABLE} WHERE reemitted_as IS NOT NULL AND reemitted_as <> id`,
		)
		const aliases = new Map(aliasRows.map((row) => [row.id, row.reemitted_as]))
		const snapshot = buildReplaySnapshot(
			this.schema,
			allOps,
			operationId,
			aliases,
			this.operationTransforms,
		)

		if (this.emitter) {
			this.emitter.emit({
				type: 'replay:completed',
				targetOperationId: operationId,
				operationsApplied: snapshot.operationsApplied.length,
				duration: Date.now() - start,
			})
		}

		return snapshot
	}

	/**
	 * Persist a merge trace to the durable audit log.
	 */
	async appendAuditTrace(trace: import('../audit/types').PersistedAuditTrace): Promise<void> {
		this.ensureOpen()
		const { appendAuditTrace: append } = await import('../audit/audit-trace-store')
		await append(this.adapter, trace)
	}

	/**
	 * Read persisted audit traces with optional filters.
	 */
	async getAuditTraces(
		query?: import('../audit/types').AuditTraceQuery,
	): Promise<import('../audit/types').PersistedAuditTrace[]> {
		this.ensureOpen()
		const { readAuditTraces } = await import('../audit/audit-trace-store')
		return readAuditTraces(this.adapter, query)
	}

	/**
	 * Export operations and merge traces as a portable audit bundle.
	 */
	async exportAudit(options?: import('../audit/types').AuditExportOptions): Promise<Uint8Array> {
		this.ensureOpen()
		const { exportAudit: doExport } = await import('../audit/export-audit')
		return doExport(this.adapter, this.schema, this.nodeId, this.schema.version, options)
	}

	/**
	 * Get the schema definition.
	 */
	getSchema(): SchemaDefinition {
		return this.schema
	}

	/**
	 * Route local CRUD through the unified apply pipeline (korajs ApplyPipeline).
	 */
	setLocalMutationHandler(handler: LocalMutationHandler | null): void {
		this.localMutationHandler = handler
		for (const col of this.collections.values()) {
			col.setMutationHandler(handler)
		}
	}

	/**
	 * Notify this store that another same-origin runtime committed an operation to
	 * the shared local database. The operation has already been persisted and
	 * materialized by the database owner; this method only advances in-memory causal
	 * watermarks and invalidates local reactive queries so already-open tabs stay
	 * live without reapplying or rewriting the operation.
	 */
	notifyExternalOperation(operation: Operation): void {
		this.ensureOpen()
		const definition = this.schema.collections[operation.collection]
		if (!definition) {
			return
		}
		this.recordOperationSequence(operation)
		this.subscriptionManager.invalidateFromPeer(operation.collection)
	}

	/**
	 * Notify this store that another same-origin runtime changed rows of a collection
	 * in the shared local database without an operation this tab can see (a re-fold,
	 * a scope retraction, a restore; RT-98). Only re-runs the affected live queries.
	 *
	 * @param collection - The collection whose rows changed
	 */
	notifyExternalChange(collection: string): void {
		this.ensureOpen()
		if (!this.schema.collections[collection]) return
		this.subscriptionManager.invalidateFromPeer(collection)
	}

	/**
	 * Listen to every committed change this store makes to collection rows: local
	 * writes, remote applies, and changes without a new operation (re-folds, scope
	 * retraction, cascade settling, rematerialization, restore). The cross-tab bus
	 * relays these to other tabs on the same database (RT-98).
	 *
	 * @returns An unsubscribe function
	 */
	onRecordsChanged(listener: RecordsChangeListener): () => void {
		return this.subscriptionManager.onRecordsChanged(listener)
	}

	/**
	 * Build the local write context for a collection: everything the single local
	 * write path needs (used by Collection writes and by ApplyPipeline).
	 */
	createMutationContext(
		collection: string,
		options?: {
			extraCausalDeps?: string[]
			/**
			 * Stamp the writes with this clock instead of the store's (it must be this
			 * node's). Used for the side effects of a remote delete, stamped right after
			 * the delete like the server's copy (seam 5), never with the device's "now".
			 */
			clock?: HybridLogicalClock
		},
	): LocalMutationContext {
		this.ensureOpen()
		const definition = this.schema.collections[collection]
		if (!definition || !this.clock) {
			throw new StoreNotOpenError()
		}
		const beforeLocalDelete = this.localMutationHandler?.beforeLocalDelete
		const fold = this.activeFold()
		return {
			...(fold ? { fold } : {}),
			collection,
			definition,
			schema: this.schema,
			adapter: this.adapter,
			clock: options?.clock ?? this.clock,
			nodeId: this.nodeId,
			onMutation: (collectionName, operation) =>
				this.publishLocalOperation(collectionName, operation),
			relationEnforcer: this.relationEnforcer,
			causalTracker: this.causalTracker,
			...(options?.extraCausalDeps ? { extraCausalDeps: options.extraCausalDeps } : {}),
			...(this.secretKeyProvider ? { secretKeyProvider: this.secretKeyProvider } : {}),
			...(this.maxOperationBytes !== undefined
				? { maxOperationBytes: this.maxOperationBytes }
				: {}),
			assertLocalWriteAllowed: () => this.assertLocalWriteAllowed(),
			...(beforeLocalDelete
				? { beforeLocalDelete: beforeLocalDelete.bind(this.localMutationHandler) }
				: {}),
			onStorageError: (error) => this.reportStorageError(error),
		}
	}

	/**
	 * Load a materialized row by ID, including soft-deleted tombstones.
	 */
	async findMaterializedRow(
		collection: string,
		recordId: string,
	): Promise<MaterializedRowSnapshot | null> {
		this.ensureOpen()
		const definition = this.schema.collections[collection]
		if (!definition) {
			return null
		}

		const rows = await this.adapter.query<RawCollectionRow>(
			`SELECT * FROM ${quoteIdent(collection)} WHERE id = ?`,
			[recordId],
		)
		const row = rows[0]
		if (!row) {
			return null
		}

		return {
			record: deserializeRecord(row, definition.fields),
			deleted: row._deleted === 1,
		}
	}

	/**
	 * Raw version state of a materialized row, for optimistic-concurrency guarded
	 * applies: capture this snapshot before computing a merge, pass it as
	 * `guardRowState`, and the apply refuses to write if the row changed since.
	 * Returns null when no row exists (which is itself a valid guard state — the
	 * apply then requires the row to still be absent).
	 */
	async getRowVersionState(collection: string, recordId: string): Promise<RowVersionState | null> {
		this.ensureOpen()
		if (!this.schema.collections[collection]) {
			return null
		}
		const rows = await this.adapter.query<RawCollectionRow>(
			`SELECT _version, _field_versions FROM ${quoteIdent(collection)} WHERE id = ?`,
			[recordId],
		)
		const row = rows[0]
		if (!row) {
			return null
		}
		return {
			version: typeof row._version === 'string' ? row._version : null,
			fieldVersions: typeof row._field_versions === 'string' ? row._field_versions : null,
		}
	}

	/**
	 * Latest operation from this device for a record (used for delete-vs-update merge on sync).
	 */
	/**
	 * Load the last server version vector acknowledged by this client (persisted in `_kora_meta`).
	 */
	async loadLastAckedServerVector(): Promise<VersionVector> {
		this.ensureOpen()
		return loadLastAckedServerVector(this.adapter)
	}

	/**
	 * Persist the last server version vector this client believes the server has applied.
	 */
	async saveLastAckedServerVector(vector: VersionVector): Promise<void> {
		this.ensureOpen()
		await saveLastAckedServerVector(this.adapter, vector)
	}

	/**
	 * Load the per-device node token the sync server issued for this node id (RT-12).
	 */
	async loadNodeToken(nodeId?: string): Promise<string | null> {
		this.ensureOpen()
		return loadNodeToken(this.adapter, nodeId ?? this.nodeId)
	}

	/**
	 * Persist the per-device node token under its node id (the current one by default).
	 */
	async saveNodeToken(token: string, nodeId?: string): Promise<void> {
		this.ensureOpen()
		await saveNodeToken(this.adapter, token, nodeId ?? this.nodeId)
	}

	/**
	 * Load the node ids the sync server named authoritative (protocol v2), or null when
	 * no protocol-2 server ever answered.
	 */
	async loadAuthoritativeNodeIds(): Promise<string[] | null> {
		this.ensureOpen()
		return loadAuthoritativeNodeIds(this.adapter)
	}

	/**
	 * Persist the node ids the sync server named authoritative (protocol v2). Same as
	 * {@link setAuthoritativeNodeIds}: merged into the union of learned explicit ids,
	 * and the fold re-folds affected records only when that set grows.
	 */
	async saveAuthoritativeNodeIds(nodeIds: string[]): Promise<void> {
		await this.setAuthoritativeNodeIds(nodeIds)
	}

	/**
	 * Load persisted delta cursor for resuming paginated initial sync.
	 */
	async loadDeltaCursor(): Promise<string | null> {
		this.ensureOpen()
		return loadDeltaCursor(this.adapter)
	}

	/**
	 * Persist or clear the delta cursor for paginated initial sync resume.
	 */
	async saveDeltaCursor(cursor: string | null): Promise<void> {
		this.ensureOpen()
		await saveDeltaCursor(this.adapter, cursor)
	}

	/**
	 * Load the persisted delivery watermark for a view signature (0 when none recorded).
	 * Defaults to the unfiltered view so existing single-watermark reads keep working.
	 */
	async loadDeliveryWatermark(signature = ''): Promise<number> {
		this.ensureOpen()
		return loadDeliveryWatermark(this.adapter, signature)
	}

	/**
	 * Persist the delivery watermark for a view signature so it survives a client restart.
	 */
	async saveDeliveryWatermark(signature: string, watermark: number): Promise<void> {
		this.ensureOpen()
		await saveDeliveryWatermark(this.adapter, signature, watermark)
	}

	/**
	 * Load every persisted view watermark, keyed by signature.
	 */
	async loadAllDeliveryWatermarks(): Promise<Record<string, number>> {
		this.ensureOpen()
		return loadAllDeliveryWatermarks(this.adapter)
	}

	/**
	 * Delete a persisted view watermark (safe: the view back-fills from 0 when next visited).
	 */
	async deleteDeliveryWatermark(signature: string): Promise<void> {
		this.ensureOpen()
		await deleteDeliveryWatermark(this.adapter, signature)
	}

	/**
	 * Record delivered operations the sync engine deliberately did not apply (inbound
	 * quarantine, W4) and, when given, advance a view's delivery watermark in the same
	 * transaction, so the watermark never passes an operation that is neither applied nor
	 * recorded.
	 */
	async saveInboundQuarantine(
		entries: UnappliedOperation[],
		watermark?: { signature: string; watermark: number },
	): Promise<void> {
		this.ensureOpen()
		await saveUnappliedOperations(this.adapter, entries, watermark)
	}

	/** Every quarantined inbound operation, oldest delivery first. */
	async loadInboundQuarantine(): Promise<UnappliedOperation[]> {
		this.ensureOpen()
		return loadUnappliedOperations(this.adapter)
	}

	/** Remove quarantined inbound operations (applied on replay, or reconciled). */
	async removeInboundQuarantine(operationIds: string[]): Promise<void> {
		this.ensureOpen()
		await removeUnappliedOperations(this.adapter, operationIds)
	}

	/**
	 * The contiguous acknowledged prefix of this device's own operations for a node id,
	 * or null when none was recorded under that contract (W3).
	 */
	async loadOwnAckedThrough(nodeId: string): Promise<number | null> {
		this.ensureOpen()
		return loadOwnAckedThrough(this.adapter, nodeId)
	}

	/** Persist the contiguous acknowledged own-operation prefix for a node id. */
	async saveOwnAckedThrough(nodeId: string, sequence: number): Promise<void> {
		this.ensureOpen()
		await saveOwnAckedThrough(this.adapter, nodeId, sequence)
	}

	/** The downlink scope the sync server last accepted (null when none). */
	async loadAcceptedDownlinkScope(): Promise<Record<string, Record<string, unknown>> | null> {
		this.ensureOpen()
		return loadAcceptedDownlinkScope(this.adapter)
	}

	/** Persist (or clear) the downlink scope the sync server last accepted. */
	async saveAcceptedDownlinkScope(
		scope: Record<string, Record<string, unknown>> | null,
	): Promise<void> {
		this.ensureOpen()
		await saveAcceptedDownlinkScope(this.adapter, scope)
	}

	/**
	 * Local operations not yet reflected on the server version vector.
	 */
	async getUnsyncedOperations(serverVector: VersionVector): Promise<Operation[]> {
		this.ensureOpen()
		return collectOperationsAheadOfServer(
			this.getVersionVector(),
			serverVector,
			(nodeId, fromSeq, toSeq) => this.getOperationRange(nodeId, fromSeq, toSeq),
		)
	}

	/**
	 * Re-stamp never-acknowledged local operations after a fast device clock was
	 * corrected, so sync can resume immediately. Safe because unacknowledged
	 * operations are private to this device (like unpushed git commits);
	 * acknowledged/shared operations are immutable and never touched.
	 *
	 * After the rewrite the store's HLC is advanced past the highest new
	 * timestamp so subsequent local writes keep sorting after the rebased ops.
	 * No data-change notifications are emitted: materialized values are
	 * unchanged, only version stamps move.
	 */
	/**
	 * Move this device to a fresh node id, re-authoring its never-acknowledged
	 * operations under it (RT-21). Used when the sync server refuses the current node
	 * id (`NODE_ID_CLAIMED`): the device keeps every local write and uploads it under
	 * the new id. Acknowledged history stays under the old id. Persisted atomically;
	 * later writes use the new id.
	 *
	 * @param unsyncedOpIds - Ids of this node's operations the server never acknowledged
	 * @returns The new node id and the rewritten operations (for the outbound queue)
	 * @throws {KoraError} When the node id is pinned (`StoreConfig.nodeId`, or per-tab isolation)
	 */
	async rotateNodeId(unsyncedOpIds: string[]): Promise<NodeRotationResult> {
		this.ensureOpen()
		if (this.configNodeId || this.isolation === 'per-tab') {
			throw new KoraError(
				'This store uses a pinned node id, so it cannot move to a fresh one after the sync server refused it.',
				'NODE_ID_PINNED',
				{
					nodeId: this.nodeId,
					fix: 'Remove StoreConfig.nodeId, or give the device a node id no other device uses.',
				},
			)
		}
		const oldNodeId = this.nodeId
		const oldClock = this.clock
		const oldBinding = (await listLocalNodes(this.adapter)).find(
			(node) => node.nodeId === oldNodeId,
		)
		const result = await rotateUnsyncedOperationsInLog(
			this.adapter,
			this.schema,
			unsyncedOpIds,
			oldNodeId,
			generateUUIDv7(),
		)
		await registerLocalNode(this.adapter, result.nodeId)
		// The re-authored writes keep their author (RT-50): the fresh node carries the old
		// node's binding, so they are never held as unassigned or given to another user.
		if (oldBinding?.principal) {
			await setLocalNodePrincipal(
				this.adapter,
				result.nodeId,
				oldBinding.principal,
				oldBinding.binding ?? 'app',
			)
		}
		this.nodeId = result.nodeId
		const clock = new HybridLogicalClock(this.nodeId)
		if (oldClock) {
			const last = oldClock.now()
			clock.advanceTo({ ...last, nodeId: this.nodeId })
			const offset = oldClock.getReferenceOffset()
			if (offset !== null) clock.setReferenceOffset(offset)
		}
		this.clock = clock
		this.causalTracker = new CausalTracker()
		this.sequenceManager = new SequenceManager(this.adapter, this.nodeId)
		this.versionVector = await this.loadVersionVector()
		// The persisted counter (MAX with the stored value, W6), not a local count.
		this.sequenceNumber = this.versionVector.get(this.nodeId) ?? result.operations.length
		for (const collection of this.collections.values()) {
			collection.rebindNode(clock, this.nodeId, this.relationEnforcer, this.causalTracker)
		}
		// The re-authored operations have new ids: their records' fold states still name
		// the old ones, so they are re-folded from the log.
		await this.refoldRecordsOf(result.operations.map((op) => op.id))
		return result
	}

	/**
	 * Re-author another local node's never-acknowledged operations under a fresh node id
	 * bound to `principal` (the user they belong to). Used when the sync server refuses an
	 * adopted node whose writes belong to the signed-in user (the app assigned them, or
	 * the node was created for them) but which no claims-aware server ever accepted: a
	 * beta.12 database's node with history the server recorded no owner for. The store's
	 * own node id, clock and counters are untouched; the fresh node is registered, so the
	 * sync engine adopts it like any other local node.
	 *
	 * @param fromNodeId - The refused local node (never the store's own)
	 * @param unsyncedOpIds - Ids of its operations the server never acknowledged
	 * @param principal - The user the writes belong to (the fresh node's binding)
	 * @returns The fresh node id and the rewritten operations (for the outbound queue)
	 * @throws {KoraError} `NODE_ID_UNKNOWN` when `fromNodeId` is the store's own node or
	 *   not a local node
	 */
	async reauthorLocalNode(
		fromNodeId: string,
		unsyncedOpIds: string[],
		principal: string,
	): Promise<NodeRotationResult> {
		this.ensureOpen()
		const from = (await listLocalNodes(this.adapter)).find((node) => node.nodeId === fromNodeId)
		if (fromNodeId === this.nodeId || !from) {
			throw new KoraError(
				`Node id "${fromNodeId}" is not another local node of this database, so its writes cannot be re-authored.`,
				'NODE_ID_UNKNOWN',
				{ nodeId: fromNodeId, storeNodeId: this.nodeId },
			)
		}
		const result = await rotateUnsyncedOperationsInLog(
			this.adapter,
			this.schema,
			unsyncedOpIds,
			fromNodeId,
			generateUUIDv7(),
			{ moveDatabaseNode: false },
		)
		await registerLocalNode(this.adapter, result.nodeId)
		await setLocalNodePrincipal(this.adapter, result.nodeId, principal, 'fresh')
		this.versionVector = await this.loadVersionVector()
		await this.refoldRecordsOf(result.operations.map((op) => op.id))
		return result
	}

	/**
	 * Move this database back to a node id it authored under before (RT-38): after the
	 * sync server refused the current node, the device tries a node a returning user
	 * owns. Nothing is rewritten; later writes use `nodeId`.
	 *
	 * @throws {KoraError} When the node id is pinned, or `nodeId` is not a local node
	 */
	async switchNodeId(nodeId: string): Promise<void> {
		this.ensureOpen()
		if (this.configNodeId || this.isolation === 'per-tab') {
			throw new KoraError(
				'This store uses a pinned node id, so it cannot switch to another one.',
				'NODE_ID_PINNED',
				{ nodeId: this.nodeId },
			)
		}
		if (nodeId === this.nodeId) return
		if (isReservedNodeId(nodeId)) throw new ReservedNodeIdError(nodeId, 'switchNodeId')
		const known = (await listLocalNodes(this.adapter)).some((node) => node.nodeId === nodeId)
		if (!known) {
			throw new KoraError(
				`Node id "${nodeId}" was never used by this database, so the store cannot switch to it.`,
				'NODE_ID_UNKNOWN',
				{ nodeId },
			)
		}
		await this.adapter.transaction((tx) => moveDatabaseNodeId(tx, nodeId))
		await this.rebindToNode(nodeId)
	}

	/** Point the clock, sequence counter and collections at `nodeId` (already persisted). */
	private async rebindToNode(nodeId: string): Promise<void> {
		const oldClock = this.clock
		this.nodeId = nodeId
		const clock = new HybridLogicalClock(this.nodeId)
		if (oldClock) {
			const last = oldClock.now()
			clock.advanceTo({ ...last, nodeId: this.nodeId })
			const offset = oldClock.getReferenceOffset()
			if (offset !== null) clock.setReferenceOffset(offset)
		}
		this.clock = clock
		this.causalTracker = new CausalTracker()
		this.sequenceManager = new SequenceManager(this.adapter, this.nodeId)
		this.versionVector = await this.loadVersionVector()
		this.sequenceNumber = this.versionVector.get(this.nodeId) ?? 0
		for (const collection of this.collections.values()) {
			collection.rebindNode(clock, this.nodeId, this.relationEnforcer, this.causalTracker)
		}
	}

	/**
	 * Bind this database's writes to the signed-in user (RT-42). Call it whenever the
	 * signed-in user is known or changes, BEFORE the next local write (`createApp` does
	 * so at start and on every auth change of `sync.authClient`).
	 *
	 * - The current node belongs to `principal`: nothing changes.
	 * - The current node is unbound and has no history (no write, never synced): it is
	 *   bound to `principal` (every write under it from now on is theirs).
	 * - The current node is unbound but has history (a database from before RT-42, or
	 *   writes made while nobody was signed in): its owner is NOT guessed (RT-50). The
	 *   store moves to `principal`'s own node, and the old node's owner is learned from
	 *   the sync server (the first accepted handshake as it binds it; a refusal rules
	 *   that user out). A node that never synced cannot be attributed by anyone: its
	 *   unsynced writes are held for the app to assign or discard (`app.sync.assignHeld`,
	 *   `app.sync.discardHeld`).
	 * - It belongs to another user: the store moves to `principal`'s own local node (the
	 *   most recent one, not held), or to a fresh node bound to `principal`. Nothing is
	 *   rewritten: the other user's unsynced writes stay under their node, and sync never
	 *   uploads them on this user's session (they count as `heldOperations`).
	 *
	 * A pinned node id (`StoreConfig.nodeId`, such as an auth device id) cannot move:
	 * `conflict` is then true when it belongs to another user, and sync refuses to
	 * upload it under `principal`; an unbound pinned node with history stays unbound
	 * until the server accepts it for a user. Under `per-tab` isolation the tab moves to
	 * a fresh per-tab node.
	 *
	 * @param principal - The signed-in user id
	 * @returns The node now in use and whether it changed
	 */
	async bindPrincipal(principal: string): Promise<PrincipalBinding> {
		const binding = await this.bindPrincipalToNode(principal)
		// The server's word was about the previous user; another user may own the node.
		if (principal !== this.signedInPrincipal) this.pinnedNodeRefusedByServer = false
		// While the pinned node belongs to another user, local writes are refused (F9):
		// they could only be written under that user's node and would upload as theirs.
		this.pinnedNodeOwnedBy = binding.conflict
			? ((await listLocalNodes(this.adapter)).find((node) => node.nodeId === this.nodeId)
					?.principal ?? null)
			: null
		this.signedInPrincipal = principal
		return binding
	}

	/**
	 * The sync server refused this store's pinned node id because another user owns it
	 * (`owned: true`), or later accepted it (`false`). A pinned node cannot move to a fresh
	 * id, so writes made under it could only ever upload as its owner: while the server
	 * says so, local writes are refused (F9). A no-op for a store whose node is not pinned
	 * (it moves to a fresh node instead).
	 *
	 * @param owned - Whether the server reported the node owned by another user
	 */
	setPinnedNodeOwnedElsewhere(owned: boolean): void {
		if (!this.configNodeId) return
		this.pinnedNodeRefusedByServer = owned
	}

	/** Refuse a local write while the pinned node belongs to another user (F9). */
	private assertLocalWriteAllowed(): void {
		if (this.pinnedNodeOwnedBy === null && !this.pinnedNodeRefusedByServer) return
		throw new NodeOwnedByAnotherUserError(this.nodeId, this.signedInPrincipal)
	}

	private async bindPrincipalToNode(principal: string): Promise<PrincipalBinding> {
		this.ensureOpen()
		const previousNodeId = this.nodeId
		const nodes = await listLocalNodes(this.adapter)
		const current = nodes.find((node) => node.nodeId === this.nodeId)
		const owner = current?.principal ?? null
		if (owner === principal) {
			return { nodeId: this.nodeId, previousNodeId, switched: false, conflict: false }
		}
		if (owner === null) {
			const written = (await this.loadVersionVector()).get(this.nodeId) ?? 0
			if (written === 0 && !(current?.accepted ?? false)) {
				await setLocalNodePrincipal(this.adapter, this.nodeId, principal, 'fresh')
				return { nodeId: this.nodeId, previousNodeId, switched: false, conflict: false }
			}
			if (this.configNodeId) {
				// Cannot move: the server decides whose it is at the first handshake.
				return { nodeId: this.nodeId, previousNodeId, switched: false, conflict: false }
			}
		} else if (this.configNodeId) {
			return { nodeId: this.nodeId, previousNodeId, switched: false, conflict: true }
		}
		if (this.isolation === 'per-tab') {
			// A per-tab node belongs to its tab; another user in this tab gets a fresh one.
			const fresh = generateUUIDv7()
			await registerLocalNode(this.adapter, fresh)
			await setLocalNodePrincipal(this.adapter, fresh, principal, 'fresh')
			savePerTabNodeId(this.dbName, fresh)
			this.releaseNodeLock?.()
			this.releaseNodeLock = acquireNodeLock(nodeLockName(this.dbName, fresh))
			await this.rebindToNode(fresh)
			return { nodeId: fresh, previousNodeId, switched: true, conflict: false }
		}
		const own = nodes
			.filter((node) => node.principal === principal && !node.held)
			.sort((a, b) => b.createdAt - a.createdAt)[0]
		if (own) {
			await this.switchNodeId(own.nodeId)
			return { nodeId: own.nodeId, previousNodeId, switched: true, conflict: false }
		}
		const fresh = generateUUIDv7()
		await this.adapter.transaction((tx) => moveDatabaseNodeId(tx, fresh))
		await registerLocalNode(this.adapter, fresh)
		await setLocalNodePrincipal(this.adapter, fresh, principal, 'fresh')
		await this.rebindToNode(fresh)
		return { nodeId: fresh, previousNodeId, switched: true, conflict: false }
	}

	/**
	 * A sync handshake as `nodeId` was accepted for `principal` (RT-50): bind an unbound
	 * node (or replace a guessed binding) from the server's answer.
	 */
	async confirmNodePrincipal(nodeId: string, principal: string): Promise<void> {
		this.ensureOpen()
		await confirmLocalNodePrincipal(this.adapter, nodeId, principal)
	}

	/**
	 * The sync server refused `nodeId` for `principal` (RT-50): clear a guessed binding,
	 * and remember that an unbound node is not theirs.
	 */
	async recordNodeRefusedFor(nodeId: string, principal: string): Promise<void> {
		this.ensureOpen()
		await recordLocalNodeRefusedFor(this.adapter, nodeId, principal)
	}

	/**
	 * Assign a held, unbound local node's writes to `principal` (RT-50): an explicit app
	 * decision for writes nobody can attribute (a database that never synced).
	 *
	 * @returns false when the node is unknown, the store's own, already bound, or was
	 *   refused for `principal` by the server
	 */
	async assignNodePrincipal(nodeId: string, principal: string): Promise<boolean> {
		this.ensureOpen()
		if (nodeId === this.nodeId) return false
		return assignLocalNodePrincipal(this.adapter, nodeId, principal)
	}

	/**
	 * Forget a local node other than the store's own whatever it still holds (RT-50: the
	 * app discarded its held writes, which were marked never to upload first).
	 */
	async dropLocalNode(nodeId: string): Promise<void> {
		this.ensureOpen()
		if (nodeId === this.nodeId) return
		await dropLocalNode(this.adapter, nodeId)
	}

	/** The adoption schedule of this database's local nodes (RT-46). */
	async loadAdoptionSchedule(): Promise<AdoptionSchedule> {
		this.ensureOpen()
		return loadAdoptionSchedule(this.adapter)
	}

	/** Persist the adoption schedule (RT-46). */
	async saveAdoptionSchedule(schedule: AdoptionSchedule): Promise<void> {
		this.ensureOpen()
		await saveAdoptionSchedule(this.adapter, schedule)
	}

	/**
	 * Raise a local node's sequence counter to at least `floor`, in a transaction (the
	 * same MAX every reservation uses, W6), so the next write never reuses a number the
	 * server already holds (RT-35: the device lost the tail of its log, for example on a
	 * reload inside the IndexedDB snapshot window or after restoring an older copy).
	 *
	 * @returns Whether the counter moved
	 */
	async raiseSequenceFloor(nodeId: string, floor: number): Promise<boolean> {
		this.ensureOpen()
		let raised = false
		await this.adapter.transaction(async (tx) => {
			const rows = await tx.query<VersionVectorRow>(
				'SELECT sequence_number FROM _kora_version_vector WHERE node_id = ?',
				[nodeId],
			)
			const current = rows[0]?.sequence_number ?? 0
			if (floor <= current) return
			await tx.execute(
				`INSERT INTO _kora_version_vector (node_id, sequence_number) VALUES (?, ?)
     ON CONFLICT(node_id) DO UPDATE SET sequence_number = MAX(sequence_number, excluded.sequence_number)`,
				[nodeId, floor],
			)
			raised = true
		})
		if (raised) {
			const previous = this.versionVector.get(nodeId) ?? 0
			this.versionVector.set(nodeId, Math.max(previous, floor))
			if (nodeId === this.nodeId) this.sequenceNumber = Math.max(this.sequenceNumber, floor)
		}
		return raised
	}

	/**
	 * Give one of a local node's operations a fresh sequence number above `floor`
	 * (RT-35): the server refused it with `SEQUENCE_CONFLICT` because it holds another
	 * operation of this node under that number (one this device lost). A version-1
	 * operation keeps its id (its hash does not cover the sequence number), exactly like
	 * the W6 sequence repair; a version-2 operation (protocol v2) is re-hashed under the
	 * new number, so it carries a new id. The old identity is recorded in
	 * `_kora_seq_conflicts` (`reemitted_as`).
	 *
	 * A new id would leave later operations naming the old one in `causalDeps`: those in
	 * `rewritableDependents` (operations the server never stored: never sent) are
	 * rewritten to name the new id, and re-hashed, transitively, in the same
	 * transaction. Dependents already sent keep their ids (the server may hold them);
	 * their dep resolves through the `_kora_seq_conflicts` record. Every touched record
	 * is re-folded (fold stamps carry operation ids).
	 *
	 * @param rewritableDependents - Ids of this node's operations that were never sent
	 * @returns The renumbered operation and the rewritten dependents, or null when the
	 *   operation is not in the log
	 */
	async resequenceOperation(
		operationId: string,
		nodeId: string,
		floor: number,
		rewritableDependents: readonly string[] = [],
	): Promise<ResequenceResult | null> {
		this.ensureOpen()
		const found: { result: ResequenceResult | null } = { result: null }
		const collections = Object.keys(this.schema.collections)
		await this.adapter.transaction(async (tx) => {
			for (const collection of collections) {
				const table = quoteIdent(`_kora_ops_${collection}`)
				const rows = await tx.query<OperationRow>(
					`SELECT * FROM ${table} WHERE id = ? AND node_id = ?`,
					[operationId, nodeId],
				)
				const row = rows[0]
				if (!row) continue
				await tx.execute(
					`INSERT INTO _kora_version_vector (node_id, sequence_number) VALUES (?, ?)
     ON CONFLICT(node_id) DO UPDATE SET sequence_number = MAX(sequence_number, excluded.sequence_number)`,
					[nodeId, floor],
				)
				const sequence = await allocateNextSequenceInTransaction(tx, nodeId)
				// A version-2 id covers the sequence number (CORE-1): such an operation is
				// re-hashed under the new number (the server never stored it).
				const moved = await renumberOperationRow(tx, collection, row, sequence)
				await insertConflictRow(
					tx,
					collection,
					row,
					'server-sequence-conflict',
					moved.id,
					sequence,
					Date.now(),
				)
				const idMapping: Record<string, string> = moved.id !== row.id ? { [row.id]: moved.id } : {}
				const rewritable = new Set(rewritableDependents)
				rewritable.delete(row.id)
				const dependents =
					moved.id !== row.id
						? await rewriteDependentsInTx(tx, collections, nodeId, idMapping, rewritable)
						: []
				found.result = { operation: moved, dependents, idMapping }
				return
			}
		})
		const result = found.result
		if (!result) return null
		this.recordOperationSequence(result.operation)
		if (Object.keys(result.idMapping).length > 0) {
			await this.refoldRecordsOf([result.operation.id, ...result.dependents.map((op) => op.id)])
		}
		return result
	}

	/**
	 * Durability barrier (RT-35): resolves once every write committed so far is durable
	 * on this device. Sync awaits it before an operation leaves the device.
	 */
	async ensureDurable(): Promise<void> {
		this.ensureOpen()
		await this.adapter.ensureDurable?.()
	}

	/** Record operations the server refused for good (RT-36). Never cleared. */
	async recordTerminalRejections(entries: TerminalRejection[]): Promise<void> {
		this.ensureOpen()
		await recordTerminalRejections(this.adapter, entries)
		// The server never stored these operations: re-fold their records without them,
		// so this device converges to the server's state (W7 step 2).
		await this.refoldRecordsOf(entries.map((entry) => entry.operationId))
	}

	/** Which of these operation ids the server refused for good (RT-36). */
	async findTerminalRejections(operationIds: string[]): Promise<Set<string>> {
		this.ensureOpen()
		return findTerminalRejections(this.adapter, operationIds)
	}

	/** Every node id this database authored operations under (RT-38, RT-40). */
	async listLocalNodes(): Promise<LocalNodeRecord[]> {
		this.ensureOpen()
		return listLocalNodes(this.adapter)
	}

	/** Forget a drained local node other than this store's own (RT-40). */
	async forgetLocalNode(nodeId: string): Promise<void> {
		this.ensureOpen()
		if (nodeId === this.nodeId) return
		await forgetLocalNode(this.adapter, nodeId)
	}

	/** The current refusal cycle: the count of accepted sync handshakes (RT-38). */
	async loadAcceptedCycle(): Promise<number> {
		this.ensureOpen()
		return loadAcceptedCycle(this.adapter)
	}

	/** Record an accepted sync handshake as `nodeId` (RT-38). */
	async markLocalNodeAccepted(nodeId: string): Promise<void> {
		this.ensureOpen()
		await markLocalNodeAccepted(this.adapter, nodeId)
	}

	/** Record that the sync server refused `nodeId`; `held` holds its writes (RT-38). */
	async markLocalNodeRefused(nodeId: string, held: boolean): Promise<void> {
		this.ensureOpen()
		await markLocalNodeRefused(this.adapter, nodeId, held)
	}

	/**
	 * Take over another local node's unsynced writes (RT-40): resolves to a release
	 * function when no live tab uses `nodeId` (its lock is free), or null when one does.
	 * Without Web Locks (Node, old browsers) the node is assumed free.
	 */
	async claimLocalNode(nodeId: string): Promise<(() => void) | null> {
		this.ensureOpen()
		if (nodeId === this.nodeId) return null
		return tryAcquireNodeLock(nodeLockName(this.dbName, nodeId))
	}

	/** Whether a live tab holds `nodeId` (per-tab isolation, RT-40). */
	async isLocalNodeLive(nodeId: string): Promise<boolean> {
		this.ensureOpen()
		if (nodeId === this.nodeId) return true
		return isNodeLockHeld(nodeLockName(this.dbName, nodeId))
	}

	async rebaseUnsyncedOperations(
		unsyncedOpIds: string[],
		correctedNowMs: number,
	): Promise<ClockRebaseResult> {
		this.ensureOpen()
		const result = await rebaseUnsyncedOperationsInLog(
			this.adapter,
			this.schema,
			unsyncedOpIds,
			correctedNowMs,
		)
		if (result.newMaxTimestamp && this.clock) {
			this.clock.advanceTo(result.newMaxTimestamp)
		}
		// Re-stamped operations order differently: re-fold their records.
		await this.refoldRecordsOf(result.operations.map((op) => op.id))
		return result
	}

	/**
	 * Count of local operations ahead of the server version vector.
	 */
	async countUnsyncedOperations(serverVector: VersionVector): Promise<number> {
		const ops = await this.getUnsyncedOperations(serverVector)
		return ops.length
	}

	/**
	 * Compact the local operation log. Only removes ops the server has acknowledged
	 * (per {@link CompactionStrategy}). With the W7 fold (STORE-14), the effect of the
	 * removed operations is first joined into each record's base fold state, so a
	 * re-fold (rejection exclusion, a later re-materialization) and the merge of a
	 * late operation stay exact; delete, atomic and custom-resolver operations are
	 * kept, and a re-delivered compacted id is a duplicate by its node's compacted
	 * prefix.
	 */
	async compact(strategy: CompactionStrategy): Promise<CompactionResult> {
		this.ensureOpen()
		const fold = this.activeFold()
		if (strategy.mode === 'never') {
			return compactOperationLog(this.adapter, this.schema, strategy, createVersionVector())
		}

		const serverVector = strategy.serverVector ?? (await loadLastAckedServerVector(this.adapter))
		if (fold) {
			return compactFoldedLog(this.adapter, this.schema, fold, strategy, serverVector)
		}
		return compactOperationLog(this.adapter, this.schema, strategy, serverVector)
	}

	/**
	 * Merge session remote vector with persisted last-acked vector (max per node).
	 */
	mergeServerVectors(sessionVector: VersionVector, persistedVector: VersionVector): VersionVector {
		return mergeVersionVectors(persistedVector, sessionVector)
	}

	async getLatestLocalOperationForRecord(
		collection: string,
		recordId: string,
	): Promise<Operation | null> {
		this.ensureOpen()
		const rows = await this.adapter.query<OperationRow>(
			`SELECT * FROM ${quoteIdent(`_kora_ops_${collection}`)} WHERE node_id = ? AND record_id = ? ORDER BY sequence_number DESC LIMIT 1`,
			[this.nodeId, recordId],
		)
		const row = rows[0]
		if (!row) {
			return null
		}
		return deserializeOperationWithCollection(row, collection)
	}

	/**
	 * Latest operation for a record from any node (for 3-way merge when local op log is empty).
	 */
	async getLatestOperationForRecord(
		collection: string,
		recordId: string,
	): Promise<Operation | null> {
		this.ensureOpen()
		const rows = await this.adapter.query<OperationRow>(
			`SELECT * FROM ${quoteIdent(`_kora_ops_${collection}`)} WHERE record_id = ?`,
			[recordId],
		)

		let latest: Operation | null = null
		for (const row of rows) {
			const op = deserializeOperationWithCollection(row, collection)
			if (!latest || HybridLogicalClock.compare(op.timestamp, latest.timestamp) > 0) {
				latest = op
			}
		}
		return latest
	}

	/**
	 * All operations for a record, sorted in HLC total order (wallTime, logical,
	 * nodeId). Used by the apply pipeline to materialize atomic-op fields by folding
	 * the record's log, matching the server's materialization exactly.
	 */
	async getOperationsForRecord(collection: string, recordId: string): Promise<Operation[]> {
		this.ensureOpen()
		const rows = [
			...(await this.adapter.query<OperationRow>(
				`SELECT * FROM ${quoteIdent(`_kora_ops_${collection}`)} WHERE record_id = ?`,
				[recordId],
			)),
			// Other nodes' operations kept only in the sequence-conflicts table still
			// belong to the record's history.
			...(await loadRetainedConflictRows(
				(sql, params) => this.adapter.query(sql, params),
				collection,
				recordId,
			)),
		]
		const ops = rows.map((row) => deserializeOperationWithCollection(row, collection))
		ops.sort((a, b) => HybridLogicalClock.compare(a.timestamp, b.timestamp))
		return ops
	}

	/** Expose the subscription manager for direct access (e.g., by QueryBuilder) */
	getSubscriptionManager(): SubscriptionManager {
		return this.subscriptionManager
	}

	/**
	 * Get the sequence manager for offline-safe sequence generation.
	 * @throws {StoreNotOpenError} If the store is not open
	 */
	getSequenceManager(): SequenceManager {
		this.ensureOpen()
		if (!this.sequenceManager) {
			throw new StoreNotOpenError()
		}
		return this.sequenceManager
	}

	/**
	 * Create a TransactionContext for atomic multi-collection operations.
	 * The returned context buffers all mutations and commits them atomically.
	 *
	 * After commit, the caller is responsible for notifying subscriptions
	 * and emitting events for each operation.
	 */
	createTransaction(): TransactionContext {
		this.ensureOpen()
		if (!this.clock) {
			throw new StoreNotOpenError()
		}
		const beforeLocalDelete = this.localMutationHandler?.beforeLocalDelete
		const fold = this.activeFold()
		return new TransactionContext({
			...(this.maxOperationBytes !== undefined
				? { maxOperationBytes: this.maxOperationBytes }
				: {}),
			assertLocalWriteAllowed: () => this.assertLocalWriteAllowed(),
			...(fold ? { fold } : {}),
			schema: this.schema,
			adapter: this.adapter,
			clock: this.clock,
			nodeId: this.nodeId,
			relationEnforcer: this.relationEnforcer,
			causalTracker: this.causalTracker,
			...(this.secretKeyProvider ? { secretKeyProvider: this.secretKeyProvider } : {}),
			...(beforeLocalDelete
				? { beforeLocalDelete: beforeLocalDelete.bind(this.localMutationHandler) }
				: {}),
			onStorageError: (error) => this.reportStorageError(error),
		})
	}

	/**
	 * Execute a function within a transaction. All mutations performed on the
	 * TransactionContext are committed atomically. Subscription notifications
	 * are batched and fired after the commit.
	 *
	 * If the function throws, the transaction is rolled back and the error is re-thrown.
	 *
	 * @param fn - Function receiving a TransactionContext for buffered operations
	 * @returns The operations that were committed
	 */
	async transaction(fn: (tx: TransactionContext) => Promise<void>): Promise<Operation[]> {
		const tx = this.createTransaction()
		try {
			await fn(tx)
		} catch (error) {
			tx.rollback()
			throw error
		}
		const { operations } = await tx.commit()

		// Notify subscriptions and emit events after commit
		for (const op of operations) {
			this.publishLocalOperation(op.collection, op)
		}

		return operations
	}

	/**
	 * Export all data as a portable backup binary.
	 * Includes operations, version vector, metadata, and optionally materialized records.
	 *
	 * @param options - Backup options (includeRecords, collections, onProgress)
	 * @returns Backup as a Uint8Array
	 */
	async exportBackup(options?: BackupOptions): Promise<Uint8Array> {
		this.ensureOpen()
		const { exportBackup: doExport } = await import('../backup/backup')
		return doExport(this.adapter, this.schema, this.nodeId, this.schema.version, options)
	}

	/**
	 * Restore data from a backup binary (format version 2, STORE-5).
	 *
	 * - `merge: true`: every backup operation is applied through the remote-apply path
	 *   (deduplicated by id, merged per field), the version vector advances by MAX, and
	 *   nothing of the exporting device's identity or sync state is imported.
	 * - Replace (default): the data is replaced by the backup's while this device keeps
	 *   its node id, local nodes and principal bindings, its own sequence counters never
	 *   move backwards, and unsynced own writes are kept (see
	 *   `RestoreOptions.keepUnsyncedWrites`). Then {@link reloadFromDisk} runs.
	 *
	 * A version-1 file (Kora 1.0.0-beta.12 and earlier) is converted first, exactly as
	 * `convertBackupV1` does (`result.convertedFromVersion: 1`); one holding an operation
	 * whose timestamp cannot be recovered is refused (`BACKUP_OPERATION_INVALID`).
	 *
	 * @param data - The backup data
	 * @param options - Restore options (merge, collections, keepUnsyncedWrites, onProgress)
	 * @param internal - `applyOperation`: the app's remote-apply path (defaults to
	 *   {@link applyRemoteOperation}); `createApp` passes the merge-aware pipeline sync uses
	 * @returns Result of the restore operation
	 */
	async importBackup(
		data: Uint8Array,
		options?: RestoreOptions,
		internal?: { applyOperation?: (operation: Operation) => Promise<ApplyResult> },
	): Promise<RestoreResult> {
		this.ensureOpen()
		const started = Date.now()
		const onProgress = options?.onProgress ?? (() => {})
		const { BackupFormatError, convertBackupV1, parseBackup, readBackupManifest } = await import(
			'../backup/backup'
		)
		const { restoreMerge, restoreReplace } = await import('../backup/restore')
		onProgress({ phase: 'verifying', progress: 0, message: 'Verifying backup' })
		let parsed: Awaited<ReturnType<typeof parseBackup>>
		let convertedFromVersion: 1 | undefined
		try {
			// A version-1 file (beta.12 and earlier) is converted here, with the same
			// deterministic rules as convertBackupV1 (F3): the exporting device's identity is
			// dropped and damaged timestamps are recovered. An operation that cannot be
			// recovered still refuses the file; dropping it stays an explicit choice.
			let bytes = data
			if (readBackupManifest(data).version === 1) {
				bytes = await convertBackupV1(data)
				convertedFromVersion = 1
			}
			parsed = await parseBackup(
				bytes,
				options?.collections ? { collections: options.collections } : undefined,
			)
		} catch (error) {
			if (!(error instanceof BackupFormatError)) throw error
			return {
				operationsRestored: 0,
				recordsRestored: 0,
				success: false,
				error: error.message,
				errorCode: error.code,
				duration: Date.now() - started,
			}
		}
		if (parsed.manifest.schemaVersion > this.schema.version) {
			return {
				operationsRestored: 0,
				recordsRestored: 0,
				success: false,
				error: `The backup was written by schema version ${parsed.manifest.schemaVersion}; this app runs version ${this.schema.version}. Update the app before restoring it.`,
				errorCode: 'BACKUP_SCHEMA_NEWER',
				duration: Date.now() - started,
			}
		}
		onProgress({ phase: 'restoring', progress: 0.3, message: 'Restoring' })
		const explicitAuthorities = new Set((await loadAuthoritativeNodeIds(this.adapter)) ?? [])
		const host = {
			adapter: this.adapter,
			schema: this.schema,
			applyOperation:
				internal?.applyOperation ?? ((op: Operation) => this.applyRemoteOperation(op)),
			listLocalNodes: () => listLocalNodes(this.adapter),
			isServerAuthority: (nodeId: string) =>
				isReservedNodeId(nodeId) || explicitAuthorities.has(nodeId),
		}
		if (options?.merge) await this.mergeBackupFoldState(parsed, options.collections !== undefined)
		const counts = options?.merge
			? await restoreMerge(host, parsed, options.collections !== undefined)
			: await restoreReplace(host, parsed, {
					collections: options?.collections ?? null,
					keepUnsyncedWrites: options?.keepUnsyncedWrites ?? true,
				})
		if (!options?.merge && this.folder) {
			// Restored rows and log replace what the fold states described: rebuild them,
			// from the backup's base states and log (RT-66). A file from an earlier
			// release carries no base states, and its log may have been compacted: its
			// records are rebuilt on top of its rows instead (row snapshots).
			await this.adapter.execute('DELETE FROM _kora_meta WHERE key = ?', [
				FOLD_MATERIALIZATION_META_KEY,
			])
			this.foldActive = false
			await this.ensureMaterialization(parsed.manifest.includesFoldState !== true)
		}
		await this.reloadFromDisk()
		onProgress({ phase: 'restoring', progress: 1, message: 'Done' })
		return {
			operationsRestored: counts.operationsRestored,
			recordsRestored: counts.recordsRestored,
			...(options?.merge ? {} : { unsyncedWritesKept: counts.unsyncedWritesKept }),
			...(counts.serverOperationsSkipped
				? { serverOperationsSkipped: counts.serverOperationsSkipped }
				: {}),
			...(convertedFromVersion ? { convertedFromVersion } : {}),
			success: true,
			duration: Date.now() - started,
		}
	}

	/**
	 * Merge mode (RT-66): join the backup's compacted base states and row snapshots
	 * into this database's, and re-fold those records, before the backup's operations
	 * are applied. The join is the fold's state-based merge, so the result equals
	 * folding both devices' histories together. Compacted prefixes advance by MAX
	 * (unfiltered restores only: the prefix is per node, across collections).
	 */
	private async mergeBackupFoldState(
		parsed: import('../backup/backup').ParsedBackup,
		filtered: boolean,
	): Promise<void> {
		const folder = this.activeFold()
		if (!folder) return
		const touched = new Map<string, Set<string>>()
		await this.adapter.transaction(async (tx) => {
			for (const [rows, kind] of [
				[parsed.foldBases, 'base'],
				[parsed.foldSnapshots, 'snapshot'],
			] as const) {
				for (const row of rows) {
					if (!this.schema.collections[row.collection]) continue
					let state: FoldState
					try {
						state = deserializeFoldState(row.state)
					} catch {
						continue
					}
					if (state.c !== row.collection || state.r !== row.recordId) continue
					if (kind === 'base') await folder.joinIntoBase(tx, state)
					else await folder.saveSnapshot(tx, state)
					const ids = touched.get(row.collection) ?? new Set<string>()
					ids.add(row.recordId)
					touched.set(row.collection, ids)
				}
			}
			if (!filtered) {
				for (const [nodeId, sequence] of parsed.compactedThrough) {
					await tx.execute(
						`INSERT INTO ${COMPACTED_THROUGH_TABLE} (node_id, sequence_number) VALUES (?, ?)
     ON CONFLICT(node_id) DO UPDATE SET sequence_number = MAX(sequence_number, excluded.sequence_number)`,
						[nodeId, sequence],
					)
				}
			}
			for (const [collection, ids] of touched) {
				for (const recordId of ids) await folder.refoldInTx(tx, collection, recordId)
			}
		})
		for (const [collection, ids] of touched)
			this.subscriptionManager.invalidate(collection, [...ids])
	}

	/**
	 * Re-read this store's state from the database after it changed underneath it (a
	 * backup restore): the node id, version vector and own sequence counter, the clock
	 * (advanced past every timestamp in the log), and a fresh causal tracker. Every live
	 * query re-runs. The local node registry and terminal rejections are always read
	 * from the database, so they need no reload.
	 */
	async reloadFromDisk(): Promise<void> {
		this.ensureOpen()
		let nodeId = this.nodeId
		if (!this.configNodeId && this.isolation !== 'per-tab') {
			const rows = await this.adapter.query<MetaRow>(
				"SELECT value FROM _kora_meta WHERE key = 'node_id'",
			)
			nodeId = rows[0]?.value ?? this.nodeId
		}
		await this.rebindToNode(nodeId)
		const newest = await this.loadNewestLogTimestamp()
		if (newest && this.clock) {
			this.clock.advanceTo({ ...newest, nodeId: this.nodeId })
		}
		for (const collection of Object.keys(this.schema.collections)) {
			this.subscriptionManager.invalidate(collection)
		}
	}

	/** The greatest HLC timestamp in the operation log (canonical strings sort by HLC). */
	private async loadNewestLogTimestamp(): Promise<HLCTimestamp | null> {
		let newest: string | null = null
		for (const collection of Object.keys(this.schema.collections)) {
			const rows = await this.adapter.query<{ t: string | null }>(
				`SELECT MAX(timestamp) AS t FROM ${quoteIdent(`_kora_ops_${collection}`)}`,
			)
			const value = rows[0]?.t ?? null
			if (value !== null && (newest === null || value > newest)) newest = value
		}
		return newest === null ? null : HybridLogicalClock.deserialize(newest)
	}

	/**
	 * Read backup manifest without loading the entire backup.
	 *
	 * @param data - The raw backup data
	 * @returns The backup manifest
	 */
	static readBackupManifest(data: Uint8Array): BackupManifest {
		return readManifest(data)
	}

	private recordOperationSequence(operation: Operation): void {
		const prev = this.versionVector.get(operation.nodeId) ?? 0
		if (operation.sequenceNumber > prev) {
			this.versionVector.set(operation.nodeId, operation.sequenceNumber)
		}
		if (operation.nodeId === this.nodeId) {
			this.sequenceNumber = Math.max(this.sequenceNumber, operation.sequenceNumber)
		}
	}

	/** Post-commit publication of a committed local operation. */
	private publishLocalOperation(collection: string, operation: Operation): void {
		this.recordOperationSequence(operation)
		this.subscriptionManager.notify(collection, operation)
		this.emitter?.emit({ type: 'operation:created', operation })
	}

	/**
	 * Map an out-of-space storage failure to `store:quota-exceeded` (STORE-15).
	 * The error itself still propagates to the caller; this only makes the
	 * condition observable on every adapter, not just IndexedDB.
	 */
	private reportStorageError(error: unknown): void {
		if (!isStorageFullError(error)) return
		this.emitter?.emit({
			type: 'store:quota-exceeded',
			dbName: this.dbName,
			message: error instanceof Error ? error.message : String(error),
		})
	}

	/** Report a database a newer build migrated (`store:schema-ahead`) and build the error. */
	private schemaAhead(storedVersion: number): SchemaVersionAheadError {
		const error = new SchemaVersionAheadError(this.dbName, storedVersion, this.schema.version)
		this.emitter?.emit({
			type: 'store:schema-ahead',
			dbName: this.dbName,
			storedVersion,
			codeVersion: this.schema.version,
			message: error.message,
		})
		return error
	}

	/**
	 * Run pending schema migrations (STORE-13, NEW-STORE-1): one transaction per version
	 * (DDL, backfills, `schema_version`); backfills write operations through the local
	 * write path so they sync, unless declared `localOnly`.
	 */
	private async runMigrationsIfNeeded(): Promise<void> {
		const clock = this.clock
		if (!clock) throw new StoreNotOpenError()
		const fold = this.activeFold()
		await runSchemaMigrations({
			adapter: this.adapter,
			schema: this.schema,
			env: {
				...(fold ? { fold } : {}),
				schema: this.schema,
				clock,
				nodeId: this.nodeId,
				relationEnforcer: null,
				...(this.secretKeyProvider ? { secretKeyProvider: this.secretKeyProvider } : {}),
			},
			causalTracker: this.causalTracker,
			onOperation: (operation) => this.publishLocalOperation(operation.collection, operation),
		})
	}

	/** The node id the database persisted before this open, if any. */
	private async readPersistedNodeId(): Promise<string | null> {
		const rows = await this.adapter.query<MetaRow>(
			"SELECT value FROM _kora_meta WHERE key = 'node_id'",
		)
		return rows[0]?.value ?? null
	}

	/**
	 * Register node ids this database authored under that the registry does not know
	 * yet: the node id a pinned `nodeId` (the auth device id) just replaced, and the
	 * authors of queued operations. A beta.12 database had no registry, and a template
	 * app created before its user signed in authored under a random node; once the
	 * store is pinned to the device id, that node's queued writes would otherwise sit in
	 * the queue forever, neither uploaded nor reported. Registered, they are adopted or
	 * held (`status.heldNodes`) like any other local node's writes. Only the outbound
	 * queue is read: received operations never enter it.
	 */
	private async registerUnregisteredAuthors(persistedNodeId: string | null): Promise<void> {
		const authors = new Set<string>()
		if (persistedNodeId !== null && persistedNodeId !== this.nodeId) authors.add(persistedNodeId)
		const queued = await this.adapter.query<{ payload: string }>(
			'SELECT payload FROM _kora_sync_queue',
		)
		for (const row of queued) {
			try {
				const nodeId = (JSON.parse(row.payload) as { node_id?: unknown }).node_id
				if (typeof nodeId === 'string' && nodeId.length > 0) authors.add(nodeId)
			} catch {
				// An unreadable queue row is surfaced by the queue's own load.
			}
		}
		authors.delete(this.nodeId)
		for (const nodeId of authors) {
			if (isReservedNodeId(nodeId)) continue
			await registerLocalNode(this.adapter, nodeId)
		}
	}

	private async loadOrGenerateNodeId(): Promise<string> {
		// The `kora:` namespace is Kora's own (server nodes `kora:server:<id>` are
		// authoritative by prefix, RT-61): a device never authors under such an id.
		if (this.configNodeId && isReservedNodeId(this.configNodeId)) {
			throw new ReservedNodeIdError(this.configNodeId, 'StoreConfig.nodeId')
		}
		if (this.configNodeId) {
			if (this.isolation !== 'per-tab') {
				await this.adapter.execute(
					"INSERT OR REPLACE INTO _kora_meta (key, value) VALUES ('node_id', ?)",
					[this.configNodeId],
				)
			}
			return this.configNodeId
		}

		if (this.isolation === 'per-tab') {
			return resolvePerTabNodeId(this.dbName)
		}

		// Try to load existing node ID
		const rows = await this.adapter.query<MetaRow>(
			"SELECT value FROM _kora_meta WHERE key = 'node_id'",
		)
		if (rows[0] && !isReservedNodeId(rows[0].value)) {
			return rows[0].value
		}

		// Generate a new node id (a UUIDv7, never in the reserved `kora:` namespace). A
		// persisted reserved id (written by something other than this client) is never
		// adopted: the database gets a fresh identity instead.
		const newNodeId = generateUUIDv7()
		await this.adapter.execute(
			"INSERT OR REPLACE INTO _kora_meta (key, value) VALUES ('node_id', ?)",
			[newNodeId],
		)
		return newNodeId
	}

	private async loadSequenceNumber(): Promise<number> {
		const rows = await this.adapter.query<VersionVectorRow>(
			'SELECT sequence_number FROM _kora_version_vector WHERE node_id = ?',
			[this.nodeId],
		)
		return rows[0]?.sequence_number ?? 0
	}

	private async loadVersionVector(): Promise<VersionVector> {
		const rows = await this.adapter.query<VersionVectorRow>(
			'SELECT node_id, sequence_number FROM _kora_version_vector',
		)
		const vector = createVersionVector()
		for (const row of rows) {
			vector.set(row.node_id, row.sequence_number)
		}
		return vector
	}

	private ensureOpen(): void {
		if (!this.opened) {
			throw new StoreNotOpenError()
		}
	}
}

/**
 * Public-facing collection accessor. Provides CRUD + where.
 */
export interface CollectionAccessor {
	insert(data: Record<string, unknown>): Promise<import('../types').CollectionRecord>
	findById(id: string): Promise<import('../types').CollectionRecord | null>
	update(id: string, data: Record<string, unknown>): Promise<import('../types').CollectionRecord>
	delete(id: string): Promise<void>
	where(conditions: Record<string, unknown>): QueryBuilder
}

/**
 * The newest HLC an operation carries: its timestamp, or for a scope-entry insert
 * (RT-27) the greatest of its timestamp and every per-field version.
 */
function newestFieldVersion(op: Operation): HLCTimestamp {
	let newest = op.timestamp
	for (const version of Object.values(op.fieldVersions ?? {})) {
		if (HybridLogicalClock.compare(version, newest) > 0) newest = version
	}
	return newest
}
