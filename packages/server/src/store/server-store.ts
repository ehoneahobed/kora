import { AsyncLocalStorage } from 'node:async_hooks'
import type {
	FoldState,
	HLCTimestamp,
	HybridLogicalClock,
	Operation,
	RecordFieldVersions,
	SchemaDefinition,
	VersionVector,
} from '@korajs/core'
import { KoraError } from '@korajs/core'
import type { OperationTransform } from '@korajs/core'
import type { ApplyResult, SyncStore } from '@korajs/sync'
import type { MembershipInterval } from '../access/membership-index'
import type { UplinkAuthorizationResult } from '../scopes/server-scope-filter'
import type {
	DeliveryIndexRead,
	DeliveryPartitionOverrides,
	DeliveryPartitionPlan,
	DeliverySources,
} from './delivery-partitions'
import type { RecordLiveViewsState } from './live-views'

/** Rejection code for a second, different operation under an existing (node, sequence). */
export const SEQUENCE_CONFLICT_CODE = 'SEQUENCE_CONFLICT'

/**
 * Thrown by a store when an operation claims a `(nodeId, sequenceNumber)` that an
 * operation with a DIFFERENT id already holds (W3 step 4). A node's sequence numbers
 * identify its writes: accepting a second operation under the same number would make
 * one of them invisible to every version-vector delta and to the client's contiguous
 * acknowledged prefix. Nothing was written. Not retriable: the same bytes always fail.
 */
export class SequenceConflictError extends KoraError {
	constructor(
		readonly operation: Pick<Operation, 'id' | 'nodeId' | 'sequenceNumber'>,
		readonly existingOperationId: string,
	) {
		super(
			`Operation "${operation.id}" claims sequence ${String(operation.sequenceNumber)} of node "${operation.nodeId}", which operation "${existingOperationId}" already holds. A node may never reuse a sequence number for different content.`,
			SEQUENCE_CONFLICT_CODE,
			{
				operationId: operation.id,
				nodeId: operation.nodeId,
				sequenceNumber: operation.sequenceNumber,
				existingOperationId,
			},
		)
		this.name = 'SequenceConflictError'
	}
}

/** Rejection code for an operation holding a value the store cannot represent. */
export const UNSTORABLE_VALUE_CODE = 'UNSTORABLE_VALUE'

/**
 * Thrown by a store when an operation carries a value the database cannot represent
 * (RT-65). Nothing was written. Not retriable: the same bytes always fail, so the
 * session refuses the operation terminally instead of failing the connection (which
 * made the device re-send it forever and blocked every later write of that device).
 */
export class UnstorableValueError extends KoraError {
	constructor(
		readonly operation: Pick<Operation, 'id' | 'collection' | 'recordId'>,
		detail: string,
	) {
		super(
			`Operation "${operation.id}" on ${operation.collection}/${operation.recordId} holds a value this server's database cannot store (${detail}). It is refused; nothing was written.`,
			UNSTORABLE_VALUE_CODE,
			{ operationId: operation.id, collection: operation.collection, recordId: operation.recordId },
		)
		this.name = 'UnstorableValueError'
	}
}

/** Whose devices a forced full resync applies to: a user's, a device node's, or both. */
export interface FullResyncTarget {
	userId?: string
	nodeId?: string
}

/** A device's full-resync bookkeeping (see `ServerStore.getFullResyncState`). */
export interface FullResyncState {
	/** The newest request token that applies to the device, or null. */
	requested: number | null
	/** The newest request token the device completed in the given delivery view, or null. */
	done: number | null
}

/** `kora_server_meta` key of the counter full-resync request tokens are taken from. */
export const FULL_RESYNC_COUNTER_KEY = 'full_resync_counter'

/** `kora_server_meta` key of a full-resync request for one user's devices. */
export function fullResyncUserKey(userId: string): string {
	return `full_resync:user:${userId}`
}

/** `kora_server_meta` key of a full-resync request for one device node. */
export function fullResyncNodeKey(nodeId: string): string {
	return `full_resync:node:${nodeId}`
}

/**
 * `kora_server_meta` key of the newest full-resync request a device node completed in one
 * delivery view. A device keeps a watermark per view (scope and query subsets), and only
 * the view it streams under restarts at a handshake, so completion is recorded per view:
 * each view the device returns to restarts from 0 once. `view` is the session's view key
 * (empty for the unscoped view).
 */
export function fullResyncDoneKey(nodeId: string, view = ''): string {
	return view === '' ? `full_resync_done:${nodeId}` : `full_resync_done:${nodeId}:${view}`
}

/** The newest of the given request tokens (stored as decimal strings), or null. */
export function newestFullResyncToken(values: ReadonlyArray<string | undefined>): number | null {
	let newest: number | null = null
	for (const value of values) {
		if (value === undefined) continue
		const token = Number(value)
		if (Number.isFinite(token) && (newest === null || token > newest)) newest = token
	}
	return newest
}

/**
 * `kora_server_meta` key holding the sequence-enforcement epoch: the highest delivery
 * sequence in the log when this release first opened the store. Operations stored at
 * or below it were accepted by a release that allowed a node to reuse a sequence
 * number (beta.12 STORE-1/2); a newly uploaded operation that shares a (node,
 * sequence) only with such legacy operations is accepted as before (the client's
 * sequence repair may keep the OTHER op of a legacy duplicate pair at that number).
 * Above it, a writer that reserves its sequence numbers (see
 * {@link ApplyRemoteOptions.legacySequenceWriter}) is refused a held sequence.
 */
export const SEQUENCE_ENFORCEMENT_EPOCH_KEY = 'sequence_enforcement_epoch'

/**
 * `kora_server_meta` key set once the legacy pairs already in the log were indexed in
 * `sequence_pairs` (RT-48); appends maintain the index from then on.
 */
export const SEQUENCE_PAIRS_BACKFILLED_KEY = 'sequence_pairs_backfilled'

/**
 * Name of the partial unique index over (node_id, sequence_number) of the rows that
 * were the sole holder of their sequence when stored (`seq_unique = 1`, RT-37).
 *
 * Design: a row is flagged when nothing else held its (node, sequence) at insert, and
 * a row stored as the second of a pair (a legacy duplicate: a pre-epoch holder, or an
 * upload from a client without the `sequenceReservation` capability) is not. So the
 * index can never be violated by an accepted legacy pair, yet two concurrent sole
 * inserts of one (node, sequence) (the race between server instances it backs) still
 * collide. Rows written by a release without the column (older instances during a
 * rolling upgrade, or history) default to 0 and sit outside it; the append check, run
 * under the store's write lock, judges them as holders.
 */
