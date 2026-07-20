import { HybridLogicalClock, MAX_LOGICAL } from '@korajs/core'
import type { HLCTimestamp, Operation, OperationInput, SchemaDefinition } from '@korajs/core'
import { computeOperationId } from '@korajs/core/internal'
import { parseFieldVersions, serializeFieldVersions } from '../lww/field-versions'
import { serializeRowVersion } from '../lww/row-version'
import { buildInsertQuery } from '../query/sql-builder'
import { deserializeOperationWithCollection, serializeOperation } from '../serialization/serializer'
import type { OperationRow, RawCollectionRow, StorageAdapter } from '../types'

/**
 * Result of re-stamping unsynced operations after a clock correction.
 */
export interface ClockRebaseResult {
	/** The rewritten operations, in causal order (original HLC total order preserved). */
	operations: Operation[]
	/** Maps each old (pre-rebase) operation id to its new content-addressed id. */
	idMapping: Record<string, string>
	/** Number of operations that were re-stamped. */
	rebasedCount: number
	/** Highest timestamp assigned during the rebase, or null when nothing was rebased. */
	newMaxTimestamp: HLCTimestamp | null
}

/**
 * The serialized logical counter is zero-padded to 5 digits; a logical value
 * needing more digits would break the lexicographic ordering of the stored
 * timestamp / `_version` columns. Overflow spills into wallTime instead.
 * Derived from the clock's own cap so the two can never drift apart.
 */
const LOGICAL_COUNTER_LIMIT = MAX_LOGICAL + 1

function emptyResult(): ClockRebaseResult {
	return { operations: [], idMapping: {}, rebasedCount: 0, newMaxTimestamp: null }
}

/**
 * Re-stamp unsynced (never server-acknowledged) operations after a fast device
 * clock was corrected, so sync can resume immediately instead of waiting for
 * real time to catch up with the future timestamps.
 *
 * This is safe for exactly the same reason rewriting unpushed git commits is
 * safe: unacknowledged operations have never been shared, so no other replica
 * can hold a reference to their old ids or timestamps. Acknowledged operations
 * are immutable forever and are never touched here.
 *
 * The relative order of the rebased operations is preserved: they are sorted by
 * their original HLC total order and assigned consecutive logical counters on a
 * single new wall time, chosen to sort after every non-rebased operation in the
 * log (and after corrected "now").
 */
