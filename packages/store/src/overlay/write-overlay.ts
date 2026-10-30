import type { FoldState, SchemaDefinition } from '@korajs/core'
import { deserializeFoldState, mismatchedFoldFields, quoteIdent } from '@korajs/core'
import type { LocalMutationContext } from '../mutations/types'
import type { WriteEnv } from '../mutations/write-context'
import type { WriteResult } from '../mutations/write-ops'
import type { PreparedInsert } from '../mutations/write-shapes'
import { deserializeRecord } from '../serialization/serializer'
import type { ObservedRead, TransactionWrite } from '../transaction/transaction-context'
import type { CollectionRecord, RawCollectionRow, StorageAdapter } from '../types'
import type { CommitInfo, GroupChange, PendingEntry, PendingWrites } from './pending-writes'
import {
	type MissReason,
	type PredictEnv,
	type PredictedChange,
	type PredictedWriteKind,
	type Prediction,
	divergentFields,
	isDeletePredictable,
	predictDelete,
	predictInsert,
	predictUpdate,
	sameValue,
	toReadShape,
	updateNeedsFoldState,
} from './predict'

/*
 * Prepare-once plumbing between the local write entry points (`execute-*.ts`) and the
 * overlay (instant-UI stage S2, docs/design/instant-ui-updates.md 4.1, 5.3a, 5.6).
 *
 * OFF BY DEFAULT and PER STORE (stage S4): a store built with `instantUpdates` owns an
 * {@link OverlayController}, whose {@link WriteOverlay} rides on the store's mutation
 * contexts (`LocalMutationContext.overlay`). A context without one (the default) is never
 * touched by anything here. The write path never reads the overlay (I1): the entry points
 * only report a write's outcome to it.
 */

/** Longest the base-record read for an update may take before the write is not predicted (5.6). */
export const BASE_READ_TIMEOUT_MS = 4

/** What a base-record read needs: the adapter to read through and the schema to shape the row. */
export interface OverlayReadEnv {
	readonly adapter: StorageAdapter
	readonly schema: SchemaDefinition
}

/** What predicting a transaction (an entry group) needs from the write environment. */
export type GroupEnv = PredictEnv & OverlayReadEnv & Pick<WriteEnv, 'assertLocalWriteAllowed'>

/** What the entry points need from an installed overlay. */
export interface WriteOverlay {
	readonly registry: PendingWrites
	/**
	 * True while the adapter refuses writes (the durability-lost state). Checked before a
	 * write is registered, never after (F2). Default: writes are accepted.
	 */
	readonly writesRefused?: () => boolean
	/**
	 * Read a record by id (the read the store itself would make). Default: a `SELECT` on
	 * the write's adapter. Tests pass a controllable one.
	 */
	readonly readRecord?: (
		ctx: OverlayReadEnv,
		collection: string,
		id: string,
	) => Promise<CollectionRecord | null>
	/**
	 * Read a record's stored fold state (an array write builds on it, S6b). Default: a
	 * `SELECT` on the write's adapter. Resolves null when there is none or it cannot be
	 * used. Tests pass a controllable one.
	 */
	readonly readFoldState?: (
		ctx: OverlayReadEnv,
		collection: string,
		id: string,
	) => Promise<FoldState | null>
	/** Wall clock for predicted timestamps; default `Date.now`. Injected by tests. */
	readonly wallClock?: () => number
	/** Longest base read, in ms; default {@link BASE_READ_TIMEOUT_MS}. */
	readonly baseReadTimeoutMs?: number
	/**
	 * True while prediction is switched off for a collection (the circuit breaker, I10).
	 * Checked before a write is registered; such a write runs as it does without the overlay.
	 */
	readonly isCollectionDisabled?: (collection: string) => boolean
	/**
	 * Called after a write was rolled back, with every entry the rollback removed (the
	 * write's own and the ones derived from it) and the error that failed the write.
	 */
	readonly onRolledBack?: (entries: readonly PendingEntry[], error: unknown) => void
}

/** Per-write options the entry points pass on (`{ durable: true }` skips prediction). */
export interface TrackOptions {
	readonly durable?: boolean
}

/**
 * Follows one predicted write from registration to its outcome. The entry points call
 * {@link WriteTracker.committed} from `runLocalWrite`'s post-commit hook and
 * {@link WriteTracker.failed} when the write rejects. Neither can throw.
 */