export const NODE_SEQ_UNIQUE_INDEX = 'idx_node_seq_unique_sole'

/** Earlier unique indexes over (node_id, sequence_number), dropped at startup. */
export const SUPERSEDED_NODE_SEQ_UNIQUE_INDEXES = [
	'idx_node_seq_unique',
	'idx_node_seq_unique_after_epoch',
] as const

/** Outcome of {@link judgeSequenceHolders}. */
export type SequenceHolderVerdict =
	/** No other operation holds the sequence: stored as its sole holder (indexed). */
	| { verdict: 'free' }
	/** Shares the sequence with `holderIds`, accepted: stored as a legacy pair. */
	| { verdict: 'legacy'; holderIds: string[]; legacyWriter: boolean }
	/** Refused: `holderId` holds the sequence under enforcement. */
	| { verdict: 'conflict'; holderId: string }

/**
 * Decide an append against the operations already holding its (node, sequence):
 * `'conflict'` when any of them was stored after the enforcement epoch and the writer
 * reserves its sequence numbers; `'legacy'` (accepted, with a warning) when all of
 * them predate the epoch, or when the writer is a legacy client (RT-37: Kora <=
 * beta.12 could give two concurrent transactions one number, and refusing the second
 * would drop a write the user made); `'free'` when there are none. Holders with the
 * operation's own id are the caller's duplicate case.
 */
export function judgeSequenceHolders(
	op: Pick<Operation, 'id' | 'nodeId' | 'sequenceNumber'>,
	holders: ReadonlyArray<{ id: string; deliverySequence: number }>,
	epoch: number,
	writer: { legacySequenceWriter?: boolean } = {},
): SequenceHolderVerdict {
	const others = holders.filter((holder) => holder.id !== op.id)
	if (others.length === 0) return { verdict: 'free' }
	const enforced = others.find((holder) => holder.deliverySequence > epoch)
	const holderIds = others.map((holder) => holder.id)
	const list = holderIds.map((id) => `"${id}"`).join(', ')
	if (enforced) {
		if (writer.legacySequenceWriter !== true) {
			return { verdict: 'conflict', holderId: enforced.id }
		}
		console.warn(
			`[kora] Operation "${op.id}" shares sequence ${String(op.sequenceNumber)} of node "${op.nodeId}" with operation(s) ${list}. The client does not reserve sequence numbers (no sequenceReservation capability: Kora <= beta.12), so this is a legacy duplicate pair: both are stored and delivered. Upgrade the client.`,
		)
		return { verdict: 'legacy', holderIds, legacyWriter: true }
	}
	console.warn(
		`[kora] Operation "${op.id}" shares sequence ${String(op.sequenceNumber)} of node "${op.nodeId}" with operation(s) ${list} stored before sequence enforcement (a duplicate written by Kora <= beta.12). Accepted and stored, as that release did.`,
	)
	return { verdict: 'legacy', holderIds, legacyWriter: false }
}

/** A stored legacy pair, reported to {@link ApplyRemoteOptions.onLegacySequencePair}. */
export interface LegacySequencePair {
	operationId: string
	nodeId: string
	sequenceNumber: number
	/** The operations that already held the sequence. */
	holderIds: string[]
	/** True when accepted because the writer is a legacy client (not a pre-epoch holder). */
	legacyWriter: boolean
}

/**
 * Tell the caller of an append that it committed a legacy pair (see
 * {@link ApplyRemoteOptions.onLegacySequencePair}). Called by the built-in stores
 * after the write committed.
 */
export function reportLegacyPair(
	op: Pick<Operation, 'id' | 'nodeId' | 'sequenceNumber'>,
	decision: SequenceHolderVerdict,
	options: Pick<ApplyRemoteOptions, 'onLegacySequencePair'> | undefined,
): void {
	if (decision.verdict !== 'legacy' || !options?.onLegacySequencePair) return
	options.onLegacySequencePair({
		operationId: op.id,
		nodeId: op.nodeId,
		sequenceNumber: op.sequenceNumber,
		holderIds: decision.holderIds,
		legacyWriter: decision.legacyWriter,
	})
}

/**
 * How the server resolved an uploaded operation it did NOT store under the submitted
 * (node, sequence) (RT-43, RT-47):
 * - `'ignored'`: the validator answered `ignore` (handled out of band, nothing stored);
 * - `'refused'`: a terminal (non-retriable) rejection; the same id is answered with the
 *   original rejection forever after;
 * - `'stored-elsewhere'`: the id is stored under another sequence of the same node (a
 *   client sequence repair renumbered it), acknowledged as a duplicate.
 * A retriable rejection, and a `SEQUENCE_CONFLICT` (the client renumbers and resubmits
 * under the same id), are never resolutions.
 */
export type OperationResolutionOutcome = 'ignored' | 'refused' | 'stored-elsewhere'

/** A durable record of how an uploaded operation was resolved without being stored. */
export interface OperationResolution {
	operationId: string
	nodeId: string
	sequenceNumber: number
	outcome: OperationResolutionOutcome
	/** Rejection code, for `'refused'`. */
	code: string | null
	/** Rejection message, for `'refused'`. */
	message: string | null
}

/** Longest rejection message kept in an {@link OperationResolution}. */
export const MAX_RESOLUTION_MESSAGE_LENGTH = 1024

/** Where a stored operation sits in its node's sequence space. */
export interface StoredOperationKey {
	nodeId: string
	sequenceNumber: number
	/**
	 * The operation's delivery sequence, when the store knows it. A reader that needs it
	 * for a history decision (a replayed delete) treats its absence as "cannot be
	 * established" and fails closed.
	 */
	deliverySequence?: number
}

/**
 * Owner recorded for a node id an admin released (see `ServerStore.releaseNodeClaim`):
 * the next principal to claim the node takes it over. Never a valid principal id.
 */
export const RELEASED_NODE_OWNER = ''

/**
 * A materialized record reconstructed from the operation log
 * or read from a materialized collection table.
 */
export interface MaterializedRecord {
	id: string
	[key: string]: unknown
}

/**
 * A conditional, atomic multi-operation apply. The store reads the target under a
 * cross-instance lock, lets the caller decide admission and build the operations
 * against that locked state, and applies them in one transaction, or applies
 * nothing. `admit` and `buildOperations` run inside the locked transaction so the
 * predicate check and any atomic-op resolution see the authoritative current value
 * even when multiple server instances race on the same target.
 */
