import { HybridLogicalClock, KoraError, quoteIdent } from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import { parseFieldVersions, serializeFieldVersions } from '../lww/field-versions'
import { serializeRowVersion } from '../lww/row-version'
import { buildInsertQuery } from '../query/sql-builder'
import { deserializeOperationWithCollection, serializeOperation } from '../serialization/serializer'
import { allocateNextSequenceInTransaction } from '../store/sequence-allocator'
import type { OperationRow, RawCollectionRow, StorageAdapter } from '../types'
import { rehashOperation } from './rehash-operation'
import { NODE_TOKEN_META_KEY } from './sync-state'

/**
 * Every operation id a rotation re-authored, and its new id (`_kora_reauthored_ops`).
 * Kept so (a) an operation rotated in a later transaction that names an earlier-rotated
 * one as a causal dep names its new id, and (b) a queue entry under an old id left by a
 * crash of an earlier release can be recognized as rewritten and dropped
 * ({@link dropRewrittenQueueEntries}).
 */
export const REAUTHORED_OPS_TABLE = '_kora_reauthored_ops'

const REAUTHORED_OPS_DDL = `CREATE TABLE IF NOT EXISTS ${REAUTHORED_OPS_TABLE} (
  old_id TEXT PRIMARY KEY NOT NULL,
  new_id TEXT NOT NULL,
  from_node TEXT NOT NULL,
  to_node TEXT NOT NULL
)`

/** Create the id map table (idempotent). */
export async function ensureReauthoredOpsTable(adapter: StorageAdapter): Promise<void> {
	await adapter.execute(REAUTHORED_OPS_DDL)
}

/**
 * Drop outbound-queue entries whose operation a rotation re-authored (the queue holds
 * the new id). A rotation rewrites the queue in its own transaction; this only cleans a
 * database an earlier release left between its two steps.
 */
export async function dropRewrittenQueueEntries(adapter: StorageAdapter): Promise<number> {
	await ensureReauthoredOpsTable(adapter)
	const rows = await adapter.query<{ n: number }>(
		`SELECT COUNT(*) AS n FROM _kora_sync_queue WHERE id IN (SELECT old_id FROM ${REAUTHORED_OPS_TABLE})`,
	)
	const n = Number(rows[0]?.n ?? 0)
	if (n > 0) {
		await adapter.execute(
			`DELETE FROM _kora_sync_queue WHERE id IN (SELECT old_id FROM ${REAUTHORED_OPS_TABLE})`,
		)
	}
	return n
}

/** Result of {@link rotateUnsyncedOperationsInLog}. */
export interface NodeRotationResult {
	/** The node id the device uses from now on. */
	nodeId: string
	/** The rewritten operations under the new node id, in their original causal order. */
	operations: Operation[]
	/** Maps each old operation id to its new content-addressed id. */
	idMapping: Record<string, string>
}

/**
 * Move a device's never-acknowledged operations to a fresh node id (RT-21).
 *
 * The server refused this device's node id (`NODE_ID_CLAIMED`: another device holds
 * it, typically because the node token issued at the first claim was lost). The
 * device keeps its data by re-authoring its unsynced operations under a new node id:
 * same type, record, data and HLC wall time / counter, but the new node id in both
 * `nodeId` and `timestamp.nodeId`, sequence numbers 1..n in the original order, and
 * recomputed content-addressed ids (causal deps among them remapped). This is safe
 * for the same reason a clock rebase is: unacknowledged operations were never
 * shared, so no replica holds their old ids.
 *
 * Materialized rows are re-stamped so per-field LWW keeps comparing against the
 * rewritten timestamps; the version vector gets the new node's sequence (MAX with the
 * stored value) and the old node's entry is never lowered (W6). Everything, the scan
 * of the rotated operations included, runs in one transaction.
 *
 * @param adapter - The store's adapter
 * @param schema - The store schema (collections to scan)
 * @param unsyncedOpIds - Ids of the old node's operations the server never acknowledged
 * @param oldNodeId - The refused node id
 * @param newNodeId - The fresh node id
 * @param options - `moveDatabaseNode: false` re-authors another local node's operations
 *   without moving the database's own node id or node token (default true). `append:
 *   true` re-authors them under a node that already has operations (the store's own):
 *   they take its next sequence numbers, allocated in this transaction like every local
 *   write's, and the rewrite is refused (`TIMESTAMP_TAKEN`, nothing written) when a
 *   rewritten timestamp equals one the node already used.
 */
