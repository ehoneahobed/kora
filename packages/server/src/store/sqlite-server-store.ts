import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import type {
	AtomicOp,
	FoldState,
	HLCTimestamp,
	Operation,
	OperationTransform,
	RecordFieldVersions,
	SchemaDefinition,
	VersionVector,
} from '@korajs/core'
import { KoraError, assertOperationTransformCoverage, quoteIdent } from '@korajs/core'
import {
	type SqliteQueryFn,
	groupKey,
	parseGroupKey,
	planSqliteConstraintRelaxation,
} from '@korajs/core/internal'
import type { ApplyResult } from '@korajs/sync'
import type { SQL } from 'drizzle-orm'
import { and, asc, between, count, eq, gt, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { AccessIndexReadiness } from '../access/access-index-readiness'
import {
	ACCESS_COLLECTIONS_EVER_KEY,
	ACCESS_FRONTIER_KEY,
	ACCESS_INDEX_GENERATION_KEY,
	ACCESS_INDEX_REBUILDING_PREFIX,
	type GroupRecordState,
	type IndexedRecord,
	MEMBERSHIP_INDEX_FINGERPRINT_KEY,
	type MembershipIndexChanges,
	type MembershipInterval,
	desiredMemberships,
	feedsMembershipIndex,
	groupCollectionOf,
	groupDeletionChanged,
	groupRecordState,
	hasMembershipChanges,
	intervalBelongsTo,
	membershipIndexFingerprint,
	mergeAccessCollectionsEver,
	newAccessIndexGeneration,
	opensFromStart,
	parseAccessCollectionsEver,
	parseMembershipIndexFingerprint,
	reconcileIndex,
	reconcileRecord,
	writeAffectsGroupMembers,
} from '../access/membership-index'
import { UplinkAuthorizationError } from '../scopes/server-scope-filter'
import { deliveryCounter, operations, syncState } from './drizzle-schema'
import {
	KEY_ID_SAMPLE_ROWS,
	envelopeColumn,
	envelopeKeyIds,
	parseEnvelopeColumn,
} from './envelope-column'
import { LEGACY_BODIES_META_KEY, provenLegacyClears } from './legacy-bodies'
import {
	SERVER_LOG_INTEGRITY_META_KEY,
	SERVER_LOG_QUARANTINE_DDL,
	type ServerLogIntegrityReport,
	type ServerOperationRow,
	checkServerOperationRow,
	quarantineRowJson,
} from './log-integrity'
import {
	deserializeFieldValue,
	generateAllCollectionDDL,
	serializeFieldValue,
	validateFieldName,
} from './materialization'
import {
	type KeptRow,
	type QuarantineScope,
	buildQuarantineScope,
	emptyQuarantineScope,
	isQuarantineAffected,
	quarantineKey,
	rebuildFromSnapshot,
} from './quarantine-base'
import {
	EMPTY_FOLD_SCHEMA,
	FOLD_MIGRATION_BATCH,
	FOLD_PLAN_FINGERPRINT_KEY,
	FoldMigrationProgress,
	type FoldMigrationReport,
	OutdatedRecordCursor,
	REFOLD_REQUIRED,
	type ServerFoldOptions,
	batchesByOperations,
	foldFieldVersions,
	foldedResult,
	foldedStoredRow,
	materializedFieldValue,
	mergeIntoFoldState,
	parseStoredFoldState,
	planStampOf,
	projectFoldState,
	refoldRecord,
	serializeServerFoldState,
	serverFoldOptions,
	serverFoldPlanFingerprint,
} from './record-fold'
import {
	SCOPE_SNAPSHOT_FINGERPRINT_KEY,
	SCOPE_SNAPSHOT_PENDING_KEY,
	parseScopeSnapshot,
	replayScopeSnapshots,
	scopeSnapshotFingerprint,
	scopeValuesOf,
} from './scope-snapshot'
import {
	type AuthorityHistory,
	type ConfiguredIdentity,
	SERVER_DEPLOYMENT_ID_KEY,
	SERVER_DERIVATION_SECRET_KEY,
	SERVER_EVER_AUTHORITY_KEY,
	SERVER_INSTANCE_ID_KEY,
	SERVER_LEGACY_AUTHORITY_KEY,
	SERVER_LEGACY_SCAN_KEY,
	SERVER_NODE_PREFIX,
	SERVER_REVOKED_AUTHORITY_KEY,
	type ServerIdentityOptions,
	authoritativeStampOpIds,
	deriveKeyedServerOpId,
	generateDeploymentId,
	generateDerivationSecret,
	normalizeLegacyAuthorities,
	parseIdentityOptions,
	parseLegacyAuthorities,
	resolveAuthorityHistory,
	serverNodeIdFor,
} from './server-identity'
import type {
	AccessIndexState,
	ApplyRemoteOptions,
	CollectionQueryOptions,
	DeliveredOperation,
	EncryptionKeyRecordRow,
	MaterializedRecord,
	OperationResolution,
	OperationResolutionOutcome,
	OperationScopeSnapshot,
	ResultingRecord,
	ServerSchemaOptions,
	ServerStore,
	StoreTransactionResult,
	StoreTransactionRun,
} from './server-store'
import {
	MAX_RESOLUTION_MESSAGE_LENGTH,
	NODE_SEQ_UNIQUE_INDEX,
	RELEASED_NODE_OWNER,
	SEQUENCE_ENFORCEMENT_EPOCH_KEY,
	SEQUENCE_PAIRS_BACKFILLED_KEY,
	SUPERSEDED_NODE_SEQ_UNIQUE_INDEXES,
	SequenceConflictError,
	type SequenceHolderVerdict,
	UnstorableValueError,
	judgeSequenceHolders,
	outsideDecision,
	reportLegacyPair,
} from './server-store'
import type { StoredOperationKey } from './server-store'
import {
	FULL_RESYNC_COUNTER_KEY,
	type FullResyncState,
	type FullResyncTarget,
	fullResyncDoneKey,
	fullResyncNodeKey,
	fullResyncUserKey,
	newestFullResyncToken,
} from './server-store'
import {
	PG_TEXT_CODEC_MIGRATION_KEY,
	deserializeSqliteFieldValue,
	encodePgText,
	isPgRawTextKind,
	serializeSqliteFieldValue,
	sqliteTextCodecMigrationSql,
} from './text-codec'
import { type StagedBlobOwner, WriteGate, stagingBlobOwners } from './write-gate'

/** Index every (node, sequence) the log holds more than once (RT-48). */
const BACKFILL_SEQUENCE_PAIRS_SQL = `INSERT OR IGNORE INTO sequence_pairs (node_id, sequence_number)
	SELECT node_id, sequence_number FROM operations
	GROUP BY node_id, sequence_number HAVING COUNT(*) > 1`

/**
 * Drop resolutions above their node's restored log, and every `stored-elsewhere`
 * resolution whose operation the restored log does not hold (RT-51; see importBackup).
 */
const PRUNE_RESOLUTIONS_PAST_LOG_SQL = `DELETE FROM operation_resolutions
	WHERE sequence_number > COALESCE(
		(SELECT max_sequence_number FROM sync_state WHERE sync_state.node_id = operation_resolutions.node_id),
		0)
	OR (outcome = 'stored-elsewhere'
		AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.id = operation_resolutions.op_id))`

interface ResolutionRow {
	op_id: string
	node_id: string
	sequence_number: number | string
	outcome: string
	code: string | null
	message: string | null
}

function resolutionFromRow(row: ResolutionRow): OperationResolution {
	return {
		operationId: row.op_id,
		nodeId: row.node_id,
		sequenceNumber: Number(row.sequence_number),
		outcome: row.outcome as OperationResolutionOutcome,
		code: row.code,
		message: row.message,
	}
}

// better-sqlite3 is a native CJS addon that cannot be loaded via ESM import().
// createRequire provides a CJS require() that works in both ESM and CJS contexts.
// tsup's shims option ensures import.meta.url is available in CJS builds.
const esmRequire = createRequire(import.meta.url)

/**
 * Connections a store opened itself ({@link createSqliteServerStore}), closed by its
 * `close()`. Module-private, so no caller can hand a store a connection to close; a store
 * built on a caller's connection is absent and leaves it to the caller.
 */
const OWNED_CONNECTIONS = new WeakMap<SqliteServerStore, () => void>()

/**
 * One running public call of a store (see `track`). The async context keeps it after the
 * call returns (a timer or promise the call left behind inherits it), so `running`, not
 * its presence, says whether the call is still in flight.
 */
interface StoreCallFrame {
	readonly store: object
	readonly parent: StoreCallFrame | null
	running: boolean
}

/** The store call the current async context was started inside (see `track`). */
const IN_STORE_CALL = new AsyncLocalStorage<StoreCallFrame>()

/**
 * SQLite result codes of values the database refuses (RT-87): an enum CHECK, a NOT NULL,
 * a value larger than SQLite's limits. Such an operation is refused terminally and per
 * operation (UNSTORABLE_VALUE), like the Postgres store's class-22/23 errors, so it can
 * never block the session. (The server's value-domain check refuses every such value
 * before it reaches a store; this is the safety net.)
 */
const SQLITE_UNSTORABLE_VALUE_CODES = new Set([
	'SQLITE_CONSTRAINT_CHECK',
	'SQLITE_CONSTRAINT_NOTNULL',
	'SQLITE_TOOBIG',
	'SQLITE_MISMATCH',
])

function sqliteUnstorableValueOr(error: unknown, op: Operation): unknown {
	const codeOf = (value: unknown): unknown =>
		value && typeof value === 'object' && 'code' in value
			? (value as { code: unknown }).code
			: undefined
	const code = codeOf(error) ?? (error instanceof Error ? codeOf(error.cause) : undefined)
	if (typeof code === 'string' && SQLITE_UNSTORABLE_VALUE_CODES.has(code)) {
		return new UnstorableValueError(
			op,
			`${code}: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	return error
}

/**
 * SQLite-backed server store using Drizzle ORM.
 * Persists operations and version vectors to a real database file,
 * surviving process restarts.
 *
 * When a schema is set via setSchema(), also maintains materialized
 * collection tables for efficient indexed queries (dual-write).
 */
/** How often a transaction is decided again when another connection keeps committing. */
const MAX_TRANSACTION_ATTEMPTS = 5

/**
 * A SQLite rebuild runs synchronously: its lease is renewed between batches, but a long
 * single transaction (a scope snapshot backfill, the index reconcile) cannot renew it.
 * The lease is long enough to cover those, at the price of a slower recovery when a
 * process sharing the file stops in the middle of a rebuild.
 */
const SQLITE_MARKER_LEASE_MS = 600_000

/** Thrown when another connection to the database file kept committing during every attempt. */
export class TransactionConflictError extends KoraError {
	constructor(attempts: number) {
		super(
			`Another connection to the SQLite database kept writing; the transaction was decided ${attempts} times without committing. Retry it, or run one server process per database file.`,
			'TRANSACTION_CONFLICT',
			{ attempts },
		)
		this.name = 'TransactionConflictError'
	}
}

export class SqliteServerStore implements ServerStore {
	private readonly nodeId: string
	private readonly db: BetterSQLite3Database
	/** Serializes operation writes behind a transaction in progress (`transact`). */
	private readonly writeGate = new WriteGate()
	private schema: SchemaDefinition | null = null
	private closed = false
	/** Public calls running now (see {@link track}); `close()` waits for them. */
	private inFlight = 0
	/**
	 * Marks the async context of this store's running calls. A token, not `this`: calls
	 * made through a transaction's view (a Proxy) see the view as `this`.
	 */
	private readonly callToken: object = {}
	/** Resolved by the last in-flight call to finish while `close()` waits. */
	private readonly drainWaiters: Array<() => void> = []
	/** See {@link SEQUENCE_ENFORCEMENT_EPOCH_KEY}; fixed per database at first start. */
	private sequenceEpoch = 0
	private logIntegrity: ServerLogIntegrityReport = {
		checkedRows: 0,
		quarantined: [],
		ran: false,
		totalQuarantined: 0,
	}
	/** Derivation secret of server-derived ids, shared by the deployment (RT-64). */
	private readonly derivationSecret: string
	/** Legacy and configured authorities (the `kora:server:` prefix needs no listing). */
	private readonly explicitAuthorities: string[]
	/** Where the sweep of outdated records goes on (see OutdatedRecordCursor). */
	private readonly outdatedCursor = new OutdatedRecordCursor()
	private planStampCache: {
		schema: SchemaDefinition
		transforms: readonly OperationTransform[]
		authorities: readonly string[]
		value: string
	} | null = null
	/** Explicit authority over time: revoked and ever-held ids (RT-81). */
	private readonly authorityHistory: AuthorityHistory
	/** Other `kora:server:` nodes with stored operations (advertised for older clients). */
	/** Records owning quarantined operations: folded onto their kept rows (RT-70). */
	private quarantine: QuarantineScope = emptyQuarantineScope()
	private foldOptions: ServerFoldOptions
	/** Schema transforms the fold applies (transforms at fold time, RT-84). */
	private operationTransforms: readonly OperationTransform[] = []
	private foldMigration: FoldMigrationReport = {
		ran: false,
		records: 0,
		skippedUnclean: 0,
		fullRefold: false,
	}

	/**
	 * @param db - The Drizzle database
	 * @param nodeId - Deprecated: a plain id is recorded as a legacy authoritative id; a
	 *   `kora:server:` id is used verbatim. Leave unset: the store authors under
	 *   `kora:server:<deployment>:<instance>`, both persisted in the database (RT-62).
	 * @param options - Extra authoritative ids and the instance id
	 */
	constructor(
		db: BetterSQLite3Database,
		nodeId?: string,
		options: Omit<ServerIdentityOptions, 'nodeId'> = {},
	) {
		this.db = db
		const configured = parseIdentityOptions({
			...(nodeId !== undefined ? { nodeId } : {}),
			...options,
		})
		this.ensureTables()
		const identity = this.loadIdentity(configured)
		this.nodeId = identity.nodeId
		this.derivationSecret = identity.secret
		this.explicitAuthorities = identity.history.explicitAuthorities
		this.authorityHistory = identity.history
		this.foldOptions = serverFoldOptions(this.explicitAuthorities, this.operationTransforms)
		for (const row of this.db.all<{ node_id: string }>(
			sql`SELECT node_id FROM sync_state WHERE node_id LIKE ${`${SERVER_NODE_PREFIX}%`}`,
		)) {
		}
	}

	/**
	 * This store's node id and the legacy and configured ids (explicit authorities).
	 * Other `kora:server:` instances are not listed: the prefix rule makes every one of
	 * them authoritative, and a list that grew by one instance id per start would make
	 * every device re-fold after each deploy (RT-75). Handshakes advertise only the
	 * explicit (non-prefixed) ids.
	 */
	getAuthoritativeNodeIds(): string[] {
		return [this.nodeId, ...this.explicitAuthorities]
	}

	/** Legacy and configured authorities (beside the `kora:server:` namespace). */
	getLegacyAuthoritativeNodeIds(): string[] {
		return [...this.explicitAuthorities]
	}

	/** Explicit authoritative ids the deployment revoked (RT-81), advertised at handshake. */
	getRevokedAuthoritativeNodeIds(): string[] {
		return [...this.authorityHistory.revoked]
	}

	/**
	 * Every explicit id the deployment ever held authoritative, revoked ones included
	 * (RT-81): never accepted as a device node id.
	 */
	getEverAuthoritativeNodeIds(): string[] {
		return [...this.authorityHistory.everAuthoritative]
	}

	async deriveServerOperationId(
		parentOpId: string,
		ruleId: string,
		targetRecordId: string,
	): Promise<string> {
		return deriveKeyedServerOpId(this.derivationSecret, parentOpId, ruleId, targetRecordId)
	}

	/** Remember another `kora:server:` node that authored stored operations. */

	/**
	 * Load (creating on first start) the persisted server identity: the deployment id,
	 * the derivation secret, this database's instance id and the legacy authoritative
	 * ids. At the first start of this release, every node id whose operations hold an
	 * authority class in a stored fold state (a server decision folded under an earlier,
	 * per-process server node id) is recorded as a legacy authority, before any re-fold
	 * could drop that class.
	 */
	private loadIdentity(configured: ConfiguredIdentity): {
		nodeId: string
		secret: string
		history: AuthorityHistory
	} {
		const meta = (tx: BetterSQLite3Database, key: string): string | undefined =>
			tx.all<{ value: string }>(sql`SELECT value FROM kora_server_meta WHERE key = ${key}`)[0]
				?.value
		const setOnce = (tx: BetterSQLite3Database, key: string, value: string): string => {
			tx.run(sql`INSERT OR IGNORE INTO kora_server_meta (key, value) VALUES (${key}, ${value})`)
			return meta(tx, key) ?? value
		}
		return this.db.transaction((tx) => {
			const deploymentId = setOnce(tx, SERVER_DEPLOYMENT_ID_KEY, generateDeploymentId())
			const secret = setOnce(tx, SERVER_DERIVATION_SECRET_KEY, generateDerivationSecret())
			// One SQLite database has one writer process, so one persisted instance id.
			const instanceId = configured.instanceId ?? setOnce(tx, SERVER_INSTANCE_ID_KEY, '1')
			const nodeId = configured.verbatimNodeId ?? serverNodeIdFor(deploymentId, instanceId)

			let legacy = parseLegacyAuthorities(meta(tx, SERVER_LEGACY_AUTHORITY_KEY))
			if (meta(tx, SERVER_LEGACY_SCAN_KEY) === undefined) {
				const stampOpIds = new Set<string>()
				for (const row of tx.all<{ state: string }>(sql`SELECT state FROM kora_fold_state`)) {
					for (const id of authoritativeStampOpIds(row.state)) stampOpIds.add(id)
				}
				const ids = [...stampOpIds]
				for (let i = 0; i < ids.length; i += 500) {
					const chunk = ids.slice(i, i + 500)
					const rows = tx.all<{ node_id: string }>(
						sql`SELECT DISTINCT node_id FROM operations WHERE id IN (${sql.join(
							chunk.map((id) => sql`${id}`),
							sql`, `,
						)})`,
					)
					legacy.push(...rows.map((row) => row.node_id))
				}
				tx.run(
					sql`INSERT OR REPLACE INTO kora_server_meta (key, value) VALUES (${SERVER_LEGACY_SCAN_KEY}, ${String(Date.now())})`,
				)
			}
			// A configured plain node id is the id this server authored under before (RT-62).
			if (configured.legacyNodeId !== null) legacy.push(configured.legacyNodeId)
			legacy = normalizeLegacyAuthorities(legacy.filter((id) => id !== nodeId))
			tx.run(
				sql`INSERT OR REPLACE INTO kora_server_meta (key, value) VALUES (${SERVER_LEGACY_AUTHORITY_KEY}, ${JSON.stringify(legacy)})`,
			)
			// Authority over time (RT-81): every explicit id ever held stays authoritative
			// until revoked, and reserved for good.
			const history = resolveAuthorityHistory({
				legacy,
				configured,
				persistedEver: parseLegacyAuthorities(meta(tx, SERVER_EVER_AUTHORITY_KEY)),
				persistedRevoked: parseLegacyAuthorities(meta(tx, SERVER_REVOKED_AUTHORITY_KEY)),
				ownNodeId: nodeId,
			})
			tx.run(
				sql`INSERT OR REPLACE INTO kora_server_meta (key, value) VALUES (${SERVER_EVER_AUTHORITY_KEY}, ${JSON.stringify(history.everAuthoritative)})`,
			)
			tx.run(
				sql`INSERT OR REPLACE INTO kora_server_meta (key, value) VALUES (${SERVER_REVOKED_AUTHORITY_KEY}, ${JSON.stringify(history.revoked)})`,
			)
			return { nodeId, secret, history }
		})
	}

	/** What the last startup re-materialization did (W7 step 7). */
	getFoldMigrationReport(): FoldMigrationReport {
		return { ...this.foldMigration }
	}

	getVersionVector(): VersionVector {
		this.assertOpen()
		const rows = this.db.select().from(syncState).all()
		const vv: VersionVector = new Map()
		for (const row of rows) {
			vv.set(row.nodeId, row.maxSequenceNumber)
		}
		return vv
	}

	getNodeId(): string {
		return this.nodeId
	}

	/** Whether the membership index may judge access rules (see AccessIndexReadiness). */
	/** Capability grants are checked inside the write's transaction (`liveGroupsOf`). */
	readonly reportsLiveGroups = true
	private readonly accessIndex = new AccessIndexReadiness(
		(keys) => this.renewMarkerLeases(keys),
		SQLITE_MARKER_LEASE_MS / 3,
	)

	/** See {@link ServerStore.isAccessIndexReady}. */
	isAccessIndexReady(): boolean {
		return this.accessIndex.isReady()
	}

	/** See {@link ServerStore.accessIndexGeneration}: refreshed by every index read. */
	accessIndexGeneration(): string | null {
		return this.accessIndex.generation()
	}

	getSchema(): SchemaDefinition | null {
		return this.schema
	}

	async setSchema(schema: SchemaDefinition, options: ServerSchemaOptions = {}): Promise<void> {
		return this.track(async () => {
			// Behind any transaction in progress, and with access rules out of force until the
			// index matches the new schema (for good if this fails after installing it).
			await this.writeGate.run(() =>
				this.accessIndex.hold((mutated) => this.installSchema(schema, options, mutated)),
			)
		})
	}

	private async installSchema(
		schema: SchemaDefinition,
		options: ServerSchemaOptions,
		mutated: () => void,
	): Promise<void> {
		this.assertOpen()
		// Refuse transforms that cannot read the stored log BEFORE anything changes (RT-103).
		this.assertTransformCoverage(
			schema.version,
			options.operationTransforms ?? this.operationTransforms,
		)
		this.schema = schema
		mutated()
		// A rebuild marker left by an interrupted rebuild: this one completes it.
		this.adoptRebuildingMarker()
		if (options.operationTransforms !== undefined) {
			this.operationTransforms = [...options.operationTransforms]
			this.foldOptions = serverFoldOptions(this.explicitAuthorities, this.operationTransforms)
		}

		// Generate and execute DDL for all collection tables
		const ddlStatements = generateAllCollectionDDL(schema, 'sqlite')
		for (const stmt of ddlStatements) {
			if (stmt.startsWith('--kora:safe-alter')) {
				const alterSql = stmt.replace('--kora:safe-alter\n', '')
				try {
					this.db.run(sql.raw(alterSql))
				} catch (e) {
					// Ignore "duplicate column" errors from safe ALTER TABLE.
					// Drizzle wraps SQLite errors, so check both outer message and cause.
					const msg = e instanceof Error ? e.message : ''
					const causeMsg = e instanceof Error && e.cause instanceof Error ? e.cause.message : ''
					if (!msg.includes('duplicate column') && !causeMsg.includes('duplicate column')) {
						throw e
					}
				}
			} else {
				this.db.run(sql.raw(stmt))
			}
		}

		// beta.12 tables carry enum CHECKs a schema upgrade cannot change: rebuild them
		// once without (RT-101); the value domain is enforced at ingest only.
		await this.relaxValueDomainConstraints(schema)
		this.migrateTextCodec(schema)

		// beta.12 clears stored by an earlier server, made explicit once (RT-85); their
		// records are re-folded by the re-materialization below.
		await this.canonicalizeLegacyBodies()
		// Re-materialize every record whose fold state is missing or stale (W7 step 7).
		this.foldMigration = this.rematerialize()
		// A change in the fields snapshots capture invalidates every snapshot: drop them
		// and rebuild from the log (RT-20). The fingerprint is written last, so a crash
		// mid-way only repeats the rebuild at the next start.
		// The drop is recorded (SCOPE_SNAPSHOT_PENDING_KEY) with it, so a restart resumes
		// the rebuild at the snapshots still missing instead of dropping them all again.
		const fingerprint = scopeSnapshotFingerprint(schema)
		const stored = this.db.all<{ value: string }>(
			sql`SELECT value FROM kora_server_meta WHERE key = ${SCOPE_SNAPSHOT_FINGERPRINT_KEY}`,
		)[0]?.value
		if (stored !== fingerprint) {
			this.db.transaction(
				(tx) => {
					const pending = tx.all<{ value: string }>(
						sql`SELECT value FROM kora_server_meta WHERE key = ${SCOPE_SNAPSHOT_PENDING_KEY}`,
					)[0]?.value
					if (pending === fingerprint) return
					tx.run(sql`UPDATE operations SET scope_snapshot = NULL`)
					tx.run(
						sql`INSERT OR REPLACE INTO kora_server_meta (key, value) VALUES (${SCOPE_SNAPSHOT_PENDING_KEY}, ${fingerprint})`,
					)
				},
				{ behavior: 'immediate' },
			)
		}
		this.backfillScopeSnapshots()
		if (stored !== fingerprint) {
			this.db.transaction((tx) => {
				tx.run(
					sql`INSERT OR REPLACE INTO kora_server_meta (key, value) VALUES (${SCOPE_SNAPSHOT_FINGERPRINT_KEY}, ${fingerprint})`,
				)
				tx.run(
					sql`DELETE FROM kora_server_meta WHERE key = ${SCOPE_SNAPSHOT_PENDING_KEY} AND value = ${fingerprint}`,
				)
			})
		}
		this.reconcileMembershipIndex()
	}

	/**
	 * A record of an indexed collection as stored now (deleted ones included), with its
	 * full values (the scope snapshot form drops strings over 512 characters).
	 */
	private readIndexedRecord(
		tx: BetterSQLite3Database,
		collection: string,
		recordId: string,
	): IndexedRecord {
		const collectionDef = this.schema?.collections[collection]
		const row = collectionDef
			? tx.all<Record<string, unknown>>(
					sql`SELECT * FROM ${sql.raw(quoteIdent(collection))} WHERE id = ${recordId} LIMIT 1`,
				)[0]
			: undefined
		if (!row || !collectionDef) return { collection, recordId, values: null, deleted: false }
		return {
			collection,
			recordId,
			values: { ...this.deserializeRow(row, collectionDef), id: recordId },
			deleted: Number(row._deleted) === 1,
		}
	}

	/** Open intervals, optionally only those of one record. */
	private readOpenIntervals(tx: BetterSQLite3Database): MembershipInterval[] {
		return this.readIntervals(
			tx,
			sql`SELECT user_id, group_key, source, record_id, role, expires_at, joined_seq, role_seq, left_seq
				FROM _kora_access_memberships WHERE left_seq IS NULL ORDER BY id`,
		)
	}

	private readIntervals(tx: BetterSQLite3Database, query: SQL): MembershipInterval[] {
		const rows = tx.all<{
			user_id: string
			group_key: string
			source: string
			record_id: string
			role: string
			expires_at: number | null
			joined_seq: number
			role_seq: number | null
			left_seq: number | null
		}>(query)
		return rows.map((row) => ({
			userId: row.user_id,
			group: row.group_key,
			source: row.source === 'owner' ? 'owner' : 'membership',
			recordId: row.record_id,
			role: row.role,
			expiresAt: row.expires_at === null ? null : Number(row.expires_at),
			joinedSeq: Number(row.joined_seq),
			roleSeq: Number(row.role_seq ?? row.joined_seq),
			leftSeq: row.left_seq === null ? null : Number(row.left_seq),
		}))
	}

	/**
	 * Reconcile one record's intervals with what it holds now, inside the write's
	 * transaction, at the write's delivery sequence.
	 */
	private reconcileRecordMemberships(
		tx: BetterSQLite3Database,
		collection: string,
		recordId: string,
		deliverySeq: number,
		groupBefore: GroupRecordState | null = null,
	): void {
		const access = this.schema?.access
		// Only this record's open intervals (indexed lookups, not a scan of the index).
		const open = this.readIntervals(
			tx,
			sql`SELECT user_id, group_key, source, record_id, role, expires_at, joined_seq, role_seq, left_seq
				FROM _kora_access_memberships
				WHERE left_seq IS NULL AND (
					(source = 'membership' AND record_id = ${recordId})
					OR (source = 'owner' AND group_key = ${groupKey(collection, recordId)})
				)
				ORDER BY id`,
		).filter((interval) => intervalBelongsTo(access, interval, collection, recordId))
		const record = this.readIndexedRecord(tx, collection, recordId)
		const desired = desiredMemberships(access, record, (group) =>
			this.groupRecordDeleted(tx, group),
		)
		this.applyMembershipChanges(tx, reconcileRecord(open, desired), deliverySeq)
		// A group record deleted or revived: its members' rows hold nothing or hold again.
		if (
			access?.memberships &&
			groupBefore !== null &&
			groupDeletionChanged(groupBefore, groupRecordState(record))
		) {
			const rows = tx.all<{ id: string }>(
				sql`SELECT id FROM ${sql.raw(quoteIdent(access.memberships))} WHERE ${sql.raw(quoteIdent('group'))} = ${groupKey(collection, recordId)}`,
			)
			for (const row of rows) {
				this.reconcileRecordMemberships(tx, access.memberships, row.id, deliverySeq)
			}
		}
	}

	/** True when `group` names a record of a group collection that is deleted. */
	private groupRecordDeleted(tx: BetterSQLite3Database, group: string): boolean {
		const access = this.schema?.access
		if (!access) return false
		const collection = groupCollectionOf(access, group)
		if (collection === null) return false
		const parsed = parseGroupKey(group)
		return parsed !== null && this.readIndexedRecord(tx, collection, parsed.id).deleted
	}

	/** Write index changes at `atSeq` (closes, in-place updates, opens). */
	private applyMembershipChanges(
		tx: BetterSQLite3Database,
		changes: MembershipIndexChanges,
		atSeq: number,
	): void {
		for (const key of changes.close) {
			tx.run(
				sql`UPDATE _kora_access_memberships SET left_seq = ${atSeq}
					WHERE user_id = ${key.userId} AND group_key = ${key.group} AND source = ${key.source}
					AND record_id = ${key.recordId} AND left_seq IS NULL`,
			)
		}
		for (const want of changes.update) {
			tx.run(
				sql`UPDATE _kora_access_memberships SET role = ${want.role}, expires_at = ${want.expiresAt}, role_seq = ${atSeq}
					WHERE user_id = ${want.userId} AND group_key = ${want.group} AND source = ${want.source}
					AND record_id = ${want.recordId} AND left_seq IS NULL`,
			)
		}
		for (const want of changes.open) {
			tx.run(
				sql`INSERT INTO _kora_access_memberships
					(user_id, group_key, source, record_id, role, expires_at, joined_seq, role_seq, left_seq)
					VALUES (${want.userId}, ${want.group}, ${want.source}, ${want.recordId}, ${want.role},
					${want.expiresAt}, ${want.fromStart ? 0 : atSeq}, ${want.fromStart ? 0 : atSeq}, NULL)`,
			)
		}
	}

	/**
	 * Make the whole index match the records, in one transaction, after a schema change,
	 * a re-fold or a restore. Intervals of memberships that still hold keep their
	 * `joinedSeq`; one of a newly indexed collection opens from the start; anything else
	 * changes at the current delivery sequence. The configuration is stored with it.
	 */
	private reconcileMembershipIndex(): void {
		const access = this.schema?.access
		let generation: string | null = null
		let markerRemains = false
		const removable = this.accessIndex.removableMarkers()
		this.accessIndex.renewIfDue()
		this.db.transaction((tx) => {
			const meta = (key: string): string | undefined =>
				tx.all<{ value: string }>(sql`SELECT value FROM kora_server_meta WHERE key = ${key}`)[0]
					?.value
			const setMeta = (key: string, value: string): void => {
				tx.run(sql`INSERT OR REPLACE INTO kora_server_meta (key, value) VALUES (${key}, ${value})`)
			}
			const records: IndexedRecord[] = []
			for (const collection of Object.keys(this.schema?.collections ?? {})) {
				if (!feedsMembershipIndex(access, collection)) continue
				const ids = tx.all<{ id: string }>(sql`SELECT id FROM ${sql.raw(quoteIdent(collection))}`)
				for (const row of ids) records.push(this.readIndexedRecord(tx, collection, row.id))
			}
			const changes = reconcileIndex(
				access,
				records,
				this.readOpenIntervals(tx),
				parseMembershipIndexFingerprint(meta(MEMBERSHIP_INDEX_FINGERPRINT_KEY)),
			)
			const ever = mergeAccessCollectionsEver(meta(ACCESS_COLLECTIONS_EVER_KEY), access)
			if (ever.changed) setMeta(ACCESS_COLLECTIONS_EVER_KEY, ever.value)
			// Intervals indexed before role_seq existed may have changed role at any point.
			const unknownRoles =
				tx.all(sql`SELECT 1 AS one FROM _kora_access_memberships WHERE role_seq IS NULL LIMIT 1`)
					.length > 0
			if (hasMembershipChanges(changes) || unknownRoles) {
				// No operation carries a reconcile: it takes a delivery sequence of its own.
				const reserved = this.nextDeliverySeq(tx)
				this.applyMembershipChanges(tx, changes, reserved)
				tx.run(
					sql`UPDATE _kora_access_memberships SET role_seq = ${reserved} WHERE role_seq IS NULL`,
				)
				setMeta(ACCESS_FRONTIER_KEY, String(reserved))
				// Intervals opened at sequence 0 reuse sequences: a new generation.
				if (opensFromStart(changes))
					setMeta(ACCESS_INDEX_GENERATION_KEY, newAccessIndexGeneration())
			}
			setMeta(MEMBERSHIP_INDEX_FINGERPRINT_KEY, membershipIndexFingerprint(access))
			generation = meta(ACCESS_INDEX_GENERATION_KEY) ?? null
			// Only this instance's own (or adopted) markers: another rebuild may be running.
			// Only markers whose lease this instance still holds (one taken over meanwhile is
			// the taker's to clear).
			for (const key of removable) {
				tx.run(
					sql`DELETE FROM kora_server_meta WHERE key = ${key} AND value LIKE ${`%|${this.accessIndex.leaseOwner}`}`,
				)
			}
			markerRemains = this.rebuildingMarkers(tx).length > 0
		})
		this.accessIndex.rebuilt(generation, markerRemains, removable)
	}

	/** The rebuild markers present (keys), from any instance. */
	private rebuildingMarkers(db: BetterSQLite3Database): string[] {
		return db
			.all<{ key: string }>(
				sql`SELECT key FROM kora_server_meta WHERE substr(key, 1, ${ACCESS_INDEX_REBUILDING_PREFIX.length}) = ${ACCESS_INDEX_REBUILDING_PREFIX}`,
			)
			.map((row) => row.key)
	}

	/**
	 * Claims markers left by an interrupted rebuild (the running hold finishes the work):
	 * those whose lease ran out, because their process stopped renewing them. Claiming
	 * renews the lease in one statement, so of several processes recovering at once only
	 * one takes each marker, and a rebuild still running elsewhere keeps its own.
	 */
	private adoptRebuildingMarker(): string[] {
		const claimed = this.db.transaction(
			(tx) => {
				const now = Date.now()
				const lease = this.markerLease(now)
				const expired = tx
					.all<{ key: string; value: string }>(
						sql`SELECT key, value FROM kora_server_meta WHERE substr(key, 1, ${ACCESS_INDEX_REBUILDING_PREFIX.length}) = ${ACCESS_INDEX_REBUILDING_PREFIX}`,
					)
					.filter((row) => markerLeaseExpired(row.value, now))
				for (const row of expired) {
					tx.run(sql`UPDATE kora_server_meta SET value = ${lease} WHERE key = ${row.key}`)
				}
				return expired.map((row) => row.key)
			},
			{ behavior: 'immediate' },
		)
		if (claimed.length > 0) this.accessIndex.adopt(claimed)
		return claimed
	}

	/** A lease held by this instance from `now`: `<expiry>|<lease token>`. */
	private markerLease(now: number): string {
		return `${now + SQLITE_MARKER_LEASE_MS}|${this.accessIndex.leaseOwner}`
	}

	/** The rebuild markers present, with their lease expiry (epoch ms). */
	private markerLeases(): { key: string; value: string }[] {
		return this.db.all<{ key: string; value: string }>(
			sql`SELECT key, value FROM kora_server_meta WHERE substr(key, 1, ${ACCESS_INDEX_REBUILDING_PREFIX.length}) = ${ACCESS_INDEX_REBUILDING_PREFIX}`,
		)
	}

	/**
	 * Renews this instance's marker leases. A SQLite rebuild blocks the event loop, so its
	 * long steps also call `accessIndex.renewIfDue()` between batches (the timer alone
	 * would never fire).
	 */
	private renewMarkerLeases(keys: readonly string[]): void {
		// Only those that still carry this instance's lease token.
		const renewed = this.db.all<{ key: string }>(
			sql`UPDATE kora_server_meta SET value = ${this.markerLease(Date.now())}
				WHERE key IN (${sql.join(
					keys.map((key) => sql`${key}`),
					sql`, `,
				)}) AND value LIKE ${`%|${this.accessIndex.leaseOwner}`}
				RETURNING key`,
		)
		reportLostLeases(keys, renewed.length)
	}

	/**
	 * Recovers a rebuild every process abandoned: claims the expired markers and, if it got
	 * any, installs the current schema again (a full rebuild), behind the write gate like
	 * `setSchema` and outside the transaction the triggering read may belong to.
	 */
	private recoverAbandonedRebuild(): void {
		this.accessIndex.recoverAbandoned(
			() =>
				outsideDecision(() =>
					this.writeGate.run(() =>
						this.accessIndex.hold(async (mutated) => {
							// Read when it runs: a schema install queued before it has finished.
							const schema = this.schema
							const claimed = this.adoptRebuildingMarker()
							// Nothing to finish: another process claimed the markers, unless this
							// one is stuck after its own failed rebuild (only its rebuild clears that).
							if (!schema || (claimed.length === 0 && !this.accessIndex.isStuck())) return
							await this.installSchema(schema, {}, mutated)
						}),
					),
				),
			(error) => {
				console.error(
					'[kora] Could not rebuild the membership index after an interrupted rebuild. Access rules stay out of force; the rebuild is retried with a backoff.',
					error,
				)
			},
		)
	}

	/** Writes this instance's rebuild marker (inside `tx`), so every instance waits for it. */
	private writeRebuildingMarker(tx: BetterSQLite3Database): void {
		if (!this.schema?.access) return
		tx.run(
			sql`INSERT OR REPLACE INTO kora_server_meta (key, value) VALUES (${this.accessIndex.ownMarker(ACCESS_INDEX_REBUILDING_PREFIX, this.nodeId)}, ${this.markerLease(Date.now())})`,
		)
	}

	async getAccessIndexState(): Promise<AccessIndexState> {
		return this.track(async () => {
			const meta = (key: string): string | undefined =>
				this.db.all<{ value: string }>(
					sql`SELECT value FROM kora_server_meta WHERE key = ${key}`,
				)[0]?.value
			const readToken = this.accessIndex.beginRead()
			const generation = meta(ACCESS_INDEX_GENERATION_KEY) ?? null
			const markers = this.markerLeases()
			const rebuilding = markers.length > 0
			this.accessIndex.seen(generation, rebuilding, readToken)
			// Every marker abandoned (its process stopped), or this instance stuck after a failed
			// rebuild with none running: nobody else will finish the rebuild it needs.
			const now = Date.now()
			const abandoned = markers.every((row) => markerLeaseExpired(row.value, now))
			if (this.schema && abandoned && (rebuilding || this.accessIndex.isStuck())) {
				this.recoverAbandonedRebuild()
			}
			return {
				frontier: Number(meta(ACCESS_FRONTIER_KEY) ?? 0) || 0,
				accessCollectionsEver: parseAccessCollectionsEver(meta(ACCESS_COLLECTIONS_EVER_KEY)),
				generation,
				rebuilding,
			}
		})
	}

	async getExpiredMembershipIntervals(now: number, limit: number): Promise<MembershipInterval[]> {
		return this.track(async () => {
			return this.readIntervals(
				this.db,
				sql`SELECT user_id, group_key, source, record_id, role, expires_at, joined_seq, role_seq, left_seq
					FROM _kora_access_memberships
					WHERE left_seq IS NULL AND source = 'membership' AND expires_at IS NOT NULL AND expires_at <= ${now}
					ORDER BY expires_at LIMIT ${limit}`,
			)
		})
	}

	async getMembershipIntervals(userId: string): Promise<MembershipInterval[]> {
		return this.track(async () => {
			return this.readIntervals(
				this.db,
				sql`SELECT user_id, group_key, source, record_id, role, expires_at, joined_seq, role_seq, left_seq
					FROM _kora_access_memberships WHERE user_id = ${userId} ORDER BY id`,
			)
		})
	}

	/**
	 * One-time migration (RT-101): rebuild collection tables that still carry an enum
	 * `CHECK` (or `NOT NULL` on a schema field), in one transaction, keeping rows, indexes
	 * and triggers. Idempotent (a relaxed table is left alone) and resumable (an
	 * interrupted rebuild rolls back and runs again at the next start).
	 */
	private async relaxValueDomainConstraints(schema: SchemaDefinition): Promise<void> {
		const query: SqliteQueryFn = async (text) => this.db.all<Record<string, unknown>>(sql.raw(text))
		// Only enum checks on the schema's enum fields are Kora's; a CHECK added by hand
		// is kept through the rebuild and never triggers one (RT-111).
		const enumColumnsByTable: Record<string, string[]> = {}
		for (const [name, collection] of Object.entries(schema.collections)) {
			enumColumnsByTable[name] = Object.entries(collection.fields)
				.filter(([, descriptor]) => descriptor.kind === 'enum')
				.map(([field]) => field)
		}
		const statements = await planSqliteConstraintRelaxation(
			query,
			Object.keys(schema.collections),
			enumColumnsByTable,
		)
		if (statements.length === 0) return
		this.db.transaction((tx) => {
			for (const statement of statements) tx.run(sql.raw(statement))
		})
	}

	/**
	 * Throws {@link OperationTransformCoverageError} when a schema version in the stored
	 * log has no transform path to `version` (RT-103): those operations would fold as
	 * absent, silently erasing them from their records.
	 */
	private assertTransformCoverage(
		version: number,
		transforms: readonly OperationTransform[],
	): void {
		if (transforms.length === 0) return
		const rows = this.db.all<{ v: number }>(
			sql`SELECT DISTINCT schema_version AS v FROM operations`,
		)
		assertOperationTransformCoverage(
			rows.map((row) => Number(row.v)),
			version,
			transforms,
			'SQLite server store',
		)
	}

	getOperationTransforms(): readonly OperationTransform[] {
		return this.operationTransforms
	}

	async setOperationTransforms(transforms: readonly OperationTransform[]): Promise<void> {
		return this.track(async () => {
			if (this.schema) this.assertTransformCoverage(this.schema.version, transforms)
			// Re-folded values may change who holds which membership: access rules are not
			// judged until the index matches them again (for good if this fails part-way).
			await this.writeGate.run(() =>
				this.accessIndex.hold(async (mutated) => {
					this.operationTransforms = [...transforms]
					this.foldOptions = serverFoldOptions(this.explicitAuthorities, this.operationTransforms)
					mutated()
					// The fold plan fingerprint includes the transforms: when they changed, every
					// record is re-folded from its log, once (RT-84).
					if (this.schema) {
						this.foldMigration = this.rematerialize()
						this.reconcileMembershipIndex()
					}
				}),
			)
		})
	}

	async applyRemoteOperation(op: Operation, options?: ApplyRemoteOptions): Promise<ApplyResult> {
		return this.track(async () => {
			// Behind any transaction in progress (`transact`), so its decision and writes see
			// no other write in between.
			return this.writeGate.run(() => this.applyRemoteOperationNow(op, options))
		})
	}

	async transact(run: StoreTransactionRun): Promise<StoreTransactionResult> {
		return this.track(async () => {
			return this.writeGate.run(async () => {
				// Writes of this store wait at the gate. Another connection to the same file
				// (another process) does not: if it commits while the decision runs, the
				// decision is made again on the new state (optimistic, by PRAGMA data_version).
				for (let attempt = 1; ; attempt++) {
					const version = this.dataVersion(this.db)
					// Blob owners the decision adds are staged and written with its operations.
					const staged: StagedBlobOwner[] = []
					const ops = await run(this.activePlanReads(stagingBlobOwners(this, staged)))
					if (ops === null) return { committed: false, applied: [] }
					const result = this.commitTransaction(ops, version, staged)
					if (result !== null) return result
					if (attempt >= MAX_TRANSACTION_ATTEMPTS) throw new TransactionConflictError(attempt)
					// Let the other process finish what it is writing before deciding again.
					await new Promise((resolve) => setTimeout(resolve, attempt * 10))
				}
			})
		})
	}

	/**
	 * `view` with its record reads (`findRecord`, `queryCollection`, `countCollection`)
	 * seeing records as this process's fold plan defines them, not rows a process still
	 * on another plan materialized (a rolling deploy): what a transaction decides on.
	 */
	private activePlanReads(view: ServerStore): ServerStore {
		return new Proxy(view, {
			get: (target, property) => {
				if (property === 'findRecord') {
					return async (collection: string, id: string) => this.findActivePlanRecord(collection, id)
				}
				if (property === 'queryCollection') {
					return async (collection: string, options?: CollectionQueryOptions) =>
						this.queryActivePlan(collection, options)
				}
				if (property === 'countCollection') {
					return async (collection: string, where?: Record<string, unknown>) =>
						this.countActivePlan(collection, where)
				}
				return Reflect.get(target, property, target)
			},
		})
	}

	/** `findRecord` as this process's fold plan defines the record. Nothing is written. */
	private findActivePlanRecord(collection: string, id: string): MaterializedRecord | null {
		this.assertOpen()
		this.assertSchema()
		this.assertCollection(collection)
		const record = this.readAuthorizationRow(this.db, collection, id)
		return record && record._deleted !== 1 ? record : null
	}

	/**
	 * `queryCollection` on records as this process's fold plan defines them: the plain
	 * query when no record of the collection was folded with another plan (the rule),
	 * else the query over the collection with those records' rows replaced by their fold
	 * with this plan, so filters, order and paging are SQLite's own. Nothing in the
	 * database is written (the fold is staged in a temporary table of this connection,
	 * synchronously, and dropped).
	 */
	private queryActivePlan(
		collection: string,
		options?: CollectionQueryOptions,
	): MaterializedRecord[] {
		this.assertOpen()
		this.assertSchema()
		this.assertCollection(collection)
		const schema = this.schema as SchemaDefinition
		const collectionDef = schema.collections[collection] as NonNullable<
			SchemaDefinition['collections'][string]
		>
		for (const key of Object.keys(options?.where ?? {})) {
			validateFieldName(collection, key, schema)
		}
		if (options?.orderBy) validateFieldName(collection, options.orderBy, schema)
		return this.withActivePlanSource(collection, options?.where, (source) =>
			this.db.all<Record<string, unknown>>(this.buildSelectQuery(collection, options, source)),
		).map((row) => this.deserializeRow(row, collectionDef))
	}

	/** `countCollection` as {@link queryActivePlan} counts. */
	private countActivePlan(collection: string, where?: Record<string, unknown>): number {
		this.assertOpen()
		this.assertSchema()
		this.assertCollection(collection)
		const schema = this.schema as SchemaDefinition
		for (const key of Object.keys(where ?? {})) {
			validateFieldName(collection, key, schema)
		}
		const whereClause = this.buildWhereClause(where ?? {}, false, schema.collections[collection])
		const rows = this.withActivePlanSource(collection, where, (source) =>
			this.db.all<{ cnt: number }>(sql`SELECT COUNT(*) as cnt FROM ${source} WHERE ${whereClause}`),
		)
		return rows[0]?.cnt ?? 0
	}

	/**
	 * Run `read` over the collection as this process's fold plan defines it: the table
	 * itself when none of its records (of `where.id`, when the filter names one) was
	 * folded with another plan, else the table with those records' rows replaced by
	 * their fold with this plan, staged in a temporary table. Synchronous from staging to
	 * drop, so nothing else on this connection runs in between.
	 */
	private withActivePlanSource<T>(
		collection: string,
		where: Record<string, unknown> | undefined,
		read: (source: SQL) => T,
	): T {
		const table = sql.raw(quoteIdent(collection))
		const collectionDef = this.schema?.collections[collection]
		const plan = this.planStamp()
		const onlyId = where && typeof where.id === 'string' ? where.id : null
		const outdated = this.db
			.all<{ record_id: string }>(
				sql`SELECT record_id FROM kora_fold_state
					WHERE collection = ${collection}
						AND ((plan > '' AND plan < ${plan}) OR plan > ${plan})
						${onlyId === null ? sql.raw('') : sql`AND record_id = ${onlyId}`}`,
			)
			.map((row) => row.record_id)
		if (outdated.length === 0 || !collectionDef) return read(table)
		const stagedName = '_kora_active_plan'
		const staged = quoteIdent(stagedName)
		this.db.run(sql.raw(`DROP TABLE IF EXISTS temp.${staged}`))
		this.db.run(
			sql.raw(
				`CREATE TEMP TABLE ${staged} AS SELECT * FROM main.${quoteIdent(collection)} WHERE 0`,
			),
		)
		try {
			this.db.run(
				sql.raw(`CREATE UNIQUE INDEX temp.${quoteIdent(`${stagedName}_id`)} ON ${staged} (id)`),
			)
			const fieldNames = Object.keys(collectionDef.fields)
			for (const recordId of outdated) {
				const state = this.readFoldState(this.db, collection, recordId)
				const row = state ? projectFoldState(state, this.foldOptions) : null
				// A record this plan folds to nothing has no row (as readAuthorizationRow reads it).
				if (!row) continue
				this.upsertMaterializedRecord(
					this.db,
					stagedName,
					recordId,
					row.values,
					fieldNames,
					collectionDef,
					row.createdAt,
					row.updatedAt,
					row.deleted,
				)
			}
			// The rows on disk of exactly the records staged (or folded to nothing), whatever
			// another process re-folds meanwhile.
			return read(sql`(SELECT * FROM main.${table} c
				WHERE c.id NOT IN (SELECT value FROM json_each(${JSON.stringify(outdated)}))
				UNION ALL SELECT * FROM temp.${sql.raw(staged)}) AS ${table}`)
		} finally {
			this.db.run(sql.raw(`DROP TABLE IF EXISTS temp.${staged}`))
		}
	}

	/** Changes when another connection commits to the database file (not this one). */
	private dataVersion(db: BetterSQLite3Database): number {
		const row = db.all<{ data_version: number }>(sql`PRAGMA data_version`)[0]
		return Number(row?.data_version ?? 0)
	}

	/**
	 * Commit a transaction's operations in one SQLite write transaction: all or none.
	 * Null (nothing written) when another connection committed since `version`.
	 */
	private commitTransaction(
		ops: readonly Operation[],
		version: number,
		staged: readonly StagedBlobOwner[],
	): StoreTransactionResult | null {
		const now = Date.now()
		let attempted: Operation | null = null
		const applied: Operation[] = []
		try {
			// IMMEDIATE: the write lock is taken before the check, so no other connection
			// commits between the check and these writes.
			const fresh = this.db.transaction(
				(tx) => {
					if (this.dataVersion(tx) !== version) return false
					for (const change of staged) {
						tx.run(
							change.kind === 'claim'
								? sql`INSERT OR IGNORE INTO blob_owners (hash, owner, created_at)
									SELECT ${change.hash}, ${change.owner}, ${now}
									WHERE NOT EXISTS (SELECT 1 FROM blob_owners WHERE hash = ${change.hash})`
								: sql`INSERT OR IGNORE INTO blob_owners (hash, owner, created_at) VALUES (${change.hash}, ${change.owner}, ${now})`,
						)
					}
					for (const op of ops) {
						attempted = op
						if (this.applyOpInTx(tx, op, now, undefined, () => {}) === 'applied') applied.push(op)
					}
					return true
				},
				{ behavior: 'immediate' },
			)
			if (!fresh) return null
		} catch (error) {
			throw attempted ? sqliteUnstorableValueOr(error, attempted) : error
		}
		return { committed: true, applied }
	}

	private async applyRemoteOperationNow(
		op: Operation,
		options?: ApplyRemoteOptions,
	): Promise<ApplyResult> {
		const now = Date.now()

		let sequenceDecision: SequenceHolderVerdict = { verdict: 'free' }
		// Use a transaction for atomicity: insert op + update version vector + materialize
		let result: 'applied' | 'duplicate'
		try {
			result = this.applyInTransaction(op, now, options, (decision) => {
				sequenceDecision = decision
			})
		} catch (error) {
			throw sqliteUnstorableValueOr(error, op)
		}

		if (result === 'applied') {
			reportLegacyPair(op, sequenceDecision, options)
		}
		return result
	}

	private applyInTransaction(
		op: Operation,
		now: number,
		options: ApplyRemoteOptions | undefined,
		onSequenceDecision: (decision: SequenceHolderVerdict) => void,
	): 'applied' | 'duplicate' {
		// Immediate: the write lock is taken first, so the index state read before the write
		// is judged cannot change (another process's rebuild) before it commits.
		return this.db.transaction((tx) => this.applyOpInTx(tx, op, now, options, onSequenceDecision), {
			behavior: 'immediate',
		})
	}

	/** Store one operation inside the caller's transaction (see {@link applyInTransaction}). */
	private applyOpInTx(
		tx: BetterSQLite3Database,
		op: Operation,
		now: number,
		options: ApplyRemoteOptions | undefined,
		onSequenceDecision: (decision: SequenceHolderVerdict) => void,
	): 'applied' | 'duplicate' {
		{
			// Content-addressed dedup: check before assigning a delivery sequence so a
			// duplicate never burns one (keeps the sequence gap-free on this store).
			const existing = tx.all<{ id: string }>(
				sql`SELECT id FROM operations WHERE id = ${op.id} LIMIT 1`,
			)
			if (existing.length > 0) {
				return 'duplicate' as const
			}
			// A different operation under the same (node, sequence) is refused (W3 step 4)
			// when it was stored under enforcement and the writer reserves its sequences;
			// a legacy holder (stored before the epoch) or a legacy writer (RT-37) is
			// accepted, as beta.12 did. Inside the write transaction so no concurrent
			// writer can slip one in.
			const holders = tx.all<{ id: string; delivery_seq: number | null }>(
				sql`SELECT id, delivery_seq FROM operations WHERE node_id = ${op.nodeId} AND sequence_number = ${op.sequenceNumber}`,
			)
			const decision = judgeSequenceHolders(
				op,
				holders.map((row) => ({ id: row.id, deliverySequence: Number(row.delivery_seq ?? 0) })),
				this.sequenceEpoch,
				{ legacySequenceWriter: options?.legacySequenceWriter === true },
			)
			if (decision.verdict === 'conflict') {
				throw new SequenceConflictError(op, decision.holderId)
			}
			onSequenceDecision(decision)

			// Authorization re-check inside the write transaction: better-sqlite3 runs
			// it synchronously under SQLite's single writer lock, so the row it sees is
			// the row this write commits against. Throwing rolls the transaction back.
			if (options?.authorize) {
				// Another process sharing the file may have started (or finished) a rebuild:
				// what it committed is seen before this write is judged.
				this.refreshAccessIndexView(tx)
				const decision = options.authorize(
					this.readAuthorizationRow(tx, op.collection, op.recordId),
					{
						...(options.previewResult ? { resulting: this.foldPreview(tx, op) } : {}),
						...(options.liveGroupsOf
							? {
									liveGroups: this.readLiveGroups(
										tx,
										options.liveGroupsOf,
										options.liveGroupsSince,
									),
								}
							: {}),
						memberships: options.membershipsFor
							? this.readIntervals(
									tx,
									sql`SELECT user_id, group_key, source, record_id, role, expires_at, joined_seq, role_seq, left_seq
									FROM _kora_access_memberships WHERE user_id = ${options.membershipsFor} ORDER BY id`,
								)
							: [],
					},
				)
				if (!decision.allowed) {
					throw new UplinkAuthorizationError(decision.code, decision.message, {
						operationId: op.id,
						collection: op.collection,
						recordId: op.recordId,
					})
				}
			}

			const materialized = this.schema?.collections[op.collection] !== undefined
			const pre = materialized ? this.readScopeValues(tx, op.collection, op.recordId, false) : null
			// A group record's state before the write: its members change only on a deletion
			// or a revival.
			const groupBefore = writeAffectsGroupMembers(this.schema?.access, op.collection)
				? groupRecordState(this.readIndexedRecord(tx, op.collection, op.recordId))
				: null

			const deliverySeq = this.nextDeliverySeq(tx)
			const row = this.serializeOperation(op, now, deliverySeq, decision.verdict === 'free')
			tx.insert(operations).values(row).run()
			// A legacy pair: index its sequence so version-vector clients get both (RT-48).
			if (decision.verdict === 'legacy') {
				tx.run(
					sql`INSERT OR IGNORE INTO sequence_pairs (node_id, sequence_number) VALUES (${op.nodeId}, ${op.sequenceNumber})`,
				)
			}

			// Advance version vector: upsert with MAX to ensure monotonic progress
			tx.insert(syncState)
				.values({
					nodeId: op.nodeId,
					maxSequenceNumber: op.sequenceNumber,
					lastSeenAt: now,
				})
				.onConflictDoUpdate({
					target: syncState.nodeId,
					set: {
						maxSequenceNumber: sql`MAX(${syncState.maxSequenceNumber}, ${op.sequenceNumber})`,
						lastSeenAt: sql`${now}`,
					},
				})
				.run()

			// Dual-write: update materialized collection table if schema is set
			if (materialized) {
				this.mergeIntoRecord(tx, op, deliverySeq)
				// The record's scope values around this write, from the store's own rows.
				const snapshot: OperationScopeSnapshot = {
					pre,
					post: this.readScopeValues(tx, op.collection, op.recordId, true),
				}
				tx.run(
					sql`UPDATE operations SET scope_snapshot = ${JSON.stringify(snapshot)} WHERE id = ${op.id}`,
				)
				// The membership index moves in the same transaction as the write.
				if (feedsMembershipIndex(this.schema?.access, op.collection)) {
					this.reconcileRecordMemberships(tx, op.collection, op.recordId, deliverySeq, groupBefore)
				}
			}

			return 'applied' as const
		}
	}

	async getOperationRange(nodeId: string, fromSeq: number, toSeq: number): Promise<Operation[]> {
		return this.track(async () => {
			const rows = this.db
				.select()
				.from(operations)
				.where(
					and(eq(operations.nodeId, nodeId), between(operations.sequenceNumber, fromSeq, toSeq)),
				)
				.orderBy(asc(operations.sequenceNumber))
				.all()

			return rows.map((row) => this.deserializeOperation(row))
		})
	}

	async getOperationCount(): Promise<number> {
		return this.track(async () => {
			const result = this.db.select({ value: count() }).from(operations).all()
			return result[0]?.value ?? 0
		})
	}

	async getMaxDeliverySequence(): Promise<number> {
		return this.track(async () => {
			// A sequence an access-index reconcile reserved (no operation) is delivered too.
			const rows = this.db.all<{ m: number | null }>(
				sql`SELECT MAX(
					COALESCE((SELECT MAX(delivery_seq) FROM operations), 0),
					COALESCE((SELECT CAST(value AS INTEGER) FROM kora_server_meta WHERE key = ${ACCESS_FRONTIER_KEY}), 0)
				) AS m`,
			)
			return Number(rows[0]?.m ?? 0)
		})
	}

	async getOperationsAfterDelivery(
		afterDeliverySequence: number,
		limit: number,
	): Promise<DeliveredOperation[]> {
		return this.track(async () => {
			const rows = this.db
				.select()
				.from(operations)
				.where(gt(operations.deliverySeq, afterDeliverySequence))
				.orderBy(asc(operations.deliverySeq))
				.limit(limit)
				.all()
			return rows.map((row) => ({
				operation: this.deserializeOperation(row),
				deliverySequence: row.deliverySeq ?? 0,
				scopeSnapshot: parseScopeSnapshot(row.scopeSnapshot),
			}))
		})
	}

	async getOperationScopeSnapshots(
		operationIds: string[],
	): Promise<Map<string, OperationScopeSnapshot>> {
		return this.track(async () => {
			const result = new Map<string, OperationScopeSnapshot>()
			for (let i = 0; i < operationIds.length; i += 500) {
				const ids = operationIds.slice(i, i + 500)
				if (ids.length === 0) continue
				const rows = this.db.all<{ id: string; scope_snapshot: string | null }>(
					sql`SELECT id, scope_snapshot FROM operations WHERE id IN (${sql.join(
						ids.map((id) => sql`${id}`),
						sql.raw(', '),
					)})`,
				)
				for (const row of rows) {
					const snapshot = parseScopeSnapshot(row.scope_snapshot)
					if (snapshot) result.set(row.id, snapshot)
				}
			}
			return result
		})
	}

	async getRecordLatestTimestamp(
		collection: string,
		recordId: string,
	): Promise<HLCTimestamp | null> {
		return this.track(async () => {
			const rows = this.db.all<{ wall_time: number; logical: number; timestamp_node_id: string }>(
				sql`SELECT wall_time, logical, timestamp_node_id FROM operations
					WHERE collection = ${collection} AND record_id = ${recordId}
					ORDER BY wall_time DESC, logical DESC, timestamp_node_id DESC LIMIT 1`,
			)
			const row = rows[0]
			return row
				? {
						wallTime: Number(row.wall_time),
						logical: Number(row.logical),
						nodeId: row.timestamp_node_id,
					}
				: null
		})
	}

	async getRecordFieldVersions(
		collection: string,
		recordId: string,
	): Promise<RecordFieldVersions | null> {
		return this.track(async () => {
			return foldFieldVersions(this.readFoldState(this.db, collection, recordId))
		})
	}

	async getRecordFoldState(collection: string, recordId: string): Promise<FoldState | null> {
		return this.track(async () => {
			return this.readFoldState(this.db, collection, recordId)
		})
	}

	async getRecordOperations(collection: string, recordId: string): Promise<Operation[]> {
		return this.track(async () => {
			return this.readRecordOperations(this.db, collection, recordId, 0)
		})
	}

	async previewOperation(op: Operation): Promise<MaterializedRecord | null> {
		return this.track(async () => {
			const row = this.foldPreview(this.db, op)
			if (!row || row.deleted) return null
			return { ...row.values, id: op.recordId }
		})
	}

	/** The record `op` leaves, folded onto the stored state read through `txOrDb`. */
	private foldPreview(txOrDb: BetterSQLite3Database, op: Operation): ResultingRecord | null {
		const schema = this.schema ?? EMPTY_FOLD_SCHEMA
		const current = this.readFoldState(txOrDb, op.collection, op.recordId)
		const merged = mergeIntoFoldState(current, [op], schema, this.foldOptions)
		const state =
			merged === REFOLD_REQUIRED
				? refoldRecord(
						[...this.readRecordOperations(txOrDb, op.collection, op.recordId, 0), op],
						schema,
						this.foldOptions,
					)
				: merged
		// Materialized exactly as the row this write persists (schema defaults included).
		return foldedResult(
			state,
			this.schema?.collections[op.collection]?.fields,
			this.foldOptions,
			storedSqliteFieldValue,
			false,
		)
	}

	async recordBlobOwner(hash: string, owner: string): Promise<void> {
		return this.track(async () => {
			return this.writeGate.run(() => this.recordBlobOwnerNow(hash, owner))
		})
	}

	private async recordBlobOwnerNow(hash: string, owner: string): Promise<void> {
		this.db.run(
			sql`INSERT OR IGNORE INTO blob_owners (hash, owner, created_at) VALUES (${hash}, ${owner}, ${Date.now()})`,
		)
	}

	async getBlobOwners(hashes: string[]): Promise<Map<string, string[]>> {
		return this.track(async () => {
			const result = new Map<string, string[]>(hashes.map((hash) => [hash, []]))
			for (let i = 0; i < hashes.length; i += 500) {
				const slice = hashes.slice(i, i + 500)
				if (slice.length === 0) continue
				const rows = this.db.all<{ hash: string; owner: string }>(
					sql`SELECT hash, owner FROM blob_owners WHERE hash IN (${sql.join(
						slice.map((hash) => sql`${hash}`),
						sql.raw(', '),
					)})`,
				)
				for (const row of rows) result.get(row.hash)?.push(row.owner)
			}
			return result
		})
	}

	async claimBlobIfUnowned(hash: string, owner: string): Promise<boolean> {
		return this.track(async () => {
			// Behind any transaction in progress, which may have staged a claim of the hash.
			return this.writeGate.run(() => this.claimBlobIfUnownedNow(hash, owner))
		})
	}

	private async claimBlobIfUnownedNow(hash: string, owner: string): Promise<boolean> {
		// better-sqlite3 runs both statements synchronously under SQLite's writer lock,
		// so no other claim interleaves (and the file lock covers other processes).
		this.db.run(
			sql`INSERT OR IGNORE INTO blob_owners (hash, owner, created_at)
				SELECT ${hash}, ${owner}, ${Date.now()}
				WHERE NOT EXISTS (SELECT 1 FROM blob_owners WHERE hash = ${hash})`,
		)
		const rows = this.db.all<{ one: number }>(
			sql`SELECT 1 AS one FROM blob_owners WHERE hash = ${hash} AND owner = ${owner} LIMIT 1`,
		)
		return rows.length > 0
	}

	/**
	 * Scope values of a record as stored, for an operation's scope snapshot. With
	 * `includeDeleted` false a soft-deleted row counts as absent (the pre-image of a
	 * write to a deleted record); with true it keeps its last values (a delete's
	 * post-image).
	 */
	private readScopeValues(
		txOrDb: BetterSQLite3Database,
		collection: string,
		recordId: string,
		includeDeleted: boolean,
	): Record<string, unknown> | null {
		const collectionDef = this.schema?.collections[collection]
		if (!collectionDef) return null
		const rows = txOrDb.all<Record<string, unknown>>(
			sql`SELECT * FROM ${sql.raw(quoteIdent(collection))} WHERE id = ${recordId} LIMIT 1`,
		)
		const row = rows[0]
		if (!row) return null
		if (!includeDeleted && Number(row._deleted) === 1) return null
		return scopeValuesOf(this.schema, collection, recordId, this.deserializeRow(row, collectionDef))
	}

	/**
	 * Rebuild missing scope snapshots from the log (migration from a database written
	 * before snapshots existed), replaying each affected record in commit order.
	 */
	private backfillScopeSnapshots(): void {
		const schema = this.schema
		if (!schema) return
		const pending = this.db.all<{ collection: string; record_id: string }>(
			sql`SELECT DISTINCT collection, record_id FROM operations WHERE scope_snapshot IS NULL`,
		)
		const targets = pending.filter((row) => schema.collections[row.collection] !== undefined)
		if (targets.length === 0) return
		// In bounded transactions, each committing whole records: a long rebuild never
		// holds the write lock throughout, and a restart resumes at the records left.
		const progress = new FoldMigrationProgress('Scope snapshot rebuild')
		progress.setTotal(targets.length)
		for (let i = 0; i < targets.length; i += FOLD_MIGRATION_BATCH) {
			const chunk = targets.slice(i, i + FOLD_MIGRATION_BATCH)
			this.backfillScopeSnapshotChunk(schema, chunk)
			progress.advance(chunk.length, chunk.length)
			if (progress.due()) progress.report()
		}
		progress.finish()
	}

	private backfillScopeSnapshotChunk(
		schema: SchemaDefinition,
		targets: readonly { collection: string; record_id: string }[],
	): void {
		this.accessIndex.renewIfDue()
		this.db.transaction((tx) => {
			for (const target of targets) {
				const rows = tx
					.select()
					.from(operations)
					.where(
						and(
							eq(operations.collection, target.collection),
							eq(operations.recordId, target.record_id),
						),
					)
					.orderBy(asc(operations.deliverySeq))
					.all()
				const replayed = replayScopeSnapshots(
					schema,
					target.collection,
					target.record_id,
					rows.map((row) => this.deserializeOperation(row)),
					this.foldOptions,
				)
				for (const row of rows) {
					if (row.scopeSnapshot !== null) continue
					const snapshot = replayed.get(row.id)
					if (!snapshot) continue
					tx.run(
						sql`UPDATE operations SET scope_snapshot = ${JSON.stringify(snapshot)} WHERE id = ${row.id}`,
					)
				}
			}
		})
	}

	async materializeCollection(collection: string): Promise<MaterializedRecord[]> {
		return this.track(async () => {
			// Fast path: if schema is set, read directly from the materialized table
			if (this.schema?.collections[collection]) {
				return this.queryCollection(collection)
			}

			// Fallback: replay operations (legacy path when schema is not set)
			return this.materializeFromOpsLog(collection)
		})
	}

	async getNodeIdsAfterDelivery(afterDeliverySequence: number): Promise<string[]> {
		return this.track(async () => {
			const rows = this.db.all<{ node_id: string }>(
				sql`SELECT DISTINCT node_id FROM operations WHERE delivery_seq > ${afterDeliverySequence}`,
			)
			return rows.map((row) => row.node_id)
		})
	}

	async getSequencePairOperations(nodeId: string, throughSequence: number): Promise<Operation[]> {
		return this.track(async () => {
			const rows = this.db
				.select()
				.from(operations)
				.where(
					and(
						eq(operations.nodeId, nodeId),
						sql`${operations.sequenceNumber} IN (SELECT sequence_number FROM sequence_pairs WHERE node_id = ${nodeId} AND sequence_number <= ${throughSequence})`,
					),
				)
				.orderBy(asc(operations.sequenceNumber), asc(operations.deliverySeq))
				.all()
			return rows.map((row) => this.deserializeOperation(row))
		})
	}

	async recordOperationResolution(resolution: OperationResolution): Promise<void> {
		return this.track(async () => {
			this.db.run(
				sql`INSERT OR IGNORE INTO operation_resolutions
					(op_id, node_id, sequence_number, outcome, code, message, resolved_at)
					VALUES (${resolution.operationId}, ${resolution.nodeId}, ${resolution.sequenceNumber},
						${resolution.outcome}, ${resolution.code},
						${resolution.message?.slice(0, MAX_RESOLUTION_MESSAGE_LENGTH) ?? null}, ${Date.now()})`,
			)
		})
	}

	async findOperationResolutions(
		nodeId: string,
		ids: string[],
	): Promise<Map<string, OperationResolution>> {
		return this.track(async () => {
			const found = new Map<string, OperationResolution>()
			for (let i = 0; i < ids.length; i += 500) {
				const chunk = ids.slice(i, i + 500)
				if (chunk.length === 0) continue
				const rows = this.db.all<ResolutionRow>(
					sql`SELECT op_id, node_id, sequence_number, outcome, code, message FROM operation_resolutions
						WHERE node_id = ${nodeId} AND op_id IN (${sql.join(
							chunk.map((id) => sql`${id}`),
							sql.raw(', '),
						)})`,
				)
				for (const row of rows) found.set(row.op_id, resolutionFromRow(row))
			}
			return found
		})
	}

	async deleteOperationResolution(nodeId: string, operationId: string): Promise<void> {
		return this.track(async () => {
			this.db.run(
				sql`DELETE FROM operation_resolutions WHERE node_id = ${nodeId} AND op_id = ${operationId}`,
			)
		})
	}

	async getResolvedThrough(nodeId: string): Promise<number> {
		return this.track(async () => {
			const rows = this.db.all<{ m: number | string | null }>(
				sql`SELECT MAX(sequence_number) AS m FROM operation_resolutions WHERE node_id = ${nodeId}`,
			)
			return Number(rows[0]?.m ?? 0)
		})
	}

	async findStoredOperations(ids: string[]): Promise<Map<string, StoredOperationKey>> {
		return this.track(async () => {
			const found = new Map<string, StoredOperationKey>()
			// Chunked to stay far below SQLite's bound-parameter limit.
			for (let i = 0; i < ids.length; i += 500) {
				const chunk = ids.slice(i, i + 500)
				if (chunk.length === 0) continue
				const rows = this.db.all<{ id: string; node_id: string; sequence_number: number | string }>(
					sql`SELECT id, node_id, sequence_number FROM operations WHERE id IN (${sql.join(
						chunk.map((id) => sql`${id}`),
						sql.raw(', '),
					)})`,
				)
				for (const row of rows) {
					found.set(row.id, { nodeId: row.node_id, sequenceNumber: Number(row.sequence_number) })
				}
			}
			return found
		})
	}

	async findRecordsByIds(
		collection: string,
		ids: string[],
	): Promise<Map<string, MaterializedRecord>> {
		return this.track(async () => {
			this.assertSchema()
			this.assertCollection(collection)
			const schema = this.schema as SchemaDefinition
			const collectionDef = schema.collections[collection] as NonNullable<
				SchemaDefinition['collections'][string]
			>
			const result = new Map<string, MaterializedRecord>()
			// Chunked to stay far below SQLite's bound-parameter limit.
			for (let i = 0; i < ids.length; i += 500) {
				const chunk = ids.slice(i, i + 500)
				if (chunk.length === 0) continue
				const rows = this.db.all<Record<string, unknown>>(
					sql`SELECT * FROM ${sql.raw(quoteIdent(collection))} WHERE id IN (${sql.join(
						chunk.map((id) => sql`${id}`),
						sql.raw(', '),
					)})`,
				)
				for (const row of rows) {
					const record = this.deserializeRow(row, collectionDef)
					result.set(record.id, record)
				}
			}
			return result
		})
	}

	async queryCollection(
		collection: string,
		options?: CollectionQueryOptions,
	): Promise<MaterializedRecord[]> {
		return this.track(async () => {
			this.assertSchema()
			this.assertCollection(collection)

			const schema = this.schema as SchemaDefinition
			const collectionDef = schema.collections[collection] as NonNullable<
				SchemaDefinition['collections'][string]
			>

			// Validate field names in options
			if (options?.where) {
				for (const key of Object.keys(options.where)) {
					validateFieldName(collection, key, schema)
				}
			}
			if (options?.orderBy) {
				validateFieldName(collection, options.orderBy, schema)
			}

			const query = this.buildSelectQuery(collection, options)
			const rows = this.db.all<Record<string, unknown>>(query)

			return rows.map((row) => this.deserializeRow(row, collectionDef))
		})
	}

	async findRecord(collection: string, id: string): Promise<MaterializedRecord | null> {
		return this.track(async () => {
			this.assertSchema()
			this.assertCollection(collection)

			const schema = this.schema as SchemaDefinition
			const collectionDef = schema.collections[collection] as NonNullable<
				SchemaDefinition['collections'][string]
			>
			const query = sql`SELECT * FROM ${sql.raw(quoteIdent(collection))} WHERE id = ${id} AND _deleted = 0`
			const rows = this.db.all<Record<string, unknown>>(query)

			if (rows.length === 0) return null
			return this.deserializeRow(rows[0] as Record<string, unknown>, collectionDef)
		})
	}

	async countCollection(collection: string, where?: Record<string, unknown>): Promise<number> {
		return this.track(async () => {
			this.assertSchema()
			this.assertCollection(collection)

			const schema = this.schema as SchemaDefinition
			if (where) {
				for (const key of Object.keys(where)) {
					validateFieldName(collection, key, schema)
				}
			}

			const whereClause = this.buildWhereClause(where ?? {}, false, schema.collections[collection])
			const query = sql`SELECT COUNT(*) as cnt FROM ${sql.raw(quoteIdent(collection))} WHERE ${whereClause}`
			const rows = this.db.all<{ cnt: number }>(query)
			return rows[0]?.cnt ?? 0
		})
	}

	async close(): Promise<void> {
		// New calls are refused from here on (assertOpen); calls already running, and the
		// store calls they make, finish first: the connection never goes away under them.
		this.closed = true
		if (this.inFlight > 0) {
			await new Promise<void>((resolve) => this.drainWaiters.push(resolve))
		}
		// Work a call started in the background (an abandoned-rebuild recovery, queued at
		// the write gate) also finishes before the handle goes away.
		await this.accessIndex.pendingRecovery()
		await this.writeGate.run(() => undefined)
		const closeConnection = OWNED_CONNECTIONS.get(this)
		OWNED_CONNECTIONS.delete(this)
		closeConnection?.()
	}

	/**
	 * Runs a public call: refused once `close()` began (unless made from inside a call
	 * still running, such as a transaction's view or a backup's own reads), and counted
	 * so `close()` waits for it before closing the connection.
	 */
	private async track<T>(work: () => Promise<T>): Promise<T> {
		this.assertOpen()
		const parent = IN_STORE_CALL.getStore() ?? null
		const frame: StoreCallFrame = { store: this.callToken, parent, running: true }
		this.inFlight += 1
		try {
			return await IN_STORE_CALL.run(frame, work)
		} finally {
			frame.running = false
			this.inFlight -= 1
			if (this.inFlight === 0) {
				for (const resolve of this.drainWaiters.splice(0)) resolve()
			}
		}
	}

	async getEncryptionKeyRecord(owner: string, keyring: string): Promise<string | null> {
		return this.track(async () => {
			const rows = this.db.all<{ record: string }>(
				sql`SELECT record FROM kora_encryption_keys WHERE owner = ${owner} AND keyring = ${keyring} LIMIT 1`,
			)
			return rows[0]?.record ?? null
		})
	}

	async putEncryptionKeyRecord(
		owner: string,
		keyring: string,
		record: string,
		revision: number,
		expectedRevision: number,
	): Promise<boolean> {
		return this.track(async () => {
			const now = Date.now()
			// Compare-and-set on the revision; better-sqlite3 runs it synchronously, and the
			// primary key makes a concurrent first write from another process fail.
			if (expectedRevision === 0) {
				const rows = this.db.all<{ owner: string }>(
					sql`INSERT OR IGNORE INTO kora_encryption_keys (owner, keyring, revision, record, updated_at)
						VALUES (${owner}, ${keyring}, ${revision}, ${record}, ${now}) RETURNING owner`,
				)
				return rows.length > 0
			}
			const rows = this.db.all<{ owner: string }>(
				sql`UPDATE kora_encryption_keys SET revision = ${revision}, record = ${record}, updated_at = ${now}
					WHERE owner = ${owner} AND keyring = ${keyring} AND revision = ${expectedRevision}
					RETURNING owner`,
			)
			return rows.length > 0
		})
	}

	async listEncryptionKeyRecords(owner?: string): Promise<EncryptionKeyRecordRow[]> {
		return this.track(async () => {
			return owner === undefined
				? this.db.all<EncryptionKeyRecordRow>(
						sql`SELECT owner, keyring, revision, record FROM kora_encryption_keys ORDER BY owner, keyring`,
					)
				: this.db.all<EncryptionKeyRecordRow>(
						sql`SELECT owner, keyring, revision, record FROM kora_encryption_keys WHERE owner = ${owner} ORDER BY keyring`,
					)
		})
	}

	async getEncryptedKeyIds(nodeOwner: string | null, limit: number): Promise<string[]> {
		return this.track(async () => {
			const rows =
				nodeOwner === null
					? this.db.all<{ encrypted: string | null }>(
							sql`SELECT encrypted FROM operations WHERE encrypted IS NOT NULL LIMIT ${KEY_ID_SAMPLE_ROWS}`,
						)
					: this.db.all<{ encrypted: string | null }>(
							sql`SELECT o.encrypted AS encrypted FROM node_claims c
								JOIN operations o ON o.node_id = c.node_id
								WHERE c.user_id = ${nodeOwner} AND o.encrypted IS NOT NULL
								LIMIT ${KEY_ID_SAMPLE_ROWS}`,
						)
			return envelopeKeyIds(
				rows.map((row) => row.encrypted),
				limit,
			)
		})
	}

	async claimNode(nodeId: string, userId: string): Promise<boolean> {
		return this.track(async () => {
			if (userId === RELEASED_NODE_OWNER) return false
			const now = Date.now()
			// better-sqlite3 runs these synchronously, so no other claim interleaves.
			// A fresh claim is only created for a node without history: history with no
			// claim predates node claims, so its writer is unknown (RT-5).
			this.db.run(
				sql`INSERT OR IGNORE INTO node_claims (node_id, user_id, claimed_at)
					SELECT ${nodeId}, ${userId}, ${now}
					WHERE NOT EXISTS (SELECT 1 FROM operations WHERE node_id = ${nodeId})`,
			)
			// An admin-released node is taken over by its next claimant.
			this.db.run(
				sql`UPDATE node_claims SET user_id = ${userId}, claimed_at = ${now}
					WHERE node_id = ${nodeId} AND user_id = ${RELEASED_NODE_OWNER}`,
			)
			const rows = this.db.all<{ user_id: string }>(
				sql`SELECT user_id FROM node_claims WHERE node_id = ${nodeId} LIMIT 1`,
			)
			return rows[0]?.user_id === userId
		})
	}

	async claimUnownedNode(nodeId: string, userId: string): Promise<boolean> {
		return this.track(async () => {
			if (userId === RELEASED_NODE_OWNER) return false
			// One upsert: a missing claim row is created, a released one ('') is taken
			// over, and any other owner is left untouched (the WHERE of the update).
			this.db.run(
				sql`INSERT INTO node_claims (node_id, user_id, claimed_at)
					VALUES (${nodeId}, ${userId}, ${Date.now()})
					ON CONFLICT (node_id) DO UPDATE SET user_id = excluded.user_id, claimed_at = excluded.claimed_at
					WHERE node_claims.user_id = ${RELEASED_NODE_OWNER}`,
			)
			const rows = this.db.all<{ user_id: string }>(
				sql`SELECT user_id FROM node_claims WHERE node_id = ${nodeId} LIMIT 1`,
			)
			return rows[0]?.user_id === userId
		})
	}

	async getNodeClaimOwner(nodeId: string): Promise<string | null> {
		return this.track(async () => {
			const rows = this.db.all<{ user_id: string }>(
				sql`SELECT user_id FROM node_claims WHERE node_id = ${nodeId} LIMIT 1`,
			)
			return rows[0]?.user_id ?? null
		})
	}

	async replaceNodeClaim(
		nodeId: string,
		expectedOwner: string,
		newOwner: string,
	): Promise<boolean> {
		return this.track(async () => {
			const rows = this.db.all<{ node_id: string }>(
				sql`UPDATE node_claims SET user_id = ${newOwner}, claimed_at = ${Date.now()}
					WHERE node_id = ${nodeId} AND user_id = ${expectedOwner} RETURNING node_id`,
			)
			return rows.length > 0
		})
	}

	async requestFullResync(target: FullResyncTarget): Promise<number> {
		this.assertOpen()
		return this.db.transaction((tx) => {
			const row = tx.all<{ value: string }>(
				sql`INSERT INTO kora_server_meta (key, value) VALUES (${FULL_RESYNC_COUNTER_KEY}, '1')
					ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(kora_server_meta.value AS INTEGER) + 1 AS TEXT)
					RETURNING value`,
			)[0]
			const token = Number(row?.value ?? 1)
			const keys = [
				...(target.userId !== undefined ? [fullResyncUserKey(target.userId)] : []),
				...(target.nodeId !== undefined ? [fullResyncNodeKey(target.nodeId)] : []),
			]
			for (const key of keys) {
				tx.run(
					sql`INSERT OR REPLACE INTO kora_server_meta (key, value) VALUES (${key}, ${String(token)})`,
				)
			}
			return token
		})
	}

	async getFullResyncState(
		userId: string | null,
		nodeId: string,
		view = '',
	): Promise<FullResyncState> {
		this.assertOpen()
		const read = (key: string): string | undefined =>
			this.db.all<{ value: string }>(sql`SELECT value FROM kora_server_meta WHERE key = ${key}`)[0]
				?.value
		return {
			requested: newestFullResyncToken([
				userId !== null ? read(fullResyncUserKey(userId)) : undefined,
				read(fullResyncNodeKey(nodeId)),
			]),
			done: newestFullResyncToken([read(fullResyncDoneKey(nodeId, view))]),
		}
	}

	async completeFullResync(nodeId: string, token: number, view = ''): Promise<void> {
		this.assertOpen()
		const key = fullResyncDoneKey(nodeId, view)
		this.db.run(
			sql`INSERT INTO kora_server_meta (key, value) VALUES (${key}, ${String(token)})
				ON CONFLICT (key) DO UPDATE SET value = excluded.value
				WHERE CAST(excluded.value AS INTEGER) > CAST(kora_server_meta.value AS INTEGER)`,
		)
	}

	async releaseNodeClaim(nodeId: string): Promise<boolean> {
		return this.track(async () => {
			const known = this.db.all<{ one: number }>(
				sql`SELECT 1 AS one WHERE EXISTS (SELECT 1 FROM node_claims WHERE node_id = ${nodeId})
					OR EXISTS (SELECT 1 FROM operations WHERE node_id = ${nodeId})`,
			)
			if (known.length === 0) return false
			this.db.run(
				sql`INSERT INTO node_claims (node_id, user_id, claimed_at)
					VALUES (${nodeId}, ${RELEASED_NODE_OWNER}, ${Date.now()})
					ON CONFLICT (node_id) DO UPDATE SET user_id = excluded.user_id, claimed_at = excluded.claimed_at`,
			)
			return true
		})
	}

	async getLiveGroups(groups: readonly string[], since?: number): Promise<ReadonlySet<string>> {
		return this.track(async () => {
			return this.readLiveGroups(this.db, groups, since)
		})
	}

	/** Of `groups` (group keys), those whose record is live in `tx`'s view. */
	private readLiveGroups(
		tx: BetterSQLite3Database,
		groups: readonly string[],
		since?: number,
	): ReadonlySet<string> {
		const live = new Set<string>()
		for (const key of groups) {
			const parsed = parseGroupKey(key)
			if (!parsed || !this.schema?.collections[parsed.collection]) continue
			const rows = tx.all<{ id: string }>(
				sql`SELECT c.id AS id FROM ${sql.raw(quoteIdent(parsed.collection))} c
					WHERE c.id = ${parsed.id} AND COALESCE(c._deleted, 0) = 0
					AND NOT EXISTS (
						SELECT 1 FROM operations o
						WHERE o.collection = ${parsed.collection} AND o.record_id = c.id AND o.type = 'delete'
							AND o.delivery_seq > ${since ?? Number.MAX_SAFE_INTEGER}
					)`,
			)
			if (rows.length > 0) live.add(key)
		}
		return live
	}

	/**
	 * The record as currently stored, including a soft-deleted one (whose last field
	 * values are kept), or null when it was never written. Without a materialized
	 * table, the last known values are replayed from the operation log.
	 */
	/**
	 * The stored row a write is authorized against: the row on disk, unless the record's
	 * fold state was folded with another plan (a process still on the old plan during a
	 * rolling deploy). Then the row on disk is that plan's, and the write is judged
	 * against the record as this process's plan folds it, which is what `mergeIntoRecord`
	 * folds the write onto. Nothing is written. Call before the operation's own row exists.
	 */
	private readAuthorizationRow(
		tx: BetterSQLite3Database,
		collection: string,
		recordId: string,
	): MaterializedRecord | null {
		const collectionDef = this.schema?.collections[collection]
		if (collectionDef) {
			const plan = tx.all<{ plan: string | null }>(
				sql`SELECT plan FROM kora_fold_state WHERE collection = ${collection} AND record_id = ${recordId}`,
			)[0]?.plan
			if (plan && plan !== this.planStamp()) {
				return foldedStoredRow(
					recordId,
					this.readFoldState(tx, collection, recordId),
					collectionDef.fields,
					this.foldOptions,
					storedSqliteFieldValue,
				)
			}
		}
		return this.readStoredRow(tx, collection, recordId)
	}

	private readStoredRow(
		txOrDb: BetterSQLite3Database,
		collection: string,
		recordId: string,
	): MaterializedRecord | null {
		const collectionDef = this.schema?.collections[collection]
		if (collectionDef) {
			const rows = txOrDb.all<Record<string, unknown>>(
				sql`SELECT * FROM ${sql.raw(quoteIdent(collection))} WHERE id = ${recordId} LIMIT 1`,
			)
			const row = rows[0]
			return row ? this.deserializeRow(row, collectionDef) : null
		}
		const ops = this.readRecordOperations(txOrDb, collection, recordId, 0)
		if (ops.length === 0) return null
		const state = refoldRecord(ops, this.schema ?? EMPTY_FOLD_SCHEMA, this.foldOptions)
		const lastKnown = state ? projectFoldState(state, this.foldOptions) : null
		return { ...(lastKnown?.values ?? {}), id: recordId }
	}

	/**
	 * The fold state of a record that owns quarantined operations (RT-70): its stored
	 * state, or its kept row as a snapshot base, with every remaining operation of the
	 * record merged on top (`rebuildFromSnapshot`). Nothing is written.
	 */
	private rebuildAffected(
		txOrDb: BetterSQLite3Database,
		collection: string,
		recordId: string,
		stored: FoldState | null,
	): FoldState | null {
		const schema = this.schema ?? EMPTY_FOLD_SCHEMA
		const collectionDef = schema.collections[collection]
		const raw = collectionDef
			? txOrDb.all<Record<string, unknown>>(
					sql`SELECT * FROM ${sql.raw(quoteIdent(collection))} WHERE id = ${recordId} LIMIT 1`,
				)[0]
			: undefined
		let row: KeptRow | null = null
		if (raw && collectionDef) {
			const record = this.deserializeRow(raw, collectionDef)
			const values: Record<string, unknown> = {}
			for (const field of Object.keys(collectionDef.fields)) {
				if (record[field] !== undefined) values[field] = record[field]
			}
			row = {
				values,
				createdAt: Number(raw._created_at ?? 0),
				updatedAt: Number(raw._updated_at ?? 0),
				deleted: Number(raw._deleted) === 1,
			}
		}
		return rebuildFromSnapshot(
			{
				collection,
				recordId,
				stored,
				row,
				ops: this.readRecordOperations(txOrDb, collection, recordId, 0),
				quarantinedLatest: this.quarantine.latest.get(quarantineKey(collection, recordId)),
			},
			schema,
			this.foldOptions,
		)
	}

	async exportBackup(): Promise<Uint8Array> {
		return this.track(async () => {
			const { buildServerBackup } = await import('./server-backup')
			// Export in delivery-sequence (commit) order so a restore reassigns delivery
			// sequences causally; an implicit scan order must not be relied on.
			const rows = this.db.select().from(operations).orderBy(asc(operations.deliverySeq)).all()
			const deserialized = rows.map((row) => this.deserializeOperation(row))
			const vv = this.getVersionVector()

			return buildServerBackup(this.nodeId, deserialized, vv, await this.listEncryptionKeyRecords())
		})
	}

	async importBackup(
		data: Uint8Array,
		merge?: boolean,
	): Promise<{ operationsRestored: number; success: boolean }> {
		return this.track(async () => {
			const { mergeBackupOperations, parseServerBackup, restoreBackupKeyRecords } = await import(
				'./server-backup'
			)
			const { operations: ops, versionVector, keyRecords } = parseServerBackup(data)
			// Both modes reconcile the key table (not part of the log), record by record (RT-110).
			await restoreBackupKeyRecords(this, keyRecords, merge === true)

			if (merge) {
				const merged = await mergeBackupOperations(ops, (op) => this.applyRemoteOperation(op))
				return merged
			}
			// Behind any transaction in progress; access rules are out of force until the index
			// is rebuilt (for good, with the shared marker, if the restore fails after replacing).
			return this.writeGate.run(() =>
				this.accessIndex.hold(async (mutated) =>
					this.replaceFromBackup(ops, versionVector, mutated),
				),
			)
		})
	}

	private replaceFromBackup(
		ops: Operation[],
		versionVector: Map<string, number>,
		mutated: () => void,
	): { operationsRestored: number; success: boolean } {
		// Replace mode: DROP and recreate
		this.db.transaction((tx) => {
			// Restored rows are inserted unflagged (`seq_unique = 0`): they may hold legacy
			// duplicate sequences, and they sit at or below the new epoch, so they stay
			// outside the partial unique index and are judged by the append check.
			tx.run(sql.raw('DELETE FROM operations'))
			tx.run(sql.raw('DELETE FROM sync_state'))
			tx.update(deliveryCounter).set({ value: 0 }).where(eq(deliveryCounter.id, 1)).run()

			for (const [nid, seq] of versionVector) {
				tx.insert(syncState)
					.values({ nodeId: nid, maxSequenceNumber: seq, lastSeenAt: Date.now() })
					.run()
			}

			// Re-assign delivery sequence from scratch in backup order.
			let deliverySeq = 0
			for (const op of ops) {
				deliverySeq += 1
				const row = this.serializeOperation(op, Date.now(), deliverySeq)
				tx.insert(operations).values(row).run()
			}
			tx.update(deliveryCounter).set({ value: deliverySeq }).where(eq(deliveryCounter.id, 1)).run()
			// The restored log's legacy pairs (RT-48), and only the resolutions it covers:
			// one past a node's restored log was decided after the backup, and advertising
			// it would hide stored operations the restore lost (RT-45).
			tx.run(sql.raw('DELETE FROM sequence_pairs'))
			tx.run(sql.raw(BACKFILL_SEQUENCE_PAIRS_SQL))
			tx.run(sql.raw(PRUNE_RESOLUTIONS_PAST_LOG_SQL))
			// The restored log is a snapshot that may hold legacy duplicate sequences: it
			// all sits at or below the new epoch, and enforcement resumes above it.
			tx.run(
				sql`INSERT OR REPLACE INTO kora_server_meta (key, value) VALUES (${SEQUENCE_ENFORCEMENT_EPOCH_KEY}, ${String(deliverySeq)})`,
			)
			// The membership index belongs to the replaced log (its sequences no longer
			// exist): cleared with it, so even a crash before the rebuild below leaves no
			// stale interval, and the next start rebuilds it from the records.
			tx.run(sql`DELETE FROM _kora_access_memberships`)
			// The restored log has its own sequences: what was reserved before means nothing.
			tx.run(sql`DELETE FROM kora_server_meta WHERE key = ${ACCESS_FRONTIER_KEY}`)
			tx.run(sql`DELETE FROM kora_server_meta WHERE key = ${MEMBERSHIP_INDEX_FINGERPRINT_KEY}`)
			// A new generation re-scopes every device in full at its next handshake.
			tx.run(
				sql`INSERT OR REPLACE INTO kora_server_meta (key, value) VALUES (${ACCESS_INDEX_GENERATION_KEY}, ${newAccessIndexGeneration()})`,
			)
			// The records and their fold state belong to the replaced log too: cleared in the
			// same transaction, so a crash before the re-materialization below leaves no
			// pre-restore record behind (the next start folds every record from the restored
			// log, and would otherwise keep and index rows the restore removed).
			tx.run(sql.raw('DELETE FROM kora_fold_state'))
			for (const collection of Object.keys(this.schema?.collections ?? {})) {
				tx.run(sql.raw(`DELETE FROM ${quoteIdent(collection)}`))
			}
			// Refuse to judge access rules until the rebuild commits (also after a crash).
			this.writeRebuildingMarker(tx)
		})
		mutated()
		this.sequenceEpoch = this.ensureSequenceEnforcement()
		// Every restored record is re-materialized through the fold from the restored log.
		if (this.schema) this.foldMigration = this.rematerialize()
		this.backfillScopeSnapshots()
		// Rebuilt from the restored records (the replace transaction cleared it).
		this.reconcileMembershipIndex()

		return { operationsRestored: ops.length, success: true }
	}

	// ---------------------------------------------------------------------------
	// Materialization internals
	// ---------------------------------------------------------------------------

	/**
	 * Merge a just-appended operation (stored under `deliverySeq`) into its record's
	 * fold state and project the row, inside the append transaction. O(fields the
	 * operation touches): the stored state is read by primary key and the freshness
	 * check is one index probe, never a scan of the record's history (SRV-7).
	 *
	 * The stored state records the highest delivery sequence it covers. If another
	 * writer appended operations to this record without folding them (an older release
	 * during a rolling upgrade), the missing tail is merged first; if the stored state
	 * is unreadable, newer than the log, or built under an incompatible field kind,
	 * the record is re-folded from its log.
	 */
	private mergeIntoRecord(tx: BetterSQLite3Database, op: Operation, deliverySeq: number): void {
		const schema = this.schema
		if (!schema?.collections[op.collection]) return
		const stored = tx.all<{
			state: string
			covered_seq: number
			covered_op_id: string
			plan: string
		}>(
			sql`SELECT state, covered_seq, covered_op_id, plan FROM kora_fold_state WHERE collection = ${op.collection} AND record_id = ${op.recordId}`,
		)[0]
		// The record's newest operation before this one: the stored state is current iff
		// it covers exactly that operation (sequence AND id, so a state left behind by a
		// dropped or restored log is never mistaken for current).
		const last = tx.all<{ id: string; d: number }>(
			sql`SELECT id, delivery_seq AS d FROM operations WHERE collection = ${op.collection} AND record_id = ${op.recordId} AND delivery_seq < ${deliverySeq} ORDER BY delivery_seq DESC LIMIT 1`,
		)[0]
		const prior = Number(last?.d ?? 0)
		// A state folded with another plan (another process during a rolling deploy) is
		// re-folded with this one; '' is a state from before plans were recorded.
		const samePlan = !stored?.plan || stored.plan === this.planStamp()
		const parsed =
			stored && samePlan ? parseStoredFoldState(stored.state, op.collection, op.recordId) : null
		const covered = stored ? Number(stored.covered_seq) : 0
		let state: FoldState | null | typeof REFOLD_REQUIRED
		if (parsed && covered === prior && stored?.covered_op_id === (last?.id ?? '')) {
			state = mergeIntoFoldState(parsed, [op], schema, this.foldOptions)
		} else if (isQuarantineAffected(this.quarantine, op.collection, op.recordId)) {
			// Incomplete log (RT-70): fold onto the kept row, never from the log alone.
			state = this.rebuildAffected(tx, op.collection, op.recordId, parsed)
		} else if (!stored && !last) {
			state = mergeIntoFoldState(null, [op], schema, this.foldOptions)
		} else if (
			parsed &&
			covered > 0 &&
			covered < prior &&
			this.coversStoredOperation(tx, op.collection, op.recordId, covered, stored?.covered_op_id)
		) {
			// Operations appended without folding (an older release during a rolling
			// upgrade): merge the missing tail.
			state = mergeIntoFoldState(
				parsed,
				this.readRecordOperations(tx, op.collection, op.recordId, covered),
				schema,
				this.foldOptions,
			)
		} else {
			state = REFOLD_REQUIRED
		}
		if (state === REFOLD_REQUIRED) {
			state = refoldRecord(
				this.readRecordOperations(tx, op.collection, op.recordId, 0),
				schema,
				this.foldOptions,
			)
		}
		this.writeFoldedRecord(tx, op.collection, op.recordId, state, deliverySeq, op.id)
	}

	/** True when the record's operation at delivery sequence `seq` has id `opId`. */
	private coversStoredOperation(
		txOrDb: BetterSQLite3Database,
		collection: string,
		recordId: string,
		seq: number,
		opId: string | undefined,
	): boolean {
		if (!opId) return false
		return (
			txOrDb.all<{ one: number }>(
				sql`SELECT 1 AS one FROM operations WHERE id = ${opId} AND collection = ${collection} AND record_id = ${recordId} AND delivery_seq = ${seq}`,
			).length > 0
		)
	}

	/**
	 * The record's current fold state for a read: the stored one when it covers the
	 * record's whole log and was folded with this process's plan, else folded from the
	 * log (nothing is written). A state another plan folded (a process still on the old
	 * plan during a rolling deploy) is never used: `mergeIntoRecord` re-folds it, so a
	 * read, and above all the authorization preview, must see what that write stores.
	 */
	private readFoldState(
		txOrDb: BetterSQLite3Database,
		collection: string,
		recordId: string,
	): FoldState | null {
		const schema = this.schema ?? EMPTY_FOLD_SCHEMA
		if (schema.collections[collection]) {
			const stored = txOrDb.all<{
				state: string
				covered_seq: number
				covered_op_id: string
				plan: string | null
			}>(
				sql`SELECT state, covered_seq, covered_op_id, plan FROM kora_fold_state WHERE collection = ${collection} AND record_id = ${recordId}`,
			)[0]
			const last = txOrDb.all<{ id: string; d: number }>(
				sql`SELECT id, delivery_seq AS d FROM operations WHERE collection = ${collection} AND record_id = ${recordId} ORDER BY delivery_seq DESC LIMIT 1`,
			)[0]
			// As in mergeIntoRecord: '' is a state from before plans were recorded.
			const samePlan = !stored?.plan || stored.plan === this.planStamp()
			const parsed =
				stored && samePlan ? parseStoredFoldState(stored.state, collection, recordId) : null
			if (
				parsed &&
				Number(stored?.covered_seq) === Number(last?.d ?? 0) &&
				stored?.covered_op_id === (last?.id ?? '')
			) {
				return parsed
			}
			if (isQuarantineAffected(this.quarantine, collection, recordId)) {
				return this.rebuildAffected(txOrDb, collection, recordId, parsed)
			}
		}
		const ops = this.readRecordOperations(txOrDb, collection, recordId, 0)
		return ops.length > 0 ? refoldRecord(ops, schema, this.foldOptions) : null
	}

	/** A record's operations stored after `afterDeliverySeq`, in delivery order. */
	private readRecordOperations(
		txOrDb: BetterSQLite3Database,
		collection: string,
		recordId: string,
		afterDeliverySeq: number,
	): Operation[] {
		return txOrDb
			.select()
			.from(operations)
			.where(
				and(
					eq(operations.collection, collection),
					eq(operations.recordId, recordId),
					gt(operations.deliverySeq, afterDeliverySeq),
				),
			)
			.orderBy(asc(operations.deliverySeq))
			.all()
			.map((row) => this.deserializeOperation(row))
	}

	/**
	 * Persist a record's fold state (covering the log up to `coveredSeq`) and project
	 * it onto the materialized row.
	 */
	private writeFoldedRecord(
		txOrDb: BetterSQLite3Database,
		collection: string,
		recordId: string,
		state: FoldState | null,
		coveredSeq: number,
		coveredOpId: string,
	): void {
		const collectionDef = this.schema?.collections[collection]
		if (!collectionDef) return
		if (state) {
			txOrDb.run(
				sql`INSERT INTO kora_fold_state (collection, record_id, state, covered_seq, covered_op_id, plan)
					VALUES (${collection}, ${recordId}, ${serializeServerFoldState(state)}, ${coveredSeq}, ${coveredOpId}, ${this.planStamp()})
					ON CONFLICT (collection, record_id) DO UPDATE SET state = excluded.state, covered_seq = excluded.covered_seq, covered_op_id = excluded.covered_op_id, plan = excluded.plan`,
			)
		} else {
			// No state (nothing the plan makes of the log): a tombstone keeps the plan it was
			// folded with, so a process on another plan still finds and re-folds it.
			txOrDb.run(
				sql`INSERT INTO kora_fold_state (collection, record_id, state, covered_seq, covered_op_id, plan)
					VALUES (${collection}, ${recordId}, '', ${coveredSeq}, ${coveredOpId}, ${this.planStamp()})
					ON CONFLICT (collection, record_id) DO UPDATE SET state = excluded.state, covered_seq = excluded.covered_seq, covered_op_id = excluded.covered_op_id, plan = excluded.plan`,
			)
		}
		const row = state ? projectFoldState(state, this.foldOptions) : null
		if (!row) {
			// Never inserted (an update with no merged insert): no visible row. A row an
			// earlier (replay) materialization produced for it is hidden.
			txOrDb.run(
				sql`UPDATE ${sql.raw(quoteIdent(collection))} SET _deleted = 1 WHERE id = ${recordId}`,
			)
			return
		}
		this.upsertMaterializedRecord(
			txOrDb,
			collection,
			recordId,
			row.values,
			Object.keys(collectionDef.fields),
			collectionDef,
			row.createdAt,
			row.updatedAt,
			row.deleted,
		)
	}

	/**
	 * UPSERT a record into the materialized collection table.
	 * Uses INSERT ... ON CONFLICT (id) DO UPDATE SET for atomic upsert.
	 */
	private upsertMaterializedRecord(
		txOrDb: BetterSQLite3Database,
		tableName: string,
		recordId: string,
		recordData: Record<string, unknown>,
		fieldNames: string[],
		collectionDef: { fields: Record<string, import('@korajs/core').FieldDescriptor> },
		createdAt: number,
		updatedAt: number,
		deleted: boolean,
	): void {
		const allColumns = ['id', ...fieldNames, '_created_at', '_updated_at', '_deleted']
		const values: unknown[] = [
			recordId,
			...fieldNames.map((f) => {
				const descriptor = collectionDef.fields[f]
				return descriptor
					? serializeSqliteFieldValue(materializedFieldValue(recordData, f, descriptor), descriptor)
					: null
			}),
			createdAt,
			updatedAt,
			deleted ? 1 : 0,
		]

		const columnsSql = sql.raw(allColumns.map((c) => quoteIdent(c)).join(', '))
		const valuesSql = sql.join(
			values.map((v) => sql`${v}`),
			sql.raw(', '),
		)
		const updateSet = sql.raw(
			allColumns
				.slice(1)
				.map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)
				.join(', '),
		)

		txOrDb.run(
			sql`INSERT INTO ${sql.raw(quoteIdent(tableName))} (${columnsSql}) VALUES (${valuesSql}) ON CONFLICT (id) DO UPDATE SET ${updateSet}`,
		)
	}

	/**
	 * Re-materialization migration (W7 step 7), run by setSchema and after a
	 * replace-mode restore. Every record whose fold state is missing, stale (it covers
	 * less, or more, of the log than is stored) or built under a different fold plan
	 * (field kind, merge strategy, resolver) is re-folded from its log and its row
	 * rewritten; nothing else is touched, so a restart on an up-to-date database does
	 * one aggregate read.
	 *
	 * - Runs only on a log the W8b integrity scan reports clean. With quarantined rows,
	 *   rows materialized before the fold existed are kept as they are (re-folding a
	 *   log that lost operations would bake the loss in) and the skip is logged loudly;
	 *   such a record is folded from its remaining log on its next write. Records with
	 *   no row yet, and fold states this release already wrote, are still processed.
	 * - Idempotent and resumable: each batch commits on its own, and staleness is
	 *   re-derived from the tables at every start, so a crash resumes where it stopped.
	 *   A plan change first marks every stored state stale (one statement), then
	 *   records the new fingerprint, so it is resumable too.
	 */
	/**
	 * One-time migration of each collection table to the lossless text encoding (RT-65):
	 * rows written before it whose raw-string columns contain U+FFFF (the escape
	 * introducer) are re-encoded, so the decoder returns them unchanged.
	 */
	private migrateTextCodec(schema: SchemaDefinition): void {
		for (const [name, collection] of Object.entries(schema.collections)) {
			const key = `${PG_TEXT_CODEC_MIGRATION_KEY}${name}`
			this.db.transaction((tx) => {
				if (tx.all(sql`SELECT 1 AS one FROM kora_server_meta WHERE key = ${key}`).length > 0) return
				const textColumns = Object.entries(collection.fields)
					.filter(([, descriptor]) => isPgRawTextKind(descriptor.kind))
					.map(([field]) => quoteIdent(field))
				for (const statement of sqliteTextCodecMigrationSql(quoteIdent(name), textColumns)) {
					tx.run(sql.raw(statement))
				}
				tx.run(
					sql`INSERT OR IGNORE INTO kora_server_meta (key, value) VALUES (${key}, ${String(Date.now())})`,
				)
			})
		}
	}

	/**
	 * Write the beta.12 clears the ids prove into the stored bodies, once per database
	 * (RT-85, see `provenLegacyClears`), and mark their records' fold states stale.
	 */
	private async canonicalizeLegacyBodies(): Promise<void> {
		const done = this.db.all(
			sql`SELECT 1 AS one FROM kora_server_meta WHERE key = ${LEGACY_BODIES_META_KEY}`,
		)
		if (done.length > 0) return
		const rows = this.db
			.select()
			.from(operations)
			.where(
				and(
					eq(operations.type, 'update'),
					sql`${operations.hashVersion} IS NULL`,
					sql`${operations.previousData} IS NOT NULL`,
				),
			)
			.all()
		const changed = await provenLegacyClears(rows.map((row) => this.deserializeOperation(row)))
		this.db.transaction((tx) => {
			if (changed.length > 0) this.writeRebuildingMarker(tx)
			for (const op of changed) {
				tx.update(operations)
					.set({ data: JSON.stringify(op.data) })
					.where(eq(operations.id, op.id))
					.run()
				tx.run(
					sql`UPDATE kora_fold_state SET covered_seq = -1 WHERE collection = ${op.collection} AND record_id = ${op.recordId}`,
				)
			}
			tx.run(
				sql`INSERT OR IGNORE INTO kora_server_meta (key, value) VALUES (${LEGACY_BODIES_META_KEY}, ${String(changed.length)})`,
			)
		})
	}

	/**
	 * Re-folds `recordIds` of `collection` from their logs with this instance's plan, in one
	 * transaction.
	 */
	private refoldRecords(
		collection: string,
		recordIds: readonly string[],
		clean: boolean,
		report: FoldMigrationReport,
		indexChanges = false,
		onlyOnRecordedPlan = false,
	): void {
		const schema = this.schema
		if (!schema) return
		this.db.transaction(
			(tx) => {
				if (onlyOnRecordedPlan) {
					// Under the write lock (immediate): if another process recorded another plan
					// since the sweep looked, this one is the outdated one.
					const recorded = tx.all<{ value: string }>(
						sql`SELECT value FROM kora_server_meta WHERE key = ${FOLD_PLAN_FINGERPRINT_KEY}`,
					)[0]?.value
					if (recorded === undefined || planStampOf(recorded) !== this.planStamp()) return
				}
				// The membership index moves with the re-folded records, in this transaction, at
				// a delivery sequence of its own (like an index reconcile: no operation carries it).
				const indexAt = indexChanges ? this.nextDeliverySeq(tx) : null
				const groupsBefore = new Map<string, GroupRecordState>()
				if (indexAt !== null && writeAffectsGroupMembers(schema.access, collection)) {
					for (const recordId of recordIds) {
						groupsBefore.set(
							recordId,
							groupRecordState(this.readIndexedRecord(tx, collection, recordId)),
						)
					}
				}
				for (const recordId of recordIds) {
					const affected = !clean && isQuarantineAffected(this.quarantine, collection, recordId)
					const rows = tx
						.select()
						.from(operations)
						.where(and(eq(operations.collection, collection), eq(operations.recordId, recordId)))
						.all()
					let covered = 0
					let coveredOpId = ''
					for (const row of rows) {
						if ((row.deliverySeq ?? 0) > covered) {
							covered = row.deliverySeq ?? 0
							coveredOpId = row.id
						}
					}
					const ordered = [...rows].sort((x, y) => (x.deliverySeq ?? 0) - (y.deliverySeq ?? 0))
					const ops = ordered.map((row) => this.deserializeOperation(row))
					if (affected) {
						// Incomplete log (RT-70): the kept row is the base, never the log alone.
						const stored = tx.all<{ state: string }>(
							sql`SELECT state FROM kora_fold_state WHERE collection = ${collection} AND record_id = ${recordId}`,
						)[0]
						this.writeFoldedRecord(
							tx,
							collection,
							recordId,
							this.rebuildAffected(
								tx,
								collection,
								recordId,
								parseStoredFoldState(stored?.state, collection, recordId),
							),
							covered,
							coveredOpId,
						)
						report.skippedUnclean++
					} else {
						this.writeFoldedRecord(
							tx,
							collection,
							recordId,
							refoldRecord(ops, schema, this.foldOptions),
							covered,
							coveredOpId,
						)
						// The operations' scope snapshots follow this plan too (download filtering
						// overlays them on the record): replayed from the log like the record.
						const replayed = replayScopeSnapshots(
							schema,
							collection,
							recordId,
							ops,
							this.foldOptions,
						)
						for (const row of ordered) {
							const snapshot = replayed.get(row.id)
							if (!snapshot) continue
							tx.run(
								sql`UPDATE operations SET scope_snapshot = ${JSON.stringify(snapshot)} WHERE id = ${row.id}`,
							)
						}
					}
					report.records++
				}
				if (indexAt !== null) {
					for (const recordId of recordIds) {
						this.reconcileRecordMemberships(
							tx,
							collection,
							recordId,
							indexAt,
							groupsBefore.get(recordId) ?? null,
						)
					}
					tx.run(
						sql`INSERT OR REPLACE INTO kora_server_meta (key, value) VALUES (${ACCESS_FRONTIER_KEY}, ${String(indexAt)})`,
					)
				}
			},
			{ behavior: 'immediate' },
		)
	}

	/**
	 * Re-folds records another process folded with another plan (a rolling deploy that
	 * changed transforms or merge rules), when this process runs the plan the database
	 * records, so an old process never folds records back; the sync server calls it on
	 * every delivery poll.
	 *
	 * @returns How many records were re-folded
	 */
	async refoldOutdatedRecords(limit = FOLD_MIGRATION_BATCH): Promise<number> {
		return this.track(async () => {
			const schema = this.schema
			if (!schema) return 0
			const plan = this.planStamp()
			const collections = Object.keys(schema.collections)
			if (collections.length === 0) return 0
			// Only collections of this schema: a state of a dropped collection is never re-folded.
			// In key order from where the last batch ended, wrapping around at the end.
			const read = (
				position: { collection: string; recordId: string } | null,
			): { collection: string; record_id: string; recorded: string | null }[] => {
				const after =
					position === null
						? sql`1`
						: sql`(f.collection, f.record_id) > (${position.collection}, ${position.recordId})`
				return this.db.all<{ collection: string; record_id: string; recorded: string | null }>(
					sql`SELECT f.collection AS collection, f.record_id AS record_id,
						(SELECT value FROM kora_server_meta WHERE key = ${FOLD_PLAN_FINGERPRINT_KEY}) AS recorded
					FROM kora_fold_state f
					WHERE ((f.plan > '' AND f.plan < ${plan}) OR f.plan > ${plan})
						AND f.collection IN (${sql.join(
							collections.map((collection) => sql`${collection}`),
							sql`, `,
						)})
						AND ${after}
					ORDER BY f.collection, f.record_id
					LIMIT ${limit}`,
				)
			}
			const position = this.outdatedCursor.position()
			let rows = read(position)
			if (rows.length === 0 && position !== null) rows = read(null)
			if (rows.length === 0) return 0
			const recorded = rows[0]?.recorded ?? null
			if (recorded === null || planStampOf(recorded) !== plan) return 0
			this.outdatedCursor.advance(rows, limit)
			const byCollection = new Map<string, string[]>()
			for (const row of rows) {
				const list = byCollection.get(row.collection)
				if (list) list.push(row.record_id)
				else byCollection.set(row.collection, [row.record_id])
			}
			const report: FoldMigrationReport = {
				ran: true,
				records: 0,
				skippedUnclean: 0,
				fullRefold: false,
			}
			const clean = this.logIntegrity.totalQuarantined === 0
			const failed: string[] = []
			await this.writeGate.run(async () => {
				for (const [collection, targets] of byCollection) {
					const indexChanges = feedsMembershipIndex(schema.access, collection)
					const counted = { records: report.records, skippedUnclean: report.skippedUnclean }
					try {
						this.refoldRecords(collection, targets, clean, report, indexChanges, true)
					} catch {
						// The batch rolled back: none of it counts. One record that cannot be folded
						// (a transform throwing on it) must not keep the others back: each is folded
						// on its own, and a failure is reported.
						report.records = counted.records
						report.skippedUnclean = counted.skippedUnclean
						for (const recordId of targets) {
							const before = { records: report.records, skippedUnclean: report.skippedUnclean }
							try {
								this.refoldRecords(collection, [recordId], clean, report, indexChanges, true)
							} catch (error) {
								report.records = before.records
								report.skippedUnclean = before.skippedUnclean
								failed.push(`${collection}/${recordId}`)
								console.error(
									`[kora] Could not re-fold ${collection}/${recordId} with this process's fold plan; it keeps the values another process folded.`,
									error,
								)
							}
						}
					}
				}
			})
			if (failed.length > 0) {
				// Reported to the caller, so the sync server keeps checking (a transient failure
				// must not leave the records with the previous plan's values for good).
				throw new KoraError(
					`${failed.length} record(s) written under another fold plan could not be re-folded (${failed.slice(0, 5).join(', ')}${failed.length > 5 ? ', ...' : ''}); ${report.records} other(s) were.`,
					'REFOLD_INCOMPLETE',
					{ failed: failed.slice(0, 20), refolded: report.records },
				)
			}
			if (report.skippedUnclean > 0) {
				console.error(
					`[kora] Re-fold of records written under another fold plan: ${report.skippedUnclean} record(s) own quarantined operations, so their kept rows stay the base their operations fold onto (see operations_quarantine).`,
				)
			}
			return report.records
		})
	}

	/** A short stamp of this instance's fold plan (schema, transforms, authorities). */
	private planStamp(): string {
		const schema = this.schema
		if (!schema) return ''
		const cached = this.planStampCache
		if (
			cached &&
			cached.schema === schema &&
			cached.transforms === this.operationTransforms &&
			cached.authorities === this.explicitAuthorities
		) {
			return cached.value
		}
		const value = planStampOf(
			serverFoldPlanFingerprint(schema, this.explicitAuthorities, this.operationTransforms),
		)
		this.planStampCache = {
			schema,
			transforms: this.operationTransforms,
			authorities: this.explicitAuthorities,
			value,
		}
		return value
	}

	private rematerialize(): FoldMigrationReport {
		const schema = this.schema
		const report: FoldMigrationReport = {
			ran: true,
			records: 0,
			skippedUnclean: 0,
			fullRefold: false,
		}
		if (!schema) return { ...report, ran: false }
		const clean = this.logIntegrity.totalQuarantined === 0
		const fingerprint = serverFoldPlanFingerprint(
			schema,
			this.explicitAuthorities,
			this.operationTransforms,
		)
		const storedFingerprint = this.db.all<{ value: string }>(
			sql`SELECT value FROM kora_server_meta WHERE key = ${FOLD_PLAN_FINGERPRINT_KEY}`,
		)[0]?.value
		if (storedFingerprint !== fingerprint) {
			report.fullRefold = storedFingerprint !== undefined
			this.db.transaction((tx) => {
				// Every instance on this database waits for the index rebuild that follows.
				this.writeRebuildingMarker(tx)
				tx.run(sql`UPDATE kora_fold_state SET covered_seq = -1`)
				tx.run(
					sql`INSERT OR REPLACE INTO kora_server_meta (key, value) VALUES (${FOLD_PLAN_FINGERPRINT_KEY}, ${fingerprint})`,
				)
			})
		}
		const progress = new FoldMigrationProgress('Fold re-materialization')
		for (const collection of Object.keys(schema.collections)) {
			let cursor = ''
			for (;;) {
				const page = this.db.all<{
					record_id: string
					max_seq: number
					op_count: number
					covered: number | null
					has_row: number
				}>(
					sql`SELECT o.record_id AS record_id, MAX(o.delivery_seq) AS max_seq, COUNT(*) AS op_count,
						(SELECT f.covered_seq FROM kora_fold_state f WHERE f.collection = o.collection AND f.record_id = o.record_id) AS covered,
						(SELECT f.covered_op_id FROM kora_fold_state f WHERE f.collection = o.collection AND f.record_id = o.record_id) AS covered_op_id,
						(SELECT f.plan FROM kora_fold_state f WHERE f.collection = o.collection AND f.record_id = o.record_id) AS fold_plan,
						EXISTS (SELECT 1 FROM ${sql.raw(quoteIdent(collection))} c WHERE c.id = o.record_id) AS has_row
					FROM operations o
					WHERE o.collection = ${collection} AND o.record_id > ${cursor}
					GROUP BY o.record_id
					HAVING covered IS NULL OR covered <> MAX(o.delivery_seq) OR NOT EXISTS (
						SELECT 1 FROM operations x WHERE x.id = covered_op_id AND x.delivery_seq = covered
					) OR (fold_plan <> '' AND fold_plan <> ${this.planStamp()})
					ORDER BY o.record_id
					LIMIT ${FOLD_MIGRATION_BATCH}`,
				)
				if (page.length === 0) break
				cursor = page[page.length - 1]?.record_id ?? cursor
				// Bounded transactions (FOLD_MIGRATION_BATCH_OPERATIONS), each committing its
				// records whole: a killed process resumes at the first record still stale.
				for (const batch of batchesByOperations(page, (row) => Number(row.op_count))) {
					this.accessIndex.renewIfDue()
					const before = report.records
					this.refoldRecords(
						collection,
						batch.map((candidate) => candidate.record_id),
						clean,
						report,
					)
					// The page holds stale records only (the query filters them), so the line
					// counts re-folded records without a total.
					progress.advance(batch.length, report.records - before)
					if (progress.due()) progress.report()
				}
				if (page.length < FOLD_MIGRATION_BATCH) break
			}
			// Affected records with no remaining operation at all (every one quarantined,
			// the insert included): the kept row is their whole history.
			if (!clean) {
				this.db.transaction((tx) => {
					const orphans = tx.all<{ id: string }>(
						sql`SELECT c.id AS id FROM ${sql.raw(quoteIdent(collection))} c
							WHERE NOT EXISTS (SELECT 1 FROM kora_fold_state f WHERE f.collection = ${collection} AND f.record_id = c.id)
							AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.collection = ${collection} AND o.record_id = c.id)`,
					)
					for (const { id } of orphans) {
						if (!isQuarantineAffected(this.quarantine, collection, id)) continue
						const state = this.rebuildAffected(tx, collection, id, null)
						if (!state) continue
						this.writeFoldedRecord(tx, collection, id, state, 0, '')
						report.skippedUnclean++
						report.records++
					}
				})
			}
		}
		progress.finish()
		if (report.skippedUnclean > 0) {
			console.error(
				`[kora] Fold re-materialization: ${report.skippedUnclean} record(s) own quarantined operations (${this.logIntegrity.totalQuarantined} quarantined row(s), see operations_quarantine). Their log is incomplete, so their pre-fold rows were kept as the base their remaining and later operations fold onto. Repair or release the quarantined rows to restore their exact history.`,
			)
		}
		return report
	}

	// ---------------------------------------------------------------------------
	// Query building
	// ---------------------------------------------------------------------------

	private buildSelectQuery(
		collection: string,
		options?: CollectionQueryOptions,
		source: SQL = sql.raw(quoteIdent(collection)),
	): SQL {
		const whereClause = this.buildWhereClause(
			options?.where ?? {},
			options?.includeDeleted ?? false,
			this.schema?.collections[collection],
		)

		const parts: SQL[] = [sql`SELECT * FROM ${source} WHERE ${whereClause}`]

		if (options?.orderBy) {
			const dir = options.orderDirection === 'desc' ? 'DESC' : 'ASC'
			parts.push(sql.raw(` ORDER BY ${quoteIdent(options.orderBy)} ${dir}`))
		}

		if (options?.limit !== undefined) {
			parts.push(sql` LIMIT ${options.limit}`)
		}

		if (options?.offset !== undefined) {
			parts.push(sql` OFFSET ${options.offset}`)
		}

		return sql.join(parts, sql.raw(''))
	}

	private buildWhereClause(
		where: Record<string, unknown>,
		includeDeleted: boolean,
		collectionDef?: { fields: Record<string, import('@korajs/core').FieldDescriptor> },
	): SQL {
		const conditions: SQL[] = []

		if (!includeDeleted) {
			conditions.push(sql.raw('_deleted = 0'))
		}

		for (const [key, value] of Object.entries(where)) {
			// Raw-string columns hold the lossless encoding (RT-65): filter on it too.
			const kind = collectionDef?.fields[key]?.kind
			const param =
				kind && isPgRawTextKind(kind) && typeof value === 'string' ? encodePgText(value) : value
			conditions.push(sql`${sql.raw(quoteIdent(key))} = ${param}`)
		}

		if (conditions.length === 0) {
			return sql.raw('1 = 1')
		}

		return sql.join(conditions, sql.raw(' AND '))
	}

	// ---------------------------------------------------------------------------
	// Row deserialization
	// ---------------------------------------------------------------------------

	private deserializeRow(
		row: Record<string, unknown>,
		collectionDef: { fields: Record<string, import('@korajs/core').FieldDescriptor> },
	): MaterializedRecord {
		const record: MaterializedRecord = { id: row.id as string }

		for (const [fieldName, descriptor] of Object.entries(collectionDef.fields)) {
			if (fieldName in row) {
				record[fieldName] = deserializeSqliteFieldValue(row[fieldName], descriptor)
			}
		}

		// Include metadata fields
		if ('_created_at' in row) record._created_at = row._created_at
		if ('_updated_at' in row) record._updated_at = row._updated_at
		// A soft-deleted row (only returned when deleted rows are asked for) says so, so a
		// caller never mistakes the last values the fold keeps on it for a live record.
		if (Number(row._deleted) === 1) record._deleted = 1

		return record
	}

	// ---------------------------------------------------------------------------
	// Fallback materialization (operation replay, no schema)
	// ---------------------------------------------------------------------------

	private materializeFromOpsLog(collection: string): MaterializedRecord[] {
		const ids = this.db.all<{ record_id: string }>(
			sql`SELECT DISTINCT record_id FROM operations WHERE collection = ${collection} ORDER BY record_id`,
		)
		const records: MaterializedRecord[] = []
		for (const { record_id: recordId } of ids) {
			const ops = this.readRecordOperations(this.db, collection, recordId, 0)
			const state = refoldRecord(ops, this.schema ?? EMPTY_FOLD_SCHEMA, this.foldOptions)
			const row = state ? projectFoldState(state, this.foldOptions) : null
			if (row && !row.deleted) records.push({ id: recordId, ...row.values })
		}
		return records
	}

	// ---------------------------------------------------------------------------
	// Table setup
	// ---------------------------------------------------------------------------

	/**
	 * Create the operations and sync_state tables if they don't exist.
	 */
	private ensureTables(): void {
		this.db.run(sql`
			CREATE TABLE IF NOT EXISTS operations (
				id TEXT PRIMARY KEY,
				node_id TEXT NOT NULL,
				type TEXT NOT NULL,
				collection TEXT NOT NULL,
				record_id TEXT NOT NULL,
				data TEXT,
				previous_data TEXT,
				atomic_ops TEXT,
				wall_time INTEGER NOT NULL,
				logical INTEGER NOT NULL,
				timestamp_node_id TEXT NOT NULL,
				sequence_number INTEGER NOT NULL,
				causal_deps TEXT NOT NULL DEFAULT '[]',
				schema_version INTEGER NOT NULL,
				received_at INTEGER NOT NULL
			)
		`)

		// Backward-compatible migration: add atomic_ops to operation logs created
		// before atomic-op persistence. Nullable, so existing rows read as "no atomic
		// ops" and keep materializing by last-write-wins exactly as before. SQLite has
		// no ADD COLUMN IF NOT EXISTS, so tolerate the duplicate-column error on re-run.
		try {
			this.db.run(sql`ALTER TABLE operations ADD COLUMN atomic_ops TEXT`)
		} catch (e) {
			const msg = e instanceof Error ? e.message : ''
			const causeMsg = e instanceof Error && e.cause instanceof Error ? e.cause.message : ''
			if (!msg.includes('duplicate column') && !causeMsg.includes('duplicate column')) {
				throw e
			}
		}

		// Backward-compatible migration: add the delivery_seq column for the gap-free
		// delivery watermark. SQLite has no ADD COLUMN IF NOT EXISTS, so tolerate the
		// duplicate-column error on re-run.
		try {
			this.db.run(sql`ALTER TABLE operations ADD COLUMN delivery_seq INTEGER`)
		} catch (e) {
			const msg = e instanceof Error ? e.message : ''
			const causeMsg = e instanceof Error && e.cause instanceof Error ? e.cause.message : ''
			if (!msg.includes('duplicate column') && !causeMsg.includes('duplicate column')) {
				throw e
			}
		}

		// Backward-compatible migration: the per-operation scope snapshot (RT-14). Rows
		// written before it are backfilled from the log when the schema is set.
		try {
			this.db.run(sql`ALTER TABLE operations ADD COLUMN scope_snapshot TEXT`)
		} catch (e) {
			const msg = e instanceof Error ? e.message : ''
			const causeMsg = e instanceof Error && e.cause instanceof Error ? e.cause.message : ''
			if (!msg.includes('duplicate column') && !causeMsg.includes('duplicate column')) {
				throw e
			}
		}

		// Backward-compatible migration (RT-37): the sole-holder flag behind the partial
		// unique index. Existing rows read 0 (outside the index; the append check still
		// judges them as holders).
		try {
			this.db.run(sql`ALTER TABLE operations ADD COLUMN seq_unique INTEGER NOT NULL DEFAULT 0`)
		} catch (e) {
			const msg = e instanceof Error ? e.message : ''
			const causeMsg = e instanceof Error && e.cause instanceof Error ? e.cause.message : ''
			if (!msg.includes('duplicate column') && !causeMsg.includes('duplicate column')) {
				throw e
			}
		}

		// Content-hash version of the stored id (CORE-1, protocol v2). Null means 1.
		try {
			this.db.run(sql`ALTER TABLE operations ADD COLUMN hash_version INTEGER`)
		} catch (e) {
			const msg = e instanceof Error ? e.message : ''
			const causeMsg = e instanceof Error && e.cause instanceof Error ? e.cause.message : ''
			if (!msg.includes('duplicate column') && !causeMsg.includes('duplicate column')) {
				throw e
			}
		}

		// Encryption envelope of the operation (protocol v2), stored opaquely (JSON).
		try {
			this.db.run(sql`ALTER TABLE operations ADD COLUMN encrypted TEXT`)
		} catch (e) {
			const msg = e instanceof Error ? e.message : ''
			const causeMsg = e instanceof Error && e.cause instanceof Error ? e.cause.message : ''
			if (!msg.includes('duplicate column') && !causeMsg.includes('duplicate column')) {
				throw e
			}
		}

		this.db.run(sql`
			CREATE INDEX IF NOT EXISTS idx_node_seq ON operations (node_id, sequence_number)
		`)
		// Per-record fold state (W7): the materialized row is projected from it.
		// `covered_seq` / `covered_op_id`: the delivery sequence and id of the record's
		// newest operation merged into it (the state covers every operation up to it).
		this.db.run(sql`
			CREATE TABLE IF NOT EXISTS kora_fold_state (
				collection TEXT NOT NULL,
				record_id TEXT NOT NULL,
				state TEXT NOT NULL,
				covered_seq INTEGER NOT NULL,
				covered_op_id TEXT NOT NULL DEFAULT '',
				PRIMARY KEY (collection, record_id)
			)
		`)
		// A pre-release table may lack it; '' never matches an operation id, so such a
		// state is re-folded on its next use.
		try {
			this.db.run(
				sql`ALTER TABLE kora_fold_state ADD COLUMN covered_op_id TEXT NOT NULL DEFAULT ''`,
			)
		} catch (e) {
			const msg = e instanceof Error ? e.message : ''
			const causeMsg = e instanceof Error && e.cause instanceof Error ? e.cause.message : ''
			if (!msg.includes('duplicate column') && !causeMsg.includes('duplicate column')) {
				throw e
			}
		}
		// The fold plan a state was folded with (a short stamp; '' before it was kept): a
		// state of another plan is re-folded (rolling deploys, see refoldOutdatedRecords).
		try {
			this.db.run(sql`ALTER TABLE kora_fold_state ADD COLUMN plan TEXT NOT NULL DEFAULT ''`)
		} catch (e) {
			const msg = e instanceof Error ? e.message : ''
			const causeMsg = e instanceof Error && e.cause instanceof Error ? e.cause.message : ''
			if (!msg.includes('duplicate column') && !causeMsg.includes('duplicate column')) {
				throw e
			}
		}
		this.db.run(sql`CREATE INDEX IF NOT EXISTS kora_fold_state_plan ON kora_fold_state (plan)`)
		// Blob content hash -> principals that pushed (or first claimed) it (RT-11).
		this.db.run(sql`
			CREATE TABLE IF NOT EXISTS blob_owners (
				hash TEXT NOT NULL,
				owner TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (hash, owner)
			)
		`)

		// Small key/value store for server-side metadata (snapshot fingerprint, RT-20).
		this.db.run(sql`
			CREATE TABLE IF NOT EXISTS kora_server_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
		`)

		// Wrapped end-to-end encryption key records (ENC-1, D4b): salt, KDF parameters and
		// wrapped keys per (owner, keyring). Never a usable key.
		this.db.run(sql`
			CREATE TABLE IF NOT EXISTS kora_encryption_keys (
				owner TEXT NOT NULL,
				keyring TEXT NOT NULL,
				revision INTEGER NOT NULL,
				record TEXT NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (owner, keyring)
			)
		`)

		// Node id -> principal binding (see claimNode). One row per device node id.
		this.db.run(sql`
			CREATE TABLE IF NOT EXISTS node_claims (
				node_id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				claimed_at INTEGER NOT NULL
			)
		`)

		this.db.run(sql`
			CREATE INDEX IF NOT EXISTS idx_delivery_seq ON operations (delivery_seq)
		`)

		this.db.run(sql`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_seq_unique
			ON operations (delivery_seq)
			WHERE delivery_seq IS NOT NULL
		`)

		this.db.run(sql`
			CREATE INDEX IF NOT EXISTS idx_collection ON operations (collection)
		`)

		this.db.run(sql`
			CREATE INDEX IF NOT EXISTS idx_received ON operations (received_at)
		`)

		// Index for efficient per-record operation lookups during materialization
		this.db.run(sql`
			CREATE INDEX IF NOT EXISTS idx_collection_record ON operations (collection, record_id)
		`)
		// A record's newest delivery sequence in one probe (the fold freshness check).
		this.db.run(sql`
			CREATE INDEX IF NOT EXISTS idx_collection_record_delivery ON operations (collection, record_id, delivery_seq)
		`)

		this.db.run(sql`
			CREATE TABLE IF NOT EXISTS sync_state (
				node_id TEXT PRIMARY KEY,
				max_sequence_number INTEGER NOT NULL,
				last_seen_at INTEGER NOT NULL
			)
		`)

		this.db.run(sql`
			CREATE TABLE IF NOT EXISTS delivery_counter (
				id INTEGER PRIMARY KEY,
				value INTEGER NOT NULL
			)
		`)

		// How uploaded operations were resolved without being stored under their sequence
		// (validator `ignore`, terminal refusal, renumbered duplicate; RT-43, RT-47).
		this.db.run(sql`
			CREATE TABLE IF NOT EXISTS operation_resolutions (
				op_id TEXT PRIMARY KEY,
				node_id TEXT NOT NULL,
				sequence_number INTEGER NOT NULL,
				outcome TEXT NOT NULL,
				code TEXT,
				message TEXT,
				resolved_at INTEGER NOT NULL
			)
		`)
		this.db.run(sql`
			CREATE INDEX IF NOT EXISTS idx_resolutions_node_seq
			ON operation_resolutions (node_id, sequence_number)
		`)
		// The membership index (access rules): one row per membership interval. The
		// `_kora_` prefix cannot collide with a collection table (collection names start
		// with a letter).
		this.db.run(sql`
			CREATE TABLE IF NOT EXISTS _kora_access_memberships (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id TEXT NOT NULL,
				group_key TEXT NOT NULL,
				source TEXT NOT NULL,
				record_id TEXT NOT NULL,
				role TEXT NOT NULL,
				expires_at INTEGER,
				joined_seq INTEGER NOT NULL,
				role_seq INTEGER,
				left_seq INTEGER
			)
		`)
		// role_seq arrived after the table first shipped (canaries): add it to older
		// databases.
		const membershipColumns = this.db.all<{ name: string }>(
			sql`PRAGMA table_info(_kora_access_memberships)`,
		)
		if (!membershipColumns.some((column) => column.name === 'role_seq')) {
			this.db.run(sql`ALTER TABLE _kora_access_memberships ADD COLUMN role_seq INTEGER`)
		}
		// NULL role_seq (rows indexed before the column) is resolved by the next reconcile.
		this.db.run(sql`
			CREATE INDEX IF NOT EXISTS _kora_access_memberships_user
			ON _kora_access_memberships (user_id, left_seq)
		`)
		this.db.run(sql`
			CREATE INDEX IF NOT EXISTS _kora_access_memberships_record
			ON _kora_access_memberships (record_id) WHERE left_seq IS NULL
		`)
		this.db.run(sql`
			CREATE INDEX IF NOT EXISTS _kora_access_memberships_group
			ON _kora_access_memberships (group_key) WHERE left_seq IS NULL
		`)
		this.db.run(sql`
			CREATE UNIQUE INDEX IF NOT EXISTS _kora_access_memberships_open
			ON _kora_access_memberships (user_id, group_key, source, record_id)
			WHERE left_seq IS NULL
		`)

		// (node, sequence) held by more than one operation: legacy pairs (RT-48).
		this.db.run(sql`
			CREATE TABLE IF NOT EXISTS sequence_pairs (
				node_id TEXT NOT NULL,
				sequence_number INTEGER NOT NULL,
				PRIMARY KEY (node_id, sequence_number)
			)
		`)

		this.backfillDeliverySequence()
		this.sequenceEpoch = this.ensureSequenceEnforcement()
		this.backfillSequencePairs()
		this.logIntegrity = this.scanLogIntegrityOnce()
		this.quarantine = buildQuarantineScope(
			this.db
				.all<{ row_json: string }>(sql`SELECT row_json FROM operations_quarantine`)
				.map((row) => row.row_json),
		)
	}

	/**
	 * The startup log-integrity scan's result (W8 step 0): rows that could not be read
	 * back into an operation are moved to `operations_quarantine` once per database,
	 * before any fold reads them.
	 */
	getLogIntegrityReport(): ServerLogIntegrityReport {
		return { ...this.logIntegrity, quarantined: [...this.logIntegrity.quarantined] }
	}

	private scanLogIntegrityOnce(): ServerLogIntegrityReport {
		this.db.run(sql.raw(SERVER_LOG_QUARANTINE_DDL))
		const report: ServerLogIntegrityReport = {
			checkedRows: 0,
			quarantined: [],
			ran: false,
			totalQuarantined: 0,
		}
		const done = this.db.all<{ value: string }>(
			sql`SELECT value FROM kora_server_meta WHERE key = ${SERVER_LOG_INTEGRITY_META_KEY}`,
		)
		if (done.length === 0) {
			report.ran = true
			const bad: Array<{
				rowid: number
				row: ServerOperationRow
				problem: string
				detail: string
			}> = []
			let after = 0
			for (;;) {
				const page = this.db.all<ServerOperationRow & { __rowid: number }>(
					sql`SELECT rowid AS __rowid, id, node_id, type, collection, record_id, data, previous_data, atomic_ops, wall_time, logical, timestamp_node_id, sequence_number, causal_deps, schema_version FROM operations WHERE rowid > ${after} ORDER BY rowid LIMIT 1000`,
				)
				for (const { __rowid, ...row } of page) {
					report.checkedRows++
					const verdict = checkServerOperationRow(row)
					if (verdict) bad.push({ rowid: __rowid, row, ...verdict })
				}
				if (page.length < 1000) break
				after = page[page.length - 1]?.__rowid ?? after
			}
			const now = Date.now()
			this.db.transaction((tx) => {
				for (const entry of bad) {
					const id = typeof entry.row.id === 'string' ? entry.row.id : `rowid:${entry.rowid}`
					tx.run(
						sql`INSERT OR REPLACE INTO operations_quarantine (id, problem, detail, row_json, quarantined_at) VALUES (${id}, ${entry.problem}, ${entry.detail}, ${quarantineRowJson(entry.row)}, ${now})`,
					)
					tx.run(sql`DELETE FROM operations WHERE rowid = ${entry.rowid}`)
					report.quarantined.push({ operationId: id, problem: entry.problem, detail: entry.detail })
				}
				tx.run(
					sql`INSERT OR REPLACE INTO kora_server_meta (key, value) VALUES (${SERVER_LOG_INTEGRITY_META_KEY}, ${String(now)})`,
				)
			})
			if (bad.length > 0) {
				console.warn(
					`[kora] Log integrity: ${bad.length} unreadable operation row(s) moved to operations_quarantine.`,
				)
			}
		}
		const total = this.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM operations_quarantine`)
		report.totalQuarantined = Number(total[0]?.n ?? 0)
		return report
	}

	/**
	 * Index the legacy pairs already in the log once (history written before the
	 * `sequence_pairs` table existed); appends maintain it from then on.
	 */
	private backfillSequencePairs(): void {
		this.db.transaction((tx) => {
			const done = tx.all<{ value: string }>(
				sql`SELECT value FROM kora_server_meta WHERE key = ${SEQUENCE_PAIRS_BACKFILLED_KEY}`,
			)
			if (done.length > 0) return
			tx.run(sql.raw(BACKFILL_SEQUENCE_PAIRS_SQL))
			tx.run(
				sql`INSERT OR REPLACE INTO kora_server_meta (key, value) VALUES (${SEQUENCE_PAIRS_BACKFILLED_KEY}, '1')`,
			)
		})
	}

	/**
	 * Record the sequence-enforcement epoch on the first start of this release (the log's
	 * highest delivery sequence then; see {@link SEQUENCE_ENFORCEMENT_EPOCH_KEY}) and
	 * back the append check with the partial unique index over sole-holder rows
	 * ({@link NODE_SEQ_UNIQUE_INDEX}), which therefore always exists: a legacy duplicate
	 * pair is stored unflagged. Replaces the earlier indexes (a full one, created only
	 * when the log had no duplicates, and one over the rows past the epoch, which a
	 * legacy client's pair would violate). Runs in one write transaction, so stores
	 * sharing a file agree on the epoch.
	 */
	private ensureSequenceEnforcement(): number {
		return this.db.transaction((tx) => {
			tx.run(
				sql`INSERT OR IGNORE INTO kora_server_meta (key, value)
					SELECT ${SEQUENCE_ENFORCEMENT_EPOCH_KEY}, CAST(COALESCE(MAX(delivery_seq), 0) AS TEXT) FROM operations`,
			)
			const stored = tx.all<{ value: string }>(
				sql`SELECT value FROM kora_server_meta WHERE key = ${SEQUENCE_ENFORCEMENT_EPOCH_KEY}`,
			)[0]?.value
			// Absent only if the row could not be written: enforce everything (epoch 0).
			const epoch = stored === undefined ? 0 : Number(stored)
			if (!Number.isSafeInteger(epoch) || epoch < 0) {
				throw new Error(
					`kora_server_meta.${SEQUENCE_ENFORCEMENT_EPOCH_KEY} holds "${String(stored)}", not a delivery sequence. Restore it from a backup or delete the row to re-derive it.`,
				)
			}
			for (const superseded of SUPERSEDED_NODE_SEQ_UNIQUE_INDEXES) {
				tx.run(sql.raw(`DROP INDEX IF EXISTS ${superseded}`))
			}
			// A row is flagged only when nothing held its sequence at insert, so flagged
			// duplicates can come only from outside writes (a manual edit, an older release
			// writing into this file). Before (re)creating the index, unflag them: they stay
			// stored and judged by the append check, and the index creation cannot fail.
			const indexed = tx.all<{ name: string }>(
				sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ${NODE_SEQ_UNIQUE_INDEX}`,
			)
			if (indexed.length === 0) {
				tx.run(sql`
					UPDATE operations SET seq_unique = 0
					WHERE seq_unique = 1 AND EXISTS (
						SELECT 1 FROM operations other
						WHERE other.node_id = operations.node_id
							AND other.sequence_number = operations.sequence_number
							AND other.id <> operations.id
					)
				`)
			}
			tx.run(
				sql.raw(
					`CREATE UNIQUE INDEX IF NOT EXISTS ${NODE_SEQ_UNIQUE_INDEX} ON operations (node_id, sequence_number) WHERE seq_unique = 1`,
				),
			)
			return epoch
		})
	}

	/**
	 * Assign delivery sequences to any operations written before the column existed,
	 * then seed the durable counter from the current max. Ordered by
	 * (received_at, sequence_number, id) so the backfill is deterministic and stable
	 * across restarts. A one-time migration: after it runs, all rows have a value.
	 */
	private backfillDeliverySequence(): void {
		this.db.transaction((tx) => {
			const maxRow = tx.all<{ m: number | null }>(
				sql`SELECT MAX(delivery_seq) AS m FROM operations`,
			)
			let next = maxRow[0]?.m ?? 0
			const nullRows = tx.all<{ id: string }>(
				sql`SELECT id FROM operations WHERE delivery_seq IS NULL ORDER BY received_at ASC, sequence_number ASC, id ASC`,
			)
			for (const row of nullRows) {
				next += 1
				tx.run(sql`UPDATE operations SET delivery_seq = ${next} WHERE id = ${row.id}`)
			}
			tx.insert(deliveryCounter)
				.values({ id: 1, value: next })
				.onConflictDoUpdate({
					target: deliveryCounter.id,
					set: {
						value: sql`MAX(${deliveryCounter.value}, ${next})`,
					},
				})
				.run()
		})
	}

	/**
	 * Reserve the next delivery sequence inside the append transaction. SQLite locks
	 * the database for the write transaction, and this counter row keeps sequence
	 * allocation shared by every SqliteServerStore instance using the same file.
	 */
	/**
	 * Reads the index generation and the rebuild markers inside `tx` (under the write
	 * lock) into this instance's view, so a write is judged, and what it triggers relayed,
	 * against the index state another process sharing the file committed.
	 */
	private refreshAccessIndexView(tx: BetterSQLite3Database): void {
		if (!this.schema?.access) return
		const readToken = this.accessIndex.beginRead()
		const meta = tx.all<{ key: string; value: string }>(
			sql`SELECT key, value FROM kora_server_meta WHERE key = ${ACCESS_INDEX_GENERATION_KEY}
				OR substr(key, 1, ${ACCESS_INDEX_REBUILDING_PREFIX.length}) = ${ACCESS_INDEX_REBUILDING_PREFIX}`,
		)
		this.accessIndex.seen(
			meta.find((row) => row.key === ACCESS_INDEX_GENERATION_KEY)?.value ?? null,
			meta.some((row) => row.key.startsWith(ACCESS_INDEX_REBUILDING_PREFIX)),
			readToken,
		)
	}

	private nextDeliverySeq(tx: BetterSQLite3Database): number {
		this.refreshAccessIndexView(tx)
		const rows = tx
			.update(deliveryCounter)
			.set({ value: sql`${deliveryCounter.value} + 1` })
			.where(eq(deliveryCounter.id, 1))
			.returning({ value: deliveryCounter.value })
			.all()
		const value = rows[0]?.value
		if (value === undefined || value === null) {
			throw new Error(
				'delivery_counter row (id=1) is missing; the operations log cannot assign delivery sequences',
			)
		}
		return value
	}

	// ---------------------------------------------------------------------------
	// Operation serialization
	// ---------------------------------------------------------------------------

	/**
	 * @param soleHolder - Nothing else held the (node, sequence) at insert: the row is
	 *   flagged `seq_unique` and covered by {@link NODE_SEQ_UNIQUE_INDEX}. False for a
	 *   legacy pair's second operation and for restored backup rows.
	 */
	private serializeOperation(
		op: Operation,
		receivedAt: number,
		deliverySeq: number,
		soleHolder = false,
	): typeof operations.$inferInsert {
		return {
			id: op.id,
			nodeId: op.nodeId,
			type: op.type,
			collection: op.collection,
			recordId: op.recordId,
			data: op.data !== null ? JSON.stringify(op.data) : null,
			previousData: op.previousData !== null ? JSON.stringify(op.previousData) : null,
			atomicOps:
				op.atomicOps && Object.keys(op.atomicOps).length > 0 ? JSON.stringify(op.atomicOps) : null,
			wallTime: op.timestamp.wallTime,
			logical: op.timestamp.logical,
			timestampNodeId: op.timestamp.nodeId,
			sequenceNumber: op.sequenceNumber,
			causalDeps: JSON.stringify(op.causalDeps),
			schemaVersion: op.schemaVersion,
			receivedAt,
			deliverySeq,
			seqUnique: soleHolder ? 1 : 0,
			hashVersion: op.hashVersion ?? null,
			encrypted: envelopeColumn(op),
		}
	}

	private deserializeOperation(row: typeof operations.$inferSelect): Operation {
		const atomicOps =
			row.atomicOps != null ? (JSON.parse(row.atomicOps) as Record<string, AtomicOp>) : undefined
		const encrypted = parseEnvelopeColumn(row.encrypted)
		return {
			id: row.id,
			nodeId: row.nodeId,
			type: row.type as Operation['type'],
			collection: row.collection,
			recordId: row.recordId,
			data: row.data !== null ? JSON.parse(row.data) : null,
			previousData: row.previousData !== null ? JSON.parse(row.previousData) : null,
			timestamp: {
				wallTime: row.wallTime,
				logical: row.logical,
				nodeId: row.timestampNodeId,
			},
			sequenceNumber: row.sequenceNumber,
			causalDeps: JSON.parse(row.causalDeps),
			schemaVersion: row.schemaVersion,
			...(atomicOps ? { atomicOps } : {}),
			...(row.hashVersion === 1 || row.hashVersion === 2 ? { hashVersion: row.hashVersion } : {}),
			...(encrypted !== undefined ? { encrypted } : {}),
		}
	}

	// ---------------------------------------------------------------------------
	// Assertions
	// ---------------------------------------------------------------------------

	private assertOpen(): void {
		// A call made from inside one still running (see track) completes: close() waits
		// for that outer call, so the connection is still open. Work a finished call left
		// behind (a detached timer or promise inherits its context) is refused like any
		// other call after close().
		if (this.closed && !this.insideRunningCall()) {
			throw new Error('SqliteServerStore is closed')
		}
	}

	/** Whether the current async context is inside a call of this store that is still running. */
	private insideRunningCall(): boolean {
		for (let frame = IN_STORE_CALL.getStore() ?? null; frame; frame = frame.parent) {
			if (frame.store === this.callToken && frame.running) return true
		}
		return false
	}

	private assertSchema(): void {
		if (!this.schema) {
			throw new Error(
				'Schema not set. Call setSchema() before using queryCollection/findRecord/countCollection.',
			)
		}
	}

	private assertCollection(collection: string): void {
		const schema = this.schema as SchemaDefinition
		if (!schema.collections[collection]) {
			throw new Error(
				`Unknown collection "${collection}". Available: ${Object.keys(schema.collections).join(', ')}`,
			)
		}
	}
}