export interface ConditionalApplyInput {
	/** Record the admission lock and predicate are keyed on. */
	target: { collection: string; id: string }
	/** Decides admission against the target's locked current state. */
	admit: (current: MaterializedRecord | null) => boolean
	/**
	 * Builds the operations to apply, given the locked current state and a clock the
	 * store has already advanced past the target record's latest committed operation.
	 * Stamping the built operations with this clock guarantees they sort strictly
	 * after every prior write to the target, so last-write-wins materialization
	 * reflects the serialized commit order even when two instances commit in the same
	 * millisecond. Without it, a same-millisecond tie could let materialization pick
	 * an earlier resolved value and undercount an atomic counter, admitting past a cap.
	 */
	buildOperations: (
		current: MaterializedRecord | null,
		context: ConditionalApplyContext,
	) => Promise<Operation[]>
	/**
	 * When set, a record whose prior existence proves this set already committed.
	 * Checked under the same lock as admission, so a retry is idempotent even across
	 * instances: it returns `idempotent: true` without re-running the operations.
	 */
	idempotencyKey?: { collection: string; id: string }
}

/** Context passed to {@link ConditionalApplyInput.buildOperations}. */
export interface ConditionalApplyContext {
	/**
	 * A clock the store has advanced past the target record's latest committed
	 * operation. Operations built here must be stamped with it (route context threads
	 * it into operation creation) so they sort strictly after every prior write.
	 */
	clock: HybridLogicalClock
	/**
	 * Read a record as stored (including a soft-deleted one) inside the store's
	 * conditional-apply transaction, for authorizing the built operations against the
	 * same state they commit over. Optional; callers fall back to a plain read.
	 */
	readStoredRow?: (collection: string, id: string) => Promise<MaterializedRecord | null>
}

/** Result of {@link ServerStore.applyConditional}. */
export interface ConditionalApplyResult {
	/** True when the predicate held (or the set was already committed). */
	admitted: boolean
	/** True when the idempotency key already existed and nothing was re-applied. */
	idempotent: boolean
	/** The operations that were applied (empty when not admitted or idempotent). */
	applied: Operation[]
}

/**
 * A store view used inside a transaction (a Proxy bound to its connection or staging
 * writes) answers this key with the store it wraps, so state kept per store (the
 * server node's clock and sequence reservations) is shared with the store itself.
 */
export const STORE_IDENTITY: unique symbol = Symbol('kora.storeIdentity')

/** The store a view wraps, or the store itself. */
export function storeIdentity(store: ServerStore): ServerStore {
	const identity = (store as { [STORE_IDENTITY]?: ServerStore })[STORE_IDENTITY]
	return identity ?? store
}

/** The transaction decision running now, with the store view it reads through. */
const currentDecision = new AsyncLocalStorage<{ store: ServerStore; bound: ServerStore }>()

/**
 * Run `work` outside any transaction decision: work a decision only starts (a background
 * rebuild) must not read through, or write into, that decision's transaction.
 */
export function outsideDecision<T>(work: () => T): T {
	return currentDecision.exit(work)
}

/**
 * Run `work` as the decision of a transaction on `store`, reading through `bound`.
 * Inside it, {@link decisionStoreFor} gives `bound` for that store.
 */
export function runAsDecision<T>(store: ServerStore, bound: ServerStore, work: () => T): T {
	return currentDecision.run({ store: storeIdentity(store), bound }, work)
}

/**
 * The view a decision running now on `store` reads through, or null outside one. Reads
 * made inside a decision through the store itself would wait for the transaction (on
 * Postgres, for a pooled connection; on SQLite and memory, writes wait at the gate).
 */
export function decisionStoreFor(store: ServerStore): ServerStore | null {
	const decision = currentDecision.getStore()
	return decision && decision.store === storeIdentity(store) ? decision.bound : null
}

/**
 * Decides a store transaction ({@link ServerStore.transact}): reads current state
 * through `store`, the store bound to the transaction (every read must go through it,
 * never through the original store, whose reads may wait for the transaction), and
 * returns the operations to commit, or null to commit nothing. No other operation write
 * commits while it runs, so what it reads is what the operations commit over. It must
 * not apply operations itself.
 */
export type StoreTransactionRun = (store: ServerStore) => Promise<Operation[] | null>

/** Result of {@link ServerStore.transact}. */
export interface StoreTransactionResult {
	/** False when the decision returned null (nothing was written). */
	committed: boolean
	/** The operations committed (empty when not committed). */
	applied: Operation[]
}

/**
 * A stored operation paired with its server-assigned delivery sequence. The
 * delivery sequence is monotonic in commit order, so a batch of these can be
 * chained (each batch's base links to the previous batch's max) to give the
 * client a gap-free, scope-agnostic recovery stream.
 */
export interface DeliveredOperation {
	operation: Operation
	deliverySequence: number
	/**
	 * The record's scope-relevant values around this operation, captured from the
	 * server's own rows when it was applied (RT-14, RT-15). Absent (or null) for
	 * operations stored before snapshots existed that could not be backfilled.
	 */
	scopeSnapshot?: OperationScopeSnapshot | null
}

/**
 * Scope-relevant field values of a record, captured by the store from its own rows
 * when an operation is applied (never from the writer's `previousData`). Download
 * visibility of a historical operation is judged on `post`, so a later ownership
 * transfer does not disclose the record's earlier history to the new owner (RT-14),
 * and a scope exit is judged from `pre` to `post` (RT-15).
 *
 * Only scalar fields (string, number, boolean, enum, timestamp) and `id` are kept:
 * scope predicates compare with `Object.is`, so other kinds can never match. A
 * string longer than {@link MAX_SCOPE_SNAPSHOT_STRING_LENGTH} is left out (fails
 * closed for a scope on such a field) so a snapshot never copies large text.
 */
export interface OperationScopeSnapshot {
	/** Values before the operation; null when the record did not exist or was deleted. */
	pre: Record<string, unknown> | null
	/** Values after it; a delete keeps the record's last values; null when unknown. */
	post: Record<string, unknown> | null
	/**
	 * Whether the record is a tombstone after the operation, as the fold decided it (a
	 * delete that won, or a write older than the record's newest delete). Absent means
	 * unknown: a snapshot written before 1.0.0-beta.15 or by an older instance (filled in
	 * the background), or one whose `post` is null.
	 */
	deleted?: boolean
}