export async function rotateUnsyncedOperationsInLog(
	adapter: StorageAdapter,
	schema: SchemaDefinition,
	unsyncedOpIds: string[],
	oldNodeId: string,
	newNodeId: string,
	options: { moveDatabaseNode?: boolean; append?: boolean } = {},
): Promise<NodeRotationResult> {
	const moveDatabaseNode = options.moveDatabaseNode !== false
	const append = options.append === true
	const rotateIds = new Set(unsyncedOpIds)
	const idMapping: Record<string, string> = {}
	const rewritten: Operation[] = []

	await ensureReauthoredOpsTable(adapter)
	// One transaction from the scan to the last write (W6): the rotated set is read in
	// the transaction that rewrites it, so nothing committed in between is missed. The
	// persisted outbound queue is rewritten in it too: a crash can never leave an old id
	// queued (counted pending forever) beside its re-authored copy.
	await adapter.transaction(async (tx) => {
		// Ids earlier rotations re-authored, so a dep on one names its new id.
		const earlier = new Map<string, string>()
		for (const row of await tx.query<{ old_id: string; new_id: string }>(
			`SELECT old_id, new_id FROM ${REAUTHORED_OPS_TABLE}`,
		)) {
			earlier.set(row.old_id, row.new_id)
		}
		const resolveEarlier = (id: string): string => {
			let current = id
			for (let hops = 0; hops < 16; hops++) {
				const next = earlier.get(current)
				if (next === undefined) return current
				current = next
			}
			return current
		}
		const rotated: Operation[] = []
		for (const collectionName of Object.keys(schema.collections)) {
			const rows = await tx.query<OperationRow>(
				`SELECT * FROM ${quoteIdent(`_kora_ops_${collectionName}`)} WHERE node_id = ?`,
				[oldNodeId],
			)
			for (const row of rows) {
				if (rotateIds.has(row.id)) {
					rotated.push(deserializeOperationWithCollection(row, collectionName))
				}
			}
		}
		// Original authoring order: sequence numbers are allocated in causal order.
		rotated.sort((a, b) => a.sequenceNumber - b.sequenceNumber)

		if (append && rotated.length > 0) {
			// The node's timestamps are a total order: a rewritten one must not equal one of
			// its own (possible only after the device clock went back).
			const taken = new Set(
				rotated.map((op) => HybridLogicalClock.serialize({ ...op.timestamp, nodeId: newNodeId })),
			)
			for (const collectionName of Object.keys(schema.collections)) {
				const rows = await tx.query<{ timestamp: string }>(
					`SELECT timestamp FROM ${quoteIdent(`_kora_ops_${collectionName}`)} WHERE node_id = ?`,
					[newNodeId],
				)
				for (const row of rows) {
					if (taken.has(row.timestamp)) {
						throw new KoraError(
							`A re-authored operation's timestamp is already used by node "${newNodeId}".`,
							'TIMESTAMP_TAKEN',
							{ nodeId: newNodeId, timestamp: row.timestamp },
						)
					}
				}
			}
		}

		for (let i = 0; i < rotated.length; i++) {
			const op = rotated[i]
			if (!op) continue
			const timestamp = { ...op.timestamp, nodeId: newNodeId }
			// Deps among the rotated set are remapped BEFORE hashing: a version-2 id covers
			// causalDeps, and sequence order is causal order, so every dep is already
			// mapped. A dep an earlier rotation re-authored (an earlier batch) names its new
			// id. Deps on acknowledged operations keep their ids.
			const causalDeps = op.causalDeps.map((dep) => idMapping[dep] ?? resolveEarlier(dep))
			const moved: Operation = {
				...op,
				nodeId: newNodeId,
				timestamp,
				sequenceNumber: append ? await allocateNextSequenceInTransaction(tx, newNodeId) : i + 1,
				causalDeps,
			}
			const id = await rehashOperation(moved)
			idMapping[op.id] = id
			rewritten.push({ ...moved, id })
		}

		for (let i = 0; i < rotated.length; i++) {
			const oldOp = rotated[i]
			const newOp = rewritten[i]
			if (!oldOp || !newOp) continue
			const opsTable = `_kora_ops_${oldOp.collection}`
			await tx.execute(`DELETE FROM ${quoteIdent(opsTable)} WHERE id = ?`, [oldOp.id])
			await tx.execute(
				`INSERT OR REPLACE INTO ${REAUTHORED_OPS_TABLE} (old_id, new_id, from_node, to_node) VALUES (?, ?, ?, ?)`,
				[oldOp.id, newOp.id, oldNodeId, newNodeId],
			)
			// A queued old id becomes its new copy in the same transaction.
			const queued = await tx.query<{ id: string }>(
				'SELECT id FROM _kora_sync_queue WHERE id = ?',
				[oldOp.id],
			)
			if (queued.length > 0) {
				await tx.execute('DELETE FROM _kora_sync_queue WHERE id = ?', [oldOp.id])
				await tx.execute('INSERT OR REPLACE INTO _kora_sync_queue (id, payload) VALUES (?, ?)', [
					newOp.id,
					JSON.stringify({ ...serializeOperation(newOp), _collection: newOp.collection }),
				])
			}
			const insert = buildInsertQuery(
				opsTable,
				serializeOperation(newOp) as unknown as Record<string, unknown>,
			)
			await tx.execute(insert.sql, insert.params)

			// Re-stamp the row and field versions this operation wrote (the version
			// string carries the node id), exactly like a clock rebase.
			const oldVersion = serializeRowVersion(oldOp.timestamp)
			const newVersion = serializeRowVersion(newOp.timestamp)
			await tx.execute(
				`UPDATE ${quoteIdent(oldOp.collection)} SET _version = ? WHERE id = ? AND _version = ?`,
				[newVersion, oldOp.recordId, oldVersion],
			)
			const rows = await tx.query<RawCollectionRow>(
				`SELECT _field_versions FROM ${quoteIdent(oldOp.collection)} WHERE id = ?`,
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
				await tx.execute(
					`UPDATE ${quoteIdent(oldOp.collection)} SET _field_versions = ? WHERE id = ?`,
					[serializeFieldVersions(fieldVersions), oldOp.recordId],
				)
			}
		}
		if (moveDatabaseNode) {
			await tx.execute("INSERT OR REPLACE INTO _kora_meta (key, value) VALUES ('node_id', ?)", [
				newNodeId,
			])
			// The node token belonged to the refused node id.
			await tx.execute('DELETE FROM _kora_meta WHERE key = ?', [NODE_TOKEN_META_KEY])
		}
		// The new node's counter covers the rewritten operations: MAX with the stored
		// value, in this transaction, like every sequence reservation (W6). Appended ones
		// reserved theirs one by one above.
		if (rewritten.length > 0 && !append) {
			await tx.execute(
				`INSERT INTO _kora_version_vector (node_id, sequence_number) VALUES (?, ?)
     ON CONFLICT(node_id) DO UPDATE SET sequence_number = MAX(sequence_number, excluded.sequence_number)`,
				[newNodeId, rewritten.length],
			)
		}
		// The old node's counter is left as it is, never lowered: a rotated operation
		// may have reached the server unacknowledged, and a writer still on the old id
		// (another tab) must not reuse its number for different content. The numbers the
		// rotated operations held become holes in the old node's log, which upload
		// tracking treats as resolved.
	})

	return { nodeId: newNodeId, operations: rewritten, idMapping }
}