export async function rebaseUnsyncedOperationsInLog(
	adapter: StorageAdapter,
	schema: SchemaDefinition,
	unsyncedOpIds: string[],
	correctedNowMs: number,
): Promise<ClockRebaseResult> {
	if (unsyncedOpIds.length === 0) {
		return emptyResult()
	}
	const rebaseIds = new Set(unsyncedOpIds)

	// Read phase. A single full scan per collection serves two purposes at once:
	// locating the rebased rows and finding the max timestamp of everything else.
	// This avoids SQL IN-list size limits and keeps the logic trivially correct
	// (correctness over performance; the op log is compacted periodically anyway).
	const rebased: Operation[] = []
	// Serialized HLC strings sort lexicographically in the same order as
	// HybridLogicalClock.compare, so a plain string max is a timestamp max.
	let maxOtherSerializedTs: string | null = null

	for (const collectionName of Object.keys(schema.collections)) {
		const rows = await adapter.query<OperationRow>(`SELECT * FROM _kora_ops_${collectionName}`)
		for (const row of rows) {
			if (rebaseIds.has(row.id)) {
				rebased.push(deserializeOperationWithCollection(row, collectionName))
			} else if (maxOtherSerializedTs === null || row.timestamp > maxOtherSerializedTs) {
				maxOtherSerializedTs = row.timestamp
			}
		}
	}

	if (rebased.length === 0) {
		return emptyResult()
	}

	// The new wall time must sort after both corrected real time and every
	// operation that stays in the log, or the rebased ops could lose LWW
	// conflicts they previously won locally (silent data reordering).
	const maxOtherWallTime =
		maxOtherSerializedTs === null
			? Number.NEGATIVE_INFINITY
			: HybridLogicalClock.deserialize(maxOtherSerializedTs).wallTime
	const baseWallTime = Math.max(correctedNowMs, maxOtherWallTime + 1)

	// Preserve the ORIGINAL total order so causal relationships (dep before
	// dependent) survive the re-stamp.
	rebased.sort((a, b) => HybridLogicalClock.compare(a.timestamp, b.timestamp))

	const newTimestamps: HLCTimestamp[] = rebased.map((op, i) => ({
		// Spill into wallTime past the 5-digit logical serialization limit so the
		// serialized order stays correct even for enormous offline queues.
		wallTime: baseWallTime + Math.floor(i / LOGICAL_COUNTER_LIMIT),
		logical: i % LOGICAL_COUNTER_LIMIT,
		nodeId: op.nodeId,
	}))

	// Recompute content-addressed ids first: the hash covers only
	// {type, collection, recordId, data, timestamp, nodeId} (+ atomicOps when
	// present), NOT causalDeps, so ids can be derived before dep remapping.
	// The deserialized `data` has the embedded metadata keys (transactionId,
	// mutationName, atomicOps) already stripped, matching exactly what the
	// original creation path hashed.
	const idMapping: Record<string, string> = {}
	const newIds: string[] = []
	for (let i = 0; i < rebased.length; i++) {
		const op = rebased[i]
		const ts = newTimestamps[i]
		if (!op || !ts) {
			continue
		}
		const input: OperationInput = {
			nodeId: op.nodeId,
			type: op.type,
			collection: op.collection,
			recordId: op.recordId,
			data: op.data,
			previousData: op.previousData,
			sequenceNumber: op.sequenceNumber,
			causalDeps: op.causalDeps,
			schemaVersion: op.schemaVersion,
			...(op.atomicOps !== undefined ? { atomicOps: op.atomicOps } : {}),
		}
		const newId = await computeOperationId(input, HybridLogicalClock.serialize(ts))
		idMapping[op.id] = newId
		newIds.push(newId)
	}

	// Remap causal deps among the rebased set; deps on non-rebased (already
	// acknowledged or foreign) operations keep their original ids.
	const newOperations: Operation[] = []
	for (let i = 0; i < rebased.length; i++) {
		const op = rebased[i]
		const ts = newTimestamps[i]
		const newId = newIds[i]
		if (!op || !ts || newId === undefined) {
			continue
		}
		newOperations.push({
			...op,
			id: newId,
			timestamp: ts,
			causalDeps: op.causalDeps.map((dep) => idMapping[dep] ?? dep),
		})
	}

	// Write phase: one transaction so a crash can never leave the log with a
	// mix of old and new stamps (which would corrupt causal deps).
	await adapter.transaction(async (tx) => {
		for (let i = 0; i < rebased.length; i++) {
			const oldOp = rebased[i]
			const newOp = newOperations[i]
			if (!oldOp || !newOp) {
				continue
			}
			const opsTable = `_kora_ops_${oldOp.collection}`
			await tx.execute(`DELETE FROM ${opsTable} WHERE id = ?`, [oldOp.id])
			const opInsert = buildInsertQuery(
				opsTable,
				serializeOperation(newOp) as unknown as Record<string, unknown>,
			)
			await tx.execute(opInsert.sql, opInsert.params)

			// Only touch materialized rows whose current version stamp came from
			// this exact operation — a row last written by a different (newer,
			// non-rebased) op must keep its version, or LWW guards would lie.
			const oldVersion = serializeRowVersion(oldOp.timestamp)
			const newVersion = serializeRowVersion(newOp.timestamp)
			await tx.execute(
				`UPDATE ${oldOp.collection} SET _version = ?, _updated_at = ? WHERE id = ? AND _version = ?`,
				[newVersion, newOp.timestamp.wallTime, oldOp.recordId, oldVersion],
			)

			// Per-field versions stamped by this operation carry the same old (pre-
			// rebase) version string, so re-stamp them too — otherwise field-level
			// LWW would keep comparing against the uncorrected timestamp forever.
			const rows = await tx.query<RawCollectionRow>(
				`SELECT _field_versions FROM ${oldOp.collection} WHERE id = ?`,
				[oldOp.recordId],
			)
			const fieldVersions = parseFieldVersions(rows[0]?._field_versions)
			let changed = false
			for (const [field, version] of Object.entries(fieldVersions)) {
				if (version === oldVersion) {
					fieldVersions[field] = newVersion
					changed = true
				}
			}
			if (changed) {
				await tx.execute(`UPDATE ${oldOp.collection} SET _field_versions = ? WHERE id = ?`, [
					serializeFieldVersions(fieldVersions),
					oldOp.recordId,
				])
			}

			// The insert op also stamped `_created_at` (the developer-visible
			// `createdAt`). Replicas materialize it from the rebased op's corrected
			// wallTime, so the originating device must re-stamp its own row too or
			// `createdAt` diverges forever after a clock rebase. Match on the old
			// (pre-rebase) created time so only rows this op created are touched.
			if (oldOp.type === 'insert') {
				await tx.execute(
					`UPDATE ${oldOp.collection} SET _created_at = ? WHERE id = ? AND _created_at = ?`,
					[newOp.timestamp.wallTime, oldOp.recordId, oldOp.timestamp.wallTime],
				)
			}
		}
		// sequenceNumbers are intentionally unchanged, so `_kora_version_vector`
		// needs no update: the version vector tracks sequences, not timestamps.
	})

	const newMaxTimestamp = newTimestamps[newTimestamps.length - 1] ?? null

	return {
		operations: newOperations,
		idMapping,
		rebasedCount: newOperations.length,
		newMaxTimestamp,
	}
}