/** Longest string value copied into an {@link OperationScopeSnapshot}. */
export const MAX_SCOPE_SNAPSHOT_STRING_LENGTH = 512

/**
 * Options for querying a materialized collection table.
 */
export interface CollectionQueryOptions {
	/** Exact-match filters on field values */
	where?: Record<string, unknown>
	/** Field name to order results by */
	orderBy?: string
	/** Sort direction (default: 'asc') */
	orderDirection?: 'asc' | 'desc'
	/** Maximum number of records to return */
	limit?: number
	/** Number of records to skip (for pagination) */
	offset?: number
	/** Include soft-deleted records (default: false) */
	includeDeleted?: boolean
}

/**
 * Options for {@link ServerStore.applyRemoteOperation}.
 */
export interface ApplyRemoteOptions {
	/**
	 * Authorization re-check for an operation submitted by an untrusted writer.
	 *
	 * The store calls it inside its apply critical section (the SQLite write
	 * transaction, the in-memory store's synchronous apply, or a Postgres
	 * transaction holding the per-record advisory lock shared with conditional
	 * applies) with the record as stored at that moment, including a soft-deleted
	 * one, or null when none exists. The record is the one this store's fold plan
	 * defines: a row materialized under another plan (an instance still on the old plan
	 * during a rolling deploy) is judged as this plan folds it. Returning a refusal aborts the apply and the
	 * store throws {@link UplinkAuthorizationError}; nothing is written.
	 *
	 * This closes the window between a caller's own pre-check and the write, where an
	 * ownership change or a same-id insert committed by another writer (or another
	 * server instance) could otherwise slip in.
	 */
	authorize?: (
		storedRow: MaterializedRecord | null,
		context: ApplyAuthorizeContext,
	) => UplinkAuthorizationResult
	/**
	 * With `authorize`: also fold the operation onto the record's stored fold state, in
	 * the same critical section, and pass the record this write leaves as
	 * `context.resulting` (access rules judge exactly what the fold stores: with atomic
	 * intents, each field's value depends on that field's history). The built-in stores
	 * honor it; a store that does not leaves `resulting` unset.
	 */
	previewResult?: boolean
	/**
	 * The user whose memberships `authorize` needs (access rules). The store reads that
	 * user's membership intervals inside the same critical section, after taking the
	 * delivery-counter lock every append takes, and passes them as
	 * `context.memberships`: a write is therefore ordered against a revoke (it commits
	 * either before the revoke with the old membership or after it without).
	 */
	membershipsFor?: string
	/**
	 * Group keys (`documents:<id>`) whose records `authorize` needs to know are live (the
	 * groups of the writer's capability grants). The store reads them inside the same
	 * critical section and passes those whose record exists and is not deleted as
	 * `context.liveGroups`, so a write is ordered against the group's deletion.
	 */
	liveGroupsOf?: readonly string[]
	/**
	 * With `liveGroupsOf`: a group deleted at a delivery sequence above this one (even if
	 * restored since) is not live for the writer, whose grants were read before it.
	 */
	liveGroupsSince?: number
	/**
	 * The writer does not reserve its sequence numbers inside the write transaction
	 * (a client that did not advertise the `sequenceReservation` handshake capability,
	 * Kora <= beta.12; RT-37). A different operation already holding the
	 * `(nodeId, sequenceNumber)` then does not refuse this one: both are stored as a
	 * legacy pair (each keeps its own delivery sequence, so both are delivered) instead
	 * of throwing {@link SequenceConflictError}. Default false: enforce.
	 */
	legacySequenceWriter?: boolean
	/**
	 * Called once the operation was committed as the second holder of its sequence (a
	 * legacy pair), for logging and diagnostics. Never called for a refused write.
	 */
	onLegacySequencePair?: (pair: LegacySequencePair) => void
}

/** What a store hands {@link ApplyRemoteOptions.authorize} besides the stored row. */
export interface ApplyAuthorizeContext {
	/** The membership intervals of `membershipsFor` (empty when not requested). */
	readonly memberships: readonly MembershipInterval[]
	/** Of `liveGroupsOf`, the groups whose record is live (absent when not requested). */
	readonly liveGroups?: ReadonlySet<string>
	/**
	 * The record exactly as the fold stores it once this write commits (`previewResult`),
	 * or null when the write leaves no record. Absent when not requested or not supported.
	 */
	readonly resulting?: ResultingRecord | null
}

/** A record as the fold leaves it: its field values and whether it is deleted. */
export interface ResultingRecord {
	readonly values: Readonly<Record<string, unknown>>
	readonly deleted: boolean
}

/** See {@link ServerStore.getAccessIndexState}. */
export interface AccessIndexState {
	frontier: number
	accessCollectionsEver: string[]
	/** Changes at each index rebuild (restore, newly indexed collection); null before. */
	generation?: string | null
	/** True while a replace-mode restore is rebuilding the index (on any instance). */
	rebuilding?: boolean
}

/** Options of {@link ServerStore.setSchema}. */
export interface ServerSchemaOptions {
	/** Schema transforms the store folds with (transforms at fold time, RT-84). */
	operationTransforms?: readonly OperationTransform[]
	/**
	 * @deprecated No effect: a schema declaring `access` is always installed, and the
	 * sync server enforces it.
	 */
	accessRulesEnforced?: boolean
	/**
	 * Extra partition fields per collection for the delivery visibility index (C2), for
	 * providers whose scopes name fields the schema does not declare. Same as
	 * {@link ServerStore.setDeliveryPartitions}.
	 */
	deliveryPartitions?: DeliveryPartitionOverrides
}

/** State of the delivery visibility index, for diagnostics and tests. */
export interface DeliveryPartitionState {
	/** Fingerprint stored with the index, or null when none was recorded. */
	fingerprint: string | null
	/** Fingerprint of the partition plan this instance derived, or null without a schema. */
	planFingerprint: string | null
	/** Every sequence at or below this has its index rows (0: nothing is covered). */
	through: number
	/**
	 * Token of the last reset of the index (null for a store that keeps none). It changes
	 * on every reset, so two reads that return the same epoch saw no reset between them
	 * even if the rebuild has since brought `through` back.
	 */
	epoch: string | null
	/** True when both composite indexes exist and are valid and the plan matches. */
	usable: boolean
}

/** One stored end-to-end key record (opaque JSON) and its owner, as backups carry it. */
export interface EncryptionKeyRecordRow {
	owner: string
	keyring: string
	revision: number
	/** The record's JSON, exactly as stored. */
	record: string
}