/**
 * Creates a SqliteServerStore with a file-backed or in-memory database.
 * Handles database creation, Drizzle wrapping, and table setup.
 *
 * @param options - Configuration options
 * @param options.filename - Path to SQLite database file. Defaults to ':memory:' for testing.
 * @param options.nodeId - Deprecated (a plain id becomes a legacy authoritative id). Leave
 *   unset: the server authors under the persisted `kora:server:<deployment>:<instance>`.
 * @param options.instanceId - Optional stable instance id
 * @returns A ready-to-use SqliteServerStore
 *
 * @example
 * ```typescript
 * import { createSqliteServerStore } from '@korajs/server'
 *
 * const store = createSqliteServerStore({ filename: './kora-server.db' })
 *
 * // Optional: enable materialized collection tables for fast queries
 * await store.setSchema(mySchema)
 *
 * const server = createKoraServer({ store, port: 3001 })
 * ```
 */
export function createSqliteServerStore(
	options: {
		filename?: string
	} & ServerIdentityOptions,
): SqliteServerStore {
	// better-sqlite3 is a native CJS addon — use esmRequire (from createRequire)
	// so this works in both ESM and CJS contexts.
	const Database = esmRequire('better-sqlite3')
	const { drizzle } = esmRequire('drizzle-orm/better-sqlite3')

	const filename = options.filename ?? ':memory:'
	ensureDatabaseDirectory(filename)
	const sqlite = new Database(filename)

	// Enable WAL mode for better concurrent read/write performance
	sqlite.pragma('journal_mode = WAL')

	const db = drizzle(sqlite)
	let store: SqliteServerStore
	try {
		store = new SqliteServerStore(db, options.nodeId, {
			...(options.authoritativeNodeIds
				? { authoritativeNodeIds: options.authoritativeNodeIds }
				: {}),
			...(options.revokedAuthoritativeNodeIds
				? { revokedAuthoritativeNodeIds: options.revokedAuthoritativeNodeIds }
				: {}),
			...(options.instanceId !== undefined ? { instanceId: options.instanceId } : {}),
		})
	} catch (error) {
		// The store never existed to own the handle: do not leak it (or its file lock).
		sqlite.close()
		throw error
	}
	// This function opened the connection, so the store owns it and close() releases it
	// (file handle, WAL checkpoint). A store built on a caller's connection leaves it open.
	OWNED_CONNECTIONS.set(store, () => sqlite.close())
	return store
}

