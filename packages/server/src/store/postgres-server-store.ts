import type {
	AtomicOp,
	FoldState,
	HLCTimestamp,
	Operation,
	OperationTransform,
	RecordFieldVersions,
	SchemaDefinition,
	TimeSource,
	VersionVector,
} from '@korajs/core'
import {
	HybridLogicalClock,
	KoraError,
	assertOperationTransformCoverage,
	quoteIdent,
} from '@korajs/core'
import { groupKey, parseGroupKey, planPostgresConstraintRelaxation } from '@korajs/core/internal'
import type { ApplyResult } from '@korajs/sync'
import type { SQL } from 'drizzle-orm'
import { and, asc, between, count, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { AccessIndexReadiness } from '../access/access-index-readiness'
import {
	ACCESS_COLLECTIONS_EVER_KEY,
	ACCESS_FRONTIER_KEY,
	ACCESS_INDEX_GENERATION_KEY,
	ACCESS_INDEX_MARKER_LEASE_MS,
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
import { pgOperations, pgSyncState } from './drizzle-pg-schema'
import {
	KEY_ID_SAMPLE_ROWS,
	envelopeColumn,
	envelopeKeyIds,
	parseEnvelopeColumn,
} from './envelope-column'
import { LEGACY_BODIES_META_KEY, provenLegacyClears } from './legacy-bodies'
import {
	LIVE_VIEW_BACKFILL_BATCH,
	LIVE_VIEW_BACKFILL_DELAY_MS,
	LIVE_VIEW_CURSOR_KEY_PREFIX,
	LIVE_VIEW_EPOCH_KEY,
	LIVE_VIEW_FIELDS_KEY_PREFIX,
	LIVE_VIEW_FIELDS_TTL_MS,
	LIVE_VIEW_REPLAY_PAGE,
	type LiveViewWrite,
	MAX_LIVE_VIEW_FIELDS,
	MAX_PENDING_LIVE_VIEW_REBUILDS,
	MAX_TOMBSTONE_LOOKBACK,
	NEW_RECORD_LIVE_VIEW_WRITE,
	NO_LIVE_VIEW_WRITE,
	type RecordLiveViews,
	type RecordLiveViewsState,
	advanceLiveViews,
	delay,
	emptyLiveViews,
	liveViewChangeNeeded,
	liveViewFieldsCover,
	liveViewFieldsKey,
	liveViewMayChange,
	liveViewTrackingFor,
	liveViewsAccountFor,
	normalizeFields,
	parseLiveViewCursor,
	parseLiveViewFields,
	parseLiveViews,
	serializeLiveViews,
	tombstoneStartOf,
	yieldToEventLoop,
} from './live-views'
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
	RecordHistoryReplayer,
	SCOPE_SNAPSHOT_FINGERPRINT_KEY,
	SCOPE_SNAPSHOT_PENDING_KEY,
	TombstoneStartCache,
	parseScopeSnapshot,
	replayScopeSnapshots,
	resolveTombstoneStart,
	scopeFieldNames,
	scopeSnapshotFingerprint,
	scopeValuesOf,
} from './scope-snapshot'
import {
	type AuthorityHistory,
	type ConfiguredIdentity,
	SERVER_DEPLOYMENT_ID_KEY,
	SERVER_DERIVATION_SECRET_KEY,
	SERVER_EVER_AUTHORITY_KEY,
	SERVER_INSTANCE_COUNTER_KEY,
	SERVER_LEGACY_AUTHORITY_KEY,
	SERVER_LEGACY_SCAN_KEY,
	SERVER_REVOKED_AUTHORITY_KEY,
	ServerIdentityError,
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
	ConditionalApplyInput,
	ConditionalApplyResult,
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
import { STORE_IDENTITY, outsideDecision, storeIdentity } from './server-store'
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
	deserializePgFieldValue,
	encodePgText,
	isPgJsonbKind,
	isPgRawTextKind,
	pgTextCodecMigrationSql,
	serializePgFieldValue,
} from './text-codec'

/** Thrown inside an append transaction to roll it back when the operation is a duplicate. */
class DuplicateOperationRollback extends Error {
	constructor() {
		super('duplicate operation; append rolled back')
		this.name = 'DuplicateOperationRollback'
	}
}

/** Index every (node, sequence) the log holds more than once (RT-48). */
const BACKFILL_SEQUENCE_PAIRS_SQL = `INSERT INTO sequence_pairs (node_id, sequence_number)
	SELECT node_id, sequence_number FROM operations
	GROUP BY node_id, sequence_number HAVING COUNT(*) > 1
	ON CONFLICT DO NOTHING`

/**
 * Drop resolutions above their node's restored log, and every `stored-elsewhere`
 * resolution whose operation the restored log does not hold (RT-51; see importBackup).
 */
const PRUNE_RESOLUTIONS_PAST_LOG_SQL = `DELETE FROM operation_resolutions r
	WHERE r.sequence_number > COALESCE(
		(SELECT s.max_sequence_number FROM sync_state s WHERE s.node_id = r.node_id), 0)
	OR (r.outcome = 'stored-elsewhere'
		AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.id = r.op_id))`

/** Postgres unique_violation. */
const PG_UNIQUE_VIOLATION = '23505'

/** True when `error` (or its drizzle-wrapped cause) is a Postgres unique violation. */
function isUniqueViolation(error: unknown): boolean {
	const codeOf = (value: unknown): unknown =>
		value && typeof value === 'object' && 'code' in value
			? (value as { code: unknown }).code
			: undefined
	if (codeOf(error) === PG_UNIQUE_VIOLATION) return true
	return error instanceof Error && codeOf(error.cause) === PG_UNIQUE_VIOLATION
}

/**
 * Whether a SQLSTATE is a refusal of the DATA (RT-87), never of the server's state:
 * class 22 (data exception: 22021 NUL in TEXT, 22P05 / 22P02 in JSONB, 22003 numeric
 * out of range, 22007 / 22008 datetime, ...) and class 23 (integrity constraint
 * violation: 23514 an enum CHECK, 23502 NOT NULL, ...) except 23505. A unique violation
 * is the signal of a concurrent writer (another instance inserted the same row first):
 * it is transient and retried, never a reason to refuse the operation for good.
 * Such an operation is refused terminally and per operation (UNSTORABLE_VALUE): the ack
 * moves past it and the device's later writes go on.
 */
function isUnstorableValueCode(code: string): boolean {
	if (code.startsWith('22')) return true
	return code.startsWith('23') && code !== PG_UNIQUE_VIOLATION
}

/**
 * Map a Postgres refusal of a value to {@link UnstorableValueError} (non-retriable).
 * The lossless text encoding keeps ordinary strings from reaching this; it is the
 * safety net that keeps any remaining unrepresentable value from failing the session.
 */
function unstorableValueOr(error: unknown, op: Operation): unknown {
	const codeOf = (value: unknown): unknown =>
		value && typeof value === 'object' && 'code' in value
			? (value as { code: unknown }).code
			: undefined
	const code = codeOf(error) ?? (error instanceof Error ? codeOf(error.cause) : undefined)
	if (typeof code === 'string' && isUnstorableValueCode(code)) {
		const message =
			error instanceof Error
				? error.cause instanceof Error
					? error.cause.message
					: error.message
				: String(error)
		return new UnstorableValueError(op, `SQLSTATE ${code}: ${message}`)
	}
	return error
}

/** One record's re-folded state, for {@link PostgresServerStore}'s batched migration writes. */
interface FoldedRecordWrite {
	recordId: string
	state: FoldState | null
	coveredSeq: number
	coveredOpId: string
}

/**
 * PostgreSQL-backed server store using Drizzle ORM.
 * All reads and writes go through Drizzle's typed query builder.
 *
 * When a schema is set via setSchema(), also maintains materialized
 * collection tables for efficient indexed queries (dual-write).
 */
export class PostgresServerStore implements ServerStore {
	/** This instance's server node id; loaded from the database during startup (RT-62). */
	private loadedNodeId: string | null = null
	private readonly configuredIdentity: ConfiguredIdentity
	/** Derivation secret of server-derived ids, shared by the deployment (RT-64). */
	private derivationSecret = ''
	/** Legacy and configured authorities (the `kora:server:` prefix needs no listing). */
	private explicitAuthorities: string[] = []
	/** Where the sweep of outdated records goes on (see OutdatedRecordCursor). */
	private readonly outdatedCursor = new OutdatedRecordCursor()
	private planStampCache: {
		schema: SchemaDefinition
		transforms: readonly OperationTransform[]
		authorities: readonly string[]
		value: string
	} | null = null
	/** Explicit authority over time: revoked and ever-held ids (RT-81). */
	private authorityHistory: AuthorityHistory = {
		explicitAuthorities: [],
		revoked: [],
		everAuthoritative: [],
	}
	/** Other `kora:server:` nodes with stored operations (advertised for older clients). */
	/** Records owning quarantined operations: folded onto their kept rows (RT-70). */
	private quarantine: QuarantineScope = emptyQuarantineScope()
	/** Registered live-view fields per collection (re-read from the meta table). */
	private liveViewFields = new Map<string, string[]>()
	private liveViewFieldsReadAt = 0
	/** Records a session asked to rebuild (bounded; see requestLiveViewRebuild). */
	private readonly liveViewRebuilds = new Set<string>()
	/** The running background backfill, and whether it must run another pass. */
	private liveViewBackfill: Promise<void> | null = null
	private liveViewBackfillAgain = false
	private readonly db: PostgresJsDatabase
	private readonly versionVector: VersionVector = new Map()
	private readonly ready: Promise<void>
	private schema: SchemaDefinition | null = null
	private closed = false
	/**
	 * Monotonic counter for this node's server-originated sequence numbers. Lazily
	 * seeded from the persisted version vector on first use, then advanced in memory
	 * (a synchronous `++`, atomic on the single JS thread) so concurrent conditional
	 * applies never receive the same number. Null means "not yet seeded"; reset to
	 * null after a backup import so it re-seeds from the restored version vector.
	 */
	private sequenceCounter: number | null = null
	/** See {@link SEQUENCE_ENFORCEMENT_EPOCH_KEY}; fixed per database at first start. */
	private sequenceEpoch = 0
	private logIntegrity: ServerLogIntegrityReport = {
		checkedRows: 0,
		quarantined: [],
		ran: false,
		totalQuarantined: 0,
	}
	/**
	 * Time source for HLC timestamps on server-originated operations. Injectable so a
	 * test can freeze wall-clock time and prove the conditional-apply ordering holds
	 * under same-millisecond commits (the case the advisory lock and clock advance
	 * exist to make correct). Defaults to the system clock in production.
	 */
	private readonly timeSource: TimeSource
	private foldOptions: ServerFoldOptions = serverFoldOptions([])
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
	 *   `kora:server:` id is used verbatim (it must then be unique per instance). Leave
	 *   unset: the store authors under `kora:server:<deployment>:<instance>`, with the
	 *   deployment persisted in the database and a distinct instance per process (RT-62).
	 * @param timeSource - Clock for server-originated operations (tests)
	 * @param options - Extra authoritative ids and a stable instance id
	 */
	constructor(
		db: PostgresJsDatabase,
		nodeId?: string,
		timeSource?: TimeSource,
		options: Omit<ServerIdentityOptions, 'nodeId'> = {},
	) {
		this.db = db
		this.configuredIdentity = parseIdentityOptions({
			...(nodeId !== undefined ? { nodeId } : {}),
			...options,
		})
		this.timeSource = timeSource ?? { now: () => Date.now() }
		this.ready = this.initialize()
		// RT-88: startup runs before anyone awaits it. The failure is not swallowed: every
		// method awaits `ready` and rejects with it, `whenReady()` returns it, and
		// createPostgresServerStore awaits it. Without this handler an unreachable
		// database would be an unhandled rejection, which terminates Node.
		this.ready.catch(() => {})
	}

	/** Resolves once the store's tables and identity are loaded. */
	whenReady(): Promise<void> {
		return this.ready
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
		await this.ready
		return deriveKeyedServerOpId(this.derivationSecret, parentOpId, ruleId, targetRecordId)
	}

	private get nodeId(): string {
		if (this.loadedNodeId === null) {
			throw new ServerIdentityError(
				'The Postgres server store is still starting: await store.setSchema(...) (or store.whenReady()) before using it.',
			)
		}
		return this.loadedNodeId
	}

	/** Remember another `kora:server:` node that authored stored operations. */

	/**
	 * Load (creating on first start) the persisted server identity under an advisory
	 * lock: the deployment id and derivation secret (one per database, shared by every
	 * instance), a fresh instance id from the database counter (unless configured), and
	 * the legacy authoritative ids. At the first start of this release, every node id
	 * whose operations hold an authority class in a stored fold state (a server decision
	 * folded under an earlier, per-process server node id) is recorded as a legacy
	 * authority, before any re-fold could drop that class.
	 */
	private async loadIdentity(): Promise<void> {
		const configured = this.configuredIdentity
		const identity = await this.db.transaction(async (tx) => {
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtextextended('kora:server-identity', 0))`,
			)
			const meta = async (key: string): Promise<string | undefined> =>
				(
					(await tx.execute(
						sql`SELECT value FROM kora_server_meta WHERE key = ${key}`,
					)) as unknown as { value: string }[]
				)[0]?.value
			const setOnce = async (key: string, value: string): Promise<string> => {
				await tx.execute(
					sql`INSERT INTO kora_server_meta (key, value) VALUES (${key}, ${value}) ON CONFLICT (key) DO NOTHING`,
				)
				return (await meta(key)) ?? value
			}
			const deploymentId = await setOnce(SERVER_DEPLOYMENT_ID_KEY, generateDeploymentId())
			const secret = await setOnce(SERVER_DERIVATION_SECRET_KEY, generateDerivationSecret())
			let instanceId = configured.instanceId
			if (instanceId === null) {
				// Every process start draws a new instance id, so two running instances never
				// share a node id (and never collide on its sequence numbers).
				await setOnce(SERVER_INSTANCE_COUNTER_KEY, '0')
				const next = (await tx.execute(
					sql`UPDATE kora_server_meta SET value = ((value)::bigint + 1)::text WHERE key = ${SERVER_INSTANCE_COUNTER_KEY} RETURNING value`,
				)) as unknown as { value: string }[]
				instanceId = String(next[0]?.value ?? '1')
			}
			const nodeId = configured.verbatimNodeId ?? serverNodeIdFor(deploymentId, instanceId)

			let legacy = parseLegacyAuthorities(await meta(SERVER_LEGACY_AUTHORITY_KEY))
			if ((await meta(SERVER_LEGACY_SCAN_KEY)) === undefined) {
				const stampOpIds = new Set<string>()
				let after = ''
				let afterRecord = ''
				for (;;) {
					const page = (await tx.execute(
						sql`SELECT collection, record_id, state FROM kora_fold_state
							WHERE (collection, record_id) > (${after}, ${afterRecord})
							ORDER BY collection, record_id LIMIT 1000`,
					)) as unknown as { collection: string; record_id: string; state: string }[]
					for (const row of page) {
						for (const id of authoritativeStampOpIds(row.state)) stampOpIds.add(id)
					}
					const last = page[page.length - 1]
					if (!last || page.length < 1000) break
					after = last.collection
					afterRecord = last.record_id
				}
				const ids = [...stampOpIds]
				for (let i = 0; i < ids.length; i += 500) {
					const chunk = ids.slice(i, i + 500)
					const rows = (await tx.execute(
						sql`SELECT DISTINCT node_id FROM operations WHERE id IN (${sql.join(
							chunk.map((id) => sql`${id}`),
							sql`, `,
						)})`,
					)) as unknown as { node_id: string }[]
					legacy.push(...rows.map((row) => row.node_id))
				}
				await tx.execute(
					sql`INSERT INTO kora_server_meta (key, value) VALUES (${SERVER_LEGACY_SCAN_KEY}, ${String(Date.now())}) ON CONFLICT (key) DO NOTHING`,
				)
			}
			// A configured plain node id is the id this server authored under before (RT-62).
			if (configured.legacyNodeId !== null) legacy.push(configured.legacyNodeId)
			legacy = normalizeLegacyAuthorities(legacy.filter((id) => id !== nodeId))
			await tx.execute(
				sql`INSERT INTO kora_server_meta (key, value) VALUES (${SERVER_LEGACY_AUTHORITY_KEY}, ${JSON.stringify(legacy)})
					ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
			)
			// Authority over time (RT-81), under the same lock: every explicit id ever held
			// stays authoritative until revoked, and reserved for good.
			const history = resolveAuthorityHistory({
				legacy,
				configured,
				persistedEver: parseLegacyAuthorities(await meta(SERVER_EVER_AUTHORITY_KEY)),
				persistedRevoked: parseLegacyAuthorities(await meta(SERVER_REVOKED_AUTHORITY_KEY)),
				ownNodeId: nodeId,
			})
			for (const [key, value] of [
				[SERVER_EVER_AUTHORITY_KEY, history.everAuthoritative],
				[SERVER_REVOKED_AUTHORITY_KEY, history.revoked],
			] as const) {
				await tx.execute(
					sql`INSERT INTO kora_server_meta (key, value) VALUES (${key}, ${JSON.stringify(value)})
						ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
				)
			}
			return { secret, nodeId, history }
		})
		this.loadedNodeId = identity.nodeId
		this.derivationSecret = identity.secret
		this.explicitAuthorities = identity.history.explicitAuthorities
		this.authorityHistory = identity.history
		this.foldOptions = serverFoldOptions(this.explicitAuthorities, this.operationTransforms)
	}

	/** What the last startup re-materialization did (W7 step 7). */
	getFoldMigrationReport(): FoldMigrationReport {
		return { ...this.foldMigration }
	}

	getVersionVector(): VersionVector {
		this.assertOpen()
		return new Map(this.versionVector)
	}

	/**
	 * Atomically reserve this node's next server-operation sequence number. The
	 * synchronous increment cannot interleave on the single JS thread, so two
	 * concurrent conditional applies are always handed distinct numbers.
	 */
	reserveSequenceNumber(): number {
		if (this.sequenceCounter === null) {
			this.sequenceCounter = this.versionVector.get(this.nodeId) ?? 0
		}
		this.sequenceCounter += 1
		return this.sequenceCounter
	}

	getNodeId(): string {
		return this.nodeId
	}

	/** Whether the membership index may judge access rules (see AccessIndexReadiness). */
	/** Capability grants are checked inside the write's transaction (`liveGroupsOf`). */
	readonly reportsLiveGroups = true
	private readonly accessIndex = new AccessIndexReadiness(
		(keys) => this.renewMarkerLeases(keys),
		ACCESS_INDEX_MARKER_LEASE_MS / 3,
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

	/**
	 * One-time migration (RT-101): drop the enum `CHECK` constraints (and any `NOT NULL`
	 * on a schema field) that beta.12 and earlier DDL put on collection tables, in one
	 * transaction. A check is dropped when it parses as an enum check (one column against
	 * string literals, in every form Postgres normalizes `IN (...)` to, the single-value
	 * `col = 'x'` included, RT-108) on an enum field of the schema, or as the multi-value
	 * `= ANY (ARRAY[...])` shape on another non-internal column; checks added by hand are
	 * kept. Idempotent and resumable: a later start finds nothing to drop.
	 */
	private async relaxValueDomainConstraints(schema: SchemaDefinition): Promise<void> {
		const fieldsByTable: Record<string, string[]> = {}
		const enumFieldsByTable: Record<string, string[]> = {}
		for (const [name, collection] of Object.entries(schema.collections)) {
			fieldsByTable[name] = Object.keys(collection.fields)
			enumFieldsByTable[name] = Object.entries(collection.fields)
				.filter(([, descriptor]) => descriptor.kind === 'enum')
				.map(([field]) => field)
		}
		await this.db.transaction(async (tx) => {
			const statements = await planPostgresConstraintRelaxation(
				async (text) =>
					(await tx.execute(sql.raw(text))) as unknown as Array<Record<string, unknown>>,
				fieldsByTable,
				enumFieldsByTable,
			)
			for (const statement of statements) await tx.execute(sql.raw(statement))
		})
	}

	/**
	 * Throws {@link OperationTransformCoverageError} when a schema version in the stored
	 * log has no transform path to `version` (RT-103): those operations would fold as
	 * absent, silently erasing them from their records.
	 */
	private async assertTransformCoverage(
		version: number,
		transforms: readonly OperationTransform[],
	): Promise<void> {
		if (transforms.length === 0) return
		const rows = (await this.db.execute(
			sql`SELECT DISTINCT schema_version AS v FROM operations`,
		)) as unknown as { v: number | string }[]
		assertOperationTransformCoverage(
			rows.map((row) => Number(row.v)),
			version,
			transforms,
			'Postgres server store',
		)
	}

	getOperationTransforms(): readonly OperationTransform[] {
		return this.operationTransforms
	}

	async setOperationTransforms(transforms: readonly OperationTransform[]): Promise<void> {
		this.assertOpen()
		await this.ready
		if (this.schema) await this.assertTransformCoverage(this.schema.version, transforms)
		// Re-folded values may change who holds which membership: access rules are not
		// judged until the index matches them again (for good if this fails part-way).
		await this.accessIndex.hold(async (mutated) => {
			this.operationTransforms = [...transforms]
			this.foldOptions = serverFoldOptions(this.explicitAuthorities, this.operationTransforms)
			mutated()
			// The fold plan fingerprint includes the transforms: when they changed, every
			// record is re-folded from its log, once (RT-84).
			if (this.schema) {
				this.foldMigration = await this.rematerialize()
				await this.reconcileMembershipIndex()
			}
		})
	}

	async setSchema(schema: SchemaDefinition, options: ServerSchemaOptions = {}): Promise<void> {
		// A new schema can decide a deletion differently.
		this.tombstoneStarts.clear()
		// Access rules are out of force until the index matches the new schema (for good if
		// this fails after installing it).
		try {
			await this.accessIndex.hold((mutated) => this.installSchema(schema, options, mutated))
		} finally {
			// A lookup that ran against the old schema meanwhile is not kept.
			this.tombstoneStarts.clear()
		}
	}

	private async installSchema(
		schema: SchemaDefinition,
		options: ServerSchemaOptions,
		mutated: () => void,
	): Promise<void> {
		this.assertOpen()
		await this.ready
		// Refuse transforms that cannot read the stored log BEFORE anything changes (RT-103).
		await this.assertTransformCoverage(
			schema.version,
			options.operationTransforms ?? this.operationTransforms,
		)
		this.schema = schema
		mutated()
		// A rebuild marker left by an interrupted rebuild: this one completes it.
		await this.adoptRebuildingMarker()
		if (options.operationTransforms !== undefined) {
			this.operationTransforms = [...options.operationTransforms]
			this.foldOptions = serverFoldOptions(this.explicitAuthorities, this.operationTransforms)
		}

		// Generate and execute DDL for all collection tables
		const ddlStatements = generateAllCollectionDDL(schema, 'postgres')
		for (const stmt of ddlStatements) {
			if (stmt.startsWith('--kora:safe-alter')) {
				const alterSql = stmt.replace('--kora:safe-alter\n', '')
				try {
					await this.db.execute(sql.raw(alterSql))
				} catch (e) {
					// Ignore "already exists" errors from safe ALTER TABLE.
					// Drizzle wraps the actual DB error in e.cause, so check both.
					const msg = e instanceof Error ? e.message : ''
					const causeMsg = e instanceof Error && e.cause instanceof Error ? e.cause.message : ''
					if (
						!msg.includes('already exists') &&
						!msg.includes('duplicate column') &&
						!causeMsg.includes('already exists') &&
						!causeMsg.includes('duplicate column')
					) {
						throw e
					}
				}
			} else {
				await this.db.execute(sql.raw(stmt))
			}
		}

		// beta.12 tables carry enum CHECKs a schema upgrade cannot change: drop them once
		// (RT-101); the value domain is enforced at ingest only.
		await this.relaxValueDomainConstraints(schema)
		await this.migrateTextCodec(schema)

		// beta.12 clears stored by an earlier server, made explicit once (RT-85); their
		// records are re-folded by the re-materialization below.
		await this.canonicalizeLegacyBodies()
		// Re-materialize every record whose fold state is missing or stale (W7 step 7).
		this.foldMigration = await this.rematerialize()
		// A change in the fields snapshots capture invalidates every snapshot: drop them
		// and rebuild from the log (RT-20). The fingerprint is written last, so a crash
		// (or a concurrent instance) only repeats the idempotent rebuild. The drop is
		// recorded (SCOPE_SNAPSHOT_PENDING_KEY) in its own transaction, so a restart
		// resumes the rebuild at the snapshots still missing instead of dropping the
		// ones it already rebuilt.
		const fingerprint = scopeSnapshotFingerprint(schema)
		const metaRows = (await this.db.execute(
			sql`SELECT value FROM kora_server_meta WHERE key = ${SCOPE_SNAPSHOT_FINGERPRINT_KEY}`,
		)) as unknown as { value: string }[]
		const stored = metaRows[0]?.value
		if (stored !== fingerprint) {
			await this.db.transaction(async (tx) => {
				const pending = (
					(await tx.execute(
						sql`SELECT value FROM kora_server_meta WHERE key = ${SCOPE_SNAPSHOT_PENDING_KEY} FOR UPDATE`,
					)) as unknown as { value: string }[]
				)[0]?.value
				if (pending === fingerprint) return
				// The epoch row first, as a rebuild takes it before it writes snapshots: two
				// transactions taking the locks in opposite orders can deadlock.
				await this.bumpLiveViewEpoch(tx)
				await tx.execute(sql`UPDATE operations SET scope_snapshot = NULL`)
				// Summaries hold values of the fields as captured: rebuilt with the snapshots.
				await tx.execute(sql`DELETE FROM kora_record_live_views`)
				await tx.execute(sql`UPDATE kora_fold_state SET lv_through = NULL, lv_fields = NULL`)
				await tx.execute(
					sql`INSERT INTO kora_server_meta (key, value) VALUES (${SCOPE_SNAPSHOT_PENDING_KEY}, ${fingerprint})
						ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
				)
			})
		}
		await this.backfillScopeSnapshots()
		if (stored !== fingerprint) {
			await this.db.transaction(async (tx) => {
				await tx.execute(
					sql`INSERT INTO kora_server_meta (key, value) VALUES (${SCOPE_SNAPSHOT_FINGERPRINT_KEY}, ${fingerprint})
						ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
				)
				await tx.execute(
					sql`DELETE FROM kora_server_meta WHERE key = ${SCOPE_SNAPSHOT_PENDING_KEY} AND value = ${fingerprint}`,
				)
			})
		}
		await this.reconcileMembershipIndex()
		await this.refreshLiveViewFields(true)
		// The epoch row exists before any rebuild reads it FOR SHARE (see bumpLiveViewEpoch).
		await this.db.execute(
			sql`INSERT INTO kora_server_meta (key, value) VALUES (${LIVE_VIEW_EPOCH_KEY}, '0') ON CONFLICT (key) DO NOTHING`,
		)
		this.kickLiveViewBackfill()
	}

	/**
	 * One-time migration of each collection table to the lossless text encoding (RT-65):
	 * rows written before it that contain U+FFFF (the escape introducer) are re-encoded,
	 * so the decoder returns them unchanged. Per table, under an advisory lock, recorded
	 * in `kora_server_meta`.
	 */
	private async migrateTextCodec(schema: SchemaDefinition): Promise<void> {
		for (const [name, collection] of Object.entries(schema.collections)) {
			const key = `${PG_TEXT_CODEC_MIGRATION_KEY}${name}`
			await this.db.transaction(async (tx) => {
				await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('kora:text-codec', 0))`)
				const done = (await tx.execute(
					sql`SELECT 1 AS one FROM kora_server_meta WHERE key = ${key}`,
				)) as unknown as unknown[]
				if (done.length > 0) return
				const fields = Object.entries(collection.fields)
				const statements = pgTextCodecMigrationSql(
					quoteIdent(name),
					fields.filter(([, d]) => isPgRawTextKind(d.kind)).map(([f]) => quoteIdent(f)),
					fields.filter(([, d]) => isPgJsonbKind(d.kind)).map(([f]) => quoteIdent(f)),
				)
				for (const statement of statements) await tx.execute(sql.raw(statement))
				await tx.execute(
					sql`INSERT INTO kora_server_meta (key, value) VALUES (${key}, ${String(Date.now())}) ON CONFLICT (key) DO NOTHING`,
				)
			})
		}
	}

	async applyRemoteOperation(op: Operation, options?: ApplyRemoteOptions): Promise<ApplyResult> {
		this.assertOpen()
		await this.ready

		const now = Date.now()
		let sequenceDecision: SequenceHolderVerdict = { verdict: 'free' }

		try {
			await this.db.transaction(async (tx) => {
				// Take the delivery-counter row lock first (see nextDeliverySeq). Every append
				// on every instance, conditional applies included, takes it until commit, so
				// from here on every earlier append is committed and visible to this READ
				// COMMITTED transaction, and no later one can commit before it. That makes
				// the dedup and sequence checks below atomic with the write across instances
				// (SRV-4): a concurrent duplicate on another instance either committed first
				// (and is seen here) or waits for this one. A duplicate rolls back, so it
				// neither burns a delivery sequence nor runs any side effect (NEW-SRV-2).
				const deliverySeq = await this.nextDeliverySeq(tx)
				// The record this write leaves, for access rules, folded under the lock just
				// taken and before the operation's own row exists (the stored fold state is
				// then current, so no re-fold is needed).
				const resulting =
					options?.authorize && options.previewResult ? await this.foldPreview(tx, op) : undefined
				// The stored row as this instance's plan folds it, when the row on disk is another
				// plan's (read here, before the operation's own row exists; undefined: the row
				// on disk is current).
				const activeStored = options?.authorize
					? await this.otherPlanAuthorizationRow(tx, op.collection, op.recordId)
					: undefined

				const inserted = await this.insertOperationRow(tx, op, now, deliverySeq, {
					legacySequenceWriter: options?.legacySequenceWriter === true,
				})
				if (inserted === 'duplicate') throw new DuplicateOperationRollback()
				sequenceDecision = inserted

				// Authorization re-check against the committed row, under the same lock, so
				// no write can commit between this read and this transaction's write.
				// Throwing rolls back, the operation row included.
				if (options?.authorize) {
					const stored =
						activeStored !== undefined
							? activeStored
							: await this.readStoredRow(tx, op.collection, op.recordId)
					const memberships = options.membershipsFor
						? await this.readIntervals(
								tx,
								sql`SELECT user_id, group_key, source, record_id, role, expires_at, joined_seq, role_seq, left_seq
									FROM _kora_access_memberships WHERE user_id = ${options.membershipsFor} ORDER BY id`,
							)
						: []
					const decision = options.authorize(stored, {
						...(resulting !== undefined ? { resulting } : {}),
						memberships,
						...(options.liveGroupsOf
							? {
									liveGroups: await this.readLiveGroups(
										tx,
										options.liveGroupsOf,
										options.liveGroupsSince,
										op.id,
									),
								}
							: {}),
					})
					if (!decision.allowed) {
						throw new UplinkAuthorizationError(decision.code, decision.message, {
							operationId: op.id,
							collection: op.collection,
							recordId: op.recordId,
						})
					}
				}

				const materialized = this.schema?.collections[op.collection] !== undefined
				const pre = materialized
					? await this.readScopeValues(tx, op.collection, op.recordId, false)
					: null
				const groupBefore = await this.groupStateBefore(tx, op)

				await this.advanceSyncState(tx, op, now)

				// Dual-write: update materialized collection table if schema is set
				if (materialized) {
					const liveViews = await this.mergeIntoRecord(tx, op, deliverySeq)
					await this.writeScopeSnapshot(tx, op, pre, deliverySeq, liveViews)
					await this.updateMembershipIndex(tx, op.collection, op.recordId, deliverySeq, groupBefore)
				}
			})
		} catch (error) {
			if (error instanceof DuplicateOperationRollback) return 'duplicate'
			throw unstorableValueOr(error, op)
		}

		// Keep this instance's cached vector current for its synchronous readers. The
		// authoritative, cross-instance vector is readVersionVector().
		const currentMax = this.versionVector.get(op.nodeId) ?? 0
		if (op.sequenceNumber > currentMax) {
			this.versionVector.set(op.nodeId, op.sequenceNumber)
		}

		reportLegacyPair(op, sequenceDecision, options)
		return 'applied'
	}

	/**
	 * The version vector as committed in `sync_state`, shared by every instance
	 * (SRV-4). Also refreshes this instance's cache, which `getVersionVector()` serves.
	 */
	async readVersionVector(): Promise<VersionVector> {
		this.assertOpen()
		await this.ready
		const rows = await this.db
			.select({
				nodeId: pgSyncState.nodeId,
				maxSequenceNumber: pgSyncState.maxSequenceNumber,
			})
			.from(pgSyncState)
		const vector: VersionVector = new Map()
		for (const row of rows) {
			const seq = Number(row.maxSequenceNumber)
			vector.set(row.nodeId, seq)
			if (seq > (this.versionVector.get(row.nodeId) ?? 0)) this.versionVector.set(row.nodeId, seq)
		}
		return vector
	}

	/**
	 * Insert one operation row inside an append transaction that already holds the
	 * delivery-counter lock. Returns `'duplicate'` (writing nothing) when an operation
	 * with the same id is stored; throws {@link SequenceConflictError} when a DIFFERENT
	 * operation stored after the sequence-enforcement epoch holds its (node, sequence)
	 * and the writer reserves its sequences (W3 step 4); a legacy holder or a legacy
	 * writer (RT-37) is accepted and the row is stored unflagged. Otherwise returns the
	 * verdict the row was stored under. The partial unique index over sole-holder rows
	 * backs the check against a writer that bypasses the counter lock.
	 */
	private async insertOperationRow(
		tx: PostgresJsDatabase,
		op: Operation,
		now: number,
		deliverySeq: number,
		writer: { legacySequenceWriter?: boolean } = {},
	): Promise<Exclude<SequenceHolderVerdict, { verdict: 'conflict' }> | 'duplicate'> {
		const holders = (await tx.execute(
			sql`SELECT id, delivery_seq FROM operations WHERE node_id = ${op.nodeId} AND sequence_number = ${op.sequenceNumber}`,
		)) as unknown as { id: string; delivery_seq: string | number | null }[]
		// Already stored (a legacy pair may hold the sequence twice: check every holder).
		if (holders.some((row) => row.id === op.id)) return 'duplicate'
		const decision = judgeSequenceHolders(
			op,
			holders.map((row) => ({ id: row.id, deliverySequence: Number(row.delivery_seq ?? 0) })),
			this.sequenceEpoch,
			writer,
		)
		if (decision.verdict === 'conflict') {
			throw new SequenceConflictError(op, decision.holderId)
		}
		const holder = holders[0]
		try {
			const inserted = await tx
				.insert(pgOperations)
				.values(this.serializeOperation(op, now, deliverySeq, decision.verdict === 'free'))
				.onConflictDoNothing({ target: pgOperations.id })
				.returning({ id: pgOperations.id })
			if (inserted.length === 0) return 'duplicate'
			// A legacy pair: index its sequence so version-vector clients get both (RT-48).
			if (decision.verdict === 'legacy') {
				await tx.execute(
					sql`INSERT INTO sequence_pairs (node_id, sequence_number) VALUES (${op.nodeId}, ${op.sequenceNumber})
						ON CONFLICT DO NOTHING`,
				)
			}
			return decision
		} catch (error) {
			if (isUniqueViolation(error)) {
				throw new SequenceConflictError(op, holder?.id ?? '(unknown)')
			}
			throw error
		}
	}

	/** Advance `sync_state` (the persisted version vector) for an appended operation. */
	private async advanceSyncState(
		tx: PostgresJsDatabase,
		op: Operation,
		now: number,
	): Promise<void> {
		await tx
			.insert(pgSyncState)
			.values({
				nodeId: op.nodeId,
				maxSequenceNumber: op.sequenceNumber,
				lastSeenAt: now,
			})
			.onConflictDoUpdate({
				target: pgSyncState.nodeId,
				set: {
					maxSequenceNumber: sql`GREATEST(${pgSyncState.maxSequenceNumber}, ${op.sequenceNumber})`,
					lastSeenAt: sql`${now}`,
				},
			})
	}

	/**
	 * Conditionally apply operations atomically, serialized across server instances
	 * on the target record via a transaction-scoped advisory lock. The lock makes
	 * the read-decide-write cycle atomic against concurrent instances, so a cap
	 * check like `responseCount < max` cannot be passed by two admissions at once.
	 */
	async applyConditional(input: ConditionalApplyInput): Promise<ConditionalApplyResult> {
		this.assertOpen()
		await this.ready
		this.assertSchema()
		this.assertCollection(input.target.collection)

		const lockKey = `kora:${input.target.collection}:${input.target.id}`

		let attempted: Operation | null = null
		const result = await this.db
			.transaction(async (tx) => {
				// Serialize this target across every server instance sharing the database.
				// hashtextextended maps the key to the bigint pg_advisory_xact_lock expects;
				// the lock releases automatically when the transaction ends.
				await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`)
				// Also take the delivery-counter row lock now (every append takes it until
				// commit), so the reads below, including the authorization reads of the
				// built operations, see every earlier commit and no append can commit
				// between them and this transaction's writes. Lock order (advisory, then
				// counter) matches every other path, so this cannot deadlock.
				await tx.execute(sql`SELECT value FROM delivery_counter WHERE id = 1 FOR UPDATE`)

				// Idempotency: if the key record already exists (from an earlier attempt),
				// this set is already committed. Checked under the lock so a retry racing a
				// first attempt on another instance still resolves to at-most-once.
				if (input.idempotencyKey) {
					const existing = (await tx.execute(
						sql`SELECT 1 FROM ${sql.raw(quoteIdent(input.idempotencyKey.collection))} WHERE id = ${input.idempotencyKey.id} AND _deleted = 0 LIMIT 1`,
					)) as unknown as unknown[]
					if (existing.length > 0) {
						return { admitted: true, idempotent: true, applied: [] as Operation[] }
					}
				}

				// The target as this instance's fold plan defines it (a live record only): during
				// a rolling deploy the row on disk may be an old-plan instance's.
				const target = await this.readActivePlanRow(tx, input.target.collection, input.target.id)
				const current = target && target._deleted !== 1 ? target : null

				if (!input.admit(current)) {
					return { admitted: false, idempotent: false, applied: [] as Operation[] }
				}

				// Seed a clock past the target record's latest committed operation so the
				// operations built next sort strictly after every prior write to it. Under
				// the advisory lock this makes last-write-wins materialization agree with the
				// serialized commit order, so a same-millisecond commit on another instance
				// cannot cause the counter to be undercounted (which would admit past a cap).
				const clock = new HybridLogicalClock(this.nodeId, this.timeSource)
				const latest = await this.latestOperationTimestamp(
					tx,
					input.target.collection,
					input.target.id,
				)
				if (latest) {
					clock.advanceTo(latest)
				}

				const ops = await input.buildOperations(current, {
					clock,
					readStoredRow: (collection, id) => this.readActivePlanRow(tx, collection, id),
				})
				await this.appendBuiltOperations(tx, ops, (op) => {
					attempted = op
				})
				return { admitted: true, idempotent: false, applied: ops }
			})
			.catch((error: unknown) => {
				throw attempted ? unstorableValueOr(error, attempted) : error
			})

		this.advanceVersionVectorCache(result.applied)
		return result
	}

	async transact(run: StoreTransactionRun): Promise<StoreTransactionResult> {
		this.assertOpen()
		await this.ready
		this.assertSchema()
		let attempted: Operation | null = null
		const result = await this.db
			.transaction(async (tx) => {
				// Every operation append takes the delivery-counter row lock until it commits,
				// on every instance: holding it from before the decision's reads until this
				// commit means no other write commits in between, so the decision is made on
				// the state its operations commit over.
				await tx.execute(sql`SELECT value FROM delivery_counter WHERE id = 1 FOR UPDATE`)
				// The decision reads through this transaction's connection: a read from the
				// pool could wait for a connection held by a writer that waits for this lock.
				const ops = await run(this.boundTo(tx))
				if (ops === null) return { committed: false, applied: [] as Operation[] }
				await this.appendBuiltOperations(tx, ops, (op) => {
					attempted = op
				})
				return { committed: true, applied: ops }
			})
			.catch((error: unknown) => {
				throw attempted ? unstorableValueOr(error, attempted) : error
			})
		this.advanceVersionVectorCache(result.applied)
		return result
	}

	/**
	 * This store with every database access going through `tx`: methods called on it
	 * read `this.db` as the transaction, while fields set through it (caches, counters)
	 * land on the store itself. Its record reads (`findRecord`, `queryCollection`,
	 * `countCollection`) see records as this instance's fold plan folds them.
	 */
	private boundTo(tx: PostgresJsDatabase): ServerStore {
		const view: ServerStore = new Proxy(this, {
			get: (target, property) => {
				if (property === 'db') return tx
				if (property === STORE_IDENTITY) return target
				// A transaction decides on records as this instance's fold plan defines them,
				// not on rows an instance still on another plan materialized (a rolling deploy).
				if (property === 'findRecord') {
					return (collection: string, id: string) => target.findActivePlanRecord(tx, collection, id)
				}
				if (property === 'queryCollection') {
					return (collection: string, options?: CollectionQueryOptions) =>
						target.queryActivePlan(tx, collection, options)
				}
				if (property === 'countCollection') {
					return (collection: string, where?: Record<string, unknown>) =>
						target.countActivePlan(tx, collection, where)
				}
				const value: unknown = Reflect.get(target, property, target)
				return typeof value === 'function'
					? (value as (...args: unknown[]) => unknown).bind(view)
					: value
			},
			set: (target, property, value) => Reflect.set(target, property, value, target),
		})
		return view
	}

	/**
	 * Store operations built by the server inside a transaction that holds the
	 * delivery-counter lock: each gets the next delivery sequence and is folded, with
	 * its scope snapshot and membership index changes, in the same transaction.
	 */
	private async appendBuiltOperations(
		tx: PostgresJsDatabase,
		ops: readonly Operation[],
		onAttempt: (op: Operation) => void,
	): Promise<void> {
		const now = Date.now()
		for (const op of ops) {
			const deliverySeq = await this.nextDeliverySeq(tx)
			const materialized = this.schema?.collections[op.collection] !== undefined
			const pre = materialized
				? await this.readScopeValues(tx, op.collection, op.recordId, false)
				: null
			const groupBefore = await this.groupStateBefore(tx, op)
			// A built operation is new by construction (fresh id, reserved sequence); a
			// duplicate would mean it is already committed, so it is not written twice.
			onAttempt(op)
			if ((await this.insertOperationRow(tx, op, now, deliverySeq)) === 'duplicate') continue
			await this.advanceSyncState(tx, op, now)
			if (materialized) {
				const liveViews = await this.mergeIntoRecord(tx, op, deliverySeq)
				await this.writeScopeSnapshot(tx, op, pre, deliverySeq, liveViews)
				await this.updateMembershipIndex(tx, op.collection, op.recordId, deliverySeq, groupBefore)
			}
		}
	}

	/** Advance the in-memory version vector cache after a commit. */
	private advanceVersionVectorCache(applied: readonly Operation[]): void {
		for (const op of applied) {
			const currentMax = this.versionVector.get(op.nodeId) ?? 0
			if (op.sequenceNumber > currentMax) {
				this.versionVector.set(op.nodeId, op.sequenceNumber)
			}
		}
	}

	async getOperationRange(nodeId: string, fromSeq: number, toSeq: number): Promise<Operation[]> {
		this.assertOpen()
		await this.ready

		const rows = await this.db
			.select()
			.from(pgOperations)
			.where(
				and(eq(pgOperations.nodeId, nodeId), between(pgOperations.sequenceNumber, fromSeq, toSeq)),
			)
			.orderBy(asc(pgOperations.sequenceNumber))

		return rows.map((row) => this.deserializeOperation(row))
	}

	async getOperationCount(): Promise<number> {
		this.assertOpen()
		await this.ready

		const result = await this.db.select({ value: count() }).from(pgOperations)
		return result[0]?.value ?? 0
	}

	async getMaxDeliverySequence(): Promise<number> {
		this.assertOpen()
		await this.ready
		// A sequence an access-index reconcile reserved (no operation) is delivered too.
		const rows = (await this.db.execute(
			sql`SELECT GREATEST(
				COALESCE((SELECT MAX(delivery_seq) FROM operations), 0),
				COALESCE((SELECT value::bigint FROM kora_server_meta WHERE key = ${ACCESS_FRONTIER_KEY}), 0)
			) AS m`,
		)) as unknown as { m: number | string | bigint }[]
		return Number(rows[0]?.m ?? 0)
	}

	async getOperationsAfterDelivery(
		afterDeliverySequence: number,
		limit: number,
	): Promise<DeliveredOperation[]> {
		this.assertOpen()
		await this.ready
		const rows = await this.db
			.select()
			.from(pgOperations)
			.where(gt(pgOperations.deliverySeq, afterDeliverySequence))
			.orderBy(asc(pgOperations.deliverySeq))
			.limit(limit)
		return rows.map((row) => ({
			operation: this.deserializeOperation(row),
			deliverySequence: row.deliverySeq ?? 0,
			scopeSnapshot: parseScopeSnapshot(row.scopeSnapshot),
		}))
	}

	async getOperationScopeSnapshots(
		operationIds: string[],
	): Promise<Map<string, OperationScopeSnapshot>> {
		this.assertOpen()
		await this.ready
		const result = new Map<string, OperationScopeSnapshot>()
		for (let i = 0; i < operationIds.length; i += 500) {
			const ids = operationIds.slice(i, i + 500)
			if (ids.length === 0) continue
			const rows = (await this.db.execute(
				sql`SELECT id, scope_snapshot FROM operations WHERE id IN (${sql.join(
					ids.map((id) => sql`${id}`),
					sql.raw(', '),
				)})`,
			)) as unknown as { id: string; scope_snapshot: string | null }[]
			for (const row of rows) {
				const snapshot = parseScopeSnapshot(row.scope_snapshot)
				if (snapshot) result.set(row.id, snapshot)
			}
		}
		return result
	}

	async getRecordLatestTimestamp(
		collection: string,
		recordId: string,
	): Promise<HLCTimestamp | null> {
		this.assertOpen()
		await this.ready
		// COLLATE "C" so the node-id tie-break is the same byte order as HLC.compare.
		const rows = (await this.db.execute(
			sql`SELECT wall_time, logical, timestamp_node_id FROM operations
				WHERE collection = ${collection} AND record_id = ${recordId}
				ORDER BY wall_time DESC, logical DESC, timestamp_node_id COLLATE "C" DESC LIMIT 1`,
		)) as unknown as { wall_time: number | string; logical: number; timestamp_node_id: string }[]
		const row = rows[0]
		return row
			? {
					wallTime: Number(row.wall_time),
					logical: Number(row.logical),
					nodeId: row.timestamp_node_id,
				}
			: null
	}

	async getRecordFieldVersions(
		collection: string,
		recordId: string,
	): Promise<RecordFieldVersions | null> {
		this.assertOpen()
		await this.ready
		return foldFieldVersions(await this.readFoldState(this.db, collection, recordId))
	}

	async getRecordFoldState(collection: string, recordId: string): Promise<FoldState | null> {
		this.assertOpen()
		await this.ready
		return this.readFoldState(this.db, collection, recordId)
	}

	async getRecordOperations(collection: string, recordId: string): Promise<Operation[]> {
		this.assertOpen()
		await this.ready
		return this.readRecordOperations(this.db, collection, recordId, 0)
	}

	async registerLiveViewFields(collection: string, fields: readonly string[]): Promise<void> {
		this.assertOpen()
		await this.ready
		const schema = this.schema
		if (!schema?.collections[collection]) return
		// Only scalar fields of the schema can be tracked (the caller passes fields the
		// server's own scopes read; anything else is dropped, never stored).
		const scalar = scopeFieldNames(schema, collection)
		const valid = normalizeFields(fields.filter((field) => scalar.has(field)))
		if (valid.length === 0) return
		// Already registered (as this instance last read it): nothing to write.
		if (liveViewFieldsCover(this.liveViewFields.get(collection) ?? [], valid)) return
		const key = `${LIVE_VIEW_FIELDS_KEY_PREFIX}${collection}`
		let changed = false
		await this.db.transaction(async (tx) => {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
			const current = parseLiveViewFields(
				(
					(await tx.execute(
						sql`SELECT value FROM kora_server_meta WHERE key = ${key}`,
					)) as unknown as { value: string }[]
				)[0]?.value,
			).filter((field) => scalar.has(field))
			const merged = normalizeFields([...current, ...valid])
			if (merged.length > MAX_LIVE_VIEW_FIELDS) return
			if (liveViewFieldsKey(merged) === liveViewFieldsKey(current)) return
			await tx.execute(
				sql`INSERT INTO kora_server_meta (key, value) VALUES (${key}, ${JSON.stringify(merged)})
					ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
			)
			changed = true
		})
		await this.refreshLiveViewFields(true)
		if (changed) this.kickLiveViewBackfill()
	}

	async getRecordLiveViews(
		collection: string,
		recordIds: readonly string[],
	): Promise<Map<string, RecordLiveViewsState>> {
		this.assertOpen()
		await this.ready
		const result = new Map<string, RecordLiveViewsState>()
		for (let i = 0; i < recordIds.length; i += 500) {
			const ids = recordIds.slice(i, i + 500)
			if (ids.length === 0) continue
			const list = sql.join(
				ids.map((id) => sql`${id}`),
				sql.raw(', '),
			)
			const rows = (await this.db.execute(
				sql`SELECT v.record_id, v.views, f.lv_through, f.covered_op_id, f.covered_seq
					FROM kora_record_live_views v
					LEFT JOIN kora_fold_state f ON f.collection = v.collection AND f.record_id = v.record_id
					WHERE v.collection = ${collection} AND v.record_id IN (${list})`,
			)) as unknown as {
				record_id: string
				views: string
				lv_through: string | null
				covered_op_id: string | null
				covered_seq: number | string | null
			}[]
			if (rows.length === 0) continue
			const latest = await this.latestRecordOperations(this.db, collection, ids)
			for (const row of rows) {
				const views = parseLiveViews(row.views)
				if (!views) continue
				const newest = latest.get(row.record_id)
				result.set(row.record_id, {
					views,
					current: liveViewsAccountFor(
						row.lv_through,
						row.covered_op_id,
						newest?.id,
						row.covered_seq,
						newest?.seq ?? null,
					),
					coveredSeq: newest?.seq ?? 0,
				})
			}
		}
		return result
	}

	requestLiveViewRebuild(collection: string, recordId: string): void {
		if (this.closed || this.liveViewRebuilds.size >= MAX_PENDING_LIVE_VIEW_REBUILDS) return
		this.liveViewRebuilds.add(JSON.stringify([collection, recordId]))
		this.kickLiveViewBackfill()
	}

	async whenLiveViewsIdle(): Promise<void> {
		while (this.liveViewBackfill) await this.liveViewBackfill
	}

	/** Decided deletion starts shared by every session (see TombstoneStartCache). */
	private readonly tombstoneStarts = new TombstoneStartCache()

	async getTombstoneStart(
		collection: string,
		recordId: string,
		operationId: string,
	): Promise<number | null> {
		this.assertOpen()
		await this.ready
		const schema = this.schema
		const at = (
			(await this.db.execute(
				sql`SELECT delivery_seq FROM operations WHERE id = ${operationId}`,
			)) as unknown as { delivery_seq: number | string | null }[]
		)[0]?.delivery_seq
		if (!schema || at === undefined || at === null) return null
		const before = Number(at)
		return this.tombstoneStarts.resolve(
			TombstoneStartCache.key(
				collection,
				recordId,
				operationId,
				before,
				await this.readLiveViewEpoch(this.db),
			),
			() =>
				resolveTombstoneStart(
					schema,
					collection,
					recordId,
					this.foldOptions,
					async (limit) =>
						(
							(await this.db.execute(
								sql`SELECT delivery_seq, scope_snapshot FROM operations
							WHERE collection = ${collection} AND record_id = ${recordId} AND delivery_seq < ${before}
							ORDER BY delivery_seq DESC LIMIT ${limit}`,
							)) as unknown as { delivery_seq: number | string; scope_snapshot: string | null }[]
						).map((row) => ({
							seq: Number(row.delivery_seq),
							deleted: parseScopeSnapshot(row.scope_snapshot)?.deleted,
						})),
					async (afterSeq, limit) =>
						(
							await this.db
								.select()
								.from(pgOperations)
								.where(
									and(
										eq(pgOperations.collection, collection),
										eq(pgOperations.recordId, recordId),
										gt(pgOperations.deliverySeq, afterSeq),
										lt(pgOperations.deliverySeq, before),
									),
								)
								.orderBy(asc(pgOperations.deliverySeq))
								.limit(limit)
						).map((row) => ({
							operation: this.deserializeOperation(row),
							deliverySequence: row.deliverySeq ?? 0,
							scopeSnapshot: parseScopeSnapshot(row.scopeSnapshot),
						})),
				),
		)
	}

	/** The live-view epoch (bumped by a replace-mode restore and a snapshot wipe). */
	private async readLiveViewEpoch(txOrDb: PostgresJsDatabase, lock = false): Promise<string> {
		const rows = (await txOrDb.execute(
			lock
				? sql`SELECT value FROM kora_server_meta WHERE key = ${LIVE_VIEW_EPOCH_KEY} FOR SHARE`
				: sql`SELECT value FROM kora_server_meta WHERE key = ${LIVE_VIEW_EPOCH_KEY}`,
		)) as unknown as { value: string }[]
		return rows[0]?.value ?? '0'
	}

	/**
	 * Bump the live-view epoch, first thing in a restore or a snapshot wipe: it takes the
	 * epoch row's lock, so a rebuild's guarded write (which reads the row FOR SHARE) is
	 * ordered with it, and no rebuild that read the old log may write a summary.
	 */
	private async bumpLiveViewEpoch(tx: PostgresJsDatabase): Promise<void> {
		await tx.execute(
			sql`INSERT INTO kora_server_meta (key, value) VALUES (${LIVE_VIEW_EPOCH_KEY}, '1')
				ON CONFLICT (key) DO UPDATE SET value = (kora_server_meta.value::bigint + 1)::text`,
		)
	}

	/** The newest operation (delivery sequence and id) of each record. */
	private async latestRecordOperations(
		txOrDb: PostgresJsDatabase,
		collection: string,
		recordIds: readonly string[],
	): Promise<Map<string, { seq: number; id: string }>> {
		const latest = new Map<string, { seq: number; id: string }>()
		if (recordIds.length === 0) return latest
		const list = sql.join(
			recordIds.map((id) => sql`${id}`),
			sql.raw(', '),
		)
		const rows = (await txOrDb.execute(
			sql`SELECT o.record_id, o.id, o.delivery_seq FROM operations o
				WHERE o.collection = ${collection} AND o.record_id IN (${list})
				AND o.delivery_seq = (SELECT MAX(i.delivery_seq) FROM operations i
					WHERE i.collection = o.collection AND i.record_id = o.record_id)`,
		)) as unknown as { record_id: string; id: string; delivery_seq: number | string }[]
		for (const row of rows) {
			latest.set(row.record_id, { seq: Number(row.delivery_seq), id: row.id })
		}
		return latest
	}

	/** Re-read the registered live-view fields (at most every few seconds unless forced). */
	private async refreshLiveViewFields(
		force = false,
		txOrDb: PostgresJsDatabase = this.db,
	): Promise<void> {
		const now = Date.now()
		if (!force && now - this.liveViewFieldsReadAt < LIVE_VIEW_FIELDS_TTL_MS) return
		this.liveViewFieldsReadAt = now
		// Inside a write, through its own transaction: never a second pooled connection
		// while the transaction holds one (a small pool would starve).
		const rows = (await txOrDb.execute(
			sql`SELECT key, value FROM kora_server_meta WHERE key LIKE ${`${LIVE_VIEW_FIELDS_KEY_PREFIX}%`}`,
		)) as unknown as { key: string; value: string }[]
		const fields = new Map<string, string[]>()
		for (const row of rows) {
			const parsed = parseLiveViewFields(row.value)
			if (parsed.length > 0) fields.set(row.key.slice(LIVE_VIEW_FIELDS_KEY_PREFIX.length), parsed)
		}
		this.liveViewFields = fields
	}

	/** Start the background backfill, or have the running one make another pass. */
	private kickLiveViewBackfill(): void {
		if (this.closed) return
		if (this.liveViewBackfill) {
			this.liveViewBackfillAgain = true
			return
		}
		// Started after a short delay, so a burst of handshakes and writes (a start, a
		// deploy) is not competing with it.
		let failed = false
		this.liveViewBackfill = delay(LIVE_VIEW_BACKFILL_DELAY_MS)
			.then(() => this.runLiveViewBackfill())
			.catch((error: unknown) => {
				failed = true
				console.warn(
					`[kora] live-view backfill stopped; it resumes at the next start: ${error instanceof Error ? error.message : String(error)}`,
				)
			})
			.finally(() => {
				this.liveViewBackfill = null
				// A rebuild asked for after the pass's last check (its kick saw this pass
				// still running) is not left waiting for the next unrelated kick.
				if (!failed && this.liveViewRebuilds.size > 0) this.kickLiveViewBackfill()
			})
	}

	/**
	 * Build live-view summaries (and fill snapshots' tombstone state) in the background:
	 * requested records first, then each registered collection from a persisted cursor
	 * (resumable; several instances may run it at once, the work is idempotent). Records
	 * are read and replayed in pages outside any transaction; each write is short and
	 * guarded (see rebuildRecordLiveViews), and never takes the delivery-counter lock.
	 */
	private async runLiveViewBackfill(): Promise<void> {
		for (;;) {
			this.liveViewBackfillAgain = false
			let worked = false
			while (!this.closed && this.liveViewRebuilds.size > 0) {
				const batch = [...this.liveViewRebuilds].slice(0, LIVE_VIEW_BACKFILL_BATCH)
				for (const key of batch) {
					if (this.closed) return
					// Dropped as it is taken up, not before the batch: a failure here leaves
					// the rest of the batch requested for the next pass.
					this.liveViewRebuilds.delete(key)
					const [collection, recordId] = JSON.parse(key) as [string, string]
					await this.rebuildRecordLiveViews(collection, recordId, true)
					await yieldToEventLoop()
				}
				worked = true
			}
			await this.refreshLiveViewFields(true)
			for (const [collection, fields] of this.liveViewFields) {
				if (this.closed) return
				if (!this.schema?.collections[collection]) continue
				const fieldsKey = liveViewFieldsKey(fields)
				const cursorKey = `${LIVE_VIEW_CURSOR_KEY_PREFIX}${collection}`
				for (;;) {
					if (this.closed) return
					const cursor = parseLiveViewCursor(
						(
							(await this.db.execute(
								sql`SELECT value FROM kora_server_meta WHERE key = ${cursorKey}`,
							)) as unknown as { value: string }[]
						)[0]?.value,
					)
					if (cursor?.fields === fieldsKey && cursor.after === null) break
					const after = cursor?.fields === fieldsKey ? (cursor.after ?? '') : ''
					const ids = (
						(await this.db.execute(
							sql`SELECT id FROM ${sql.raw(quoteIdent(collection))} WHERE id COLLATE "C" > ${after} ORDER BY id COLLATE "C" LIMIT ${LIVE_VIEW_BACKFILL_BATCH}`,
						)) as unknown as { id: string }[]
					).map((row) => row.id)
					for (const id of ids) {
						if (this.closed) return
						await this.rebuildRecordLiveViews(collection, id, false)
						await yieldToEventLoop()
					}
					const next = ids.length < LIVE_VIEW_BACKFILL_BATCH ? null : (ids[ids.length - 1] ?? null)
					await this.db.execute(
						sql`INSERT INTO kora_server_meta (key, value) VALUES (${cursorKey}, ${JSON.stringify({ fields: fieldsKey, after: next })})
							ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
					)
					worked = true
					await yieldToEventLoop()
				}
			}
			if (this.closed) return
			// A record asked for meanwhile is always rebuilt; another pass over the
			// collections only when something was kicked and this pass did work.
			if (this.liveViewRebuilds.size > 0) continue
			if (!this.liveViewBackfillAgain || !worked) return
		}
	}

	/**
	 * Rebuild one record's live-view summary from its log and fill the tombstone state of
	 * its snapshots that lack it. The log is read and replayed in pages outside any
	 * transaction. The summary is then written in one short transaction guarded by the
	 * fold-state row: `lv_through` is set (taking the row lock, so it is ordered with every
	 * write of the record) only while the fold state covers exactly the last operation
	 * replayed and that operation is still the record's newest; otherwise a write came in
	 * between and the summary stays unknown (rebuilt again on request). Skipped (left
	 * unknown) for a record whose log the integrity scan quarantined. Unless `force`, a
	 * summary that already accounts for the record over the registered fields is kept.
	 */
	private async rebuildRecordLiveViews(
		collection: string,
		recordId: string,
		force: boolean,
	): Promise<void> {
		const schema = this.schema
		const fields = this.liveViewFields.get(collection)
		if (!schema?.collections[collection] || !fields) return
		if (isQuarantineAffected(this.quarantine, collection, recordId)) return
		const fieldsKey = liveViewFieldsKey(fields)
		if (!force) {
			const tracked = (
				(await this.db.execute(
					sql`SELECT f.lv_through, f.lv_fields, f.covered_op_id,
						EXISTS (SELECT 1 FROM kora_record_live_views v WHERE v.collection = f.collection AND v.record_id = f.record_id) AS has_views
						FROM kora_fold_state f WHERE f.collection = ${collection} AND f.record_id = ${recordId}`,
				)) as unknown as {
					lv_through: string | null
					lv_fields: string | null
					covered_op_id: string
					has_views: boolean
				}[]
			)[0]
			const newest = (await this.latestRecordOperations(this.db, collection, [recordId])).get(
				recordId,
			)
			if (
				tracked?.has_views &&
				liveViewFieldsKey(parseLiveViewFields(tracked.lv_fields)) === fieldsKey &&
				liveViewsAccountFor(tracked.lv_through, tracked.covered_op_id, newest?.id)
			) {
				return
			}
		}
		const epoch = await this.readLiveViewEpoch(this.db)
		const replayer = new RecordHistoryReplayer(
			schema,
			collection,
			recordId,
			this.foldOptions,
			fields,
		)
		const missing: Array<{
			id: string
			stored: OperationScopeSnapshot | null
			raw: string | null
		}> = []
		let lastSeq = 0
		let lastId: string | null = null
		for (;;) {
			const page = await this.db
				.select()
				.from(pgOperations)
				.where(
					and(
						eq(pgOperations.collection, collection),
						eq(pgOperations.recordId, recordId),
						gt(pgOperations.deliverySeq, lastSeq),
					),
				)
				.orderBy(asc(pgOperations.deliverySeq))
				.limit(LIVE_VIEW_REPLAY_PAGE)
			if (page.length === 0) break
			replayer.push(
				page.map((row) => ({
					operation: this.deserializeOperation(row),
					deliverySequence: row.deliverySeq ?? 0,
				})),
			)
			for (const row of page) {
				const stored = parseScopeSnapshot(row.scopeSnapshot)
				if (stored?.deleted === undefined)
					missing.push({ id: row.id, stored, raw: row.scopeSnapshot })
			}
			const tail = page[page.length - 1]
			lastSeq = tail?.deliverySeq ?? lastSeq
			lastId = tail?.id ?? lastId
			if (page.length < LIVE_VIEW_REPLAY_PAGE) break
			await yieldToEventLoop()
			if (this.closed) return
		}
		if (lastId === null) return
		// Snapshots: a historical fact per operation, each filled only over the value read.
		for (let i = 0; i < missing.length; i += LIVE_VIEW_REPLAY_PAGE) {
			const page = missing.slice(i, i + LIVE_VIEW_REPLAY_PAGE)
			let voided = false
			await this.db.transaction(async (tx) => {
				// A restore or a snapshot wipe since the log was read: this replay is void
				// (read FOR SHARE: ordered with the restore that bumps it).
				if ((await this.readLiveViewEpoch(tx, true)) !== epoch) {
					voided = true
					return
				}
				for (const entry of page) {
					const replayed = replayer.snapshots.get(entry.id)
					if (!replayed) continue
					const filled = entry.stored
						? {
								...entry.stored,
								...(entry.stored.post ? { deleted: replayed.deleted === true } : {}),
							}
						: replayed
					await tx.execute(
						sql`UPDATE operations SET scope_snapshot = ${JSON.stringify(filled)}
							WHERE id = ${entry.id} AND scope_snapshot IS NOT DISTINCT FROM ${entry.raw}`,
					)
				}
			})
			if (voided) return
		}
		const views = replayer.views
		if (!views) return
		const through = lastId
		await this.db.transaction(async (tx) => {
			// A restore or a snapshot wipe since the log was read: this replay is void.
			if ((await this.readLiveViewEpoch(tx, true)) !== epoch) return
			// The guard: the fold-state row (locked by this UPDATE, so ordered with every
			// write of the record) still covers exactly the last operation replayed, and no
			// later operation of the record exists.
			const guarded = (await tx.execute(
				sql`UPDATE kora_fold_state SET lv_through = ${through}, lv_fields = ${fieldsKey}
					WHERE collection = ${collection} AND record_id = ${recordId} AND covered_op_id = ${through}
					AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.collection = ${collection} AND o.record_id = ${recordId} AND o.delivery_seq > ${lastSeq})
					RETURNING record_id`,
			)) as unknown as unknown[]
			if (guarded.length !== 1) return
			await tx.execute(
				sql`INSERT INTO kora_record_live_views (collection, record_id, views)
					VALUES (${collection}, ${recordId}, ${serializeLiveViews(views)})
					ON CONFLICT (collection, record_id) DO UPDATE SET views = EXCLUDED.views`,
			)
		})
	}

	async previewOperation(op: Operation): Promise<MaterializedRecord | null> {
		this.assertOpen()
		await this.ready
		const row = await this.foldPreview(this.db, op)
		if (!row || row.deleted) return null
		return { ...row.values, id: op.recordId }
	}

	/** The record `op` leaves, folded onto the stored state read through `txOrDb`. */
	private async foldPreview(
		txOrDb: PostgresJsDatabase,
		op: Operation,
	): Promise<ResultingRecord | null> {
		const schema = this.schema ?? EMPTY_FOLD_SCHEMA
		const current = await this.readFoldState(txOrDb, op.collection, op.recordId)
		const merged = mergeIntoFoldState(current, [op], schema, this.foldOptions)
		const state =
			merged === REFOLD_REQUIRED
				? refoldRecord(
						[...(await this.readRecordOperations(txOrDb, op.collection, op.recordId, 0)), op],
						schema,
						this.foldOptions,
					)
				: merged
		// Materialized exactly as the row this write persists (schema defaults included).
		return foldedResult(
			state,
			this.schema?.collections[op.collection]?.fields,
			this.foldOptions,
			storedPgFieldValue,
			false,
		)
	}

	async recordBlobOwner(hash: string, owner: string): Promise<void> {
		this.assertOpen()
		await this.ready
		await this.db.execute(
			sql`INSERT INTO blob_owners (hash, owner, created_at) VALUES (${hash}, ${owner}, ${Date.now()})
				ON CONFLICT (hash, owner) DO NOTHING`,
		)
	}

	async getBlobOwners(hashes: string[]): Promise<Map<string, string[]>> {
		this.assertOpen()
		await this.ready
		const result = new Map<string, string[]>(hashes.map((hash) => [hash, []]))
		for (let i = 0; i < hashes.length; i += 500) {
			const slice = hashes.slice(i, i + 500)
			if (slice.length === 0) continue
			const rows = (await this.db.execute(
				sql`SELECT hash, owner FROM blob_owners WHERE hash IN (${sql.join(
					slice.map((hash) => sql`${hash}`),
					sql.raw(', '),
				)})`,
			)) as unknown as { hash: string; owner: string }[]
			for (const row of rows) result.get(row.hash)?.push(row.owner)
		}
		return result
	}

	async claimBlobIfUnowned(hash: string, owner: string): Promise<boolean> {
		this.assertOpen()
		await this.ready
		// A transaction-scoped advisory lock per hash makes "insert when nobody owns it"
		// atomic across instances (two concurrent first claims cannot both win).
		return this.db.transaction(async (tx) => {
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kora:blob:${hash}`}, 0))`,
			)
			await tx.execute(
				sql`INSERT INTO blob_owners (hash, owner, created_at)
					SELECT ${hash}, ${owner}, ${Date.now()}
					WHERE NOT EXISTS (SELECT 1 FROM blob_owners WHERE hash = ${hash})
					ON CONFLICT (hash, owner) DO NOTHING`,
			)
			const rows = (await tx.execute(
				sql`SELECT 1 AS one FROM blob_owners WHERE hash = ${hash} AND owner = ${owner} LIMIT 1`,
			)) as unknown as unknown[]
			return rows.length > 0
		})
	}

	/**
	 * Scope values of a record as stored, for an operation's scope snapshot. With
	 * `includeDeleted` false a soft-deleted row counts as absent; with true it keeps
	 * its last values (a delete's post-image).
	 */
	private async readScopeValues(
		txOrDb: PostgresJsDatabase,
		collection: string,
		recordId: string,
		includeDeleted: boolean,
	): Promise<Record<string, unknown> | null> {
		const collectionDef = this.schema?.collections[collection]
		if (!collectionDef) return null
		const rows = (await txOrDb.execute(
			sql`SELECT * FROM ${sql.raw(quoteIdent(collection))} WHERE id = ${recordId} LIMIT 1`,
		)) as unknown as Record<string, unknown>[]
		const row = rows[0]
		if (!row) return null
		if (!includeDeleted && Number(row._deleted) === 1) return null
		return scopeValuesOf(this.schema, collection, recordId, this.deserializeRow(row, collectionDef))
	}

	/**
	 * Reconcile the written record's membership intervals with what it holds now, in the
	 * write's transaction (which holds the delivery-counter lock, so index changes commit
	 * in delivery order).
	 */
	private async updateMembershipIndex(
		tx: PostgresJsDatabase,
		collection: string,
		recordId: string,
		deliverySeq: number,
		groupBefore: GroupRecordState | null,
	): Promise<void> {
		const access = this.schema?.access
		if (!feedsMembershipIndex(access, collection)) return
		await this.reconcileRecordMemberships(tx, collection, recordId, deliverySeq)
		// A group record deleted or revived: its members' rows hold nothing or hold again.
		if (
			access?.memberships &&
			groupBefore !== null &&
			groupDeletionChanged(
				groupBefore,
				groupRecordState(await this.readIndexedRecord(tx, collection, recordId)),
			)
		) {
			const rows = (await tx.execute(
				sql`SELECT id FROM ${sql.raw(quoteIdent(access.memberships))} WHERE ${sql.raw(quoteIdent('group'))} = ${groupKey(collection, recordId)}`,
			)) as unknown as { id: string }[]
			for (const row of rows) {
				await this.reconcileRecordMemberships(tx, access.memberships, row.id, deliverySeq)
			}
		}
	}

	/** A group record's state before `op` writes it (null for other collections). */
	private async groupStateBefore(
		tx: PostgresJsDatabase,
		op: Operation,
	): Promise<GroupRecordState | null> {
		if (!writeAffectsGroupMembers(this.schema?.access, op.collection)) return null
		return groupRecordState(await this.readIndexedRecord(tx, op.collection, op.recordId))
	}

	/** Reconcile one record's open intervals with what it holds now, in `tx`, at `deliverySeq`. */
	private async reconcileRecordMemberships(
		tx: PostgresJsDatabase,
		collection: string,
		recordId: string,
		deliverySeq: number,
	): Promise<void> {
		const access = this.schema?.access
		// Only this record's open intervals (indexed lookups, not a scan of the index,
		// which matters while this transaction holds the delivery-counter lock).
		const open = (
			await this.readIntervals(
				tx,
				sql`SELECT user_id, group_key, source, record_id, role, expires_at, joined_seq, role_seq, left_seq
					FROM _kora_access_memberships
					WHERE left_seq IS NULL AND (
						(source = 'membership' AND record_id = ${recordId})
						OR (source = 'owner' AND group_key = ${groupKey(collection, recordId)})
					)
					ORDER BY id`,
			)
		).filter((interval) => intervalBelongsTo(access, interval, collection, recordId))
		const record = await this.readIndexedRecord(tx, collection, recordId)
		// The membership's group, when it is a group collection's record, decides too.
		let groupDeleted = false
		if (access && record.values && collection === access.memberships) {
			const group = typeof record.values.group === 'string' ? record.values.group : ''
			const groupCollection = groupCollectionOf(access, group)
			const parsed = parseGroupKey(group)
			if (groupCollection !== null && parsed !== null) {
				groupDeleted = (await this.readIndexedRecord(tx, groupCollection, parsed.id)).deleted
			}
		}
		const desired = desiredMemberships(access, record, () => groupDeleted)
		await this.applyMembershipChanges(tx, reconcileRecord(open, desired), deliverySeq)
	}

	/**
	 * A record of an indexed collection as stored now (deleted ones included), with its
	 * full values (the scope snapshot form drops strings over 512 characters).
	 */
	private async readIndexedRecord(
		tx: PostgresJsDatabase,
		collection: string,
		recordId: string,
	): Promise<IndexedRecord> {
		const collectionDef = this.schema?.collections[collection]
		if (!collectionDef) return { collection, recordId, values: null, deleted: false }
		const rows = (await tx.execute(
			sql`SELECT * FROM ${sql.raw(quoteIdent(collection))} WHERE id = ${recordId} LIMIT 1`,
		)) as unknown as Record<string, unknown>[]
		const row = rows[0]
		if (!row) return { collection, recordId, values: null, deleted: false }
		return {
			collection,
			recordId,
			values: { ...this.deserializeRow(row, collectionDef), id: recordId },
			deleted: Number(row._deleted) === 1,
		}
	}

	private async readOpenIntervals(tx: PostgresJsDatabase): Promise<MembershipInterval[]> {
		return this.readIntervals(
			tx,
			sql`SELECT user_id, group_key, source, record_id, role, expires_at, joined_seq, role_seq, left_seq
				FROM _kora_access_memberships WHERE left_seq IS NULL ORDER BY id`,
		)
	}

	private async readIntervals(tx: PostgresJsDatabase, query: SQL): Promise<MembershipInterval[]> {
		const rows = (await tx.execute(query)) as unknown as {
			user_id: string
			group_key: string
			source: string
			record_id: string
			role: string
			expires_at: string | number | null
			joined_seq: string | number
			role_seq: string | number | null
			left_seq: string | number | null
		}[]
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

	/** Write index changes at `atSeq` (closes, in-place updates, opens). */
	private async applyMembershipChanges(
		tx: PostgresJsDatabase,
		changes: MembershipIndexChanges,
		atSeq: number,
	): Promise<void> {
		for (const key of changes.close) {
			await tx.execute(
				sql`UPDATE _kora_access_memberships SET left_seq = ${atSeq}
					WHERE user_id = ${key.userId} AND group_key = ${key.group} AND source = ${key.source}
					AND record_id = ${key.recordId} AND left_seq IS NULL`,
			)
		}
		for (const want of changes.update) {
			await tx.execute(
				sql`UPDATE _kora_access_memberships SET role = ${want.role}, expires_at = ${want.expiresAt}, role_seq = ${atSeq}
					WHERE user_id = ${want.userId} AND group_key = ${want.group} AND source = ${want.source}
					AND record_id = ${want.recordId} AND left_seq IS NULL`,
			)
		}
		for (const want of changes.open) {
			await tx.execute(
				sql`INSERT INTO _kora_access_memberships
					(user_id, group_key, source, record_id, role, expires_at, joined_seq, role_seq, left_seq)
					VALUES (${want.userId}, ${want.group}, ${want.source}, ${want.recordId}, ${want.role},
					${want.expiresAt}, ${want.fromStart ? 0 : atSeq}, ${want.fromStart ? 0 : atSeq}, NULL)`,
			)
		}
	}

	/**
	 * Make the whole index match the records after a schema change, a re-fold or a
	 * restore, in one transaction under the delivery-counter lock (no append interleaves).
	 * Intervals of memberships that still hold keep their `joinedSeq`; one of a newly
	 * indexed collection opens from the start; anything else changes at the current
	 * delivery sequence. The configuration is stored with it.
	 */
	private async reconcileMembershipIndex(): Promise<void> {
		const access = this.schema?.access
		let generation: string | null = null
		let markerRemains = false
		const removable = this.accessIndex.removableMarkers()
		await this.db.transaction(async (tx) => {
			await this.lockDeliveryCounter(tx)
			const meta = async (key: string): Promise<string | undefined> =>
				(
					(await tx.execute(
						sql`SELECT value FROM kora_server_meta WHERE key = ${key}`,
					)) as unknown as { value: string }[]
				)[0]?.value
			const setMeta = async (key: string, value: string): Promise<void> => {
				await tx.execute(
					sql`INSERT INTO kora_server_meta (key, value) VALUES (${key}, ${value})
						ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
				)
			}
			const records: IndexedRecord[] = []
			for (const collection of Object.keys(this.schema?.collections ?? {})) {
				if (!feedsMembershipIndex(access, collection)) continue
				const ids = (await tx.execute(
					sql`SELECT id FROM ${sql.raw(quoteIdent(collection))}`,
				)) as unknown as { id: string }[]
				for (const row of ids) records.push(await this.readIndexedRecord(tx, collection, row.id))
			}
			const changes = reconcileIndex(
				access,
				records,
				await this.readOpenIntervals(tx),
				parseMembershipIndexFingerprint(await meta(MEMBERSHIP_INDEX_FINGERPRINT_KEY)),
			)
			const ever = mergeAccessCollectionsEver(await meta(ACCESS_COLLECTIONS_EVER_KEY), access)
			if (ever.changed) await setMeta(ACCESS_COLLECTIONS_EVER_KEY, ever.value)
			// Intervals indexed before role_seq existed may have changed role at any point.
			const unknownRoles =
				(
					(await tx.execute(
						sql`SELECT 1 AS one FROM _kora_access_memberships WHERE role_seq IS NULL LIMIT 1`,
					)) as unknown as unknown[]
				).length > 0
			if (hasMembershipChanges(changes) || unknownRoles) {
				// No operation carries a reconcile: it takes a delivery sequence of its own
				// (under the counter lock, so every earlier sequence is already committed).
				const reserved = await this.nextDeliverySeq(tx)
				await this.applyMembershipChanges(tx, changes, reserved)
				await tx.execute(
					sql`UPDATE _kora_access_memberships SET role_seq = ${reserved} WHERE role_seq IS NULL`,
				)
				await setMeta(ACCESS_FRONTIER_KEY, String(reserved))
				// Intervals opened at sequence 0 reuse sequences: a new generation.
				if (opensFromStart(changes)) {
					await setMeta(ACCESS_INDEX_GENERATION_KEY, newAccessIndexGeneration())
				}
			}
			await setMeta(MEMBERSHIP_INDEX_FINGERPRINT_KEY, membershipIndexFingerprint(access))
			generation = (await meta(ACCESS_INDEX_GENERATION_KEY)) ?? null
			// Only this instance's own (or adopted) markers: another rebuild may be running.
			// Only markers whose lease this instance still holds (one taken over meanwhile is
			// the taker's to clear).
			for (const key of removable) {
				await tx.execute(
					sql`DELETE FROM kora_server_meta
						WHERE key = ${key} AND split_part(value, '|', 2) = ${this.accessIndex.leaseOwner}`,
				)
			}
			markerRemains = (await this.rebuildingMarkers(tx)).length > 0
		})
		this.accessIndex.rebuilt(generation, markerRemains, removable)
	}

	/** The rebuild markers present (keys), from any instance. */
	private async rebuildingMarkers(db: {
		execute: (query: SQL) => Promise<unknown>
	}): Promise<string[]> {
		const rows = (await db.execute(
			sql`SELECT key FROM kora_server_meta WHERE substr(key, 1, ${ACCESS_INDEX_REBUILDING_PREFIX.length}) = ${ACCESS_INDEX_REBUILDING_PREFIX}`,
		)) as unknown as { key: string }[]
		return rows.map((row) => row.key)
	}

	/**
	 * Claims markers left by an interrupted rebuild (the running hold finishes the work):
	 * those whose lease ran out, because their process stopped renewing them. Claiming
	 * renews the lease in one statement, so of several instances recovering at once only
	 * one takes each marker, and a rebuild still running elsewhere keeps its own.
	 */
	private async adoptRebuildingMarker(): Promise<string[]> {
		const store = this.realStore()
		const rows = (await store.db.execute(
			sql`UPDATE kora_server_meta
				SET value = ((extract(epoch from clock_timestamp()) * 1000)::bigint + ${ACCESS_INDEX_MARKER_LEASE_MS})::text || '|' || ${this.accessIndex.leaseOwner}
				WHERE substr(key, 1, ${ACCESS_INDEX_REBUILDING_PREFIX.length}) = ${ACCESS_INDEX_REBUILDING_PREFIX}
					AND CASE WHEN split_part(value, '|', 1) ~ '^[0-9]+$'
						THEN split_part(value, '|', 1)::bigint < (extract(epoch from clock_timestamp()) * 1000)::bigint
						ELSE true END
				RETURNING key`,
		)) as unknown as { key: string }[]
		const claimed = rows.map((row) => row.key)
		if (claimed.length > 0) this.accessIndex.adopt(claimed)
		return claimed
	}

	/** The store itself, when called through a transaction's view. */
	private realStore(): PostgresServerStore {
		return storeIdentity(this) as unknown as PostgresServerStore
	}

	/**
	 * Renews this instance's marker leases, on the store's own connection: only those that
	 * still carry its lease token (a marker another instance took over is no longer its).
	 */
	private async renewMarkerLeases(keys: readonly string[]): Promise<void> {
		const rows = (await this.db.execute(
			sql`UPDATE kora_server_meta
				SET value = ((extract(epoch from clock_timestamp()) * 1000)::bigint + ${ACCESS_INDEX_MARKER_LEASE_MS})::text || '|' || ${this.accessIndex.leaseOwner}
				WHERE key IN (${sql.join(
					keys.map((key) => sql`${key}`),
					sql`, `,
				)}) AND split_part(value, '|', 2) = ${this.accessIndex.leaseOwner}
				RETURNING key`,
		)) as unknown as { key: string }[]
		reportLostLeases(keys, rows.length)
	}

	/**
	 * Recovers a rebuild every instance abandoned: claims the expired markers and, if it
	 * got any, installs the schema again (a full rebuild), as one hold. Started in the
	 * background by an index read, outside the transaction that read may belong to.
	 */
	private recoverAbandonedRebuild(): void {
		const store = this.realStore()
		store.accessIndex.recoverAbandoned(
			() =>
				outsideDecision(() =>
					store.accessIndex.hold(async (mutated) => {
						const schema = store.schema
						const claimed = await store.adoptRebuildingMarker()
						// Nothing to finish: another instance claimed the markers, unless this
						// one is stuck after its own failed rebuild (only its rebuild clears that).
						if (!schema || (claimed.length === 0 && !store.accessIndex.isStuck())) return
						await store.installSchema(schema, {}, mutated)
					}),
				),
			(error) => {
				console.error(
					'[kora] Could not rebuild the membership index after an interrupted rebuild. Access rules stay out of force; the rebuild is retried with a backoff.',
					error,
				)
			},
		)
	}

	/**
	 * Writes this instance's rebuild marker inside `tx`, so every instance stops judging
	 * access rules until this instance's next index rebuild commits.
	 */
	private async writeRebuildingMarker(tx: {
		execute: (query: SQL) => Promise<unknown>
	}): Promise<void> {
		if (!this.schema?.access) return
		await tx.execute(
			sql`INSERT INTO kora_server_meta (key, value)
				VALUES (${this.accessIndex.ownMarker(ACCESS_INDEX_REBUILDING_PREFIX, this.nodeId)},
					((extract(epoch from clock_timestamp()) * 1000)::bigint + ${ACCESS_INDEX_MARKER_LEASE_MS})::text || '|' || ${this.accessIndex.leaseOwner})
				ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
		)
	}

	async getAccessIndexState(): Promise<AccessIndexState> {
		this.assertOpen()
		await this.ready
		const readToken = this.accessIndex.beginRead()
		const rows = (await this.db.execute(
			sql`SELECT key, value, (extract(epoch from clock_timestamp()) * 1000)::bigint AS now
				FROM kora_server_meta WHERE key IN (${ACCESS_FRONTIER_KEY}, ${ACCESS_COLLECTIONS_EVER_KEY}, ${ACCESS_INDEX_GENERATION_KEY})
				OR substr(key, 1, ${ACCESS_INDEX_REBUILDING_PREFIX.length}) = ${ACCESS_INDEX_REBUILDING_PREFIX}`,
		)) as unknown as { key: string; value: string; now: string | number }[]
		const meta = (key: string) => rows.find((row) => row.key === key)?.value
		const generation = meta(ACCESS_INDEX_GENERATION_KEY) ?? null
		const markers = rows.filter((row) => row.key.startsWith(ACCESS_INDEX_REBUILDING_PREFIX))
		const rebuilding = markers.length > 0
		this.accessIndex.seen(generation, rebuilding, readToken)
		// Every marker abandoned (its process stopped), or this instance stuck after a failed
		// rebuild with none running: nobody else will finish the rebuild it needs.
		const abandoned = markers.every((row) => markerLeaseExpired(row.value, Number(row.now)))
		if (abandoned && (rebuilding || this.accessIndex.isStuck())) {
			this.recoverAbandonedRebuild()
		}
		return {
			frontier: Number(meta(ACCESS_FRONTIER_KEY) ?? 0) || 0,
			accessCollectionsEver: parseAccessCollectionsEver(meta(ACCESS_COLLECTIONS_EVER_KEY)),
			generation,
			rebuilding,
		}
	}

	async getExpiredMembershipIntervals(now: number, limit: number): Promise<MembershipInterval[]> {
		this.assertOpen()
		await this.ready
		return this.readIntervals(
			this.db,
			sql`SELECT user_id, group_key, source, record_id, role, expires_at, joined_seq, role_seq, left_seq
				FROM _kora_access_memberships
				WHERE left_seq IS NULL AND source = 'membership' AND expires_at IS NOT NULL AND expires_at <= ${now}
				ORDER BY expires_at LIMIT ${limit}`,
		)
	}

	async getMembershipIntervals(userId: string): Promise<MembershipInterval[]> {
		this.assertOpen()
		await this.ready
		return this.readIntervals(
			this.db,
			sql`SELECT user_id, group_key, source, record_id, role, expires_at, joined_seq, role_seq, left_seq
				FROM _kora_access_memberships WHERE user_id = ${userId} ORDER BY id`,
		)
	}

	/** Persist the scope snapshot of a just-applied operation (RT-14). */
	private async writeScopeSnapshot(
		tx: PostgresJsDatabase,
		op: Operation,
		pre: Record<string, unknown> | null,
		deliverySeq: number,
		liveViews: LiveViewWrite,
	): Promise<void> {
		const collectionDef = this.schema?.collections[op.collection]
		let tracking = liveViews.tracking
		// A write that may change the record's summary reads it with the row it reads
		// anyway, and writes it with the snapshot below: no extra round trip. A new record
		// reads its collection's registered fields the same way (it is tracked from them,
		// as the database says now, never from this instance's cache).
		const fetchViews =
			tracking !== null && !tracking.created && liveViewMayChange(tracking, op, pre)
		const extra = fetchViews
			? sql`(SELECT v.views FROM kora_record_live_views v WHERE v.collection = ${op.collection} AND v.record_id = ${op.recordId})`
			: liveViews.newRecord
				? sql`(SELECT m.value FROM kora_server_meta m WHERE m.key = ${`${LIVE_VIEW_FIELDS_KEY_PREFIX}${op.collection}`})`
				: sql`NULL`
		const rows = collectionDef
			? ((await tx.execute(
					sql`SELECT c.*, ${extra} AS "__kora_live_views" FROM ${sql.raw(quoteIdent(op.collection))} c WHERE c.id = ${op.recordId} LIMIT 1`,
				)) as unknown as Record<string, unknown>[])
			: []
		const row = rows[0]
		let createColumns: { through: string; fields: string } | null = null
		if (liveViews.newRecord) {
			const registered = parseLiveViewFields(row?.__kora_live_views)
			const created = liveViewTrackingFor(
				null,
				null,
				op.id,
				registered.length > 0 ? registered : null,
			)
			tracking = created.tracking
			createColumns = created.columns
		}
		const post =
			row && collectionDef
				? scopeValuesOf(
						this.schema,
						op.collection,
						op.recordId,
						this.deserializeRow(row, collectionDef),
					)
				: null
		// The tombstone state rides along: a session decides delivery on the record's
		// folded state, not on the operation's own values.
		const snapshot: OperationScopeSnapshot = {
			pre,
			post,
			...(post && row ? { deleted: Number(row._deleted) === 1 } : {}),
		}
		const snapshotSql = sql`UPDATE operations SET scope_snapshot = ${JSON.stringify(snapshot)} WHERE id = ${op.id}`
		if (liveViews.stale) this.requestLiveViewRebuild(op.collection, op.recordId)
		if (!tracking || !liveViewChangeNeeded(tracking, op, snapshot)) {
			await tx.execute(snapshotSql)
			return
		}
		let views: RecordLiveViews | null = tracking.created ? emptyLiveViews(tracking.fields) : null
		if (!views && fetchViews) views = parseLiveViews(row?.__kora_live_views)
		if (!views && !fetchViews) {
			// Not predicted (see liveViewMayChange): read it on its own.
			views = parseLiveViews(
				(
					(await tx.execute(
						sql`SELECT views FROM kora_record_live_views WHERE collection = ${op.collection} AND record_id = ${op.recordId}`,
					)) as unknown as { views: string }[]
				)[0]?.views,
			)
		}
		if (!views) {
			// Tracked, but its summary is gone (removed with a re-fold): unknown until rebuilt.
			await tx.execute(
				sql`WITH s AS (${snapshotSql}) UPDATE kora_fold_state SET lv_through = NULL WHERE collection = ${op.collection} AND record_id = ${op.recordId}`,
			)
			this.requestLiveViewRebuild(op.collection, op.recordId)
			return
		}
		// An overflowed summary proves nothing any more; only its newest delete is kept.
		if (views.overflow && op.type !== 'delete') {
			await tx.execute(snapshotSql)
			return
		}
		const next = advanceLiveViews(views, {
			seq: deliverySeq,
			op,
			live: snapshot.post !== null && snapshot.deleted === false,
			values: snapshot.post,
		})
		// One statement: the snapshot, the summary and (a new record) its live-view columns.
		const trackSql = createColumns
			? sql`, f AS (UPDATE kora_fold_state SET lv_through = ${createColumns.through}, lv_fields = ${createColumns.fields} WHERE collection = ${op.collection} AND record_id = ${op.recordId})`
			: sql``
		await tx.execute(
			sql`WITH s AS (${snapshotSql})${trackSql}
				INSERT INTO kora_record_live_views (collection, record_id, views)
				VALUES (${op.collection}, ${op.recordId}, ${serializeLiveViews(next)})
				ON CONFLICT (collection, record_id) DO UPDATE SET views = EXCLUDED.views`,
		)
	}

	/**
	 * Rebuild missing scope snapshots from the log (migration from a database written
	 * before snapshots existed), replaying each affected record in commit order.
	 */
	private async backfillScopeSnapshots(): Promise<void> {
		const schema = this.schema
		if (!schema) return
		const pending = (await this.db.execute(
			sql`SELECT DISTINCT collection, record_id FROM operations WHERE scope_snapshot IS NULL`,
		)) as unknown as { collection: string; record_id: string }[]
		const byCollection = new Map<string, string[]>()
		for (const row of pending) {
			if (schema.collections[row.collection] === undefined) continue
			const ids = byCollection.get(row.collection)
			if (ids) ids.push(row.record_id)
			else byCollection.set(row.collection, [row.record_id])
		}
		// Records in chunks: one read of their operations and one batched update per
		// chunk, instead of a statement per record and per operation. Each chunk's
		// updates commit on their own, so a restart resumes at the snapshots still missing.
		const progress = new FoldMigrationProgress('Scope snapshot rebuild')
		progress.setTotal(pending.length)
		for (const [collection, recordIds] of byCollection) {
			for (let i = 0; i < recordIds.length; i += FOLD_MIGRATION_BATCH) {
				const chunk = recordIds.slice(i, i + FOLD_MIGRATION_BATCH)
				const rows = await this.db
					.select()
					.from(pgOperations)
					.where(
						and(eq(pgOperations.collection, collection), inArray(pgOperations.recordId, chunk)),
					)
					.orderBy(asc(pgOperations.deliverySeq))
				const byRecord = new Map<string, Array<(typeof rows)[number]>>()
				for (const row of rows) {
					const list = byRecord.get(row.recordId)
					if (list) list.push(row)
					else byRecord.set(row.recordId, [row])
				}
				const updates: Array<[string, string]> = []
				for (const [recordId, recordRows] of byRecord) {
					const replayed = replayScopeSnapshots(
						schema,
						collection,
						recordId,
						recordRows.map((row) => this.deserializeOperation(row)),
						this.foldOptions,
					)
					for (const row of recordRows) {
						if (row.scopeSnapshot !== null) continue
						const snapshot = replayed.get(row.id)
						if (snapshot) updates.push([row.id, JSON.stringify(snapshot)])
					}
				}
				for (let j = 0; j < updates.length; j += 1000) {
					const values = updates
						.slice(j, j + 1000)
						.map(([id, snapshot]) => sql`(${id}, ${snapshot})`)
					// Only fill a still-empty column: a concurrent apply's own snapshot wins.
					await this.db.execute(
						sql`UPDATE operations AS o SET scope_snapshot = v.s
							FROM (VALUES ${sql.join(values, sql.raw(', '))}) AS v(id, s)
							WHERE o.id = v.id AND o.scope_snapshot IS NULL`,
					)
				}
				progress.advance(chunk.length, byRecord.size)
				if (progress.due()) progress.report()
			}
		}
		progress.finish()
	}

	async materializeCollection(collection: string): Promise<MaterializedRecord[]> {
		this.assertOpen()
		await this.ready

		// Fast path: if schema is set, read directly from the materialized table
		if (this.schema?.collections[collection]) {
			return this.queryCollection(collection)
		}

		// Fallback: replay operations (legacy path when schema is not set)
		return this.materializeFromOpsLog(collection)
	}

	async getNodeIdsAfterDelivery(afterDeliverySequence: number): Promise<string[]> {
		this.assertOpen()
		await this.ready
		const rows = (await this.db.execute(
			sql`SELECT DISTINCT node_id FROM operations WHERE delivery_seq > ${afterDeliverySequence}`,
		)) as unknown as { node_id: string }[]
		return rows.map((row) => row.node_id)
	}

	async getSequencePairOperations(nodeId: string, throughSequence: number): Promise<Operation[]> {
		this.assertOpen()
		await this.ready
		const rows = await this.db
			.select()
			.from(pgOperations)
			.where(
				and(
					eq(pgOperations.nodeId, nodeId),
					sql`${pgOperations.sequenceNumber} IN (SELECT sequence_number FROM sequence_pairs WHERE node_id = ${nodeId} AND sequence_number <= ${throughSequence})`,
				),
			)
			.orderBy(asc(pgOperations.sequenceNumber), asc(pgOperations.deliverySeq))
		return rows.map((row) => this.deserializeOperation(row))
	}

	async recordOperationResolution(resolution: OperationResolution): Promise<void> {
		this.assertOpen()
		await this.ready
		await this.db.execute(
			sql`INSERT INTO operation_resolutions
				(op_id, node_id, sequence_number, outcome, code, message, resolved_at)
				VALUES (${resolution.operationId}, ${resolution.nodeId}, ${resolution.sequenceNumber},
					${resolution.outcome}, ${resolution.code},
					${
						// A human-readable message: an unstorable code unit is replaced (RT-65).
						resolution.message?.slice(0, MAX_RESOLUTION_MESSAGE_LENGTH).replace(
							// biome-ignore lint/suspicious/noControlCharactersInRegex: U+0000 is what Postgres TEXT refuses (RT-65)
							/\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
							'\ufffd',
						) ?? null
					}, ${Date.now()})
				ON CONFLICT (op_id) DO NOTHING`,
		)
	}

	async findOperationResolutions(
		nodeId: string,
		ids: string[],
	): Promise<Map<string, OperationResolution>> {
		this.assertOpen()
		await this.ready
		const found = new Map<string, OperationResolution>()
		for (let i = 0; i < ids.length; i += 1000) {
			const chunk = ids.slice(i, i + 1000)
			if (chunk.length === 0) continue
			const rows = (await this.db.execute(
				sql`SELECT op_id, node_id, sequence_number, outcome, code, message FROM operation_resolutions
					WHERE node_id = ${nodeId} AND op_id IN (${sql.join(
						chunk.map((id) => sql`${id}`),
						sql.raw(', '),
					)})`,
			)) as unknown as {
				op_id: string
				node_id: string
				sequence_number: number | string
				outcome: string
				code: string | null
				message: string | null
			}[]
			for (const row of rows) {
				found.set(row.op_id, {
					operationId: row.op_id,
					nodeId: row.node_id,
					sequenceNumber: Number(row.sequence_number),
					outcome: row.outcome as OperationResolutionOutcome,
					code: row.code,
					message: row.message,
				})
			}
		}
		return found
	}

	async deleteOperationResolution(nodeId: string, operationId: string): Promise<void> {
		this.assertOpen()
		await this.ready
		await this.db.execute(
			sql`DELETE FROM operation_resolutions WHERE node_id = ${nodeId} AND op_id = ${operationId}`,
		)
	}

	async getResolvedThrough(nodeId: string): Promise<number> {
		this.assertOpen()
		await this.ready
		const rows = (await this.db.execute(
			sql`SELECT MAX(sequence_number) AS m FROM operation_resolutions WHERE node_id = ${nodeId}`,
		)) as unknown as { m: string | number | null }[]
		return Number(rows[0]?.m ?? 0)
	}

	async findStoredOperations(ids: string[]): Promise<Map<string, StoredOperationKey>> {
		this.assertOpen()
		await this.ready
		const found = new Map<string, StoredOperationKey>()
		// One statement per 1000 ids, well below the bind-parameter limit.
		for (let i = 0; i < ids.length; i += 1000) {
			const chunk = ids.slice(i, i + 1000)
			if (chunk.length === 0) continue
			const rows = (await this.db.execute(
				sql`SELECT id, node_id, sequence_number FROM operations WHERE id IN (${sql.join(
					chunk.map((id) => sql`${id}`),
					sql.raw(', '),
				)})`,
			)) as unknown as { id: string; node_id: string; sequence_number: number | string }[]
			for (const row of rows) {
				found.set(row.id, { nodeId: row.node_id, sequenceNumber: Number(row.sequence_number) })
			}
		}
		return found
	}

	async findRecordsByIds(
		collection: string,
		ids: string[],
	): Promise<Map<string, MaterializedRecord>> {
		this.assertOpen()
		await this.ready
		this.assertSchema()
		this.assertCollection(collection)
		const schema = this.schema as SchemaDefinition
		const collectionDef = schema.collections[collection] as NonNullable<
			SchemaDefinition['collections'][string]
		>
		const result = new Map<string, MaterializedRecord>()
		// One statement per 1000 ids (LMS #11), well below the bind-parameter limit.
		for (let i = 0; i < ids.length; i += 1000) {
			const chunk = ids.slice(i, i + 1000)
			if (chunk.length === 0) continue
			const rows = (await this.db.execute(
				sql`SELECT * FROM ${sql.raw(quoteIdent(collection))} WHERE id IN (${sql.join(
					chunk.map((id) => sql`${id}`),
					sql.raw(', '),
				)})`,
			)) as unknown as Record<string, unknown>[]
			for (const row of rows) {
				const record = this.deserializeRow(row, collectionDef)
				result.set(record.id, record)
			}
		}
		return result
	}

	async queryCollection(
		collection: string,
		options?: CollectionQueryOptions,
	): Promise<MaterializedRecord[]> {
		this.assertOpen()
		await this.ready
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
		const rows = (await this.db.execute(query)) as unknown as Record<string, unknown>[]

		return rows.map((row) => this.deserializeRow(row, collectionDef))
	}

	async findRecord(collection: string, id: string): Promise<MaterializedRecord | null> {
		this.assertOpen()
		await this.ready
		this.assertSchema()
		this.assertCollection(collection)

		const schema = this.schema as SchemaDefinition
		const collectionDef = schema.collections[collection] as NonNullable<
			SchemaDefinition['collections'][string]
		>
		const query = sql`SELECT * FROM ${sql.raw(quoteIdent(collection))} WHERE id = ${id} AND _deleted = 0`
		const rows = (await this.db.execute(query)) as unknown as Record<string, unknown>[]

		if (rows.length === 0) return null
		return this.deserializeRow(rows[0] as Record<string, unknown>, collectionDef)
	}

	async countCollection(collection: string, where?: Record<string, unknown>): Promise<number> {
		this.assertOpen()
		await this.ready
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
		const rows = (await this.db.execute(query)) as unknown as Array<{ cnt: number | string }>
		const cnt = rows[0]?.cnt
		return typeof cnt === 'string' ? Number.parseInt(cnt, 10) : (cnt ?? 0)
	}

	async close(): Promise<void> {
		this.closed = true
		await this.liveViewBackfill
	}

	async exportBackup(): Promise<Uint8Array> {
		this.assertOpen()
		await this.ready

		const { buildServerBackup } = await import('./server-backup')

		// Export in delivery-sequence order (commit order), NOT sequenceNumber order.
		// sequenceNumber is per-node and interleaves nodes arbitrarily, which can place a
		// dependent operation before its dependency; restoring in that order would then
		// reassign delivery sequences non-causally, so a resumed client would receive the
		// dependent first, defer it, advance its watermark past it, and lose it. Delivery
		// order is commit order and therefore respects causality.
		const rows = await this.db.select().from(pgOperations).orderBy(asc(pgOperations.deliverySeq))
		const operations = rows.map((row) => this.deserializeOperation(row))

		return buildServerBackup(
			this.nodeId,
			operations,
			this.versionVector,
			await this.listEncryptionKeyRecords(),
		)
	}

	async importBackup(
		data: Uint8Array,
		merge?: boolean,
	): Promise<{ operationsRestored: number; success: boolean }> {
		this.assertOpen()
		await this.ready

		const { mergeBackupOperations, parseServerBackup, restoreBackupKeyRecords } = await import(
			'./server-backup'
		)
		const { operations, versionVector, keyRecords } = parseServerBackup(data)
		// Both modes reconcile the key table (not part of the log), record by record (RT-110).
		await restoreBackupKeyRecords(this, keyRecords, merge === true)

		if (merge) {
			const merged = await mergeBackupOperations(operations, (op) => this.applyRemoteOperation(op))
			// Re-seed the sequence counter from the (possibly advanced) version vector,
			// in case the merge restored operations on this node with higher numbers.
			this.sequenceCounter = null
			return merged
		}
		// Access rules are out of force until the index is rebuilt (for good, with the
		// shared marker every instance honors, if the restore fails after replacing).
		let restored: { operationsRestored: number; success: boolean }
		try {
			restored = await this.accessIndex.hold((mutated) =>
				this.replaceFromBackup(operations, versionVector, mutated),
			)
		} finally {
			// A lookup that ran against the replaced log meanwhile is not kept.
			this.tombstoneStarts.clear()
		}
		// The summaries of the restored log are built in the background, from the start.
		if (this.liveViewFields.size > 0) this.kickLiveViewBackfill()
		return restored
	}

	private async replaceFromBackup(
		operations: Operation[],
		versionVector: Map<string, number>,
		mutated: () => void,
	): Promise<{ operationsRestored: number; success: boolean }> {
		// Delivery sequences are reassigned: nothing decided before still holds.
		this.tombstoneStarts.clear()
		const now = Date.now()
		const restoredMax = await this.db.transaction(async (tx) => {
			// First: an upload or a transaction in flight commits before the replace (its
			// delivery sequence cannot survive into the restored log), or waits for it.
			await this.lockDeliveryCounter(tx)
			// No rebuild that read the log being replaced may store a summary of it.
			await this.bumpLiveViewEpoch(tx)

			// Restored rows are inserted unflagged (`seq_unique = 0`: a legacy log may reuse
			// a sequence), so they stay outside the partial unique index; they sit at or
			// below the new epoch and the append check judges them as holders.
			await tx.delete(pgOperations)
			await tx.delete(pgSyncState)
			// Live-view summaries describe the replaced log: none survives it.
			await tx.execute(sql`DELETE FROM kora_record_live_views`)
			await tx.execute(sql`UPDATE kora_fold_state SET lv_through = NULL, lv_fields = NULL`)
			// A finished backfill pass over the replaced log says nothing about the restored one.
			await tx.execute(
				sql`DELETE FROM kora_server_meta WHERE key LIKE ${`${LIVE_VIEW_CURSOR_KEY_PREFIX}%`}`,
			)

			for (const [nid, seq] of versionVector) {
				await tx
					.insert(pgSyncState)
					.values({ nodeId: nid, maxSequenceNumber: seq, lastSeenAt: now })
					.onConflictDoNothing({ target: pgSyncState.nodeId })
			}

			// Re-assign delivery sequence from scratch in backup order, then realign the
			// counter so future appends continue above the restored maximum.
			let deliverySeq = 0
			for (const op of operations) {
				deliverySeq += 1
				const row = this.serializeOperation(op, now, deliverySeq)
				await tx.insert(pgOperations).values(row).onConflictDoNothing({ target: pgOperations.id })
			}
			await tx.execute(
				sql`INSERT INTO delivery_counter (id, value) VALUES (1, ${deliverySeq})
					ON CONFLICT (id) DO UPDATE SET value = ${deliverySeq}`,
			)
			// The restored log's legacy pairs (RT-48), and only the resolutions it covers:
			// one past a node's restored log was decided after the backup, and advertising
			// it would hide stored operations the restore lost (RT-45).
			await tx.execute(sql`DELETE FROM sequence_pairs`)
			await tx.execute(sql.raw(BACKFILL_SEQUENCE_PAIRS_SQL))
			await tx.execute(sql.raw(PRUNE_RESOLUTIONS_PAST_LOG_SQL))
			// The restored snapshot sits at or below the new epoch (see
			// SEQUENCE_ENFORCEMENT_EPOCH_KEY); enforcement resumes above it.
			await tx.execute(
				sql`INSERT INTO kora_server_meta (key, value) VALUES (${SEQUENCE_ENFORCEMENT_EPOCH_KEY}, ${String(deliverySeq)})
					ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
			)
			// The membership index belongs to the replaced log: cleared with it, so a crash
			// before the rebuild leaves no stale interval and the next start rebuilds it.
			await tx.execute(sql`DELETE FROM _kora_access_memberships`)
			// The restored log has its own sequences: what was reserved before means nothing.
			await tx.execute(sql`DELETE FROM kora_server_meta WHERE key = ${ACCESS_FRONTIER_KEY}`)
			await tx.execute(
				sql`DELETE FROM kora_server_meta WHERE key = ${MEMBERSHIP_INDEX_FINGERPRINT_KEY}`,
			)
			// A new generation re-scopes every device in full at its next handshake.
			await tx.execute(
				sql`INSERT INTO kora_server_meta (key, value) VALUES (${ACCESS_INDEX_GENERATION_KEY}, ${newAccessIndexGeneration()})
					ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
			)
			// The records and their fold state belong to the replaced log too: cleared in the
			// same transaction, so a crash before the re-materialization below leaves no
			// pre-restore record behind (the next start folds every record from the restored
			// log, and would otherwise keep and index rows the restore removed).
			await tx.execute(sql`DELETE FROM kora_fold_state`)
			for (const collection of Object.keys(this.schema?.collections ?? {})) {
				await tx.execute(sql.raw(`DELETE FROM ${quoteIdent(collection)}`))
			}
			// Other instances refuse to judge access rules until the rebuild commits.
			await this.writeRebuildingMarker(tx)
			return deliverySeq
		})
		mutated()
		this.sequenceEpoch = restoredMax
		// Every restored record is re-materialized through the fold from the restored log.
		if (this.schema) this.foldMigration = await this.rematerialize()
		await this.backfillScopeSnapshots()
		// Rebuilt from the restored records (the replace transaction cleared it).
		await this.reconcileMembershipIndex()

		// Rebuild in-memory version vector
		this.versionVector.clear()
		for (const [nid, seq] of versionVector) {
			this.versionVector.set(nid, seq)
		}
		// Re-seed the sequence counter from the restored version vector.
		this.sequenceCounter = null

		return { operationsRestored: operations.length, success: true }
	}

	// ---------------------------------------------------------------------------
	// Materialization internals
	// ---------------------------------------------------------------------------

	/**
	 * The HLC timestamp of the most recent operation on a record, by total order
	 * (wallTime, logical, nodeId), or null when the record has no operations. Used
	 * by {@link applyConditional} to advance its clock past the record's latest
	 * write so newly built operations sort strictly after it.
	 */
	private async latestOperationTimestamp(
		txOrDb: PostgresJsDatabase,
		collection: string,
		recordId: string,
	): Promise<HLCTimestamp | null> {
		const rows = await txOrDb
			.select({
				wallTime: pgOperations.wallTime,
				logical: pgOperations.logical,
				timestampNodeId: pgOperations.timestampNodeId,
			})
			.from(pgOperations)
			.where(and(eq(pgOperations.collection, collection), eq(pgOperations.recordId, recordId)))
			.orderBy(
				desc(pgOperations.wallTime),
				desc(pgOperations.logical),
				// Byte order (COLLATE "C"), like HLC.compare.
				sql`${pgOperations.timestampNodeId} COLLATE "C" DESC`,
			)
			.limit(1)

		const row = rows[0]
		if (!row) {
			return null
		}
		return { wallTime: row.wallTime, logical: row.logical, nodeId: row.timestampNodeId }
	}

	async getEncryptionKeyRecord(owner: string, keyring: string): Promise<string | null> {
		this.assertOpen()
		await this.ready
		const rows = (await this.db.execute(
			sql`SELECT record FROM kora_encryption_keys WHERE owner = ${owner} AND keyring = ${keyring} LIMIT 1`,
		)) as unknown as { record: string }[]
		return rows[0]?.record ?? null
	}

	async putEncryptionKeyRecord(
		owner: string,
		keyring: string,
		record: string,
		revision: number,
		expectedRevision: number,
	): Promise<boolean> {
		this.assertOpen()
		await this.ready
		const now = Date.now()
		// One statement each, atomic on the (owner, keyring) primary key: concurrent writes
		// from any number of server instances have exactly one winner.
		const rows = (expectedRevision === 0
			? await this.db.execute(
					sql`INSERT INTO kora_encryption_keys (owner, keyring, revision, record, updated_at)
							VALUES (${owner}, ${keyring}, ${revision}, ${record}, ${now})
							ON CONFLICT (owner, keyring) DO NOTHING RETURNING owner`,
				)
			: await this.db.execute(
					sql`UPDATE kora_encryption_keys SET revision = ${revision}, record = ${record}, updated_at = ${now}
							WHERE owner = ${owner} AND keyring = ${keyring} AND revision = ${expectedRevision}
							RETURNING owner`,
				)) as unknown as { owner: string }[]
		return rows.length > 0
	}

	async listEncryptionKeyRecords(owner?: string): Promise<EncryptionKeyRecordRow[]> {
		this.assertOpen()
		await this.ready
		const rows = (await this.db.execute(
			owner === undefined
				? sql`SELECT owner, keyring, revision, record FROM kora_encryption_keys ORDER BY owner, keyring`
				: sql`SELECT owner, keyring, revision, record FROM kora_encryption_keys WHERE owner = ${owner} ORDER BY keyring`,
		)) as unknown as Array<{
			owner: string
			keyring: string
			revision: number | string
			record: string
		}>
		// BIGINT columns may come back as strings.
		return rows.map((row) => ({
			owner: row.owner,
			keyring: row.keyring,
			revision: Number(row.revision),
			record: row.record,
		}))
	}

	async getEncryptedKeyIds(nodeOwner: string | null, limit: number): Promise<string[]> {
		this.assertOpen()
		await this.ready
		const rows = (nodeOwner === null
			? await this.db.execute(
					sql`SELECT encrypted FROM operations WHERE encrypted IS NOT NULL LIMIT ${KEY_ID_SAMPLE_ROWS}`,
				)
			: await this.db.execute(
					sql`SELECT o.encrypted AS encrypted FROM node_claims c
							JOIN operations o ON o.node_id = c.node_id
							WHERE c.user_id = ${nodeOwner} AND o.encrypted IS NOT NULL
							LIMIT ${KEY_ID_SAMPLE_ROWS}`,
				)) as unknown as { encrypted: string | null }[]
		return envelopeKeyIds(
			rows.map((row) => row.encrypted),
			limit,
		)
	}

	async claimNode(nodeId: string, userId: string): Promise<boolean> {
		this.assertOpen()
		await this.ready
		if (userId === RELEASED_NODE_OWNER) return false
		const now = Date.now()
		// Each statement is atomic on the node_claims primary key. A fresh claim is
		// only created for a node without history: history with no claim predates
		// node claims, so its writer is unknown (RT-5).
		await this.db.execute(
			sql`INSERT INTO node_claims (node_id, user_id, claimed_at)
				SELECT ${nodeId}, ${userId}, ${now}
				WHERE NOT EXISTS (SELECT 1 FROM operations WHERE node_id = ${nodeId})
				ON CONFLICT (node_id) DO NOTHING`,
		)
		// An admin-released node is taken over by its next claimant (one winner).
		await this.db.execute(
			sql`UPDATE node_claims SET user_id = ${userId}, claimed_at = ${now}
				WHERE node_id = ${nodeId} AND user_id = ${RELEASED_NODE_OWNER}`,
		)
		const rows = (await this.db.execute(
			sql`SELECT user_id FROM node_claims WHERE node_id = ${nodeId} LIMIT 1`,
		)) as unknown as { user_id: string }[]
		return rows[0]?.user_id === userId
	}

	async claimUnownedNode(nodeId: string, userId: string): Promise<boolean> {
		this.assertOpen()
		await this.ready
		if (userId === RELEASED_NODE_OWNER) return false
		// One upsert, atomic on the node_claims primary key: a missing claim row is
		// created, a released one ('') is taken over, and any other owner is left
		// untouched (the WHERE of the update). Concurrent claimants have one winner.
		await this.db.execute(
			sql`INSERT INTO node_claims (node_id, user_id, claimed_at)
				VALUES (${nodeId}, ${userId}, ${Date.now()})
				ON CONFLICT (node_id) DO UPDATE SET user_id = EXCLUDED.user_id, claimed_at = EXCLUDED.claimed_at
				WHERE node_claims.user_id = ${RELEASED_NODE_OWNER}`,
		)
		const rows = (await this.db.execute(
			sql`SELECT user_id FROM node_claims WHERE node_id = ${nodeId} LIMIT 1`,
		)) as unknown as { user_id: string }[]
		return rows[0]?.user_id === userId
	}

	async getNodeClaimOwner(nodeId: string): Promise<string | null> {
		this.assertOpen()
		await this.ready
		const rows = (await this.db.execute(
			sql`SELECT user_id FROM node_claims WHERE node_id = ${nodeId} LIMIT 1`,
		)) as unknown as { user_id: string }[]
		return rows[0]?.user_id ?? null
	}

	async replaceNodeClaim(
		nodeId: string,
		expectedOwner: string,
		newOwner: string,
	): Promise<boolean> {
		this.assertOpen()
		await this.ready
		// One statement, atomic on the row: concurrent re-issues have one winner.
		const rows = (await this.db.execute(
			sql`UPDATE node_claims SET user_id = ${newOwner}, claimed_at = ${Date.now()}
				WHERE node_id = ${nodeId} AND user_id = ${expectedOwner} RETURNING node_id`,
		)) as unknown as { node_id: string }[]
		return rows.length > 0
	}

	async requestFullResync(target: FullResyncTarget): Promise<number> {
		this.assertOpen()
		await this.ready
		return this.db.transaction(async (tx) => {
			// One statement: concurrent requests on any instance get distinct, ordered tokens.
			const rows = (await tx.execute(
				sql`INSERT INTO kora_server_meta (key, value) VALUES (${FULL_RESYNC_COUNTER_KEY}, '1')
					ON CONFLICT (key) DO UPDATE SET value = ((kora_server_meta.value)::bigint + 1)::text
					RETURNING value`,
			)) as unknown as { value: string }[]
			const token = Number(rows[0]?.value ?? 1)
			const keys = [
				...(target.userId !== undefined ? [fullResyncUserKey(target.userId)] : []),
				...(target.nodeId !== undefined ? [fullResyncNodeKey(target.nodeId)] : []),
			]
			for (const key of keys) {
				await tx.execute(
					sql`INSERT INTO kora_server_meta (key, value) VALUES (${key}, ${String(token)})
						ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
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
		await this.ready
		const keys = [
			...(userId !== null ? [fullResyncUserKey(userId)] : []),
			fullResyncNodeKey(nodeId),
			fullResyncDoneKey(nodeId, view),
		]
		const rows = (await this.db.execute(
			sql`SELECT key, value FROM kora_server_meta WHERE key IN (${sql.join(
				keys.map((key) => sql`${key}`),
				sql`, `,
			)})`,
		)) as unknown as { key: string; value: string }[]
		const read = (key: string): string | undefined => rows.find((row) => row.key === key)?.value
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
		await this.ready
		const key = fullResyncDoneKey(nodeId, view)
		await this.db.execute(
			sql`INSERT INTO kora_server_meta (key, value) VALUES (${key}, ${String(token)})
				ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
				WHERE (EXCLUDED.value)::numeric > (kora_server_meta.value)::numeric`,
		)
	}

	async releaseNodeClaim(nodeId: string): Promise<boolean> {
		this.assertOpen()
		await this.ready
		const known = (await this.db.execute(
			sql`SELECT 1 AS one WHERE EXISTS (SELECT 1 FROM node_claims WHERE node_id = ${nodeId})
				OR EXISTS (SELECT 1 FROM operations WHERE node_id = ${nodeId})`,
		)) as unknown as { one: number }[]
		if (known.length === 0) return false
		await this.db.execute(
			sql`INSERT INTO node_claims (node_id, user_id, claimed_at)
				VALUES (${nodeId}, ${RELEASED_NODE_OWNER}, ${Date.now()})
				ON CONFLICT (node_id) DO UPDATE SET user_id = EXCLUDED.user_id, claimed_at = EXCLUDED.claimed_at`,
		)
		return true
	}

	async getLiveGroups(groups: readonly string[], since?: number): Promise<ReadonlySet<string>> {
		this.assertOpen()
		await this.ready
		return this.readLiveGroups(this.db, groups, since)
	}

	/** Of `groups` (group keys), those whose record is live in `tx`'s view. */
	private async readLiveGroups(
		tx: PostgresJsDatabase,
		groups: readonly string[],
		since?: number,
		pendingOpId?: string,
	): Promise<ReadonlySet<string>> {
		const live = new Set<string>()
		const byCollection = new Map<string, string[]>()
		for (const key of groups) {
			const parsed = parseGroupKey(key)
			if (!parsed || !this.schema?.collections[parsed.collection]) continue
			const ids = byCollection.get(parsed.collection)
			if (ids) ids.push(parsed.id)
			else byCollection.set(parsed.collection, [parsed.id])
		}
		for (const [collection, ids] of byCollection) {
			const rows = (await tx.execute(
				sql`SELECT c.id AS id FROM ${sql.raw(quoteIdent(collection))} c
					WHERE c.id IN (${sql.join(
						ids.map((id) => sql`${id}`),
						sql`, `,
					)}) AND COALESCE(c._deleted, 0) = 0
					AND NOT EXISTS (
						SELECT 1 FROM operations o
						WHERE o.collection = ${collection} AND o.record_id = c.id AND o.type = 'delete'
							AND o.delivery_seq > ${since ?? Number.MAX_SAFE_INTEGER}
							-- The write being authorized is already inserted: it is not a delete
							-- that happened before it.
							AND o.id <> ${pendingOpId ?? ''}
					)`,
			)) as unknown as { id: string }[]
			for (const row of rows) live.add(groupKey(collection, row.id))
		}
		return live
	}

	/**
	 * The record as currently stored, including a soft-deleted one (whose last field
	 * values are kept), or null when it was never written. Without a materialized
	 * table, the last known values are replayed from the operation log.
	 */
	/**
	 * When the record's fold state was folded with another plan (an instance still on the
	 * old plan during a rolling deploy), the row on disk is that plan's: this is the
	 * record as this instance's plan folds it, which is what `mergeIntoRecord` folds the
	 * write onto and what the write is authorized against. Undefined when the row on disk
	 * is current. Nothing is written. Call before the operation's own row exists.
	 */
	private async otherPlanAuthorizationRow(
		tx: PostgresJsDatabase,
		collection: string,
		recordId: string,
	): Promise<MaterializedRecord | null | undefined> {
		const collectionDef = this.schema?.collections[collection]
		if (!collectionDef) return undefined
		const plan = (
			(await tx.execute(
				sql`SELECT plan FROM kora_fold_state WHERE collection = ${collection} AND record_id = ${recordId}`,
			)) as unknown as { plan: string | null }[]
		)[0]?.plan
		if (!plan || plan === this.planStamp()) return undefined
		return foldedStoredRow(
			recordId,
			await this.readFoldState(tx, collection, recordId),
			collectionDef.fields,
			this.foldOptions,
			storedPgFieldValue,
		)
	}

	/**
	 * A record as stored (a soft-deleted one included), as this instance's fold plan
	 * defines it: the row on disk, or, when an instance on another plan materialized it,
	 * the record folded with this plan ({@link otherPlanAuthorizationRow}). Nothing is
	 * written. For decisions made inside a transaction before its own operations exist.
	 */
	private async readActivePlanRow(
		tx: PostgresJsDatabase,
		collection: string,
		recordId: string,
	): Promise<MaterializedRecord | null> {
		const other = await this.otherPlanAuthorizationRow(tx, collection, recordId)
		return other !== undefined ? other : this.readStoredRow(tx, collection, recordId)
	}

	/**
	 * `findRecord` inside a transaction: the live record as this instance's fold plan
	 * defines it ({@link readActivePlanRow}). Nothing is written.
	 */
	private async findActivePlanRecord(
		tx: PostgresJsDatabase,
		collection: string,
		id: string,
	): Promise<MaterializedRecord | null> {
		this.assertOpen()
		await this.ready
		this.assertSchema()
		this.assertCollection(collection)
		const record = await this.readActivePlanRow(tx, collection, id)
		return record && record._deleted !== 1 ? record : null
	}

	/**
	 * `queryCollection` inside a transaction, on records as this instance's fold plan
	 * defines them. When no record of the collection was folded with another plan (the
	 * rule), it is the plain query. Otherwise those records are folded with this plan
	 * and the query runs over the collection with them in place of their rows on disk
	 * (passed as one JSON parameter), so filters, order and paging are the database's
	 * own. Nothing in the database is written, and no privilege beyond reading is needed.
	 */
	private async queryActivePlan(
		tx: PostgresJsDatabase,
		collection: string,
		options?: CollectionQueryOptions,
	): Promise<MaterializedRecord[]> {
		this.assertOpen()
		await this.ready
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
		const rows = await this.withActivePlanSource(tx, collection, options?.where, (source) =>
			tx.execute(this.buildSelectQuery(collection, options, source)),
		)
		return (rows as unknown as Record<string, unknown>[]).map((row) =>
			this.deserializeRow(row, collectionDef),
		)
	}

	/** `countCollection` inside a transaction, as {@link queryActivePlan} counts. */
	private async countActivePlan(
		tx: PostgresJsDatabase,
		collection: string,
		where?: Record<string, unknown>,
	): Promise<number> {
		this.assertOpen()
		await this.ready
		this.assertSchema()
		this.assertCollection(collection)
		const schema = this.schema as SchemaDefinition
		for (const key of Object.keys(where ?? {})) {
			validateFieldName(collection, key, schema)
		}
		const whereClause = this.buildWhereClause(where ?? {}, false, schema.collections[collection])
		const rows = (await this.withActivePlanSource(tx, collection, where, (source) =>
			tx.execute(sql`SELECT COUNT(*) as cnt FROM ${source} WHERE ${whereClause}`),
		)) as unknown as Array<{ cnt: number | string }>
		const cnt = rows[0]?.cnt
		return typeof cnt === 'string' ? Number.parseInt(cnt, 10) : (cnt ?? 0)
	}

	/**
	 * Run `read` over the collection as this instance's fold plan defines it: the table
	 * itself when none of its records (of `where.id`, when the filter names one) was
	 * folded with another plan, else the table with those records' rows replaced by
	 * their fold with this plan (rows of the table's own type, from a JSON parameter).
	 */
	private async withActivePlanSource<T>(
		tx: PostgresJsDatabase,
		collection: string,
		where: Record<string, unknown> | undefined,
		read: (source: SQL) => Promise<T>,
	): Promise<T> {
		const table = sql.raw(quoteIdent(collection))
		const plan = this.planStamp()
		const onlyId = where && typeof where.id === 'string' ? where.id : null
		const outdated = (
			(await tx.execute(
				sql`SELECT record_id FROM kora_fold_state
					WHERE collection = ${collection}
						AND ((plan > '' AND plan < ${plan}) OR plan > ${plan})
						${onlyId === null ? sql.raw('') : sql`AND record_id = ${onlyId}`}`,
			)) as unknown as { record_id: string }[]
		).map((row) => row.record_id)
		if (outdated.length === 0) return read(table)
		const collectionDef = this.schema?.collections[collection]
		if (!collectionDef) return read(table)
		// The records folded with this plan, as JSON objects keyed by column, read back as
		// rows of the collection's own row type (jsonb_populate_recordset): no temporary
		// table, so a role without the TEMP privilege reads them too, and one parameter
		// however many records are outdated.
		const fieldNames = Object.keys(collectionDef.fields)
		const folded: Record<string, unknown>[] = []
		for (const recordId of outdated) {
			const state = await this.readFoldState(tx, collection, recordId)
			const row = state ? projectFoldState(state, this.foldOptions) : null
			// A record this plan folds to nothing has no row (as readActivePlanRow reads it).
			if (!row) continue
			const columns: Record<string, unknown> = { id: recordId }
			for (const field of fieldNames) {
				const descriptor = collectionDef.fields[field]
				if (!descriptor) continue
				columns[field] = pgJsonColumnValue(
					serializePgFieldValue(materializedFieldValue(row.values, field, descriptor), descriptor),
					descriptor,
				)
			}
			columns._created_at = row.createdAt
			columns._updated_at = row.updatedAt
			columns._deleted = row.deleted ? 1 : 0
			folded.push(columns)
		}
		// The rows on disk of exactly the records folded here (or folded to nothing): a
		// re-fold another instance commits meanwhile must not make one appear twice.
		const source = sql`(SELECT * FROM ${table} c
			WHERE c.id NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify(outdated)}::jsonb))
			UNION ALL SELECT * FROM jsonb_populate_recordset(NULL::${table}, ${JSON.stringify(folded)}::jsonb)) AS ${table}`
		return read(source)
	}

	private async readStoredRow(
		txOrDb: PostgresJsDatabase,
		collection: string,
		recordId: string,
	): Promise<MaterializedRecord | null> {
		const collectionDef = this.schema?.collections[collection]
		if (collectionDef) {
			const rows = (await txOrDb.execute(
				sql`SELECT * FROM ${sql.raw(quoteIdent(collection))} WHERE id = ${recordId} LIMIT 1`,
			)) as unknown as Record<string, unknown>[]
			const row = rows[0]
			return row ? this.deserializeRow(row, collectionDef) : null
		}
		// The fold orders writes by HLC stamps compared in JavaScript, never by a
		// database collation, so this needs no ORDER BY.
		const ops = await this.readRecordOperations(txOrDb, collection, recordId, 0)
		if (ops.length === 0) return null
		const state = refoldRecord(ops, this.schema ?? EMPTY_FOLD_SCHEMA, this.foldOptions)
		const lastKnown = state ? projectFoldState(state, this.foldOptions) : null
		return { ...(lastKnown?.values ?? {}), id: recordId }
	}

	/**
	 * Merge a just-appended operation (stored under `deliverySeq`) into its record's
	 * fold state and project the row, inside the append transaction. O(fields the
	 * operation touches): the state is read by primary key and the freshness check is
	 * one index probe (SRV-7).
	 *
	 * Concurrency: every append on every instance holds the delivery-counter row lock
	 * until commit (see nextDeliverySeq), and applyConditional takes its per-record
	 * advisory lock before it, so this read-merge-write of one record's state is
	 * serialized across instances; the `FOR UPDATE` on the state row is defense in
	 * depth. A record whose log grew without this state (an older release during a
	 * rolling upgrade) has its missing tail merged first; an unreadable, newer-than-log
	 * or plan-incompatible state is re-folded from the log.
	 */
	private async mergeIntoRecord(
		tx: PostgresJsDatabase,
		op: Operation,
		deliverySeq: number,
	): Promise<LiveViewWrite> {
		const schema = this.schema
		if (!schema?.collections[op.collection]) return NO_LIVE_VIEW_WRITE
		const stored = (
			(await tx.execute(
				sql`SELECT state, covered_seq, covered_op_id, plan, lv_through, lv_fields FROM kora_fold_state WHERE collection = ${op.collection} AND record_id = ${op.recordId} FOR UPDATE`,
			)) as unknown as {
				state: string
				covered_seq: string | number
				covered_op_id: string
				plan: string
				lv_through: string | null
				lv_fields: string | null
			}[]
		)[0]
		// The record's newest operation before this one: the stored state is current iff
		// it covers exactly that operation (sequence AND id, so a state left behind by a
		// dropped or restored log is never mistaken for current).
		// The record's newest operation before this one: the stored state is current iff
		// it covers exactly that operation (sequence AND id, so a state left behind by a
		// dropped or restored log is never mistaken for current).
		const last = (
			(await tx.execute(
				sql`SELECT id, delivery_seq AS d FROM operations WHERE collection = ${op.collection} AND record_id = ${op.recordId} AND delivery_seq < ${deliverySeq} ORDER BY delivery_seq DESC LIMIT 1`,
			)) as unknown as { id: string; d: string | number }[]
		)[0]
		const prior = Number(last?.d ?? 0)
		// A state folded with another plan (another instance during a rolling deploy) is
		// re-folded with this one; '' is a state from before plans were recorded.
		const samePlan = !stored?.plan || stored.plan === this.planStamp()
		const parsed =
			stored && samePlan ? parseStoredFoldState(stored.state, op.collection, op.recordId) : null
		const covered = stored ? Number(stored.covered_seq) : 0
		let state: FoldState | null | typeof REFOLD_REQUIRED
		// The record's live-view summary moves only with a plain merge (or a new record);
		// any other path leaves it unknown (see liveViewTrackingFor).
		let liveViews: LiveViewWrite = NO_LIVE_VIEW_WRITE
		if (parsed && covered === prior && stored?.covered_op_id === (last?.id ?? '')) {
			state = mergeIntoFoldState(parsed, [op], schema, this.foldOptions)
			liveViews = liveViewTrackingFor(
				{ lvThrough: stored?.lv_through ?? null, lvFields: stored?.lv_fields ?? null },
				last?.id ?? null,
				op.id,
				null,
			)
		} else if (isQuarantineAffected(this.quarantine, op.collection, op.recordId)) {
			// Incomplete log (RT-70): fold onto the kept row, never from the log alone.
			state = await this.rebuildAffected(tx, op.collection, op.recordId, parsed)
		} else if (!stored && !last) {
			state = mergeIntoFoldState(null, [op], schema, this.foldOptions)
			// Whether a new record is tracked is decided with its snapshot (writeScopeSnapshot),
			// from the registration in the database, in a round trip that write makes anyway.
			liveViews = NEW_RECORD_LIVE_VIEW_WRITE
		} else if (
			parsed &&
			covered > 0 &&
			covered < prior &&
			(await this.coversStoredOperation(
				tx,
				op.collection,
				op.recordId,
				covered,
				stored?.covered_op_id,
			))
		) {
			// Operations appended without folding (an older release during a rolling
			// upgrade): merge the missing tail.
			state = mergeIntoFoldState(
				parsed,
				await this.readRecordOperations(tx, op.collection, op.recordId, covered),
				schema,
				this.foldOptions,
			)
		} else {
			state = REFOLD_REQUIRED
		}
		if (state === REFOLD_REQUIRED) {
			state = refoldRecord(
				await this.readRecordOperations(tx, op.collection, op.recordId, 0),
				schema,
				this.foldOptions,
			)
		}
		if (stored?.lv_through != null && liveViews.columns === null) {
			// A tracked record folded another way: its summary is unknown until rebuilt.
			liveViews = { ...liveViews, stale: true }
		}
		await this.writeFoldedRecord(
			tx,
			op.collection,
			op.recordId,
			state,
			deliverySeq,
			op.id,
			liveViews.columns,
		)
		return liveViews
	}

	/**
	 * The fold state of a record that owns quarantined operations (RT-70): its stored
	 * state, or its kept row as a snapshot base, with every remaining operation of the
	 * record merged on top (`rebuildFromSnapshot`). Nothing is written.
	 */
	private async rebuildAffected(
		txOrDb: PostgresJsDatabase,
		collection: string,
		recordId: string,
		stored: FoldState | null,
	): Promise<FoldState | null> {
		const schema = this.schema ?? EMPTY_FOLD_SCHEMA
		const collectionDef = schema.collections[collection]
		const raw = collectionDef
			? (
					(await txOrDb.execute(
						sql`SELECT * FROM ${sql.raw(quoteIdent(collection))} WHERE id = ${recordId} LIMIT 1`,
					)) as unknown as Record<string, unknown>[]
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
				ops: await this.readRecordOperations(txOrDb, collection, recordId, 0),
				quarantinedLatest: this.quarantine.latest.get(quarantineKey(collection, recordId)),
			},
			schema,
			this.foldOptions,
		)
	}

	/** True when the record's operation at delivery sequence `seq` has id `opId`. */
	private async coversStoredOperation(
		txOrDb: PostgresJsDatabase,
		collection: string,
		recordId: string,
		seq: number,
		opId: string | undefined,
	): Promise<boolean> {
		if (!opId) return false
		const rows = (await txOrDb.execute(
			sql`SELECT 1 AS one FROM operations WHERE id = ${opId} AND collection = ${collection} AND record_id = ${recordId} AND delivery_seq = ${seq}`,
		)) as unknown as unknown[]
		return rows.length > 0
	}

	/**
	 * The record's current fold state for a read: the stored one when it covers the
	 * record's whole log and was folded with this instance's plan, else folded from the
	 * log (nothing is written). A state another plan folded (an instance still on the old
	 * plan during a rolling deploy) is never used: `mergeIntoRecord` re-folds it, so a
	 * read, and above all the authorization preview, must see what that write stores.
	 */
	private async readFoldState(
		txOrDb: PostgresJsDatabase,
		collection: string,
		recordId: string,
	): Promise<FoldState | null> {
		const schema = this.schema ?? EMPTY_FOLD_SCHEMA
		if (schema.collections[collection]) {
			const rows = (await txOrDb.execute(
				sql`SELECT f.state, f.covered_seq, f.covered_op_id, f.plan, l.id AS last_id, l.delivery_seq AS last_seq
					FROM kora_fold_state f
					LEFT JOIN LATERAL (
						SELECT o.id, o.delivery_seq FROM operations o
						WHERE o.collection = ${collection} AND o.record_id = ${recordId}
						ORDER BY o.delivery_seq DESC LIMIT 1
					) l ON TRUE
					WHERE f.collection = ${collection} AND f.record_id = ${recordId}`,
			)) as unknown as {
				state: string
				covered_seq: string | number
				covered_op_id: string
				plan: string | null
				last_id: string | null
				last_seq: string | number | null
			}[]
			const stored = rows[0]
			// As in mergeIntoRecord: '' is a state from before plans were recorded.
			const samePlan = !stored?.plan || stored.plan === this.planStamp()
			const parsed =
				stored && samePlan ? parseStoredFoldState(stored.state, collection, recordId) : null
			if (
				parsed &&
				Number(stored?.covered_seq) === Number(stored?.last_seq ?? 0) &&
				stored?.covered_op_id === (stored?.last_id ?? '')
			) {
				return parsed
			}
			if (isQuarantineAffected(this.quarantine, collection, recordId)) {
				return this.rebuildAffected(txOrDb, collection, recordId, parsed)
			}
		}
		const ops = await this.readRecordOperations(txOrDb, collection, recordId, 0)
		return ops.length > 0 ? refoldRecord(ops, schema, this.foldOptions) : null
	}

	/** A record's operations stored after `afterDeliverySeq`, in delivery order. */
	private async readRecordOperations(
		txOrDb: PostgresJsDatabase,
		collection: string,
		recordId: string,
		afterDeliverySeq: number,
	): Promise<Operation[]> {
		const rows = await txOrDb
			.select()
			.from(pgOperations)
			.where(
				and(
					eq(pgOperations.collection, collection),
					eq(pgOperations.recordId, recordId),
					gt(pgOperations.deliverySeq, afterDeliverySeq),
				),
			)
			.orderBy(asc(pgOperations.deliverySeq))
		return rows.map((row) => this.deserializeOperation(row))
	}

	/**
	 * Persist a record's fold state (covering the log up to `coveredSeq`) and project
	 * it onto the materialized row.
	 */
	private async writeFoldedRecord(
		txOrDb: PostgresJsDatabase,
		collection: string,
		recordId: string,
		state: FoldState | null,
		coveredSeq: number,
		coveredOpId: string,
		liveViews: { through: string; fields: string } | null = null,
	): Promise<void> {
		const collectionDef = this.schema?.collections[collection]
		if (!collectionDef) return
		// No state (nothing the plan makes of the log): a tombstone keeps the plan it was
		// folded with, so an instance on another plan still finds and re-folds it. The
		// live-view columns are written only by a write that maintains the summary; any
		// other write leaves them, so they no longer match `covered_op_id` (unknown).
		const body = state ? serializeServerFoldState(state) : ''
		if (liveViews) {
			await txOrDb.execute(
				sql`INSERT INTO kora_fold_state (collection, record_id, state, covered_seq, covered_op_id, plan, lv_through, lv_fields)
					VALUES (${collection}, ${recordId}, ${body}, ${coveredSeq}, ${coveredOpId}, ${this.planStamp()}, ${liveViews.through}, ${liveViews.fields})
					ON CONFLICT (collection, record_id) DO UPDATE SET state = EXCLUDED.state, covered_seq = EXCLUDED.covered_seq, covered_op_id = EXCLUDED.covered_op_id, plan = EXCLUDED.plan, lv_through = EXCLUDED.lv_through, lv_fields = EXCLUDED.lv_fields`,
			)
		} else {
			await txOrDb.execute(
				sql`INSERT INTO kora_fold_state (collection, record_id, state, covered_seq, covered_op_id, plan)
					VALUES (${collection}, ${recordId}, ${body}, ${coveredSeq}, ${coveredOpId}, ${this.planStamp()})
					ON CONFLICT (collection, record_id) DO UPDATE SET state = EXCLUDED.state, covered_seq = EXCLUDED.covered_seq, covered_op_id = EXCLUDED.covered_op_id, plan = EXCLUDED.plan`,
			)
		}
		const row = state ? projectFoldState(state, this.foldOptions) : null
		if (!row) {
			// Never inserted (an update with no merged insert): no visible row. A row an
			// earlier (replay) materialization produced for it is hidden.
			await txOrDb.execute(
				sql`UPDATE ${sql.raw(quoteIdent(collection))} SET _deleted = 1 WHERE id = ${recordId}`,
			)
			return
		}
		await this.upsertMaterializedRecord(
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
	 */
	private async upsertMaterializedRecord(
		txOrDb: PostgresJsDatabase,
		tableName: string,
		recordId: string,
		recordData: Record<string, unknown>,
		fieldNames: string[],
		collectionDef: { fields: Record<string, import('@korajs/core').FieldDescriptor> },
		createdAt: number,
		updatedAt: number,
		deleted: boolean,
	): Promise<void> {
		const allColumns = ['id', ...fieldNames, '_created_at', '_updated_at', '_deleted']
		const values: unknown[] = [
			recordId,
			...fieldNames.map((f) => {
				const descriptor = collectionDef.fields[f]
				return descriptor
					? serializePgFieldValue(materializedFieldValue(recordData, f, descriptor), descriptor)
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

		await txOrDb.execute(
			sql`INSERT INTO ${sql.raw(quoteIdent(tableName))} (${columnsSql}) VALUES (${valuesSql}) ON CONFLICT (id) DO UPDATE SET ${updateSet}`,
		)
	}

	/**
	 * {@link writeFoldedRecord} for a batch of records of one collection, in a handful
	 * of multi-row statements (the migration's write path). Rows are chunked so a
	 * statement never nears the 65,535 bind-parameter limit, however wide the collection.
	 */
	private async writeFoldedRecords(
		tx: PostgresJsDatabase,
		collection: string,
		batch: FoldedRecordWrite[],
	): Promise<void> {
		const collectionDef = this.schema?.collections[collection]
		if (!collectionDef || batch.length === 0) return
		const kept = batch.filter((entry) => entry.state !== null)
		const plan = this.planStamp()
		for (let i = 0; i < kept.length; i += 1000) {
			const values = kept
				.slice(i, i + 1000)
				.map(
					(entry) =>
						sql`(${collection}, ${entry.recordId}, ${serializeServerFoldState(entry.state as FoldState)}, ${entry.coveredSeq}, ${entry.coveredOpId}, ${plan})`,
				)
			await tx.execute(
				sql`INSERT INTO kora_fold_state (collection, record_id, state, covered_seq, covered_op_id, plan)
					VALUES ${sql.join(values, sql.raw(', '))}
					ON CONFLICT (collection, record_id) DO UPDATE SET state = EXCLUDED.state, covered_seq = EXCLUDED.covered_seq, covered_op_id = EXCLUDED.covered_op_id, plan = EXCLUDED.plan`,
			)
		}
		// No state: tombstones that keep the plan (see writeFoldedRecord).
		const dropped = batch.filter((entry) => entry.state === null)
		for (let i = 0; i < dropped.length; i += 1000) {
			const values = dropped
				.slice(i, i + 1000)
				.map(
					(entry) =>
						sql`(${collection}, ${entry.recordId}, '', ${entry.coveredSeq}, ${entry.coveredOpId}, ${plan})`,
				)
			await tx.execute(
				sql`INSERT INTO kora_fold_state (collection, record_id, state, covered_seq, covered_op_id, plan)
					VALUES ${sql.join(values, sql.raw(', '))}
					ON CONFLICT (collection, record_id) DO UPDATE SET state = EXCLUDED.state, covered_seq = EXCLUDED.covered_seq, covered_op_id = EXCLUDED.covered_op_id, plan = EXCLUDED.plan`,
			)
		}
		const fieldNames = Object.keys(collectionDef.fields)
		const columns = ['id', ...fieldNames, '_created_at', '_updated_at', '_deleted']
		const rows: unknown[][] = []
		const hidden: string[] = []
		for (const entry of batch) {
			const row = entry.state ? projectFoldState(entry.state, this.foldOptions) : null
			if (!row) {
				hidden.push(entry.recordId)
				continue
			}
			rows.push([
				entry.recordId,
				...fieldNames.map((field) => {
					const descriptor = collectionDef.fields[field]
					return descriptor
						? serializePgFieldValue(
								materializedFieldValue(row.values, field, descriptor),
								descriptor,
							)
						: null
				}),
				row.createdAt,
				row.updatedAt,
				row.deleted ? 1 : 0,
			])
		}
		const perStatement = Math.max(1, Math.floor(30_000 / columns.length))
		const columnsSql = sql.raw(columns.map((c) => quoteIdent(c)).join(', '))
		const updateSet = sql.raw(
			columns
				.slice(1)
				.map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)
				.join(', '),
		)
		for (let i = 0; i < rows.length; i += perStatement) {
			const tuples = rows.slice(i, i + perStatement).map(
				(values) =>
					sql`(${sql.join(
						values.map((v) => sql`${v}`),
						sql.raw(', '),
					)})`,
			)
			await tx.execute(
				sql`INSERT INTO ${sql.raw(quoteIdent(collection))} (${columnsSql}) VALUES ${sql.join(tuples, sql.raw(', '))} ON CONFLICT (id) DO UPDATE SET ${updateSet}`,
			)
		}
		if (hidden.length > 0) {
			await tx.execute(
				sql`UPDATE ${sql.raw(quoteIdent(collection))} SET _deleted = 1 WHERE id IN (${sql.join(
					hidden.map((id) => sql`${id}`),
					sql.raw(', '),
				)})`,
			)
		}
	}

	/**
	 * Re-materialization migration (W7 step 7), run by setSchema and after a
	 * replace-mode restore: every record whose fold state is missing, stale or built
	 * under a different fold plan is re-folded from its log; nothing else is touched.
	 * See the SQLite store's `rematerialize` for the rules (a record owning quarantined
	 * operations folds onto its kept row, RT-70; idempotent; resumable).
	 *
	 * Postgres specifics: records are paged in batches of
	 * {@link FOLD_MIGRATION_BATCH} through the (collection, record_id, delivery_seq)
	 * index, and re-folded in transactions of whole records bounded by
	 * {@link FOLD_MIGRATION_BATCH_OPERATIONS} operations, each of which first takes the
	 * delivery-counter row lock. Appends on every instance take that lock too, so a
	 * batch reads each record's complete log and writes its state while no append to it can commit: a
	 * live write on another instance during a rolling deploy is never overwritten by a
	 * stale re-fold (NEW-SRV-5), it either committed before the batch (and is folded)
	 * or commits after it (and is merged into the batch's state).
	 */
	/**
	 * Write the beta.12 clears the ids prove into the stored bodies, once per database
	 * (RT-85, see `provenLegacyClears`), and mark their records' fold states stale.
	 * Idempotent: concurrent first starts write the same bodies.
	 */
	private async canonicalizeLegacyBodies(): Promise<void> {
		const done = (await this.db.execute(
			sql`SELECT 1 AS one FROM kora_server_meta WHERE key = ${LEGACY_BODIES_META_KEY}`,
		)) as unknown as unknown[]
		if (done.length > 0) return
		const rows = await this.db
			.select()
			.from(pgOperations)
			.where(
				and(
					eq(pgOperations.type, 'update'),
					sql`${pgOperations.hashVersion} IS NULL`,
					sql`${pgOperations.previousData} IS NOT NULL`,
				),
			)
		const changed = await provenLegacyClears(rows.map((row) => this.deserializeOperation(row)))
		await this.db.transaction(async (tx) => {
			if (changed.length > 0) await this.writeRebuildingMarker(tx)
			for (const op of changed) {
				await tx
					.update(pgOperations)
					.set({ data: JSON.stringify(op.data) })
					.where(eq(pgOperations.id, op.id))
				await tx.execute(
					sql`UPDATE kora_fold_state SET covered_seq = -1, lv_through = NULL WHERE collection = ${op.collection} AND record_id = ${op.recordId}`,
				)
			}
			await tx.execute(
				sql`INSERT INTO kora_server_meta (key, value) VALUES (${LEGACY_BODIES_META_KEY}, ${String(changed.length)})
					ON CONFLICT (key) DO NOTHING`,
			)
		})
	}

	/**
	 * Re-folds `targets` of `collection` from their logs with this instance's plan, in one
	 * transaction serialized with every append (the delivery-counter lock).
	 */
	private async refoldRecords(
		collection: string,
		targets: readonly string[],
		clean: boolean,
		report: FoldMigrationReport,
		indexChanges = false,
		onlyOnRecordedPlan = false,
	): Promise<void> {
		const schema = this.schema
		if (!schema) return
		await this.db.transaction(async (tx) => {
			// Serialize with every append (see the method comment).
			await tx.execute(sql`SELECT value FROM delivery_counter WHERE id = 1 FOR UPDATE`)
			// A re-folded record's live-view summary is rebuilt from its log on demand.
			if (targets.length > 0) {
				const list = sql.join(
					targets.map((id) => sql`${id}`),
					sql.raw(', '),
				)
				await tx.execute(
					sql`DELETE FROM kora_record_live_views WHERE collection = ${collection} AND record_id IN (${list})`,
				)
				await tx.execute(
					sql`UPDATE kora_fold_state SET lv_through = NULL WHERE collection = ${collection} AND record_id IN (${list})`,
				)
			}
			if (onlyOnRecordedPlan) {
				// Under the lock a plan change's re-fold also takes: if another instance recorded
				// another plan since the sweep looked, this one is the outdated one.
				const recorded = (
					(await tx.execute(
						sql`SELECT value FROM kora_server_meta WHERE key = ${FOLD_PLAN_FINGERPRINT_KEY}`,
					)) as unknown as { value: string }[]
				)[0]?.value
				if (recorded === undefined || planStampOf(recorded) !== this.planStamp()) return
			}
			// The membership index moves with the re-folded records, in this transaction, at
			// a delivery sequence of its own (like an index reconcile: no operation carries it).
			const indexAt = indexChanges ? await this.nextDeliverySeq(tx) : null
			const groupsBefore = new Map<string, GroupRecordState>()
			if (indexAt !== null && writeAffectsGroupMembers(schema.access, collection)) {
				for (const recordId of targets) {
					groupsBefore.set(
						recordId,
						groupRecordState(await this.readIndexedRecord(tx, collection, recordId)),
					)
				}
			}
			const rows = await tx
				.select()
				.from(pgOperations)
				.where(
					and(eq(pgOperations.collection, collection), inArray(pgOperations.recordId, targets)),
				)
			const byRecord = new Map<string, Array<(typeof rows)[number]>>()
			for (const row of rows) {
				const list = byRecord.get(row.recordId)
				if (list) list.push(row)
				else byRecord.set(row.recordId, [row])
			}
			const batch: FoldedRecordWrite[] = []
			const snapshots: Array<[string, string]> = []
			for (const recordId of targets) {
				const recordRows = byRecord.get(recordId) ?? []
				let covered = 0
				let coveredOpId = ''
				for (const row of recordRows) {
					if (Number(row.deliverySeq ?? 0) > covered) {
						covered = Number(row.deliverySeq ?? 0)
						coveredOpId = row.id
					}
				}
				let state: FoldState | null
				if (!clean && isQuarantineAffected(this.quarantine, collection, recordId)) {
					// Incomplete log (RT-70): the kept row is the base, never the log alone.
					const storedState = (
						(await tx.execute(
							sql`SELECT state FROM kora_fold_state WHERE collection = ${collection} AND record_id = ${recordId}`,
						)) as unknown as { state: string }[]
					)[0]
					state = await this.rebuildAffected(
						tx,
						collection,
						recordId,
						parseStoredFoldState(storedState?.state, collection, recordId),
					)
					report.skippedUnclean++
				} else {
					const ordered = [...recordRows].sort(
						(x, y) => Number(x.deliverySeq ?? 0) - Number(y.deliverySeq ?? 0),
					)
					const ops = ordered.map((row) => this.deserializeOperation(row))
					state = refoldRecord(ops, schema, this.foldOptions)
					// The operations' scope snapshots follow this plan too (download filtering
					// overlays them on the record): replayed from the log like the record.
					const replayed = replayScopeSnapshots(schema, collection, recordId, ops, this.foldOptions)
					for (const row of ordered) {
						const snapshot = replayed.get(row.id)
						if (snapshot) snapshots.push([row.id, JSON.stringify(snapshot)])
					}
				}
				batch.push({ recordId, state, coveredSeq: covered, coveredOpId })
				report.records++
			}
			await this.writeFoldedRecords(tx, collection, batch)
			for (let j = 0; j < snapshots.length; j += 1000) {
				const values = snapshots
					.slice(j, j + 1000)
					.map(([id, snapshot]) => sql`(${id}, ${snapshot})`)
				await tx.execute(
					sql`UPDATE operations AS o SET scope_snapshot = v.s
						FROM (VALUES ${sql.join(values, sql.raw(', '))}) AS v(id, s)
						WHERE o.id = v.id`,
				)
			}
			if (indexAt !== null) {
				for (const recordId of targets) {
					await this.updateMembershipIndex(
						tx,
						collection,
						recordId,
						indexAt,
						groupsBefore.get(recordId) ?? null,
					)
				}
				await tx.execute(
					sql`INSERT INTO kora_server_meta (key, value) VALUES (${ACCESS_FRONTIER_KEY}, ${String(indexAt)})
						ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
				)
			}
		})
	}

	/**
	 * Re-folds records whose fold state another instance folded with another plan (a
	 * rolling deploy that changed transforms or merge rules: an instance on the previous
	 * plan kept writing after this one re-folded everything). Only an instance on the plan
	 * the database records does it, so an old instance never folds records back; the
	 * sync server calls it on every delivery poll.
	 *
	 * @returns How many records were re-folded
	 */
	async refoldOutdatedRecords(limit = FOLD_MIGRATION_BATCH): Promise<number> {
		this.assertOpen()
		await this.ready
		const schema = this.schema
		if (!schema) return 0
		const plan = this.planStamp()
		const collections = Object.keys(schema.collections)
		if (collections.length === 0) return 0
		// Only collections of this schema: a state of a dropped collection is never re-folded.
		// In key order from where the last batch ended, wrapping around at the end.
		const read = async (
			position: { collection: string; recordId: string } | null,
		): Promise<{ collection: string; record_id: string; recorded: string | null }[]> => {
			const after =
				position === null
					? sql`TRUE`
					: sql`(f.collection, f.record_id) > (${position.collection}, ${position.recordId})`
			return (await this.db.execute(
				sql`SELECT f.collection, f.record_id,
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
			)) as unknown as { collection: string; record_id: string; recorded: string | null }[]
		}
		const position = this.outdatedCursor.position()
		let rows = await read(position)
		if (rows.length === 0 && position !== null) rows = await read(null)
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
		for (const [collection, targets] of byCollection) {
			const indexChanges = feedsMembershipIndex(schema.access, collection)
			const counted = { records: report.records, skippedUnclean: report.skippedUnclean }
			try {
				await this.refoldRecords(collection, targets, clean, report, indexChanges, true)
			} catch {
				// The batch rolled back: none of it counts.
				report.records = counted.records
				report.skippedUnclean = counted.skippedUnclean
				// One record that cannot be folded (a transform throwing on it) must not keep
				// the others back: each is folded on its own, and a failure is reported.
				for (const recordId of targets) {
					const before = { records: report.records, skippedUnclean: report.skippedUnclean }
					try {
						await this.refoldRecords(collection, [recordId], clean, report, indexChanges, true)
					} catch (error) {
						report.records = before.records
						report.skippedUnclean = before.skippedUnclean
						failed.push(`${collection}/${recordId}`)
						console.error(
							`[kora] Could not re-fold ${collection}/${recordId} with this instance's fold plan; it keeps the values another instance folded.`,
							error,
						)
					}
				}
			}
		}
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

	private async rematerialize(): Promise<FoldMigrationReport> {
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
		await this.db.transaction(async (tx) => {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('kora:fold-plan', 0))`)
			const stored = (
				(await tx.execute(
					sql`SELECT value FROM kora_server_meta WHERE key = ${FOLD_PLAN_FINGERPRINT_KEY}`,
				)) as unknown as { value: string }[]
			)[0]?.value
			if (stored === fingerprint) return
			report.fullRefold = stored !== undefined
			// Records are re-folded over many transactions: every instance waits for the
			// index rebuild that follows.
			await this.writeRebuildingMarker(tx)
			await tx.execute(sql`UPDATE kora_fold_state SET covered_seq = -1, lv_through = NULL`)
			await tx.execute(
				sql`INSERT INTO kora_server_meta (key, value) VALUES (${FOLD_PLAN_FINGERPRINT_KEY}, ${fingerprint})
					ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
			)
		})
		const progress = new FoldMigrationProgress('Fold re-materialization')
		for (const collection of Object.keys(schema.collections)) {
			let cursor = ''
			for (;;) {
				const page = (await this.db.execute(
					sql`WITH recs AS (
						SELECT record_id, MAX(delivery_seq) AS max_seq, COUNT(*) AS op_count FROM operations
						WHERE collection = ${collection} AND record_id > ${cursor}
						GROUP BY record_id ORDER BY record_id LIMIT ${FOLD_MIGRATION_BATCH}
					)
					SELECT r.record_id, r.max_seq, r.op_count, f.covered_seq AS covered, f.plan AS plan,
						EXISTS (SELECT 1 FROM ${sql.raw(quoteIdent(collection))} c WHERE c.id = r.record_id) AS has_row,
						EXISTS (
							SELECT 1 FROM operations x
							WHERE x.id = f.covered_op_id AND x.delivery_seq = f.covered_seq
						) AS covered_exists
					FROM recs r LEFT JOIN kora_fold_state f
						ON f.collection = ${collection} AND f.record_id = r.record_id
					ORDER BY r.record_id`,
				)) as unknown as {
					record_id: string
					max_seq: string | number
					op_count: string | number
					covered: string | number | null
					plan: string | null
					has_row: boolean
					covered_exists: boolean
				}[]
				if (page.length === 0) break
				cursor = page[page.length - 1]?.record_id ?? cursor
				const plan = this.planStamp()
				const stale = page.filter(
					(row) =>
						row.covered === null ||
						Number(row.covered) !== Number(row.max_seq) ||
						!row.covered_exists ||
						// Folded meanwhile by an instance on another plan (a rolling deploy).
						(row.plan !== null && row.plan !== '' && row.plan !== plan),
				)
				// Bounded transactions (FOLD_MIGRATION_BATCH_OPERATIONS): each holds the lock
				// every append takes, and each commits its records whole (state, row and
				// snapshots), so a killed process resumes at the first record still stale.
				let unreported = page.length - stale.length
				for (const batch of batchesByOperations(stale, (row) => Number(row.op_count))) {
					const before = report.records
					await this.refoldRecords(
						collection,
						batch.map((row) => row.record_id),
						clean,
						report,
					)
					progress.advance(batch.length + unreported, report.records - before)
					unreported = 0
					if (progress.due()) {
						if (progress.needsTotal()) progress.setTotal(await this.countLogRecords(schema))
						progress.report()
					}
				}
				progress.advance(unreported, 0)
				if (page.length < FOLD_MIGRATION_BATCH) break
			}
			// Affected records with no remaining operation at all (every one quarantined,
			// the insert included): the kept row is their whole history.
			if (!clean) {
				await this.db.transaction(async (tx) => {
					await tx.execute(sql`SELECT value FROM delivery_counter WHERE id = 1 FOR UPDATE`)
					const orphans = (await tx.execute(
						sql`SELECT c.id AS id FROM ${sql.raw(quoteIdent(collection))} c
							WHERE NOT EXISTS (SELECT 1 FROM kora_fold_state f WHERE f.collection = ${collection} AND f.record_id = c.id)
							AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.collection = ${collection} AND o.record_id = c.id)`,
					)) as unknown as { id: string }[]
					const batch: FoldedRecordWrite[] = []
					for (const { id } of orphans) {
						if (!isQuarantineAffected(this.quarantine, collection, id)) continue
						const state = await this.rebuildAffected(tx, collection, id, null)
						if (!state) continue
						batch.push({ recordId: id, state, coveredSeq: 0, coveredOpId: '' })
						report.skippedUnclean++
						report.records++
					}
					if (batch.length > 0) await this.writeFoldedRecords(tx, collection, batch)
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

	/** Records of the schema's collections in the log (progress lines of a long migration). */
	private async countLogRecords(schema: SchemaDefinition): Promise<number> {
		const collections = Object.keys(schema.collections)
		if (collections.length === 0) return 0
		const rows = (await this.db.execute(
			sql`SELECT COUNT(*) AS n FROM (SELECT DISTINCT collection, record_id FROM operations
				WHERE collection IN (${sql.join(
					collections.map((name) => sql`${name}`),
					sql.raw(', '),
				)})) AS records`,
		)) as unknown as { n: string | number }[]
		return Number(rows[0]?.n ?? 0)
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
				record[fieldName] = deserializePgFieldValue(row[fieldName], descriptor)
			}
		}

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

	private async materializeFromOpsLog(collection: string): Promise<MaterializedRecord[]> {
		const ids = (await this.db.execute(
			sql`SELECT DISTINCT record_id FROM operations WHERE collection = ${collection} ORDER BY record_id`,
		)) as unknown as { record_id: string }[]
		const records: MaterializedRecord[] = []
		for (const { record_id: recordId } of ids) {
			const ops = await this.readRecordOperations(this.db, collection, recordId, 0)
			const state = refoldRecord(ops, this.schema ?? EMPTY_FOLD_SCHEMA, this.foldOptions)
			const row = state ? projectFoldState(state, this.foldOptions) : null
			if (row && !row.deleted) records.push({ id: recordId, ...row.values })
		}
		return records
	}

	// ---------------------------------------------------------------------------
	// Initialization
	// ---------------------------------------------------------------------------

	private async initialize(): Promise<void> {
		await this.ensureTables()
		await this.loadIdentity()
		this.logIntegrity = await this.scanLogIntegrityOnce()
		this.quarantine = buildQuarantineScope(
			(
				(await this.db.execute(sql`SELECT row_json FROM operations_quarantine`)) as unknown as {
					row_json: string
				}[]
			).map((row) => row.row_json),
		)

		// Hydrate in-memory version vector cache
		const rows = await this.db
			.select({
				nodeId: pgSyncState.nodeId,
				maxSequenceNumber: pgSyncState.maxSequenceNumber,
			})
			.from(pgSyncState)

		for (const row of rows) {
			this.versionVector.set(row.nodeId, row.maxSequenceNumber)
		}
	}

	/**
	 * The startup log-integrity scan's result (W8 step 0): rows that could not be read
	 * back into an operation are moved to `operations_quarantine` once per database,
	 * before any fold reads them.
	 */
	async getLogIntegrityReport(): Promise<ServerLogIntegrityReport> {
		await this.ready
		return { ...this.logIntegrity, quarantined: [...this.logIntegrity.quarantined] }
	}

	/**
	 * One-time scan under the setup advisory lock (concurrent starts run it once). Keyset
	 * pages by id, so a large log is read in bounded chunks; like the delivery-sequence
	 * backfill it runs on the first start of this release only.
	 */
	private async scanLogIntegrityOnce(): Promise<ServerLogIntegrityReport> {
		const report: ServerLogIntegrityReport = {
			checkedRows: 0,
			quarantined: [],
			ran: false,
			totalQuarantined: 0,
		}
		await this.db.transaction(async (tx) => {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('kora:log-integrity', 0))`)
			await tx.execute(sql.raw(SERVER_LOG_QUARANTINE_DDL))
			const done = (await tx.execute(
				sql`SELECT value FROM kora_server_meta WHERE key = ${SERVER_LOG_INTEGRITY_META_KEY}`,
			)) as unknown as { value: string }[]
			if (done.length > 0) return
			report.ran = true
			const now = Date.now()
			let after = ''
			for (;;) {
				const page = (await tx.execute(
					sql`SELECT id, node_id, type, collection, record_id, data, previous_data, atomic_ops, wall_time, logical, timestamp_node_id, sequence_number, causal_deps, schema_version FROM operations WHERE id > ${after} ORDER BY id LIMIT 2000`,
				)) as unknown as ServerOperationRow[]
				for (const row of page) {
					report.checkedRows++
					const verdict = checkServerOperationRow(row)
					if (!verdict) continue
					const id = String(row.id)
					await tx.execute(
						sql`INSERT INTO operations_quarantine (id, problem, detail, row_json, quarantined_at) VALUES (${id}, ${verdict.problem}, ${verdict.detail}, ${quarantineRowJson(row)}, ${now}) ON CONFLICT (id) DO NOTHING`,
					)
					await tx.execute(sql`DELETE FROM operations WHERE id = ${id}`)
					report.quarantined.push({ operationId: id, ...verdict })
				}
				if (page.length < 2000) break
				after = String(page[page.length - 1]?.id ?? after)
			}
			await tx.execute(
				sql`INSERT INTO kora_server_meta (key, value) VALUES (${SERVER_LOG_INTEGRITY_META_KEY}, ${String(now)}) ON CONFLICT (key) DO NOTHING`,
			)
		})
		if (report.quarantined.length > 0) {
			console.warn(
				`[kora] Log integrity: ${report.quarantined.length} unreadable operation row(s) moved to operations_quarantine.`,
			)
		}
		const total = (await this.db.execute(
			sql`SELECT COUNT(*) AS n FROM operations_quarantine`,
		)) as unknown as { n: string | number }[]
		report.totalQuarantined = Number(total[0]?.n ?? 0)
		return report
	}

	private async ensureTables(): Promise<void> {
		// Serialize all schema setup across instances with an advisory transaction lock.
		// `CREATE TABLE IF NOT EXISTS` is not atomic in Postgres: two servers cold-starting
		// against the same empty database race and one fails with a duplicate-type error.
		// Running every setup statement in one advisory-locked transaction makes concurrent
		// startup safe and also serializes the delivery-sequence backfill.
		await this.db.transaction(async (tx) => {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('kora:ensure-tables', 0))`)

			// Change an existing table only when the change is missing. Even when it has
			// nothing to do, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` takes an ACCESS
			// EXCLUSIVE lock and `CREATE INDEX IF NOT EXISTS` a SHARE lock on the table, held
			// to the end of this transaction. Further down it seeds the delivery counter,
			// which waits for any append in flight on another instance; that append next
			// reads and writes `operations`, so it would wait for this transaction in turn:
			// a deadlock, and Postgres aborts one of them (a failed write, or a failed start).
			// The catalog reads below take no lock on the tables themselves. (Under the
			// advisory lock no other instance changes them meanwhile.)
			const columnRows = (await tx.execute(sql`
				SELECT table_name, column_name FROM information_schema.columns
				WHERE table_schema = current_schema()
			`)) as unknown as { table_name: string; column_name: string }[]
			const columns = new Set(columnRows.map((row) => `${row.table_name}.${row.column_name}`))
			const indexRows = (await tx.execute(
				sql`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`,
			)) as unknown as { indexname: string }[]
			const indexes = new Set(indexRows.map((row) => row.indexname))
			const addColumn = async (table: string, column: string, definition: string) => {
				if (columns.has(`${table}.${column}`)) return
				await tx.execute(
					sql.raw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`),
				)
			}
			const createIndex = async (name: string, statement: SQL) => {
				if (indexes.has(name)) return
				await tx.execute(statement)
			}

			await tx.execute(sql`
				CREATE TABLE IF NOT EXISTS operations (
					id TEXT PRIMARY KEY,
					node_id TEXT NOT NULL,
					type TEXT NOT NULL,
					collection TEXT NOT NULL,
					record_id TEXT NOT NULL,
					data TEXT,
					previous_data TEXT,
					atomic_ops TEXT,
					wall_time BIGINT NOT NULL,
					logical INTEGER NOT NULL,
					timestamp_node_id TEXT NOT NULL,
					sequence_number BIGINT NOT NULL,
					causal_deps TEXT NOT NULL DEFAULT '[]',
					schema_version INTEGER NOT NULL,
					received_at BIGINT NOT NULL
				)
			`)

			// Backward-compatible migration: add atomic_ops to operation logs created
			// before atomic-op persistence. Nullable, so existing rows read as "no atomic
			// ops" and keep materializing by last-write-wins exactly as before.
			await addColumn('operations', 'atomic_ops', 'TEXT')

			// Backward-compatible migration: add the delivery_seq column for the gap-free
			// delivery watermark.
			await addColumn('operations', 'delivery_seq', 'BIGINT')

			// Backward-compatible migration: the per-operation scope snapshot (RT-14).
			// Rows written before it are backfilled from the log when the schema is set.
			await addColumn('operations', 'scope_snapshot', 'TEXT')

			// Content-hash version of the stored id (CORE-1, protocol v2). Null means 1.
			await addColumn('operations', 'hash_version', 'INTEGER')

			// Encryption envelope of the operation (protocol v2), stored opaquely (JSON).
			await addColumn('operations', 'encrypted', 'TEXT')

			// Per-record fold state (W7): the materialized row is projected from it.
			// `covered_seq` / `covered_op_id`: the delivery sequence and id of the record's
			// newest operation merged into it (the state covers every operation up to it).
			await tx.execute(sql`
				CREATE TABLE IF NOT EXISTS kora_fold_state (
					collection TEXT NOT NULL,
					record_id TEXT NOT NULL,
					state TEXT NOT NULL,
					covered_seq BIGINT NOT NULL,
					covered_op_id TEXT NOT NULL DEFAULT '',
					PRIMARY KEY (collection, record_id)
				)
			`)
			// A pre-release table may lack it; '' never matches an operation id, so such a
			// state is re-folded on its next use.
			await addColumn('kora_fold_state', 'covered_op_id', "TEXT NOT NULL DEFAULT ''")
			// The fold plan a state was folded with (a short stamp; '' before it was kept):
			// a state of another plan is re-folded (rolling deploys, see refoldOutdatedRecords).
			await addColumn('kora_fold_state', 'plan', "TEXT NOT NULL DEFAULT ''")
			// The live-view columns (see live-views.ts): nullable, so an instance that does not
			// know them never writes them, which reads as unknown.
			await addColumn('kora_fold_state', 'lv_through', 'TEXT')
			await addColumn('kora_fold_state', 'lv_fields', 'TEXT')
			await createIndex(
				'kora_fold_state_plan',
				sql`CREATE INDEX IF NOT EXISTS kora_fold_state_plan ON kora_fold_state (plan)`,
			)
			// A record's newest delivery sequence in one probe (the fold freshness check),
			// and the migration's record paging.
			await createIndex(
				'idx_collection_record_delivery',
				sql`CREATE INDEX IF NOT EXISTS idx_collection_record_delivery ON operations (collection, record_id, delivery_seq)`,
			)

			// Backward-compatible migration (RT-37): the sole-holder flag behind the partial
			// unique index. Existing rows (and rows an older instance writes during a rolling
			// upgrade) read 0: outside the index, still judged as holders by the append check.
			await addColumn('operations', 'seq_unique', 'INTEGER NOT NULL DEFAULT 0')

			// Blob content hash -> principals that pushed (or first claimed) it (RT-11).
			await tx.execute(sql`
				CREATE TABLE IF NOT EXISTS blob_owners (
					hash TEXT NOT NULL,
					owner TEXT NOT NULL,
					created_at BIGINT NOT NULL,
					PRIMARY KEY (hash, owner)
				)
			`)

			await createIndex(
				'idx_node_seq',
				sql`CREATE INDEX IF NOT EXISTS idx_node_seq ON operations (node_id, sequence_number)`,
			)
			await createIndex(
				'idx_collection',
				sql`CREATE INDEX IF NOT EXISTS idx_collection ON operations (collection)`,
			)
			await createIndex(
				'idx_received',
				sql`CREATE INDEX IF NOT EXISTS idx_received ON operations (received_at)`,
			)
			await createIndex(
				'idx_delivery_seq',
				sql`CREATE INDEX IF NOT EXISTS idx_delivery_seq ON operations (delivery_seq)`,
			)
			// Index for efficient per-record operation lookups during materialization
			await createIndex(
				'idx_collection_record',
				sql`CREATE INDEX IF NOT EXISTS idx_collection_record ON operations (collection, record_id)`,
			)

			// The membership index (access rules): one row per membership interval. The
			// `_kora_` prefix cannot collide with a collection table.
			await tx.execute(sql`
				CREATE TABLE IF NOT EXISTS _kora_access_memberships (
					id BIGSERIAL PRIMARY KEY,
					user_id TEXT NOT NULL,
					group_key TEXT NOT NULL,
					source TEXT NOT NULL,
					record_id TEXT NOT NULL,
					role TEXT NOT NULL,
					expires_at BIGINT,
					joined_seq BIGINT NOT NULL,
					role_seq BIGINT,
					left_seq BIGINT
				)
			`)
			// role_seq arrived after the table first shipped (canaries); NULL (rows indexed
			// before it) is resolved by the next reconcile.
			await addColumn('_kora_access_memberships', 'role_seq', 'BIGINT')
			await createIndex(
				'_kora_access_memberships_user',
				sql`
				CREATE INDEX IF NOT EXISTS _kora_access_memberships_user
				ON _kora_access_memberships (user_id, left_seq)
			`,
			)
			await createIndex(
				'_kora_access_memberships_record',
				sql`
				CREATE INDEX IF NOT EXISTS _kora_access_memberships_record
				ON _kora_access_memberships (record_id) WHERE left_seq IS NULL
			`,
			)
			await createIndex(
				'_kora_access_memberships_group',
				sql`
				CREATE INDEX IF NOT EXISTS _kora_access_memberships_group
				ON _kora_access_memberships (group_key) WHERE left_seq IS NULL
			`,
			)
			await createIndex(
				'_kora_access_memberships_open',
				sql`
				CREATE UNIQUE INDEX IF NOT EXISTS _kora_access_memberships_open
				ON _kora_access_memberships (user_id, group_key, source, record_id)
				WHERE left_seq IS NULL
			`,
			)

			// Live-view summaries per record (see live-views.ts). Additive: an instance that
			// does not know the table ignores it, and a summary it leaves behind reads as stale.
			await tx.execute(sql`
				CREATE TABLE IF NOT EXISTS kora_record_live_views (
					collection TEXT NOT NULL,
					record_id TEXT NOT NULL,
					views TEXT NOT NULL,
					PRIMARY KEY (collection, record_id)
				)
			`)

			// Small key/value store for server-side metadata (snapshot fingerprint, RT-20).
			await tx.execute(sql`
				CREATE TABLE IF NOT EXISTS kora_server_meta (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL
				)
			`)

			// Wrapped end-to-end encryption key records (ENC-1, D4b): salt, KDF parameters
			// and wrapped keys per (owner, keyring). Never a usable key.
			await tx.execute(sql`
				CREATE TABLE IF NOT EXISTS kora_encryption_keys (
					owner TEXT NOT NULL,
					keyring TEXT NOT NULL,
					revision BIGINT NOT NULL,
					record TEXT NOT NULL,
					updated_at BIGINT NOT NULL,
					PRIMARY KEY (owner, keyring)
				)
			`)

			// Node id -> principal binding (see claimNode). One row per device node id.
			await tx.execute(sql`
				CREATE TABLE IF NOT EXISTS node_claims (
					node_id TEXT PRIMARY KEY,
					user_id TEXT NOT NULL,
					claimed_at BIGINT NOT NULL
				)
			`)

			await tx.execute(sql`
				CREATE TABLE IF NOT EXISTS sync_state (
					node_id TEXT PRIMARY KEY,
					max_sequence_number BIGINT NOT NULL,
					last_seen_at BIGINT NOT NULL
				)
			`)

			// Migration (SRV-4): sequence numbers were INTEGER, so a node past 2^31-1 writes
			// failed. Widen both columns once; the type check keeps restarts free (ALTER
			// TYPE rewrites the table under an exclusive lock, so it must not repeat).
			const narrowColumns = (await tx.execute(sql`
				SELECT table_name, column_name FROM information_schema.columns
				WHERE table_schema = current_schema() AND data_type = 'integer' AND (
					(table_name = 'operations' AND column_name = 'sequence_number') OR
					(table_name = 'sync_state' AND column_name = 'max_sequence_number')
				)
			`)) as unknown as { table_name: string; column_name: string }[]
			for (const column of narrowColumns) {
				await tx.execute(
					sql.raw(
						`ALTER TABLE ${quoteIdent(column.table_name)} ALTER COLUMN ${quoteIdent(column.column_name)} TYPE BIGINT`,
					),
				)
			}

			// Counter row that assigns delivery sequences in commit order. Every append
			// does `UPDATE ... value = value + 1 RETURNING value` inside its transaction,
			// which holds an exclusive row lock until commit. So a later assigner cannot
			// obtain its number until the earlier one has committed: delivery-sequence
			// order equals commit (visibility) order, which is what makes a `> watermark`
			// stream provably gap-free across instances. This serializes appends through
			// one row (correctness over throughput, per the framework's priorities).
			await tx.execute(sql`
				CREATE TABLE IF NOT EXISTS delivery_counter (
					id INTEGER PRIMARY KEY,
					value BIGINT NOT NULL
				)
			`)

			// Backfill any pre-column rows deterministically, then seed the counter to the
			// resulting maximum. Under the advisory lock two starting servers cannot
			// double-assign. The window scan touches only rows lacking a sequence, so a
			// fresh or already-migrated table does almost no work here.
			await tx.execute(sql`
				WITH ordered AS (
					SELECT id, ROW_NUMBER() OVER (
						ORDER BY received_at ASC, sequence_number ASC, id ASC
					) + COALESCE((SELECT MAX(delivery_seq) FROM operations), 0) AS rn
					FROM operations WHERE delivery_seq IS NULL
				)
				UPDATE operations o SET delivery_seq = ordered.rn
				FROM ordered WHERE o.id = ordered.id
			`)
			await tx.execute(sql`
				INSERT INTO delivery_counter (id, value)
				VALUES (1, COALESCE((SELECT MAX(delivery_seq) FROM operations), 0))
				ON CONFLICT (id) DO UPDATE
					SET value = GREATEST(delivery_counter.value, EXCLUDED.value)
			`)

			// Sequence enforcement (W3 step 4): record the epoch on the first start of this
			// release (the log's highest delivery sequence then; see
			// SEQUENCE_ENFORCEMENT_EPOCH_KEY), then back the append check with a partial
			// unique index over sole-holder rows (NODE_SEQ_UNIQUE_INDEX), which therefore
			// always exists: a legacy duplicate pair is stored unflagged. It replaces the
			// earlier indexes (a full one, and one over the rows past the epoch, which a
			// legacy client's pair and an older instance's insert would violate, RT-37).
			await tx.execute(sql`
				INSERT INTO kora_server_meta (key, value)
				SELECT ${SEQUENCE_ENFORCEMENT_EPOCH_KEY}, COALESCE(MAX(delivery_seq), 0)::text FROM operations
				ON CONFLICT (key) DO NOTHING
			`)
			const epochRows = (await tx.execute(
				sql`SELECT value FROM kora_server_meta WHERE key = ${SEQUENCE_ENFORCEMENT_EPOCH_KEY}`,
			)) as unknown as { value: string }[]
			// Absent only if the row could not be written: enforce everything (epoch 0).
			const epoch = epochRows[0] === undefined ? 0 : Number(epochRows[0].value)
			if (!Number.isSafeInteger(epoch) || epoch < 0) {
				throw new Error(
					`kora_server_meta.${SEQUENCE_ENFORCEMENT_EPOCH_KEY} holds "${String(epochRows[0]?.value)}", not a delivery sequence. Restore it from a backup or delete the row to re-derive it.`,
				)
			}
			this.sequenceEpoch = epoch
			for (const superseded of SUPERSEDED_NODE_SEQ_UNIQUE_INDEXES) {
				if (indexes.has(superseded)) await tx.execute(sql.raw(`DROP INDEX IF EXISTS ${superseded}`))
			}
			// A row is flagged only when nothing held its sequence at insert, so flagged
			// duplicates can come only from outside writes (a manual edit). Before
			// (re)creating the index, unflag them: they stay stored and judged by the append
			// check, and the index creation cannot fail.
			const indexed = (await tx.execute(
				sql`SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ${NODE_SEQ_UNIQUE_INDEX}`,
			)) as unknown as unknown[]
			if (indexed.length === 0) {
				await tx.execute(sql`
					UPDATE operations o SET seq_unique = 0
					WHERE o.seq_unique = 1 AND EXISTS (
						SELECT 1 FROM operations other
						WHERE other.node_id = o.node_id
							AND other.sequence_number = o.sequence_number
							AND other.id <> o.id
					)
				`)
			}
			await createIndex(
				NODE_SEQ_UNIQUE_INDEX,
				sql.raw(
					`CREATE UNIQUE INDEX IF NOT EXISTS ${NODE_SEQ_UNIQUE_INDEX} ON operations (node_id, sequence_number) WHERE seq_unique = 1`,
				),
			)

			// How uploaded operations were resolved without being stored under their
			// sequence (validator `ignore`, terminal refusal, renumbered duplicate; RT-43,
			// RT-47).
			await tx.execute(sql`
				CREATE TABLE IF NOT EXISTS operation_resolutions (
					op_id TEXT PRIMARY KEY,
					node_id TEXT NOT NULL,
					sequence_number BIGINT NOT NULL,
					outcome TEXT NOT NULL,
					code TEXT,
					message TEXT,
					resolved_at BIGINT NOT NULL
				)
			`)
			await createIndex(
				'idx_resolutions_node_seq',
				sql`CREATE INDEX IF NOT EXISTS idx_resolutions_node_seq ON operation_resolutions (node_id, sequence_number)`,
			)
			// (node, sequence) held by more than one operation: legacy pairs (RT-48),
			// indexed once from the existing log, then maintained by appends.
			await tx.execute(sql`
				CREATE TABLE IF NOT EXISTS sequence_pairs (
					node_id TEXT NOT NULL,
					sequence_number BIGINT NOT NULL,
					PRIMARY KEY (node_id, sequence_number)
				)
			`)
			const pairsBackfilled = (await tx.execute(
				sql`SELECT 1 FROM kora_server_meta WHERE key = ${SEQUENCE_PAIRS_BACKFILLED_KEY}`,
			)) as unknown as unknown[]
			if (pairsBackfilled.length === 0) {
				await tx.execute(sql.raw(BACKFILL_SEQUENCE_PAIRS_SQL))
				await tx.execute(
					sql`INSERT INTO kora_server_meta (key, value) VALUES (${SEQUENCE_PAIRS_BACKFILLED_KEY}, '1')
						ON CONFLICT (key) DO NOTHING`,
				)
			}
		})
	}

	/**
	 * Reserve the next delivery sequence inside an open append transaction. The
	 * `UPDATE ... RETURNING` locks the counter row until this transaction commits,
	 * serializing assignment into commit order (see the counter table comment).
	 */
	/**
	 * Take the delivery-counter row lock without advancing it: every append waits for
	 * this transaction, so work done under it (an index rebuild) sees no interleaved write.
	 */
	private async lockDeliveryCounter(tx: {
		execute: (query: SQL) => Promise<unknown>
	}): Promise<void> {
		await tx.execute(sql`SELECT value FROM delivery_counter WHERE id = 1 FOR UPDATE`)
	}

	private async nextDeliverySeq(tx: {
		execute: (query: SQL) => Promise<unknown>
	}): Promise<number> {
		const readToken = this.accessIndex.beginRead()
		const rows = (await tx.execute(
			sql`UPDATE delivery_counter SET value = value + 1 WHERE id = 1 RETURNING value`,
		)) as unknown as { value: number | string | bigint }[]
		if (this.schema?.access) {
			// Under the counter lock, which a restore takes first: the index state another
			// instance committed (a new generation, a rebuild in progress) is seen before
			// this write is judged, and before anything it triggers is relayed.
			const meta = (await tx.execute(
				sql`SELECT key, value FROM kora_server_meta WHERE key = ${ACCESS_INDEX_GENERATION_KEY}
					OR substr(key, 1, ${ACCESS_INDEX_REBUILDING_PREFIX.length}) = ${ACCESS_INDEX_REBUILDING_PREFIX}`,
			)) as unknown as { key: string; value: string }[]
			this.accessIndex.seen(
				meta.find((row) => row.key === ACCESS_INDEX_GENERATION_KEY)?.value ?? null,
				meta.some((row) => row.key.startsWith(ACCESS_INDEX_REBUILDING_PREFIX)),
				readToken,
			)
		}
		const value = rows[0]?.value
		if (value === undefined || value === null) {
			// The counter row must always exist (ensureTables seeds it). A missing row would
			// silently return 0 and stamp every op with delivery_seq 0, making them invisible
			// to clients (a `> watermark` scan never returns 0). Fail loudly instead of
			// corrupting the delivery stream.
			throw new Error(
				'delivery_counter row (id=1) is missing; the operations log cannot assign delivery sequences',
			)
		}
		return Number(value)
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
	): typeof pgOperations.$inferInsert {
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

	private deserializeOperation(row: typeof pgOperations.$inferSelect): Operation {
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
		if (this.closed) {
			throw new Error('PostgresServerStore is closed')
		}
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
 * Creates a PostgresServerStore from a PostgreSQL connection string.
 */
export async function createPostgresServerStore(
	options: {
		connectionString: string
	} & ServerIdentityOptions,
): Promise<PostgresServerStore> {
	const { postgresClient, drizzleFn } = await loadPostgresDeps()
	const client = postgresClient(options.connectionString)
	const db = drizzleFn(client)

	const store = new PostgresServerStore(db, options.nodeId, undefined, {
		...(options.authoritativeNodeIds ? { authoritativeNodeIds: options.authoritativeNodeIds } : {}),
		...(options.revokedAuthoritativeNodeIds
			? { revokedAuthoritativeNodeIds: options.revokedAuthoritativeNodeIds }
			: {}),
		...(options.instanceId !== undefined ? { instanceId: options.instanceId } : {}),
	})
	// RT-88: fail at startup, where the caller awaits, rather than on the first sync.
	try {
		await store.whenReady()
	} catch (error) {
		await endPostgresClient(client)
		throw new ServerStoreUnavailableError(options.connectionString, error)
	}
	return store
}

/**
 * The Postgres server store could not start: the database is unreachable, refused the
 * credentials, or its tables could not be created. `cause` is the driver's error.
 */
export class ServerStoreUnavailableError extends KoraError {
	constructor(connectionString: string, cause: unknown) {
		const reason = cause instanceof Error ? cause.message : String(cause)
		super(
			`Could not start the PostgreSQL server store (${redactConnectionString(connectionString)}): ${reason}. Check that the database is running and reachable, and that the connection string and credentials are correct.`,
			'SERVER_STORE_UNAVAILABLE',
			{ target: redactConnectionString(connectionString) },
		)
		this.name = 'ServerStoreUnavailableError'
		;(this as { cause?: unknown }).cause = cause
	}
}

/** host:port/database of a connection string, never its credentials. */
function redactConnectionString(connectionString: string): string {
	try {
		const url = new URL(connectionString)
		return `${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`
	} catch {
		return 'invalid connection string'
	}
}

async function endPostgresClient(client: unknown): Promise<void> {
	const end = (client as { end?: (options?: { timeout?: number }) => Promise<void> }).end
	if (typeof end !== 'function') return
	try {
		await end.call(client, { timeout: 0 })
	} catch {
		// Best effort: the startup error above is the one that matters.
	}
}

async function loadPostgresDeps(): Promise<{
	postgresClient: (connectionString: string) => unknown
	drizzleFn: (client: unknown) => PostgresJsDatabase
}> {
	// `postgres` is an optional peer: imported only when this backend is used. The
	// specifiers come from an array so no bundler resolves them at build time (an app
	// without `postgres` must still bundle), and the import is a real `import()` so it runs
	// inside vitest's module runner too. A `new Function('return import(x)')` wrapper did
	// neither reliably: it escaped vitest's VM (RT-30) and hid the real error.
	const [postgresSpecifier, drizzleSpecifier] = POSTGRES_DRIVER_SPECIFIERS
	let postgresMod: { default: (cs: string) => unknown }
	let drizzleMod: { drizzle: (client: unknown) => PostgresJsDatabase }
	try {
		postgresMod = (await import(/* @vite-ignore */ postgresSpecifier)) as typeof postgresMod
		drizzleMod = (await import(/* @vite-ignore */ drizzleSpecifier)) as typeof drizzleMod
	} catch (error) {
		throw new Error(
			`PostgreSQL backend requires the "postgres" package. Install it in your project dependencies. (${error instanceof Error ? error.message : String(error)})`,
		)
	}
	return {
		postgresClient: postgresMod.default,
		drizzleFn: drizzleMod.drizzle,
	}
}

/** Optional driver modules, loaded on first use of the Postgres backend. */
const POSTGRES_DRIVER_SPECIFIERS: readonly [string, string] = [
	'postgres',
	'drizzle-orm/postgres-js',
]

/**
 * True when a rebuild marker's lease (its value: `<expiry, epoch ms>|<lease token>`) has
 * run out at `now`.
 */
function markerLeaseExpired(value: string, now: number): boolean {
	const expiry = value.split('|')[0] ?? ''
	return !/^[0-9]+$/.test(expiry) || Number(expiry) < now
}

/** A renewal that matched fewer markers than it held: another instance took some over. */
function reportLostLeases(keys: readonly string[], renewed: number): void {
	if (renewed >= keys.length) return
	console.warn(
		`[kora] ${keys.length - renewed} membership index rebuild marker(s) of this instance were taken over by another instance (its lease ran out). That instance completes the rebuild; this one no longer clears them.`,
	)
}

/**
 * A column value as `serializePgFieldValue` writes it, in the JSON form
 * `jsonb_populate_recordset` reads back as that same column value: a JSONB column takes
 * the JSON value itself (the serialized text parsed), a BYTEA column the `\x` hex input
 * form, every other column its value (a string's contents are taken as they are).
 */
function pgJsonColumnValue(
	column: unknown,
	descriptor: import('@korajs/core').FieldDescriptor,
): unknown {
	if (column === null || column === undefined) return null
	if (isPgJsonbKind(descriptor.kind) && typeof column === 'string') return JSON.parse(column)
	if (ArrayBuffer.isView(column)) {
		const bytes = new Uint8Array(column.buffer, column.byteOffset, column.byteLength)
		return `\\x${Buffer.from(bytes).toString('hex')}`
	}
	return column
}

/** A field value as a Postgres column round trip leaves it (what `readStoredRow` returns). */
function storedPgFieldValue(
	value: unknown,
	descriptor: import('@korajs/core').FieldDescriptor,
): unknown {
	const column = serializePgFieldValue(value, descriptor)
	// The driver hands a JSONB column back parsed.
	return deserializePgFieldValue(
		isPgJsonbKind(descriptor.kind) && typeof column === 'string' ? parseJsonb(column) : column,
		descriptor,
	)
}

/** A JSONB column's text as the driver returns it (parsed), or the text when it is not JSON. */
function parseJsonb(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return text
	}
}