export interface WriteTracker {
	/** The transaction committed. */
	committed(results: readonly WriteResult[]): void
	/**
	 * The write failed. A no-op once the write has committed (a later barrier failure is
	 * not a rollback) or its outcome was left unknown (a commit that cannot be confirmed
	 * is never silently rolled back, F11).
	 */
	failed(error?: unknown): void
	/**
	 * The commit's answer was lost and the lookup could not decide: the entries stay shown
	 * as `unknown` until a later read decides (7).
	 *
	 * @param lookupOperationId - The content-addressed id that decides whether it landed
	 */
	unknown(lookupOperationId: string | null): void
}

/** Wall time to predict: at least now, and at least every timestamp this registry saw committed. */
function predictedWallTime(overlay: WriteOverlay): number {
	return Math.max((overlay.wallClock ?? Date.now)(), overlay.registry.wallTimeFloor())
}

/** Whether the write may be predicted at all, before looking at its values (5.2, F1, F2). */
function gateMiss(
	ctx: Pick<WriteEnv, 'assertLocalWriteAllowed'>,
	overlay: WriteOverlay,
	collection: string,
	options: TrackOptions | undefined,
): MissReason | null {
	if (options?.durable === true) return 'durable-option'
	try {
		ctx.assertLocalWriteAllowed?.()
	} catch {
		return 'write-gate'
	}
	if (overlay.writesRefused?.()) return 'writes-refused'
	if (overlay.isCollectionDisabled?.(collection)) return 'collection-disabled'
	return null
}

/** Whether a write this one was derived from (transitively) has not reported its outcome yet. */
function baseUnsettled(overlay: WriteOverlay, entry: PendingEntry): boolean {
	for (const id of entry.ancestors) {
		// A write derived from one that has since been rolled back was stored on the old record.
		if (overlay.registry.wasRolledBack(id)) return true
		if (overlay.registry.get(id)?.state === 'pending') return true
	}
	return false
}

/**
 * The fields on which a committed write differs from its prediction (5.3e).
 *
 * The prediction was made on a base (the pending chain, the row cache, a read). When the
 * base the transaction really read differs from it on a field the write sets
 * (`operation.previousData` against the predicted base), a remote write or another tab
 * changed that field in between and a value that depends on its base (an atomic op, a
 * counter, a max or min) legitimately differs. Those fields are then judged against a
 * prediction made again from the base the transaction read: that tests the predictor
 * (`prediction(real base) == committed fold`), not the race. A field that cannot be
 * predicted again (an array needs the fold state) is not judged. When the collection also
 * changed under the write (a remote apply, another tab), only the fields the write sets are
 * compared; otherwise the whole record is, as before.
 */
function divergenceOf(
	overlay: WriteOverlay,
	entry: PendingEntry,
	change: PredictedChange | undefined,
	result: WriteResult,
	committed: CollectionRecord,
): string[] {
	if (entry.kind !== 'update') {
		// A delete removes the record whatever a remote write changed in it meanwhile.
		const unsettled = baseUnsettled(overlay, entry)
		const concurrent =
			overlay.registry.foreignCount(entry.collection) !== entry.foreignAtAdd ||
			overlay.registry.foreignSince(entry)
		if (entry.kind === 'delete' && (unsettled || concurrent)) {
			overlay.registry.noteUnverified(unsettled ? 'unsettled-base' : 'concurrent-remote')
			return []
		}
		return divergentFields(entry.record, committed)
	}
	const written = Object.keys(entry.patch ?? {}).filter((field) => field !== 'updatedAt')
	const actual = result.operation?.previousData ?? null
	const moved =
		actual === null
			? []
			: written.filter((field) => !sameValue(entry.previous?.[field], actual[field]))
	// The write this one was derived from has not reported yet: it committed (its bookkeeping
	// is queued behind this one's) or it failed and its rollback is on the way. Either way the
	// stored record may not hold what the prediction built on, so only the fields this write
	// sets are judged.
	const unsettled = baseUnsettled(overlay, entry)
	const concurrent =
		overlay.registry.foreignCount(entry.collection) !== entry.foreignAtAdd ||
		overlay.registry.foreignSince(entry)
	const noisy = unsettled || concurrent
	if (noisy) overlay.registry.noteUnverified(unsettled ? 'unsettled-base' : 'concurrent-remote')
	const expected: Record<string, unknown> = { ...entry.record }
	const skipped = new Set<string>()
	// An array write is re-predicted whenever the commit reported the fold state it merged
	// into, not only when a value moved: which copy of an element is present is not in the
	// values, so two equal-looking bases can fold differently.
	const replayAlways = entry.foldState !== null && result.priorFoldState !== undefined
	if ((moved.length > 0 || replayAlways) && actual !== null) {
		const again = change?.replay?.(actual, result.priorFoldState ?? null)
		if (again?.predicted) Object.assign(expected, again.patch)
		else {
			for (const field of moved) skipped.add(field)
			if (skipped.size > 0) overlay.registry.noteUnverified('replay-declined')
		}
	}
	if (!noisy) {
		for (const field of skipped) expected[field] = committed[field]
		return divergentFields(expected as CollectionRecord, committed)
	}
	return written
		.filter((field) => !skipped.has(field) && !sameValue(expected[field], committed[field]))
		.sort()
}

