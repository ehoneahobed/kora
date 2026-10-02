import { HybridLogicalClock, quoteIdent } from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import { FOLD_BASE_TABLE, FOLD_STATE_TABLE } from '../fold/record-folder'
import { deserializeOperationWithCollection, serializeOperation } from '../serialization/serializer'
import { SEQ_CONFLICTS_TABLE, insertConflictRow } from '../store/sequence-repair'
import {
	type LocalNodeRecord,
	TERMINAL_REJECTIONS_TABLE,
	ensureLocalSyncRecordTables,
} from '../sync/local-sync-records'
import { loadOwnAckedThrough } from '../sync/sync-durability'
import {
	DELIVERY_WATERMARK_META_KEY,
	DELTA_CURSOR_META_KEY,
	loadLastAckedServerVector,
} from '../sync/sync-state'
import type { ApplyResult, OperationRow, StorageAdapter, Transaction } from '../types'
import type { ParsedBackup } from './backup'

/** What a restore needs from the store it restores into. */
export interface RestoreHost {
	readonly adapter: StorageAdapter
	readonly schema: SchemaDefinition
	/** The normal remote-apply path (sync's): dedup by id, per-field merge, version vector. */
	applyOperation(operation: Operation): Promise<ApplyResult>
	/** This database's own nodes (RT-38/40), never taken from a backup. */
	listLocalNodes(): Promise<LocalNodeRecord[]>
}

/** Outcome counts of a restore. */
export interface RestoreCounts {
	operationsRestored: number
	recordsRestored: number
	unsyncedWritesKept: number
}

/**
 * Merge a backup into the database (STORE-5): every operation goes through the normal
 * remote-apply path in HLC (causal) order, the version vector advances by MAX, the
 * terminal-rejection markers are added. Never imported: the node id, node tokens, local
 * node registry and principal bindings, sync watermarks, acknowledged prefixes.
 */
export async function restoreMerge(
	host: RestoreHost,
	backup: ParsedBackup,
	filtered: boolean,
): Promise<RestoreCounts> {
	await importTerminalRejections(host.adapter, backup)
	let restored = 0
	for (const operation of backup.operations) {
		if (!host.schema.collections[operation.collection]) continue
		if ((await host.applyOperation(operation)) === 'applied') restored++
	}
	if (!filtered && backup.versionVector.size > 0) {
		// With a collection filter the vector would claim other collections' operations.
		await host.adapter.transaction(async (tx) => {
			for (const [nodeId, sequence] of backup.versionVector) {
				await maxVector(tx, nodeId, sequence)
			}
		})
	}
	return { operationsRestored: restored, recordsRestored: 0, unsyncedWritesKept: 0 }
}

/**
 * Replace the database's data with a backup's (STORE-5), keeping this device's
 * identity:
 *
 * - The node id, node tokens, local node registry, principal bindings and acknowledged
 *   prefixes are untouched; the exporting device's are never imported.
 * - This database's own nodes never move their sequence counters backwards (numbers the
 *   server may hold are never reused). A node the server never accepted, whose unsynced
 *   writes are not kept, restarts after its highest restored number (its numbers never
 *   left the device), so its log stays contiguous.
 * - Unacknowledged writes of an accepted node, and with `keepUnsyncedWrites` every
 *   unsynced own write, are re-applied on top of the restored data.
 * - Delivery watermarks restart at 0 and the delta cursor is dropped, so the sync server
 *   re-sends everything in scope (deduplicated by id).
 * - Rows, operations, version vector and sync bookkeeping change in one transaction;
 *   re-applied writes (and a backup without records, materialized through the
 *   remote-apply path) follow it.
 */
