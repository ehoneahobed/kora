import { quoteIdent } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { deserializeOperationWithCollection } from '../serialization/serializer'
import { renumberOperationRow } from '../sync/rehash-operation'
import type { OperationRow, StorageAdapter, Transaction } from '../types'
import { allocateNextSequenceInTransaction } from './sequence-allocator'

/**
 * Audit table for operation rows whose `(node_id, sequence_number)` identity
 * collided with another operation (STORE-1 / STORE-2 duplicates written by
 * beta.12, or a conflicting remote operation). Rows here are never deleted.
 *
 * - `reemitted_as` set: the operation was given a fresh sequence number and still
 *   lives in the operation log under that number (`new_sequence_number`).
 * - `reemitted_as` NULL: the operation is kept ONLY here (another node's
 *   operation whose number this log already holds). It still takes part in
 *   dedup and in record folds, so no data is lost.
 */
export const SEQ_CONFLICTS_TABLE = '_kora_seq_conflicts'

const REPAIR_DONE_META_KEY = 'seq_unique_repair_v1'

/** DDL for {@link SEQ_CONFLICTS_TABLE}. */
const CREATE_SEQ_CONFLICTS_SQL = `CREATE TABLE IF NOT EXISTS ${SEQ_CONFLICTS_TABLE} (
  id TEXT PRIMARY KEY NOT NULL,
  collection TEXT NOT NULL,
  node_id TEXT NOT NULL,
  type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  data TEXT,
  previous_data TEXT,
  timestamp TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  causal_deps TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  reemitted_as TEXT,
  new_sequence_number INTEGER,
  recorded_at INTEGER NOT NULL
)`

/** Name of the unique `(node_id, sequence_number)` index on a collection's op log. */
export function uniqueSequenceIndexName(collection: string): string {
	return `uidx_kora_ops_${collection.length}_${collection}_node_seq`
}

/** Outcome of {@link repairSequenceUniqueness}. */
export interface SequenceRepairResult {
	/** Own-node operations that were given a fresh sequence number. */
	resequenced: number
	/** Other nodes' operations moved out of the log into the conflicts table. */
	retained: number
}

/**
 * Make `(node_id, sequence_number)` unique in the local operation log, then
 * enforce it with a UNIQUE index on every operation table (W6 step 2).
 *
 * beta.12 could give two different operations of this device the same sequence
 * number (STORE-1/2). A plain UNIQUE index cannot be created over such a log, and
 * dropping either row would lose a write. The repair, in one transaction:
 *
 * 1. Raises this node's persisted counter to at least the highest sequence number
 *    in its log (beta.12 could leave it behind, which would make the next write
 *    collide).
 * 2. For every duplicated `(node, seq)` — across all collections, since one node
 *    numbers all its operations in one sequence — keeps the first row by id.
 * 3. Every other row of THIS node is re-emitted with a fresh sequence number from
 *    the counter, keeping its id and content (see the note below), and recorded
 *    in {@link SEQ_CONFLICTS_TABLE}.
 * 4. Rows of OTHER nodes (this device cannot number them) move to
 *    {@link SEQ_CONFLICTS_TABLE} with `reemitted_as` NULL; the store keeps using
 *    them for dedup and record folds.
 * 5. Creates the UNIQUE index on every operation table.
 *
 * Why the re-emitted operation keeps its id: protocol v1 content-addresses
 * operations without the sequence number, and changing any hashed content (data
 * or HLC timestamp) would change what the write means under last-write-wins.
 * With the id kept, a server that already stored the operation deduplicates it
 * (acknowledging the new number), and a server that never got it — beta.12 could
 * skip the second of two same-numbered operations — stores it. Either way atomic
 * increments are never applied twice and no write is lost.
 *
 * Idempotent: the scan runs once per database (a meta flag records completion);
 * the index creation runs on every open so collections added later are covered.
 *
 * @param adapter - The store's adapter (already opened)
 * @param schema - The schema whose operation tables are repaired
 * @param nodeId - This device's node id
 */