function track(
	ctx: LocalMutationContext,
	overlay: WriteOverlay,
	changes: readonly PredictedChange[],
	dependsOn: string | null,
): WriteTracker | null {
	const [only] = changes
	const added =
		changes.length === 1 && only
			? overlay.registry.add(only, { dependsOn })
			: overlay.registry.addMany(changes)
	if (!added.ok) {
		// Refused (caps): the write runs unpredicted, so it is a miss as far as the records go.
		return guardMiss(
			overlay,
			only?.kind ?? 'insert',
			changes[0]?.collection ?? ctx.collection,
			changes.map((change) => change.recordId),
		)
	}
	const entries = 'entries' in added ? added.entries : [added.entry]
	const first = entries[0]
	if (!first) return null
	// Settled once, one way: committed, rolled back, or left unknown.
	let done = false
	return {
		committed(results) {
			if (done) return
			done = true
			try {
				const definition = ctx.schema.collections[first.collection]
				entries.forEach((entry, index) => {
					const result = results[index]
					// In the shape reads have, so it is comparable with the prediction and is a
					// valid base for the next update (an insert returns absent optionals, a
					// SELECT returns null).
					const record = result && definition ? toReadShape(definition, result.record) : undefined
					const operationIds = result
						? [
								...(result.operation ? [result.operation.id] : []),
								...result.sideEffects.map((operation) => operation.id),
							]
						: []
					// A delete reports the record as it stood, not a committed row.
					const committedRecord = entry.kind === 'delete' ? undefined : record
					const retired = overlay.registry.commit(entry.writeId, {
						...(committedRecord ? { record: committedRecord } : {}),
						operationIds,
					})
					// Verification at commit (5.3e): the prediction against what the write stored.
					if (retired && record && result) {
						overlay.registry.reportDivergence(
							entry,
							divergenceOf(overlay, entry, changes[index], result, record),
						)
					}
				})
			} catch (error) {
				console.error('[kora] overlay commit bookkeeping failed', error)
			}
		},
		failed(error) {
			if (done) return
			done = true
			try {
				const removed: PendingEntry[] = []
				for (const entry of entries) removed.push(...overlay.registry.rollback(entry.writeId))
				if (removed.length > 0) overlay.onRolledBack?.(removed, error)
			} catch (failure) {
				console.error('[kora] overlay rollback bookkeeping failed', failure)
			}
		},
		unknown(lookupOperationId) {
			if (done) return
			done = true
			try {
				for (const entry of entries) overlay.registry.markUnknown(entry.writeId, lookupOperationId)
			} catch (failure) {
				console.error('[kora] overlay unknown-outcome bookkeeping failed', failure)
			}
		},
	}
}

function noteMiss(
	overlay: WriteOverlay,
	kind: PredictedWriteKind,
	collection: string,
	recordIds: readonly string[],
	reason: MissReason,
): WriteTracker | null {
	overlay.registry.noteMiss(kind, collection, recordIds, reason)
	return guardMiss(overlay, kind, collection, recordIds)
}

/**
 * A write that is not predicted still changes records the registry may know: while it
 * runs, the registry must not derive a later write from what it knew before. Inserts
 * create new ids and need no guard (null: the write runs as it does with the overlay off).
 */
function guardMiss(
	overlay: WriteOverlay,
	kind: PredictedWriteKind,
	collection: string,
	recordIds: readonly string[],
): WriteTracker | null {
	if (kind === 'insert') return null
	const release = overlay.registry.holdUnpredicted(collection, recordIds)
	return { committed: release, failed: release, unknown: release }
}

/**
 * Predict an insert from the prepared insert the transaction will write (the SAME
 * object, I4) and register it. Synchronous: an insert needs no read.
 *
 * @returns A tracker, or null when the write is not predicted (it then runs as today)
 */
export function trackInsert(
	ctx: LocalMutationContext,
	overlay: WriteOverlay,
	prepared: PreparedInsert,
	options?: TrackOptions,
): WriteTracker | null {
	const gate = gateMiss(ctx, overlay, prepared.collection, options)
	if (gate) return noteMiss(overlay, 'insert', prepared.collection, [prepared.recordId], gate)
	const prediction = safely(() => predictInsert(ctx, prepared, predictedWallTime(overlay)))
	return register(ctx, overlay, prediction, 'insert', prepared.collection, prepared.recordId, null)
}