export async function restoreReplace(
	host: RestoreHost,
	backup: ParsedBackup,
	options: { collections: string[] | null; keepUnsyncedWrites: boolean },
): Promise<RestoreCounts> {
	const { adapter, schema } = host
	const targets = Object.keys(schema.collections).filter(
		(name) => !options.collections || options.collections.includes(name),
	)
	const rawRecords = backup.manifest.includesRecords
	const localNodes = await host.listLocalNodes()
	const localIds = new Set(localNodes.map((node) => node.nodeId))
	const acked = await loadAckedThrough(adapter, localNodes)

	// Writes that exist only on this device: re-applied after the replace.
	const kept: Operation[] = []
	const dropped = new Set<string>()
	for (const node of localNodes) {
		const keep = node.accepted || options.keepUnsyncedWrites
		const floor = acked.get(node.nodeId) ?? 0
		for (const collection of targets) {
			const rows = await adapter.query<OperationRow>(
				`SELECT * FROM ${quoteIdent(`_kora_ops_${collection}`)} WHERE node_id = ? AND sequence_number > ?`,
				[node.nodeId, floor],
			)
			for (const row of rows) {
				if (keep) kept.push(deserializeOperationWithCollection(row, collection))
				else dropped.add(node.nodeId)
			}
		}
	}
	kept.sort((a, b) => HybridLogicalClock.compare(a.timestamp, b.timestamp))
	// Counters that may restart: nodes the server never accepted whose writes are dropped.
	const restartable = new Set(
		localNodes
			.filter((node) => !node.accepted && !options.keepUnsyncedWrites)
			.map((node) => node.nodeId),
	)

	await ensureLocalSyncRecordTables(adapter)
	let recordsRestored = 0
	const hasConflicts = await tableExists(adapter, SEQ_CONFLICTS_TABLE)
	await adapter.transaction(async (tx) => {
		for (const collection of targets) {
			await tx.execute(`DELETE FROM ${quoteIdent(`_kora_ops_${collection}`)}`)
			await tx.execute(`DELETE FROM ${quoteIdent(collection)}`)
			await tx.execute('DELETE FROM _kora_scope_retractions WHERE collection = ?', [collection])
			// W7: the records' fold states go with their rows and log; the store
			// re-materializes the restored collections afterwards.
			await tx.execute(`DELETE FROM ${FOLD_STATE_TABLE} WHERE collection = ?`, [collection])
			await tx.execute(`DELETE FROM ${FOLD_BASE_TABLE} WHERE collection = ?`, [collection])
			if (hasConflicts) {
				await tx.execute(
					`DELETE FROM ${SEQ_CONFLICTS_TABLE} WHERE collection = ? AND reemitted_as IS NULL`,
					[collection],
				)
			}
		}

		// Version vector. Without a collection filter, remote nodes take the backup's
		// values; this database's own nodes never go backwards. With a filter, MAX only.
		const current = await tx.query<{ node_id: string; sequence_number: number }>(
			'SELECT node_id, sequence_number FROM _kora_version_vector',
		)
		if (!options.collections) {
			for (const row of current) {
				if (!localIds.has(row.node_id)) {
					await tx.execute('DELETE FROM _kora_version_vector WHERE node_id = ?', [row.node_id])
				}
			}
		}
		for (const [nodeId, sequence] of backup.versionVector) {
			if (restartable.has(nodeId)) continue
			await maxVector(tx, nodeId, sequence)
		}

		// The server must re-send everything in scope: this database no longer holds what
		// it delivered before.
		await tx.execute('UPDATE _kora_meta SET value = ? WHERE key = ? OR key LIKE ?', [
			'0',
			DELIVERY_WATERMARK_META_KEY,
			`${DELIVERY_WATERMARK_META_KEY}:%`,
		])
		await tx.execute('DELETE FROM _kora_meta WHERE key = ?', [DELTA_CURSOR_META_KEY])

		for (const entry of backup.terminalRejections) {
			await tx.execute(
				`INSERT OR IGNORE INTO ${TERMINAL_REJECTIONS_TABLE} (operation_id, node_id, sequence_number, code, rejected_at) VALUES (?, ?, ?, ?, ?)`,
				[entry.operationId, entry.nodeId, entry.sequenceNumber, entry.code, entry.rejectedAt],
			)
		}

		if (rawRecords) {
			for (const operation of backup.operations) {
				if (!targets.includes(operation.collection)) continue
				await insertOperationRow(tx, operation)
			}
			for (const collection of targets) {
				const rows = backup.records.get(collection) ?? []
				if (rows.length === 0) continue
				const columns = new Set(
					(await tx.query<{ name: string }>(`PRAGMA table_info(${quoteIdent(collection)})`)).map(
						(column) => column.name,
					),
				)
				for (const row of rows) {
					const keys = Object.keys(row).filter((key) => columns.has(key))
					await tx.execute(
						`INSERT OR REPLACE INTO ${quoteIdent(collection)} (${keys.map((k) => quoteIdent(k)).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
						keys.map((key) => toSqlValue(row[key])),
					)
					recordsRestored++
				}
			}
		}
	})

	let restored = rawRecords
		? backup.operations.filter((operation) => targets.includes(operation.collection)).length
		: 0
	if (!rawRecords) {
		// No materialized rows in the backup: the remote-apply path rebuilds them.
		for (const operation of backup.operations) {
			if (!targets.includes(operation.collection)) continue
			if ((await host.applyOperation(operation)) === 'applied') restored++
		}
	}
	let unsyncedWritesKept = 0
	for (const operation of kept) {
		if ((await host.applyOperation(operation)) === 'applied') unsyncedWritesKept++
	}

	await adapter.transaction(async (tx) => {
		// Restartable counters continue after the highest number now in the log.
		for (const nodeId of restartable) {
			const highest = await highestSequence(tx, targets, nodeId)
			await tx.execute('DELETE FROM _kora_version_vector WHERE node_id = ?', [nodeId])
			if (highest > 0) {
				await tx.execute(
					'INSERT INTO _kora_version_vector (node_id, sequence_number) VALUES (?, ?)',
					[nodeId, highest],
				)
			}
		}
		// Nothing dropped may still wait to upload.
		if (dropped.size > 0 || !options.keepUnsyncedWrites) {
			const union = targets
				.map((c) => `SELECT id FROM ${quoteIdent(`_kora_ops_${c}`)}`)
				.join(' UNION ')
			if (union) {
				await tx.execute(`DELETE FROM _kora_sync_queue WHERE id NOT IN (${union})`)
			}
		}
	})

	return { operationsRestored: restored, recordsRestored, unsyncedWritesKept }
}

async function importTerminalRejections(
	adapter: StorageAdapter,
	backup: ParsedBackup,
): Promise<void> {
	if (backup.terminalRejections.length === 0) return
	await ensureLocalSyncRecordTables(adapter)
	await adapter.transaction(async (tx) => {
		for (const entry of backup.terminalRejections) {
			await tx.execute(
				`INSERT OR IGNORE INTO ${TERMINAL_REJECTIONS_TABLE} (operation_id, node_id, sequence_number, code, rejected_at) VALUES (?, ?, ?, ?, ?)`,
				[entry.operationId, entry.nodeId, entry.sequenceNumber, entry.code, entry.rejectedAt],
			)
		}
	})
}

/** Append a canonical operation row; a taken `(node, sequence)` goes to the conflicts table. */
async function insertOperationRow(tx: Transaction, operation: Operation): Promise<void> {
	const table = quoteIdent(`_kora_ops_${operation.collection}`)
	const row = serializeOperation(operation)
	const existing = await tx.query<{ id: string }>(`SELECT id FROM ${table} WHERE id = ?`, [row.id])
	if (existing.length > 0) return
	const holder = await tx.query<{ id: string }>(
		`SELECT id FROM ${table} WHERE node_id = ? AND sequence_number = ?`,
		[row.node_id, row.sequence_number],
	)
	if (holder.length > 0) {
		await insertConflictRow(
			tx,
			operation.collection,
			row,
			'backup-sequence-conflict',
			null,
			null,
			Date.now(),
		)
		return
	}
	await tx.execute(
		`INSERT INTO ${table} (id, node_id, type, record_id, data, previous_data, timestamp, sequence_number, causal_deps, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			row.id,
			row.node_id,
			row.type,
			row.record_id,
			row.data,
			row.previous_data,
			row.timestamp,
			row.sequence_number,
			row.causal_deps,
			row.schema_version,
		],
	)
}

async function maxVector(tx: Transaction, nodeId: string, sequence: number): Promise<void> {
	await tx.execute(
		`INSERT INTO _kora_version_vector (node_id, sequence_number) VALUES (?, ?)
     ON CONFLICT(node_id) DO UPDATE SET sequence_number = MAX(sequence_number, excluded.sequence_number)`,
		[nodeId, sequence],
	)
}

async function highestSequence(
	tx: Transaction,
	collections: string[],
	nodeId: string,
): Promise<number> {
	let highest = 0
	for (const collection of collections) {
		const rows = await tx.query<{ m: number | null }>(
			`SELECT MAX(sequence_number) AS m FROM ${quoteIdent(`_kora_ops_${collection}`)} WHERE node_id = ?`,
			[nodeId],
		)
		highest = Math.max(highest, rows[0]?.m ?? 0)
	}
	return highest
}

/**
 * Per own node, how far the sync server acknowledged its operations: the W3 contiguous
 * acknowledged prefix, else the last acknowledged server vector, else 0.
 */
async function loadAckedThrough(
	adapter: StorageAdapter,
	nodes: readonly LocalNodeRecord[],
): Promise<Map<string, number>> {
	const lastAcked = await loadLastAckedServerVector(adapter)
	const result = new Map<string, number>()
	for (const node of nodes) {
		const prefix = await loadOwnAckedThrough(adapter, node.nodeId)
		result.set(node.nodeId, prefix ?? lastAcked.get(node.nodeId) ?? 0)
	}
	return result
}

async function tableExists(adapter: StorageAdapter, name: string): Promise<boolean> {
	const rows = await adapter.query<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
		[name],
	)
	return rows.length > 0
}

function toSqlValue(value: unknown): unknown {
	if (typeof value === 'boolean') return value ? 1 : 0
	if (value instanceof Uint8Array) return value
	if (value !== null && typeof value === 'object') return JSON.stringify(value)
	return value
}
