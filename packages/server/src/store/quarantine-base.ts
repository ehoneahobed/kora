/**
 * Records with quarantined history (RT-70).
 *
 * The startup log-integrity scan (W8 step 0) moves unreadable operation rows to
 * `operations_quarantine`. A record that owned such a row has an incomplete log:
 * re-folding it from the remaining operations drops the quarantined operation's effect,
 * and the record itself when its insert was quarantined. Its materialized row (written
 * before the scan, when every operation was still readable) is the only complete view,
 * so the stores keep it as a snapshot base and fold the remaining and later operations
 * onto it, for exactly those records; every other record folds from its (complete) log.
 */
import { HybridLogicalClock, createSnapshotState, getFoldFieldVersions } from '@korajs/core'
import type { FoldState, HLCTimestamp, Operation, SchemaDefinition } from '@korajs/core'
import {
	REFOLD_REQUIRED,
	type ServerFoldOptions,
	mergeIntoFoldState,
	refoldRecord,
} from './record-fold'

/** A materialized row, as a snapshot base for {@link rebuildFromSnapshot}. */
export interface KeptRow {
	/** Field values (record form). */
	values: Record<string, unknown>
	/** `_created_at` (wall ms). */
	createdAt: number
	/** `_updated_at` (wall ms). */
	updatedAt: number
	/** `_deleted`. */
	deleted: boolean
}

/** What the log-integrity scan quarantined, by record. */
export interface QuarantineScope {
	/** Keys ({@link quarantineKey}) of every record owning a quarantined row. */
	records: Set<string>
	/** Collections where a quarantined row named no readable record: every record is affected. */
	collections: Set<string>
	/** A quarantined row named no readable collection: every record is affected. */
	all: boolean
	/** Newest readable HLC of the quarantined rows, per record key. */
	latest: Map<string, HLCTimestamp>
}

/** Key of a record in a {@link QuarantineScope}. */
export function quarantineKey(collection: string, recordId: string): string {
	return JSON.stringify([collection, recordId])
}

/** An empty scope (a clean log). */
export function emptyQuarantineScope(): QuarantineScope {
	return { records: new Set(), collections: new Set(), all: false, latest: new Map() }
}

/** True when the record owns (or may own) a quarantined operation. */
export function isQuarantineAffected(
	scope: QuarantineScope,
	collection: string,
	recordId: string,
): boolean {
	return (
		scope.all ||
		scope.collections.has(collection) ||
		scope.records.has(quarantineKey(collection, recordId))
	)
}

/**
 * Build the scope from the quarantine table's `row_json` values. A row whose
 * collection or record id is unreadable widens the scope (its collection, or all).
 */
export function buildQuarantineScope(rowJsons: Iterable<string>): QuarantineScope {
	const scope = emptyQuarantineScope()
	for (const json of rowJsons) {
		let row: Record<string, unknown>
		try {
			row = JSON.parse(json) as Record<string, unknown>
		} catch {
			scope.all = true
			continue
		}
		const collection = row.collection
		const recordId = row.record_id
		if (typeof collection !== 'string' || collection.length === 0) {
			scope.all = true
			continue
		}
		if (typeof recordId !== 'string' || recordId.length === 0) {
			scope.collections.add(collection)
			continue
		}
		const key = quarantineKey(collection, recordId)
		scope.records.add(key)
		const wall = Number(row.wall_time)
		const logical = Number(row.logical)
		if (Number.isSafeInteger(wall) && wall >= 0 && Number.isSafeInteger(logical) && logical >= 0) {
			const ts: HLCTimestamp = {
				wallTime: wall,
				logical,
				nodeId: typeof row.timestamp_node_id === 'string' ? row.timestamp_node_id : '',
			}
			const prior = scope.latest.get(key)
			if (!prior || HybridLogicalClock.compare(ts, prior) > 0) scope.latest.set(key, ts)
		}
	}
	return scope
}

/**
 * The fold state of a record whose log is incomplete: never re-folded from the
 * remaining operations alone. The base is the record's stored fold state when it can
 * take the remaining operations, else a snapshot of its kept row (`createSnapshotState`),
 * each field stamped at its newest known version (from the remaining log, and at least
 * the quarantined operations' newest readable HLC, since the row reflects them). The
 * remaining operations are merged onto the base (a no-op for those the row already
 * reflects). Lossy only as snapshots are: a late concurrent write older than a field's
 * version folds against the snapshot value (RT-68's caveat).
 *
 * @returns The state, or null when the record has no kept row, state or operations
 */
export function rebuildFromSnapshot(
	input: {
		collection: string
		recordId: string
		stored: FoldState | null
		row: KeptRow | null
		ops: readonly Operation[]
		quarantinedLatest?: HLCTimestamp | undefined
	},
	schema: SchemaDefinition,
	options: ServerFoldOptions,
): FoldState | null {
	if (input.stored) {
		const merged = mergeIntoFoldState(input.stored, input.ops, schema, options)
		if (merged !== REFOLD_REQUIRED && merged !== null) return merged
	}
	if (!input.row) return input.ops.length > 0 ? refoldRecord(input.ops, schema, options) : null
	const fromLog = input.ops.length > 0 ? refoldRecord(input.ops, schema, options) : null
	const versions = fromLog ? getFoldFieldVersions(fromLog) : null
	const floor = input.quarantinedLatest
	const atLeast = (ts: HLCTimestamp | undefined): HLCTimestamp | undefined => {
		if (!ts) return floor
		if (!floor) return ts
		return HybridLogicalClock.compare(ts, floor) >= 0 ? ts : floor
	}
	const rowWall = (wall: number): HLCTimestamp => ({ wallTime: wall, logical: 0, nodeId: '' })
	const latest =
		atLeast(versions?.latest) ?? rowWall(Math.max(input.row.updatedAt, input.row.createdAt))
	const fieldVersions: Record<string, HLCTimestamp> = {}
	for (const field of Object.keys(input.row.values)) {
		fieldVersions[field] = atLeast(versions?.fields[field]) ?? latest
	}
	const base = createSnapshotState(
		{
			collection: input.collection,
			recordId: input.recordId,
			values: input.row.values,
			fieldVersions,
			created: versions?.created ?? rowWall(input.row.createdAt),
			latest,
			deleted: input.row.deleted,
		},
		schema,
	)
	const merged = mergeIntoFoldState(base, input.ops, schema, options)
	return merged === REFOLD_REQUIRED || merged === null ? base : merged
}
