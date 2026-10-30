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
 * OFF BY DEFAULT: nothing here runs unless {@link installWriteOverlay} was called, which
 * only tests and benchmarks do. Until stage S4 wires the flag into `createApp`, an
 * installed overlay predicts and keeps its registry honest but changes nothing a
 * subscriber, a binding or the database can see: no subscription reads the registry yet
 * (S3), and the write path never does (I1).
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
}

let installed: WriteOverlay | null = null

/** Install (or with null, remove) the process-wide overlay. Internal; off by default. */
export function installWriteOverlay(overlay: WriteOverlay | null): void {
	installed = overlay
}

/** The installed overlay, or null (the normal case). */
export function activeWriteOverlay(): WriteOverlay | null {
	return installed
}

/**
 * Follows one predicted write from registration to its outcome. The entry points call
 * {@link WriteTracker.committed} from `runLocalWrite`'s post-commit hook and
 * {@link WriteTracker.failed} when the write rejects. Neither can throw.
 */
export interface WriteTracker {
	readonly entry: PendingEntry
	/** The transaction committed. */
	committed(results: readonly WriteResult[]): void
	/** The write failed. A no-op once the write has committed (a later barrier failure is not a rollback). */
	failed(): void
}

/** Wall time to predict: at least now, and at least every timestamp this registry saw committed. */
function predictedWallTime(overlay: WriteOverlay): number {
	return Math.max((overlay.wallClock ?? Date.now)(), overlay.registry.wallTimeFloor())
}

/** Whether the write may be predicted at all, before looking at its values (5.2, F1, F2). */
function gateMiss(ctx: LocalMutationContext, overlay: WriteOverlay): MissReason | null {
	try {
		ctx.assertLocalWriteAllowed?.()
	} catch {
		return 'write-gate'
	}
	if (overlay.writesRefused?.()) return 'writes-refused'
	return null
}

function track(
	ctx: LocalMutationContext,
	overlay: WriteOverlay,
	change: PredictedChange,
	dependsOn: string | null,
): WriteTracker | null {
	const added = overlay.registry.add(change, { dependsOn })
	if (!added.ok) return null
	const entry = added.entry
	let done = false
	return {
		entry,
		committed(results) {
			if (done) return
			done = true
			try {
				const first = results[0]
				const definition = ctx.schema.collections[entry.collection]
				// In the shape reads have, so it is comparable with the prediction and is a
				// valid base for the next update (an insert returns absent optionals, a
				// SELECT returns null).
				const record = first && definition ? toReadShape(definition, first.record) : undefined
				const operationIds = results.flatMap((one) => [
					...(one.operation ? [one.operation.id] : []),
					...one.sideEffects.map((operation) => operation.id),
				])
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
			} catch (error) {
				console.error('[kora] overlay commit bookkeeping failed', error)
			}
		},
		failed() {
			if (done) return
			done = true
			try {
				overlay.registry.rollback(entry.writeId)
			} catch (error) {
				console.error('[kora] overlay rollback bookkeeping failed', error)
			}
		},
	}
}

function noteMiss(
	overlay: WriteOverlay,
	kind: PredictedWriteKind,
	collection: string,
	recordId: string,
	reason: MissReason,
): null {
	overlay.registry.noteMiss(kind, collection, [recordId], reason)
	return null
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
): WriteTracker | null {
	const gate = gateMiss(ctx, overlay)
	if (gate) return noteMiss(overlay, 'insert', prepared.collection, prepared.recordId, gate)
	const prediction = safely(() => predictInsert(ctx, prepared, predictedWallTime(overlay)))
	return register(ctx, overlay, prediction, 'insert', prepared.collection, prepared.recordId, null)
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
): WriteTracker | null {
	const collection = ctx.collection
	const gate = gateMiss(ctx, overlay)
	if (gate) return noteMiss(overlay, 'update', collection, id, gate)
	const base = resolveBase(overlay, collection, id, read)
	if (base.miss) return noteMiss(overlay, 'update', collection, id, base.miss)
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
): WriteTracker | null {
	const collection = ctx.collection
	const gate = gateMiss(ctx, overlay)
	if (gate) return noteMiss(overlay, 'delete', collection, id, gate)
	const base = resolveBase(overlay, collection, id, read)
	if (base.miss) return noteMiss(overlay, 'delete', collection, id, base.miss)
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
	if (!prediction.predicted) return noteMiss(overlay, kind, collection, recordId, prediction.reason)
	return track(ctx, overlay, prediction, dependsOn)
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
