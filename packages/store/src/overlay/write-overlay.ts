import { quoteIdent } from '@korajs/core'
import type { LocalMutationContext } from '../mutations/types'
import type { WriteResult } from '../mutations/write-ops'
import type { PreparedInsert } from '../mutations/write-shapes'
import { deserializeRecord } from '../serialization/serializer'
import type { CollectionRecord, RawCollectionRow } from '../types'
import type { PendingEntry, PendingWrites } from './pending-writes'
import {
	type MissReason,
	type PredictedChange,
	type PredictedWriteKind,
	type Prediction,
	divergentFields,
	predictDelete,
	predictInsert,
	predictUpdate,
	toReadShape,
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
		ctx: LocalMutationContext,
		collection: string,
		id: string,
	) => Promise<CollectionRecord | null>
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
	ctx: LocalMutationContext,
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
					if (retired && record) {
						overlay.registry.reportDivergence(entry, divergentFields(entry.record, record))
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
	| { readonly status: 'read'; readonly record: CollectionRecord | null }
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
	ctx: LocalMutationContext,
	overlay: WriteOverlay,
	collection: string,
	id: string,
): BaseRead | Promise<BaseRead> {
	if (overlay.registry.baseFor(collection, id).found !== 'none') return { status: 'skipped' }
	return readBase(ctx, overlay, collection, id)
}

async function readBase(
	ctx: LocalMutationContext,
	overlay: WriteOverlay,
	collection: string,
	id: string,
): Promise<BaseRead> {
	const read = overlay.readRecord ?? defaultReadRecord
	const timeoutMs = overlay.baseReadTimeoutMs ?? BASE_READ_TIMEOUT_MS
	let timer: ReturnType<typeof setTimeout> | undefined
	const timedOut = new Promise<'timeout'>((resolve) => {
		timer = setTimeout(() => resolve('timeout'), timeoutMs)
	})
	try {
		const outcome = await Promise.race([read(ctx, collection, id), timedOut])
		if (outcome === 'timeout') return { status: 'timeout' }
		return { status: 'read', record: outcome }
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
	const prediction = safely(() =>
		predictUpdate(ctx, collection, id, validated, base.record, predictedWallTime(overlay)),
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
	ctx: LocalMutationContext,
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