/**
 * Predict a bulk insert (one transaction, all or none) and register one entry per record,
 * together or not at all: a write over the record or byte caps, or with a record the
 * predictor declines, is not predicted (8). The entries share the write's fate.
 *
 * @param prepared - The objects `executeInsertMany` will write, in input order
 */
export function trackInsertMany(
	ctx: LocalMutationContext,
	overlay: WriteOverlay,
	prepared: readonly PreparedInsert[],
	options?: TrackOptions,
): WriteTracker | null {
	const first = prepared[0]
	if (!first) return null
	const ids = prepared.map((insert) => insert.recordId)
	const gate = gateMiss(ctx, overlay, first.collection, options)
	if (gate) return noteMiss(overlay, 'insert', first.collection, ids, gate)
	if (prepared.length > overlay.registry.limits.maxRecordsPerWrite) {
		return noteMiss(overlay, 'insert', first.collection, ids, 'records-cap')
	}
	const wallTime = predictedWallTime(overlay)
	const changes: PredictedChange[] = []
	for (const insert of prepared) {
		const prediction = safely(() => predictInsert(ctx, insert, wallTime))
		if (!prediction.predicted) {
			return noteMiss(overlay, 'insert', first.collection, ids, prediction.reason)
		}
		changes.push(prediction)
	}
	return track(ctx, overlay, changes, null)
}

/**
 * The outcome of the one read an update or delete may need for its base record (5.6).
 * Only produced when neither a pending write nor the committed-row cache knows the record.
 */
export type BaseRead =
	| { readonly status: 'skipped' }
	| {
			readonly status: 'read'
			readonly record: CollectionRecord | null
			/**
			 * The stored fold state, when one was asked for (S6b): null when there is none.
			 * `stateToken` is the registry's seed stamp taken before the read was issued.
			 */
			readonly foldState?: FoldState | null
			readonly stateToken?: number
	  }
	| { readonly status: 'timeout' }
	| { readonly status: 'error' }

/**
 * Read the record an update or delete needs as its base, but only when the registry does
 * not already know it. Returns synchronously (`skipped`) in the common case, so the
 * caller's registration and its `runLocalWrite` call stay in one synchronous step: the
 * registration order of overlapping writes is then the order of their transactions,
 * which is the order patches must be applied in. A read that takes longer than
 * {@link BASE_READ_TIMEOUT_MS} gives up (`timeout`) and the write is not predicted.
 */
export function readBaseIfNeeded(
	ctx: OverlayReadEnv,
	overlay: WriteOverlay,
	collection: string,
	id: string,
	needsState = false,
): BaseRead | Promise<BaseRead> {
	const needRecord = overlay.registry.baseFor(collection, id).found === 'none'
	// An unsettled write that carries no state ("unknown") cannot be helped by a read.
	const needState = needsState && overlay.registry.foldStateFor(collection, id).found === 'none'
	if (!needRecord && !needState) return { status: 'skipped' }
	return readBase(ctx, overlay, collection, id, needRecord, needState)
}