/**
 * Server-side store interface. Extends SyncStore with lifecycle,
 * introspection, and materialization methods needed by the sync server.
 */
export interface ServerStore extends SyncStore {
	/**
	 * Apply an operation to the log and materialized state. With
	 * `options.authorize`, the authorization is re-checked atomically with the write
	 * (see {@link ApplyRemoteOptions}). Stores written before this option existed
	 * may ignore it; callers always pre-check as well.
	 *
	 * Built-in stores throw {@link SequenceConflictError} when a different operation
	 * already holds the operation's `(nodeId, sequenceNumber)` under enforcement
	 * (unless `options.legacySequenceWriter`, see {@link judgeSequenceHolders}), and return
	 * `'duplicate'` (writing nothing) for an operation id already stored, decided
	 * atomically with the write.
	 */
	/**
	 * True when `applyRemoteOperation` honors `liveGroupsOf` (reports
	 * `context.liveGroups`): capability grants then authorize writes. The built-in stores
	 * do; without it, grants authorize reads only.
	 */
	readonly reportsLiveGroups?: boolean

	/**
	 * Of `groups` (group keys), those whose record is live now and, with `since`, was not
	 * deleted at a delivery sequence above it (even if restored since). Stores that
	 * report `reportsLiveGroups` implement it.
	 */
	getLiveGroups?(groups: readonly string[], since?: number): Promise<ReadonlySet<string>>

	applyRemoteOperation(op: Operation, options?: ApplyRemoteOptions): Promise<ApplyResult>

	/**
	 * The version vector as committed in the shared database, read fresh (SRV-4). A
	 * store shared by several server instances must implement it: its synchronous
	 * {@link SyncStore.getVersionVector} can only reflect this instance's own writes.
	 * Optional; callers fall back to `getVersionVector()`.
	 */
	readVersionVector?(): Promise<VersionVector>

	/**
	 * Several records of one collection by id, as stored (soft-deleted ones included),
	 * in one read: `id = ANY(...)` on Postgres, chunked `IN (...)` on SQLite (LMS #11).
	 * Ids with no row are absent from the result. Optional; the delivery stream falls
	 * back to one lookup per operation without it.
	 */
	findRecordsByIds?(collection: string, ids: string[]): Promise<Map<string, MaterializedRecord>>

	/**
	 * Which of `ids` the operation log already holds, with the node and sequence each is
	 * stored under, in one read per batch (chunked `IN (...)`). The sync session asks before any other per-operation check, so a
	 * device re-uploading history the server already stores (the one-time upgrade
	 * re-upload, or an op the client's sequence repair renumbered under its original
	 * id) is acknowledged as a duplicate instead of being re-judged by today's
	 * authorization and validators. Optional; sessions fall back to a per-operation
	 * (node, sequence) lookup without it.
	 */
	findStoredOperations?(ids: string[]): Promise<Map<string, StoredOperationKey>>

	/**
	 * Durably record how an uploaded operation was resolved without being stored under
	 * its sequence (RT-43, RT-47; see {@link OperationResolution}). Idempotent per
	 * operation id: the first resolution wins. The session awaits it BEFORE answering the
	 * client, so a client never acts on a resolution the server could forget. Optional
	 * for custom stores: without it an ignored tail op may be re-validated at reconnect
	 * and a refused id re-judged on resubmission.
	 */
	recordOperationResolution?(resolution: OperationResolution): Promise<void>

	/**
	 * The resolutions recorded for `ids` under `nodeId` (ids resolved under another node
	 * are absent: the answer never crosses devices or tenants).
	 */
	findOperationResolutions?(
		nodeId: string,
		ids: string[],
	): Promise<Map<string, OperationResolution>>

	/** The highest sequence number of `nodeId` with a recorded resolution (0 when none). */
	getResolvedThrough?(nodeId: string): Promise<number>

	/**
	 * Forget the resolution recorded for `operationId` under `nodeId` (no-op when none).
	 * The session calls it for a stale `stored-elsewhere` record: one whose id the batch
	 * lookup did not find stored (RT-51). The operation is then judged normally, and its
	 * real outcome is recorded in place of the stale one. Optional for custom stores:
	 * without it the stale record is ignored but kept.
	 */
	deleteOperationResolution?(nodeId: string, operationId: string): Promise<void>

	/**
	 * Every operation of `nodeId` at or below `throughSequence` that shares its sequence
	 * with another stored operation (a legacy pair, RT-37), ordered by sequence then
	 * delivery. A version-vector client reporting `throughSequence` for the node may hold
	 * only one of a pair, and a range read above its entry can never return the other
	 * (RT-48). Optional; without it such clients miss the second op of a pair.
	 */
	getSequencePairOperations?(nodeId: string, throughSequence: number): Promise<Operation[]>

	/**
	 * The distinct node ids of the operations with `deliverySequence >
	 * afterDeliverySequence`. Optional; lets a handshake stop judging which nodes a
	 * scoped client will hear from as soon as every candidate was found visible.
	 */
	getNodeIdsAfterDelivery?(afterDeliverySequence: number): Promise<string[]>