/**
 * Create the directory a SQLite database file lives in, so a default such as
 * `./.kora/kora-server.db` works on a fresh checkout. In-memory databases and `file:`
 * URIs are left alone.
 */
function ensureDatabaseDirectory(filename: string): void {
	if (filename === '' || filename === ':memory:' || filename.startsWith('file:')) return
	mkdirSync(dirname(filename), { recursive: true })
}

/**
 * True when a rebuild marker's lease (its value: `<expiry, epoch ms>|<lease token>`) has
 * run out at `now`.
 */
function markerLeaseExpired(value: string, now: number): boolean {
	const expiry = value.split('|')[0] ?? ''
	return !/^[0-9]+$/.test(expiry) || Number(expiry) < now
}

/** A renewal that matched fewer markers than it held: another process took some over. */
function reportLostLeases(keys: readonly string[], renewed: number): void {
	if (renewed >= keys.length) return
	console.warn(
		`[kora] ${keys.length - renewed} membership index rebuild marker(s) of this process were taken over by another process (its lease ran out). That process completes the rebuild; this one no longer clears them.`,
	)
}

/** A field value as a SQLite column round trip leaves it (what `readStoredRow` returns). */
function storedSqliteFieldValue(
	value: unknown,
	descriptor: import('@korajs/core').FieldDescriptor,
): unknown {
	return deserializeSqliteFieldValue(serializeSqliteFieldValue(value, descriptor), descriptor)
}