async function readBase(
	ctx: OverlayReadEnv,
	overlay: WriteOverlay,
	collection: string,
	id: string,
	wantRecord: boolean,
	wantState: boolean,
): Promise<BaseRead> {
	const read = overlay.readRecord ?? defaultReadRecord
	const readState = overlay.readFoldState ?? defaultReadFoldState
	const timeoutMs = overlay.baseReadTimeoutMs ?? BASE_READ_TIMEOUT_MS
	// Taken before the read is issued: any change the registry hears of before the result
	// arrives makes the state older than what it knows.
	const stateToken = overlay.registry.seedStamp(collection)
	let timer: ReturnType<typeof setTimeout> | undefined
	const timedOut = new Promise<'timeout'>((resolve) => {
		timer = setTimeout(() => resolve('timeout'), timeoutMs)
	})
	try {
		const outcome = await Promise.race([
			Promise.all([
				wantRecord ? read(ctx, collection, id) : Promise.resolve(null),
				wantState ? readState(ctx, collection, id) : Promise.resolve(null),
			]),
			timedOut,
		])
		if (outcome === 'timeout') return { status: 'timeout' }
		const [record, foldState] = outcome
		return {
			status: 'read',
			record,
			...(wantState ? { foldState, stateToken } : {}),
		}
	} catch {
		return { status: 'error' }
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}

type BaseResolution =
	| { miss: null; record: CollectionRecord; dependsOn: string | null }
	| { miss: MissReason }

/**
 * The record's current values for an update or delete (5.6): the newest pending write
 * (the chain), else the committed-row cache, else the read. Looked up again here, after
 * any read, so a write registered while the read was in flight wins over the read.
 */
function resolveBase(
	overlay: WriteOverlay,
	collection: string,
	id: string,
	read: BaseRead,
): BaseResolution {
	const known = overlay.registry.baseFor(collection, id)
	if (known.found === 'deleted') return { miss: 'no-base' }
	if (known.found === 'record') {
		const pending = overlay.registry.pendingFor(collection, id)
		return { miss: null, record: known.record, dependsOn: pending?.writeId ?? null }
	}
	if (read.status === 'timeout') return { miss: 'base-timeout' }
	if (read.status !== 'read' || read.record === null) return { miss: 'no-base' }
	overlay.registry.cacheRecord(collection, read.record)
	return { miss: null, record: read.record, dependsOn: null }
}

type StateResolution = { miss: null; state: FoldState } | { miss: MissReason }

/**
 * The record's fold state for an array write (S6b): the newest unsettled write of the
 * record carries it, else the committed state the read returned, if nothing the registry
 * heard of (a commit, a remote apply, a clear) happened since the read was issued.
 */
function resolveFoldState(
	overlay: WriteOverlay,
	collection: string,
	id: string,
	read: BaseRead,
): StateResolution {
	const known = overlay.registry.foldStateFor(collection, id)
	if (known.found === 'state') return { miss: null, state: known.state }
	if (known.found === 'unknown') return { miss: 'array-chain' }
	if (read.status === 'timeout') return { miss: 'base-timeout' }
	if (read.status !== 'read' || !read.foldState) return { miss: 'no-fold-state' }
	if (read.stateToken !== overlay.registry.seedStamp(collection))
		return { miss: 'fold-state-stale' }
	return { miss: null, state: read.foldState }
}

/**
 * Predict an update and register it, synchronously (the caller then starts the write in
 * the same step).
 *
 * @param read - Result of {@link readBaseIfNeeded}
 */
export function trackUpdate(
	ctx: LocalMutationContext,
	overlay: WriteOverlay,
	id: string,
	validated: Record<string, unknown>,
	read: BaseRead,
	options?: TrackOptions,
): WriteTracker | null {
	const collection = ctx.collection
	const gate = gateMiss(ctx, overlay, collection, options)
	if (gate) return noteMiss(overlay, 'update', collection, [id], gate)
	const base = resolveBase(overlay, collection, id, read)
	if (base.miss) return noteMiss(overlay, 'update', collection, [id], base.miss)
	let baseState: FoldState | null = null
	if (updateNeedsFoldState(ctx, collection, validated)) {
		const state = resolveFoldState(overlay, collection, id, read)
		if (state.miss) return noteMiss(overlay, 'update', collection, [id], state.miss)
		baseState = state.state
	}
	const prediction = safely(() =>
		predictUpdate(
			ctx,
			collection,
			id,
			validated,
			base.record,
			predictedWallTime(overlay),
			baseState,
		),
	)
	return register(ctx, overlay, prediction, 'update', collection, id, base.dependsOn)
}

/** Predict a delete (a tombstone) and register it, synchronously. */
export function trackDelete(
	ctx: LocalMutationContext,
	overlay: WriteOverlay,
	id: string,
	read: BaseRead,
	options?: TrackOptions,
): WriteTracker | null {
	const collection = ctx.collection
	const gate = gateMiss(ctx, overlay, collection, options)
	if (gate) return noteMiss(overlay, 'delete', collection, [id], gate)
	// Declined by the schema whatever the record holds: no base is needed (nor was one read).
	if (!isDeletePredictable(ctx.schema, collection)) {
		return noteMiss(overlay, 'delete', collection, [id], 'cascade-target')
	}
	const base = resolveBase(overlay, collection, id, read)
	if (base.miss) return noteMiss(overlay, 'delete', collection, [id], base.miss)
	const prediction = safely(() => predictDelete(ctx, collection, id, base.record))
	return register(ctx, overlay, prediction, 'delete', collection, id, base.dependsOn)
}

function register(
	ctx: LocalMutationContext,
	overlay: WriteOverlay,
	prediction: Prediction,
	kind: PredictedWriteKind,
	collection: string,
	recordId: string,
	dependsOn: string | null,
): WriteTracker | null {
	if (!prediction.predicted) {
		return noteMiss(overlay, kind, collection, [recordId], prediction.reason)
	}
	return track(ctx, overlay, [prediction], dependsOn)
}

function safely(predict: () => Prediction): Prediction {
	try {
		return predict()
	} catch {
		return { predicted: false, reason: 'predictor-error' }
	}
}

async function defaultReadRecord(
	ctx: OverlayReadEnv,
	collection: string,
	id: string,
): Promise<CollectionRecord | null> {
	const rows = await ctx.adapter.query<RawCollectionRow>(
		`SELECT * FROM ${quoteIdent(collection)} WHERE id = ? AND _deleted = 0`,
		[id],
	)
	const row = rows[0]
	const definition = ctx.schema.collections[collection]
	return row && definition ? deserializeRecord(row, definition.fields) : null
}

async function defaultReadFoldState(
	ctx: OverlayReadEnv,
	collection: string,
	id: string,
): Promise<FoldState | null> {
	const rows = await ctx.adapter.query<{ state: string }>(
		'SELECT state FROM _kora_fold_state WHERE collection = ? AND record_id = ?',
		[collection, id],
	)
	const raw = rows[0]?.state
	if (raw === undefined) return null
	try {
		const state = deserializeFoldState(raw)
		// A state folded under another plan is re-folded by the write path; it is not a base.
		return mismatchedFoldFields(state, ctx.schema).length > 0 ? null : state
	} catch {
		return null
	}
}

// --- transactions: one entry group (stage S6a, design "S6a design") ---

/** Key of a record in the maps keyed by collection and id (also the write-order key). */
export const recordKey = (collection: string, id: string): string => `${collection}\u0000${id}`

/** The record a buffered write targets. */
function targetOf(write: TransactionWrite): { collection: string; id: string } {
	return write.kind === 'insert'
		? { collection: write.collection, id: write.insert.recordId }
		: { collection: write.collection, id: write.id }
}

/** The records a transaction touches, for the write order; `all` when it deletes (cascades). */
export function groupOrderKeys(writes: readonly TransactionWrite[]): {
	keys: string[]
	all: boolean
} {
	return {
		keys: writes.map((write) => {
			const { collection, id } = targetOf(write)
			return recordKey(collection, id)
		}),
		all: writes.some((write) => write.kind === 'delete'),
	}
}

/** Base reads a group needs, by record key. A record absent from the map needs none. */
export type GroupBaseReads = ReadonlyMap<string, BaseRead>

/** Committed rows the transaction's callback read, by record key (see {@link ObservedRead}). */
export type ObservedReads = ReadonlyMap<string, ObservedRead>

/**
 * The committed row the callback read for a record, if it is still as fresh as everything
 * the registry knows: the registry's seed stamp for the collection (foreign changes, its own
 * commits, clears) is the one taken before the read was issued, the rule
 * `PendingWrites.seedFromRead` uses for subscription rows. Null when it is not usable.
 */
function observedBase(
	overlay: WriteOverlay,
	observed: ObservedReads,
	collection: string,
	id: string,
): CollectionRecord | null {
	const read = observed.get(recordKey(collection, id))
	if (!read || read.record === null || overlay.registry.isHeld(collection, id)) return null
	return read.token === overlay.registry.seedStamp(collection) ? read.record : null
}

/**
 * The records of a group some write of which needs the fold state (an array write). The
 * record's earlier writes then carry the state forward too, so a later array write builds on
 * it instead of declining.
 */
function recordsNeedingState(
	env: PredictEnv,
	writes: readonly TransactionWrite[],
): ReadonlySet<string> {
	const keys = new Set<string>()
	for (const write of writes) {
		if (write.kind !== 'update') continue
		const { collection, id } = targetOf(write)
		if (updateNeedsFoldState(env, collection, write.data)) keys.add(recordKey(collection, id))
	}
	return keys
}

/**
 * Step 2b of the group lifecycle: read the base record of every update or delete whose
 * record the group has not written earlier and the registry does not know, all in
 * parallel, each with the base-read budget. Synchronous (an empty map) when nothing needs
 * a read, which is the case for a transaction of inserts and for records a list showed.
 *
 * @param writes - The sealed transaction's writes, in buffer order
 */
export function readGroupBasesIfNeeded(
	env: OverlayReadEnv & PredictEnv,
	overlay: WriteOverlay,
	writes: readonly TransactionWrite[],
	observed: ObservedReads = new Map(),
): GroupBaseReads | Promise<GroupBaseReads> {
	const written = new Set<string>()
	const needed = new Map<string, { collection: string; id: string }>()
	const needsState = new Set<string>()
	const stateKeys = recordsNeedingState(env, writes)
	for (const write of writes) {
		const { collection, id } = targetOf(write)
		const key = recordKey(collection, id)
		// A delete the schema never predicts declines the group whatever the record holds.
		const neverPredicted = write.kind === 'delete' && !isDeletePredictable(env.schema, collection)
		if (write.kind !== 'insert' && !neverPredicted && !written.has(key) && !needed.has(key)) {
			// Only the record's first write reads: a later write of it derives from the
			// group's own prediction (and an array write after a plain one is a miss).
			const wantsState = write.kind === 'update' && stateKeys.has(key)
			const knowsRecord =
				overlay.registry.baseFor(collection, id).found !== 'none' ||
				observedBase(overlay, observed, collection, id) !== null
			const knowsState =
				!wantsState || overlay.registry.foldStateFor(collection, id).found !== 'none'
			if (!knowsRecord || !knowsState) {
				needed.set(key, { collection, id })
				if (wantsState) needsState.add(key)
			}
		}
		written.add(key)
	}
	if (needed.size === 0) return new Map()
	return Promise.all(
		[...needed].map(async ([key, { collection, id }]) => {
			const read = readBaseIfNeeded(env, overlay, collection, id, needsState.has(key))
			return [key, read instanceof Promise ? await read : read] as const
		}),
	).then((pairs) => new Map(pairs))
}

/**
 * Steps 2a, 2c and 2d of the group lifecycle: predict every write of a sealed transaction,
 * in buffer order, and register them as ONE entry group, all or nothing (T1). Synchronous,
 * so the caller starts the storage transaction in the same step.
 *
 * A write of a record the group already wrote derives from the group's own earlier
 * prediction; any other update or delete derives from the registry (and depends on its
 * pending entry, if any) or from the read of {@link readGroupBasesIfNeeded}. One declined
 * write, a gated collection, or a cap makes the whole group a miss: nothing is registered,
 * one miss is reported, and the records it updates or deletes are held until it settles.
 *
 * @param reads - Result of {@link readGroupBasesIfNeeded}
 * @param observed - Committed rows the callback read; one still fresh (its token matches)
 *   is the base of a record the registry does not know, so the group needs no read of it
 * @returns The group's tracker; null when nothing needs one (an unpredicted group of inserts)
 */
export function trackGroup(
	env: GroupEnv,
	overlay: WriteOverlay,
	writes: readonly TransactionWrite[],
	reads: GroupBaseReads,
	observed: ObservedReads = new Map(),
): WriteTracker | null {
	if (writes.length === 0) return null
	const collections = [...new Set(writes.map((write) => write.collection))]
	const recordIds = writes.map((write) => targetOf(write).id)
	const miss = (reason: MissReason): WriteTracker | null => {
		overlay.registry.noteGroupMiss(collections, recordIds, reason)
		return guardGroup(overlay, writes)
	}
	for (const collection of collections) {
		const gate = gateMiss(env, overlay, collection, undefined)
		if (gate) return miss(gate)
	}
	if (writes.length > overlay.registry.limits.maxRecordsPerWrite) return miss('records-cap')
	const wallTime = predictedWallTime(overlay)
	const stateKeys = recordsNeedingState(env, writes)
	// What the group itself has written so far: the base of its later writes of the record.
	const local = new Map<string, CollectionRecord | 'deleted'>()
	// The fold state after the group's own write of a record, when its prediction produced one.
	const localStates = new Map<string, FoldState>()
	const changes: GroupChange[] = []
	for (const write of writes) {
		const { collection, id } = targetOf(write)
		const key = recordKey(collection, id)
		let prediction: Prediction
		let dependsOn: string | null = null
		if (write.kind === 'delete' && !isDeletePredictable(env.schema, collection)) {
			return miss('cascade-target')
		}
		if (write.kind === 'insert') {
			const insert = write.insert
			prediction = safely(() => predictInsert(env, insert, wallTime))
		} else {
			const own = local.get(key)
			let base: CollectionRecord
			if (own === 'deleted') return miss('no-base')
			const seen =
				own === undefined && overlay.registry.baseFor(collection, id).found === 'none'
					? observedBase(overlay, observed, collection, id)
					: null
			if (own !== undefined) {
				base = own
			} else if (seen !== null) {
				// The callback's own read of the committed row, still fresh: no second read.
				overlay.registry.cacheRecord(collection, seen)
				base = seen
			} else {
				const resolved = resolveBase(
					overlay,
					collection,
					id,
					reads.get(key) ?? { status: 'skipped' },
				)
				if (resolved.miss) return miss(resolved.miss)
				base = resolved.record
				dependsOn = resolved.dependsOn
			}
			if (write.kind === 'update') {
				const data = write.data
				let baseState: FoldState | null = null
				if (stateKeys.has(key)) {
					if (own !== undefined) {
						// The group already wrote the record: build on its own prediction's state.
						baseState = localStates.get(key) ?? null
						if (baseState === null) return miss('array-chain')
					} else {
						const state = resolveFoldState(
							overlay,
							collection,
							id,
							reads.get(key) ?? { status: 'skipped' },
						)
						if (state.miss) return miss(state.miss)
						baseState = state.state
					}
				}
				prediction = safely(() =>
					predictUpdate(env, collection, id, data, base, wallTime, baseState),
				)
			} else {
				prediction = safely(() => predictDelete(env, collection, id, base))
			}
		}
		if (!prediction.predicted) return miss(prediction.reason)
		local.set(key, prediction.kind === 'delete' ? 'deleted' : prediction.record)
		if (prediction.foldState) localStates.set(key, prediction.foldState)
		else localStates.delete(key)
		changes.push({ change: prediction, dependsOn })
	}
	const added = overlay.registry.addGroup(changes)
	// Refused by a cap: the registry reported the miss; the group runs unpredicted.
	if (!added.ok) return guardGroup(overlay, writes)
	return groupTracker(
		env,
		overlay,
		added.groupId,
		added.entries,
		changes.map((one) => one.change),
	)
}

/** The tracker of a registered group: every outcome acts on the whole group (T2). */
function groupTracker(
	env: GroupEnv,
	overlay: WriteOverlay,
	groupId: string,
	entries: readonly PendingEntry[],
	changes: readonly PredictedChange[],
): WriteTracker {
	const first = entries[0]
	let done = false
	const rollBack = (error: unknown): void => {
		if (!first) return
		const removed = overlay.registry.rollback(first.writeId)
		if (removed.length > 0) overlay.onRolledBack?.(removed, error)
	}
	return {
		committed(results) {
			if (done) return
			done = true
			try {
				// One result per buffered write, in order: entry i is write i.
				const infos = new Map<string, CommitInfo>()
				const committedRecords = new Map<string, CollectionRecord>()
				entries.forEach((entry, index) => {
					const result = results[index]
					const definition = env.schema.collections[entry.collection]
					const record = result && definition ? toReadShape(definition, result.record) : undefined
					const operationIds = result
						? [
								...(result.operation ? [result.operation.id] : []),
								...result.sideEffects.map((operation) => operation.id),
							]
						: []
					// A delete reports the record as it stood, not a committed row.
					const committedRecord = entry.kind === 'delete' ? undefined : record
					infos.set(entry.writeId, {
						...(committedRecord ? { record: committedRecord } : {}),
						operationIds,
					})
					if (record) committedRecords.set(entry.writeId, record)
				})
				const retired = overlay.registry.commitGroup(groupId, infos)
				// Verification at commit (5.3e), per member, against what its own write stored.
				entries.forEach((entry, index) => {
					const record = committedRecords.get(entry.writeId)
					const result = results[index]
					if (record && result && retired.some((one) => one.writeId === entry.writeId)) {
						overlay.registry.reportDivergence(
							entry,
							divergenceOf(overlay, entry, changes[index], result, record),
						)
					}
				})
			} catch (error) {
				console.error('[kora] overlay transaction commit bookkeeping failed', error)
			}
		},
		failed(error) {
			if (done) return
			done = true
			try {
				rollBack(error)
			} catch (failure) {
				console.error('[kora] overlay transaction rollback bookkeeping failed', failure)
			}
		},
		unknown(lookupOperationId) {
			if (done) return
			done = true
			try {
				// Without a witness nothing can decide it later, and a transaction that wrote no
				// operation changed nothing: taking its prediction back is exact.
				if (lookupOperationId === null) {
					rollBack(
						new Error('The transaction wrote no operation and its commit was not confirmed.'),
					)
					return
				}
				if (first) overlay.registry.markUnknown(first.writeId, lookupOperationId)
			} catch (failure) {
				console.error('[kora] overlay transaction unknown-outcome bookkeeping failed', failure)
			}
		},
	}
}

/**
 * An unpredicted transaction still changes the records it updates and deletes: hold them
 * (one hold per collection) until it settles, as {@link guardMiss} does for a single
 * write. A transaction of inserts only needs no hold (null).
 */
function guardGroup(
	overlay: WriteOverlay,
	writes: readonly TransactionWrite[],
): WriteTracker | null {
	const byCollection = new Map<string, string[]>()
	for (const write of writes) {
		if (write.kind === 'insert') continue
		const ids = byCollection.get(write.collection) ?? []
		if (!ids.includes(write.id)) ids.push(write.id)
		byCollection.set(write.collection, ids)
	}
	if (byCollection.size === 0) return null
	const releases = [...byCollection].map(([collection, ids]) =>
		overlay.registry.holdUnpredicted(collection, ids),
	)
	const release = (): void => {
		for (const one of releases) one()
	}
	return { committed: release, failed: release, unknown: release }
}