	/**
	 * Bind a client node id to the authenticated principal that first used it.
	 * Returns true when the node id is already owned by `userId`, was released by an
	 * admin (see {@link releaseNodeClaim}; the caller takes it over), or is unclaimed
	 * AND has no operation history. Returns false when another principal owns it, or
	 * when it is unclaimed but already has operations in the log: history written
	 * before node claims existed has no recorded writer, so nobody may adopt it
	 * until an admin releases it (RT-5). Called at handshake when auth is configured,
	 * so one user cannot upload operations under another user's device id. Every
	 * write after this check is preceded by a claim, so going forward the claim row
	 * records the writer of a node's history. Must be atomic per node id. Optional
	 * for custom stores; the built-in stores persist the claim.
	 */
	claimNode?(nodeId: string, userId: string): Promise<boolean>
	/**
	 * Atomically claim a node id that has no real owner for `userId` (F1): a node
	 * with operation history but no claim (written before node claims existed, by a
	 * beta.12 or older server) or one an admin released (owner `''`). A node another
	 * principal owns is never taken. One statement, so there is no gap between a
	 * release and a claim another claimant could slip into. Returns true when
	 * `userId` owns the node afterwards. The server calls it only for a node whose id
	 * equals the device id the auth provider verified for that user. Optional for
	 * custom stores; without it such nodes stay refused until an admin binds them.
	 */
	claimUnownedNode?(nodeId: string, userId: string): Promise<boolean>
	/**
	 * Admin release of a node id (RT-5): the next principal to claim it takes it
	 * over, even when the node has operation history. Returns true when the node had
	 * a claim or history to release, false when it was unknown.
	 */
	releaseNodeClaim?(nodeId: string): Promise<boolean>
	/**
	 * Record an operator's request that a user's devices (or one device node) resync in
	 * full (`KoraSyncServer.forceFullResync`). Returns the request's token, from a counter
	 * the store keeps (one statement, shared by every server instance): a later request
	 * always has a larger token. Optional; without it `forceFullResync` throws.
	 */
	requestFullResync?(target: FullResyncTarget): Promise<number>
	/**
	 * The newest full-resync request that applies to a device (its user's or its node's)
	 * and the newest one the device completed in delivery view `view` (an opaque key, empty
	 * for the unscoped view), each null when none. Required with `requestFullResync`.
	 */
	getFullResyncState?(
		userId: string | null,
		nodeId: string,
		view?: string,
	): Promise<FullResyncState>
	/**
	 * Record that a device completed the full-resync request `token` in delivery view
	 * `view` (keeps the newest). Required with `requestFullResync`.
	 */
	completeFullResync?(nodeId: string, token: number, view?: string): Promise<void>
	/**
	 * The owner a node id is currently claimed by, or null when unclaimed (RT-21).
	 * Optional; anonymous provisional claims need it together with
	 * {@link replaceNodeClaim}.
	 */
	getNodeClaimOwner?(nodeId: string): Promise<string | null>
	/**
	 * Atomically replace the owner of a node claim, only if it is still
	 * `expectedOwner` (compare-and-set, RT-21). Returns true when replaced. Used to
	 * confirm or re-issue an anonymous device's provisional claim; never creates one.
	 */
	replaceNodeClaim?(nodeId: string, expectedOwner: string, newOwner: string): Promise<boolean>
	/**
	 * The wrapped encryption key record (JSON) of one owner's keyring, or null (ENC-1).
	 * The record holds only salt, KDF parameters and wrapped keys: never a usable key.
	 * Optional for custom stores; without it the server answers key requests with
	 * `unsupported` (it never keeps key records in memory only, which would fork a
	 * user's keys after a restart).
	 */
	getEncryptionKeyRecord?(owner: string, keyring: string): Promise<string | null>
	/**
	 * Write a key record with compare-and-set: store `record` at `revision` only when the
	 * stored revision is `expectedRevision` (0: no record yet). Returns false when
	 * another write won. Must be atomic per (owner, keyring) across server instances.
	 */
	putEncryptionKeyRecord?(
		owner: string,
		keyring: string,
		record: string,
		revision: number,
		expectedRevision: number,
	): Promise<boolean>
	/**
	 * Stored key records: every one (for `exportBackup`; RT-104: a server restored from
	 * its backup must still hold the records its encrypted history needs), or one owner's
	 * (the key service tells another keyring's history from a lost record with it).
	 * Optional.
	 */
	listEncryptionKeyRecords?(owner?: string): Promise<EncryptionKeyRecordRow[]>
	/**
	 * Key ids named by stored encrypted operations (their envelope's `keyId`), a sample
	 * of at most `limit` distinct ids (RT-104). `nodeOwner` restricts it to operations of
	 * nodes claimed by that principal (see {@link claimNode}); null means every node (a
	 * server without authentication, whose clients share one keyring). The key service
	 * reports them when an owner has no key record, so a new device can tell a lost
	 * record (encrypted history exists) from a first one. Optional; without it a new
	 * device cannot tell, and a fork it creates is merged later by a device holding the
	 * old ring.
	 */
	getEncryptedKeyIds?(nodeOwner: string | null, limit: number): Promise<string[]>
	/**
	 * Record that `owner` holds the bytes behind a blob content hash (it pushed them,
	 * proving possession) (RT-11). Idempotent. Optional; without it the sync server
	 * keeps ownership in memory (lost on restart, not shared between instances).
	 */
	recordBlobOwner?(hash: string, owner: string): Promise<void>
	/** The owners recorded for each hash (an empty list for unowned hashes). */
	getBlobOwners?(hashes: string[]): Promise<Map<string, string[]>>
	/**
	 * Atomically make `owner` the first owner of a hash nobody owns yet. Returns true
	 * when `owner` owns the hash afterwards (newly, or already), false when someone
	 * else does. Must be atomic per hash across server instances.
	 */
	claimBlobIfUnowned?(hash: string, owner: string): Promise<boolean>
	/**
	 * The scope snapshots captured when the given operations were applied (RT-14).
	 * Operations without one are absent from the result.
	 */
	getOperationScopeSnapshots?(operationIds: string[]): Promise<Map<string, OperationScopeSnapshot>>
	/**
	 * The greatest HLC timestamp among every stored operation of one record (its
	 * newest field write), or null when the record has no operations (RT-19). A
	 * scope-entry operation is stamped with it so it never overrides newer client data.
	 */
	getRecordLatestTimestamp?(collection: string, recordId: string): Promise<HLCTimestamp | null>
	/**
	 * Per-field versions of one live record, folded from its stored operations exactly
	 * as the materialization folds its values (RT-27): each field's version is the HLC
	 * of the write that produced its current value, plus the record's first and newest
	 * operation. Null when the record is deleted or has no operations. A scope-entry
	 * operation carries them so a receiver resolves every field on its own.
	 */
	getRecordFieldVersions?(collection: string, recordId: string): Promise<RecordFieldVersions | null>
	/**
	 * The record's fold state (W7): the per-field CRDT state its row is projected from.
	 * Null when the record has no operations or its collection is not materialized. A
	 * scope-entry operation carries it (filtered to the fields the receiver may see) so
	 * the receiver merges richtext, counter and resolver fields exactly (RT-29).
	 */
	getRecordFoldState?(collection: string, recordId: string): Promise<FoldState | null>
	/** Every stored operation of one record, in delivery (commit) order. */
	getRecordOperations?(collection: string, recordId: string): Promise<Operation[]>
	/**
	 * Register the fields a download view of `collection` reads (its scope fields and
	 * query-subset fields), so the store keeps each record's live-view summary over them
	 * (see `live-views.ts`). Idempotent; the registered set only grows (up to
	 * `MAX_LIVE_VIEW_FIELDS`). Summaries of existing records are built in the background.
	 * Optional: without it every tombstoning operation is judged on its own values.
	 */
	registerLiveViewFields?(collection: string, fields: readonly string[]): Promise<void>
	/**
	 * The live-view summaries of records (absent: unknown), each with whether it
	 * includes the record's newest operation. One batched read.
	 */
	getRecordLiveViews?(
		collection: string,
		recordIds: readonly string[],
	): Promise<Map<string, RecordLiveViewsState>>
	/**
	 * Ask the background backfill to (re)build a record's summary and fill its
	 * snapshots' tombstone state: a session found it missing, stale or narrower than its
	 * view. Never blocks; bounded.
	 */
	requestLiveViewRebuild?(collection: string, recordId: string): void
	/**
	 * The delivery sequence at which the record's tombstone, as of just before stored
	 * operation `operationId`, began (see `tombstoneStartOf`), or null when it cannot be
	 * determined (the operation is not stored, or the record's history is longer than the
	 * replay bound). One bounded read of the record's newest operations; when their stored
	 * tombstone state cannot decide it, a bounded replay of the record's history (see
	 * `resolveTombstoneStart`).
	 */
	getTombstoneStart?(
		collection: string,
		recordId: string,
		operationId: string,
	): Promise<number | null>
	/** Resolves when the background backfill has nothing left to do (tests, tooling). */
	whenLiveViewsIdle?(): Promise<void>
	/**
	 * The membership intervals of a user (open and closed), from the index the store
	 * keeps in the same transaction as every operation on the memberships collection
	 * and the group collections (`access`). Empty when the schema declares no access.
	 */
	getMembershipIntervals?(userId: string): Promise<MembershipInterval[]>
	/**
	 * Access index state a delivery stream needs: the highest delivery sequence an index
	 * reconcile reserved (it writes no operation, so a stream may advance a client to it),
	 * every collection that has ever had access rules here, and the index generation
	 * (`null` until the index is first rebuilt from nothing by a backup restore).
	 */
	getAccessIndexState?(): Promise<AccessIndexState>
	/**
	 * False while the store is (re)building its membership index for an access schema
	 * (between `setSchema` or a replace-mode `importBackup` installing the schema or
	 * clearing the index, and the rebuild committing). Sessions refuse to serve or judge
	 * access collections meanwhile, retriably. Omitted: always ready.
	 */
	isAccessIndexReady?(): boolean
	/**
	 * The membership index generation as this store instance last saw it (synchronous:
	 * set by its own rebuilds and refreshed by every `getAccessIndexState()` read, which
	 * the sync server polls, so another instance's restore is seen within one poll).
	 * Sessions compare it with the generation they started under. Omitted: not compared.
	 */
	accessIndexGeneration?(): string | null
	/**
	 * Open intervals of memberships-collection records whose expiry is at or before
	 * `now`, oldest expiry first, at most `limit`. The access sweeper ends each one
	 * with a server write.
	 */
	getExpiredMembershipIntervals?(now: number, limit: number): Promise<MembershipInterval[]>
	/**
	 * The record's row as it would be after merging `op` into its fold state, with
	 * nothing written: the candidate a Tier-2 constraint check judges at ingest. Null
	 * when the record would not be live (deleted, or never inserted).
	 */
	previewOperation?(op: Operation): Promise<MaterializedRecord | null>
	/**
	 * Node ids whose operations win `merge('server-authoritative')` fields in the fold:
	 * this store's own node id (every server-originated operation is authored by it)
	 * plus any configured extras. The sync server advertises them in the handshake so
	 * clients fold with the same authority.
	 */
	getAuthoritativeNodeIds?(): string[]