export async function repairSequenceUniqueness(
	adapter: StorageAdapter,
	schema: SchemaDefinition,
	nodeId: string,
): Promise<SequenceRepairResult> {
	await adapter.execute(CREATE_SEQ_CONFLICTS_SQL)
	const collections = Object.keys(schema.collections)
	const result: SequenceRepairResult = { resequenced: 0, retained: 0 }

	const done = await adapter.query<{ value: string }>(
		'SELECT value FROM _kora_meta WHERE key = ?',
		[REPAIR_DONE_META_KEY],
	)
	if (done.length === 0 && collections.length > 0) {
		await runRepair(adapter, collections, nodeId, result)
	}

	for (const collection of collections) {
		const createIndex = `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(uniqueSequenceIndexName(collection))} ON ${quoteIdent(`_kora_ops_${collection}`)} (node_id, sequence_number)`
		try {
			await adapter.execute(createIndex)
		} catch (error) {
			// Duplicates written after an earlier repair (for example by an older
			// Kora version opening this database again): repair once more, then
			// create the index. A second failure propagates.
			if (!/UNIQUE/i.test(error instanceof Error ? error.message : String(error))) throw error
			await runRepair(adapter, collections, nodeId, result)
			await adapter.execute(createIndex)
		}
	}
	return result
}

async function runRepair(
	adapter: StorageAdapter,
	collections: string[],
	nodeId: string,
	result: SequenceRepairResult,
): Promise<void> {
	let resequenced = 0
	let retained = 0
	await adapter.transaction(async (tx) => {
		await raiseOwnCounterToLog(tx, collections, nodeId)
		const repaired = await repairDuplicates(tx, collections, nodeId)
		resequenced = repaired.resequenced
		retained = repaired.retained
		await tx.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
			REPAIR_DONE_META_KEY,
			String(Date.now()),
		])
	})
	result.resequenced += resequenced
	result.retained += retained
	if (resequenced > 0 || retained > 0) {
		console.warn(
			`[kora] Repaired ${resequenced + retained} operation(s) that shared a sequence number (written by an earlier Kora version). ${resequenced} were given fresh sequence numbers; ${retained} from other devices were kept in ${SEQ_CONFLICTS_TABLE}. No data was removed.`,
		)
	}
}

async function raiseOwnCounterToLog(
	tx: Transaction,
	collections: string[],
	nodeId: string,
): Promise<void> {
	let maxSeq = 0
	for (const collection of collections) {
		const rows = await tx.query<{ max_seq: number | null }>(
			`SELECT MAX(sequence_number) AS max_seq FROM ${quoteIdent(`_kora_ops_${collection}`)} WHERE node_id = ?`,
			[nodeId],
		)
		maxSeq = Math.max(maxSeq, rows[0]?.max_seq ?? 0)
	}
	if (maxSeq > 0) {
		await tx.execute(
			`INSERT INTO _kora_version_vector (node_id, sequence_number) VALUES (?, ?)
     ON CONFLICT(node_id) DO UPDATE SET sequence_number = MAX(sequence_number, excluded.sequence_number)`,
			[nodeId, maxSeq],
		)
	}
}

interface LoggedIdentity {
	collection: string
	id: string
	node_id: string
	sequence_number: number
}

async function repairDuplicates(
	tx: Transaction,
	collections: string[],
	nodeId: string,
): Promise<SequenceRepairResult> {
	// One node numbers all its operations in one sequence, so duplicates are
	// found across every collection's table, not per table.
	const all: LoggedIdentity[] = []
	for (const collection of collections) {
		const rows = await tx.query<Omit<LoggedIdentity, 'collection'>>(
			`SELECT id, node_id, sequence_number FROM ${quoteIdent(`_kora_ops_${collection}`)}`,
		)
		for (const row of rows) all.push({ collection, ...row })
	}
	const groups = new Map<string, LoggedIdentity[]>()
	for (const row of all) {
		const key = `${row.node_id}\u0000${row.sequence_number}`
		const group = groups.get(key)
		if (group) group.push(row)
		else groups.set(key, [row])
	}

	const losers: LoggedIdentity[] = []
	for (const group of groups.values()) {
		if (group.length < 2) continue
		// A version-2 operation (beta.14+) keeps its place: renumbering would re-hash it
		// under a new id, and if the server already stored it under the old id the new
		// copy would be stored as a second write (an atomic increment applied twice). A
		// version-1 loser keeps its id, which the server deduplicates (RT-31). Ties by id.
		const version2 = new Set<string>()
		for (const member of group) {
			if (await isVersion2Row(tx, member)) version2.add(member.id)
		}
		group.sort((a, b) => {
			const va = version2.has(a.id) ? 0 : 1
			const vb = version2.has(b.id) ? 0 : 1
			if (va !== vb) return va - vb
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
		})
		losers.push(...group.slice(1))
	}
	// Re-emit in original order so the new numbers keep the authoring order.
	losers.sort((a, b) =>
		a.sequence_number !== b.sequence_number
			? a.sequence_number - b.sequence_number
			: a.id < b.id
				? -1
				: a.id > b.id
					? 1
					: 0,
	)

	const result: SequenceRepairResult = { resequenced: 0, retained: 0 }
	const now = Date.now()
	for (const loser of losers) {
		const table = quoteIdent(`_kora_ops_${loser.collection}`)
		const rows = await tx.query<OperationRow>(`SELECT * FROM ${table} WHERE id = ?`, [loser.id])
		const row = rows[0]
		if (!row) continue
		if (loser.node_id === nodeId) {
			const newSeq = await allocateNextSequenceInTransaction(tx, nodeId)
			const moved = await renumberOperationRow(tx, loser.collection, row, newSeq)
			await insertConflictRow(
				tx,
				loser.collection,
				row,
				'duplicate-sequence',
				moved.id,
				newSeq,
				now,
			)
			result.resequenced++
		} else {
			await insertConflictRow(tx, loser.collection, row, 'duplicate-sequence', null, null, now)
			await tx.execute(`DELETE FROM ${table} WHERE id = ?`, [loser.id])
			result.retained++
		}
	}
	return result
}