	/** Explicit authoritative ids the deployment revoked (RT-81); advertised at handshake. */
	getRevokedAuthoritativeNodeIds?(): string[]

	/**
	 * Every explicit id the deployment ever held authoritative, revoked ones included
	 * (RT-81). The session never accepts one as a device node id.
	 */
	getEverAuthoritativeNodeIds?(): string[]
	/**
	 * Keyed id of a server-derived operation (cascade, set-null, constraint correction):
	 * deterministic across every instance of the deployment, unpredictable to clients
	 * (RT-64). Built-in stores key it with a persisted deployment secret. A store
	 * without it falls back to the unkeyed `deriveSideEffectOpId`.
	 */
	deriveServerOperationId?(
		parentOpId: string,
		ruleId: string,
		targetRecordId: string,
	): Promise<string>
	/** Close the store and release resources */
	close(): Promise<void>

	/** Get the total number of stored operations */
	getOperationCount(): Promise<number>

	/**
	 * The highest delivery sequence currently visible in the store (0 when empty).
	 * Used to initialize a fresh client's watermark baseline and for diagnostics.
	 */
	getMaxDeliverySequence(): Promise<number>

	/**
	 * Operations with `deliverySequence > afterDeliverySequence`, ordered ascending
	 * by delivery sequence, at most `limit` of them. This is the substrate for the
	 * gap-free server->client stream: the caller (a client session) applies its own
	 * scope filter and chains the results into batches, advancing the client's
	 * durable watermark as batches are acknowledged. Because delivery sequence is
	 * assigned in commit order, a lower sequence is always visible before any higher
	 * one, so this scan can never skip an operation that later appears below the
	 * cursor.
	 */
	getOperationsAfterDelivery(
		afterDeliverySequence: number,
		limit: number,
	): Promise<DeliveredOperation[]>

	/**
	 * Operations found in `sources` after `afterDeliverySequence`, through the delivery
	 * visibility index (C2): the substrate of a session whose scope sees a small part of
	 * the log. Optional; stores without the index omit it and callers use
	 * {@link getOperationsAfterDelivery}.
	 *
	 * The index only NARROWS the read: it returns a superset of what the session's
	 * `filterDeliveryChunk` acts on below `coveredThrough`, and the filter still judges
	 * every operation. See {@link DeliveryIndexRead} for the contract.
	 *
	 * @param sources - Partition keys, whole collections and nodes to read
	 * @param afterDeliverySequence - The cursor (exclusive)
	 * @param limit - Most operations to return
	 */
	getOperationsAfterDeliveryIn?(
		sources: DeliverySources,
		afterDeliverySequence: number,
		limit: number,
	): Promise<DeliveryIndexRead>

	/**
	 * Declare extra partition fields for the delivery visibility index (the
	 * `deliveryPartitions` option of `KoraSyncServer`). A change rebuilds the index.
	 */
	setDeliveryPartitions?(overrides: DeliveryPartitionOverrides): Promise<void>

	/**
	 * Index (a chunk of) the operations the delivery visibility index does not cover yet
	 * and advance its contiguous frontier. Resumable and idempotent.
	 *
	 * @param maxChunks - Most chunks to index (default: until complete)
	 * @param chunkSize - Operations per chunk (default `DELIVERY_PARTITION_BACKFILL_CHUNK`)
	 * @returns Operations indexed (0 when the index was complete)
	 */
	backfillDeliveryPartitions?(maxChunks?: number, chunkSize?: number): Promise<number>

	/**
	 * Index whatever lies above the contiguous frontier, in the background, when the log has
	 * moved past it: an older instance of a rolling deploy appends without index rows, so the
	 * frontier stops at its first such write until they are filled in. Called on every delivery
	 * poll, so it only reads the frontier when nothing is behind; sessions read the uncovered
	 * tail through the global scan meanwhile, which is correct and only slower.
	 *
	 * @param upToSequence - The highest delivery sequence the poll observed
	 */
	catchUpDeliveryIndex?(upToSequence: number): Promise<void>

	/**
	 * The partition plan this instance indexes under, or null before a schema is set. A
	 * session derives its read sources from it ({@link getOperationsAfterDeliveryIn}).
	 */
	getDeliveryPartitionPlan?(): DeliveryPartitionPlan | null

	/** Resolves when no index build or backfill is running (tests, shutdown). */
	whenDeliveryIndexIdle?(): Promise<void>

	/** State of the delivery visibility index. */
	getDeliveryPartitionState?(): Promise<DeliveryPartitionState>

	/**
	 * Conditionally apply a set of operations atomically, serialized across server
	 * instances on the target record. Optional: stores that can only run in a single
	 * process (or do not back a shared database) may omit it, and callers fall back
	 * to per-instance serialization. The Postgres store implements it with a
	 * transaction-scoped advisory lock so concurrent admissions cannot both pass a
	 * cap check (`applyConditional` returns `admitted: false` for the loser).
	 */
	applyConditional?(input: ConditionalApplyInput): Promise<ConditionalApplyResult>

	/**
	 * Run a read-decide-write transaction: `run` reads current state and returns the
	 * operations to commit, and the store commits all of them in one database
	 * transaction or none. No other operation write (sync upload, route write, another
	 * transaction, on any instance sharing the database) commits between the reads
	 * `run` makes and that commit. Optional: route transactions need it.
	 */
	transact?(run: StoreTransactionRun): Promise<StoreTransactionResult>

	/**
	 * Atomically reserve the next sequence number for a server-originated operation
	 * on this store's own node. Stores that serve conditional applies concurrently
	 * (the Postgres store, which does not serialize behind a single mutation tail)
	 * must implement this so two in-flight server operations cannot be handed the
	 * same sequence number, which would let one shadow the other during version-vector
	 * delta sync. Stores whose server writes are fully serialized may omit it, and
	 * callers fall back to reading the version vector.
	 */
	reserveSequenceNumber?(): number

	/**
	 * Set the schema for materialized collection tables.
	 * Creates collection tables and indexes based on the schema definition.
	 * If operations already exist in the store, backfills the materialized
	 * tables from the operation log.
	 *
	 * @param schema - The schema definition describing all collections
	 * @param options - `operationTransforms`: the schema transforms the store folds with
	 *   (transforms at fold time, RT-84). Pass the same list as the sync server's
	 *   `operationTransforms`, so the startup re-materialization folds with them once.
	 */
	setSchema(schema: SchemaDefinition, options?: ServerSchemaOptions): Promise<void>

	/** Schema used for materialized tables and server-side validation, if set. */
	getSchema(): SchemaDefinition | null

	/**
	 * Set the schema transforms the store folds with (RT-84). Operations are stored
	 * exactly as uploaded; the fold merges each operation as
	 * `operationSchemaView(op, schema.version, transforms)` reads it. Transforms are part
	 * of the fold plan fingerprint: a change re-folds every record (once). The sync
	 * server calls this with its `operationTransforms` at construction.
	 */
	setOperationTransforms?(transforms: readonly OperationTransform[]): Promise<void>

	/** The schema transforms the store folds with (empty when none). */
	getOperationTransforms?(): readonly OperationTransform[]

	/**
	 * Re-fold (a batch of) records another instance folded with another fold plan, when
	 * this instance runs the plan the database records: during a rolling deploy that
	 * changed transforms or merge rules, an instance on the previous plan may keep writing
	 * after the new plan re-folded everything. The sync server calls it on every delivery
	 * poll; it returns how many records it re-folded (0 almost always).
	 */
	refoldOutdatedRecords?(limit?: number): Promise<number>

	/**
	 * Get all records from a materialized collection.
	 * When schema is set, reads directly from the collection table (O(1) indexed).
	 * When schema is not set, falls back to replaying the operation log.
	 * Deleted records are excluded.
	 *
	 * @param collection - The collection name to query
	 * @returns Array of records with their current state
	 */
	materializeCollection(collection: string): Promise<MaterializedRecord[]>

	/**
	 * Query records from a materialized collection with filtering, ordering,
	 * and pagination. Requires schema to be set via setSchema().
	 *
	 * @param collection - The collection name to query
	 * @param options - Query options (where, orderBy, limit, offset)
	 * @returns Array of matching records
	 */
	queryCollection(
		collection: string,
		options?: CollectionQueryOptions,
	): Promise<MaterializedRecord[]>

	/**
	 * Find a single record by ID from a materialized collection.
	 * Requires schema to be set via setSchema().
	 *
	 * @param collection - The collection name
	 * @param id - The record ID
	 * @returns The record or null if not found (or deleted)
	 */
	findRecord(collection: string, id: string): Promise<MaterializedRecord | null>

	/**
	 * Count records in a materialized collection, optionally filtered.
	 * Requires schema to be set via setSchema().
	 *
	 * @param collection - The collection name
	 * @param where - Optional exact-match filters
	 * @returns Number of matching records
	 */
	countCollection(collection: string, where?: Record<string, unknown>): Promise<number>

	/**
	 * Export all data as a portable backup binary.
	 * Ships operations, version vector, and metadata in a self-describing format
	 * with SHA-256 checksum.
	 */
	exportBackup(): Promise<Uint8Array>

	/**
	 * Restore data from a portable backup binary.
	 * Operations are applied through applyRemoteOperation for safe merge.
	 *
	 * @param data - Backup binary
	 * @param merge - If true, merge with existing operations; if false, replace all
	 */
	importBackup(
		data: Uint8Array,
		merge?: boolean,
	): Promise<{ operationsRestored: number; success: boolean }>
}