/** Whether a logged operation declares content-hash version 2. */
async function isVersion2Row(tx: Transaction, identity: LoggedIdentity): Promise<boolean> {
	const rows = await tx.query<OperationRow>(
		`SELECT * FROM ${quoteIdent(`_kora_ops_${identity.collection}`)} WHERE id = ?`,
		[identity.id],
	)
	const row = rows[0]
	if (!row) return false
	return deserializeOperationWithCollection(row, identity.collection).hashVersion === 2
}

/**
 * Record an operation row in {@link SEQ_CONFLICTS_TABLE}.
 *
 * @param reemittedAs - Id of the operation that carries it in the log, or null
 *   when the row is kept only in the conflicts table
 * @param newSequenceNumber - The sequence number it was re-emitted under
 */
export async function insertConflictRow(
	tx: Transaction,
	collection: string,
	row: OperationRow,
	reason: string,
	reemittedAs: string | null,
	newSequenceNumber: number | null,
	recordedAt: number,
): Promise<void> {
	await tx.execute(
		`INSERT OR IGNORE INTO ${SEQ_CONFLICTS_TABLE} (id, collection, node_id, type, record_id, data, previous_data, timestamp, sequence_number, causal_deps, schema_version, reason, reemitted_as, new_sequence_number, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			row.id,
			collection,
			row.node_id,
			row.type,
			row.record_id,
			row.data,
			row.previous_data,
			row.timestamp,
			row.sequence_number,
			row.causal_deps,
			row.schema_version,
			reason,
			reemittedAs,
			newSequenceNumber,
			recordedAt,
		],
	)
}

/**
 * Operation rows kept only in the conflicts table for a record (other nodes'
 * operations whose sequence number collided). Record folds include them.
 */
export async function loadRetainedConflictRows(
	query: <T>(sql: string, params?: unknown[]) => Promise<T[]>,
	collection: string,
	recordId: string,
	types?: readonly string[],
): Promise<OperationRow[]> {
	const typeFilter =
		types && types.length > 0 ? ` AND type IN (${types.map(() => '?').join(', ')})` : ''
	return query<OperationRow>(
		`SELECT id, node_id, type, record_id, data, previous_data, timestamp, sequence_number, causal_deps, schema_version FROM ${SEQ_CONFLICTS_TABLE} WHERE collection = ? AND record_id = ? AND reemitted_as IS NULL${typeFilter}`,
		[collection, recordId, ...(types ?? [])],
	)
}

/** Whether an operation id is already recorded (log or retained conflict). */
export async function isOperationLogged(
	tx: Transaction,
	collection: string,
	opId: string,
): Promise<boolean> {
	const inLog = await tx.query<{ id: string }>(
		`SELECT id FROM ${quoteIdent(`_kora_ops_${collection}`)} WHERE id = ?`,
		[opId],
	)
	if (inLog.length > 0) return true
	const retained = await tx.query<{ id: string }>(
		`SELECT id FROM ${SEQ_CONFLICTS_TABLE} WHERE id = ? AND reemitted_as IS NULL`,
		[opId],
	)
	return retained.length > 0
}
