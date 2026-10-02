import type { MetaRow, StorageAdapter, Transaction } from '../types'
import { OWN_ACKED_THROUGH_META_KEY } from './sync-durability'
import { LAST_ACKED_SERVER_VECTOR_META_KEY, NODE_TOKEN_META_KEY, nodeTokenKey } from './sync-state'

/**
 * Durable sync bookkeeping that belongs to the device, not to the app (Phase 2 RT-36,
 * RT-38, RT-40): the operations the server refused for good, and the node ids this
 * database authored operations under.
 *
 * Both tables are created on first use, so existing databases need no migration.
 */

/**
 * Operations the server refused with a non-retriable rejection (RT-36). Unlike
 * `_kora_sync_rejected` (the app's reconciliation list, which `clearRejectedOperations`
 * empties), a row here is never removed: a refused operation stays refused, so a later
 * rescan of the device's own history never submits it again.
 */
export const TERMINAL_REJECTIONS_TABLE = '_kora_terminal_rejections'

/**
 * Node ids this database authored operations under (RT-38, RT-40): the node in use,
 * nodes it rotated away from, and other tabs' nodes under per-tab isolation.
 */
export const LOCAL_NODES_TABLE = '_kora_local_nodes'

/** Meta key: count of accepted sync handshakes on this database (refusal cycles, RT-38). */
export const ACCEPTED_CYCLE_META_KEY = 'sync_accepted_cycle'

/** Meta key: terminal rejections were seeded from the pre-Phase-2 rejected list once. */
const TERMINAL_SEED_META_KEY = 'terminal_rejections_seeded_v1'

/**
 * Rejection codes that never become a terminal marker: the operation was not judged on
 * its content, so a later upload of it may be accepted.
 *
 * - `SEQUENCE_CONFLICT`: the device's sequence number collided with an operation the
 *   server holds (a lost local tail, RT-35, or a beta.13 duplicate pair, RT-37); the
 *   operation is renumbered and uploaded again.
 * - `NODE_ID_MISMATCH`: uploaded on another node's session.
 * - `OUT_OF_UPLINK_SCOPE`: judged by the client against the scope it had then.
 */
export const NON_TERMINAL_REJECTION_CODES: ReadonlySet<string> = new Set([
	'SEQUENCE_CONFLICT',
	'NODE_ID_MISMATCH',
	'OUT_OF_UPLINK_SCOPE',
])

const TERMINAL_REJECTIONS_DDL = `CREATE TABLE IF NOT EXISTS ${TERMINAL_REJECTIONS_TABLE} (
  operation_id TEXT PRIMARY KEY NOT NULL,
  node_id TEXT,
  sequence_number INTEGER,
  code TEXT NOT NULL,
  rejected_at INTEGER NOT NULL
)`

const LOCAL_NODES_DDL = `CREATE TABLE IF NOT EXISTS ${LOCAL_NODES_TABLE} (
  node_id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 0,
  held INTEGER NOT NULL DEFAULT 0,
  refused_cycle INTEGER
)`

/** A terminal rejection to record (RT-36). */
export interface TerminalRejection {
	operationId: string
	/** Authoring node and sequence, when known (null for rows seeded from the old list). */
	nodeId: string | null
	sequenceNumber: number | null
	code: string
	rejectedAt: number
}

/** A node id this database authored operations under (RT-38, RT-40). */
export interface LocalNodeRecord {
	nodeId: string
	/** Wall-clock time (ms) the node was registered. Display only. */
	createdAt: number
	/** A sync handshake as this node was accepted at least once. */
	accepted: boolean
	/**
	 * The server refused this node (`NODE_ID_CLAIMED`) after it had been accepted: it
	 * belongs to a principal that is not signed in. Its unsynced operations are held for
	 * that principal, never uploaded under another one.
	 */
	held: boolean
	/** {@link ACCEPTED_CYCLE_META_KEY} value when the server last refused it, or null. */
	refusedCycle: number | null
}

interface LocalNodeRow {
	node_id: string
	created_at: number
	accepted: number
	held: number
	refused_cycle: number | null
}

/**
 * Create both tables. `Store.open` runs it (through {@link registerLocalNode}), so the
 * read paths, which run often, assume the tables exist and never issue DDL (on the
 * IndexedDB adapter every statement schedules a snapshot).
 */
export async function ensureLocalSyncRecordTables(adapter: StorageAdapter): Promise<void> {
	await adapter.execute(TERMINAL_REJECTIONS_DDL)
	await adapter.execute(LOCAL_NODES_DDL)
}

/** Record terminal rejections (idempotent by operation id; the first record wins). */
export async function recordTerminalRejections(
	adapter: StorageAdapter,
	entries: TerminalRejection[],
): Promise<void> {
	const recordable = entries.filter((entry) => !NON_TERMINAL_REJECTION_CODES.has(entry.code))
	if (recordable.length === 0) return
	await ensureLocalSyncRecordTables(adapter)
	await adapter.transaction(async (tx) => {
		for (const entry of recordable) {
			await tx.execute(
				`INSERT OR IGNORE INTO ${TERMINAL_REJECTIONS_TABLE} (operation_id, node_id, sequence_number, code, rejected_at) VALUES (?, ?, ?, ?, ?)`,
				[entry.operationId, entry.nodeId, entry.sequenceNumber, entry.code, entry.rejectedAt],
			)
		}
	})
}

/** Which of `operationIds` carry a terminal rejection marker. */
export async function findTerminalRejections(
	adapter: StorageAdapter,
	operationIds: string[],
): Promise<Set<string>> {
	const found = new Set<string>()
	if (operationIds.length === 0) return found
	const CHUNK = 500
	for (let i = 0; i < operationIds.length; i += CHUNK) {
		const chunk = operationIds.slice(i, i + CHUNK)
		const rows = await adapter.query<{ operation_id: string }>(
			`SELECT operation_id FROM ${TERMINAL_REJECTIONS_TABLE} WHERE operation_id IN (${chunk.map(() => '?').join(', ')})`,
			chunk,
		)
		for (const row of rows) found.add(row.operation_id)
	}
	return found
}

/**
 * Seed terminal markers once from `_kora_sync_rejected`, the list earlier releases kept
 * (and the app may have cleared since). Rows whose code is not terminal are skipped:
 * in particular a beta.13 device's `SEQUENCE_CONFLICT` rejections (RT-37) stay eligible
 * for the one-time re-upload, which is how those writes reach the server.
 */
export async function seedTerminalRejectionsOnce(adapter: StorageAdapter): Promise<void> {
	await ensureLocalSyncRecordTables(adapter)
	const done = await adapter.query<MetaRow>('SELECT value FROM _kora_meta WHERE key = ?', [
		TERMINAL_SEED_META_KEY,
	])
	if (done.length > 0) return
	const tables = await adapter.query<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_kora_sync_rejected'",
	)
	await adapter.transaction(async (tx) => {
		if (tables.length > 0) {
			const placeholders = [...NON_TERMINAL_REJECTION_CODES].map(() => '?').join(', ')
			await tx.execute(
				`INSERT OR IGNORE INTO ${TERMINAL_REJECTIONS_TABLE} (operation_id, node_id, sequence_number, code, rejected_at)
         SELECT operation_id, NULL, NULL, code, rejected_at FROM _kora_sync_rejected
         WHERE retriable = 0 AND code NOT IN (${placeholders})`,
				[...NON_TERMINAL_REJECTION_CODES],
			)
		}
		await tx.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
			TERMINAL_SEED_META_KEY,
			String(Date.now()),
		])
	})
}

function rowToRecord(row: LocalNodeRow): LocalNodeRecord {
	return {
		nodeId: row.node_id,
		createdAt: Number(row.created_at),
		accepted: Number(row.accepted) === 1,
		held: Number(row.held) === 1,
		refusedCycle: row.refused_cycle === null ? null : Number(row.refused_cycle),
	}
}

/**
 * Register a node id this database authors operations under. A node registered for the
 * first time that already has sync history here (a database from an earlier release)
 * is recorded as accepted, so a later refusal holds its writes instead of re-authoring
 * them under another principal (RT-38).
 */
export async function registerLocalNode(adapter: StorageAdapter, nodeId: string): Promise<void> {
	await ensureLocalSyncRecordTables(adapter)
	const existing = await adapter.query<{ node_id: string }>(
		`SELECT node_id FROM ${LOCAL_NODES_TABLE} WHERE node_id = ?`,
		[nodeId],
	)
	if (existing.length > 0) return
	const accepted = await hasSyncHistory(adapter, nodeId)
	await adapter.execute(
		`INSERT OR IGNORE INTO ${LOCAL_NODES_TABLE} (node_id, created_at, accepted, held, refused_cycle) VALUES (?, ?, ?, 0, NULL)`,
		[nodeId, Date.now(), accepted ? 1 : 0],
	)
}

async function hasSyncHistory(adapter: StorageAdapter, nodeId: string): Promise<boolean> {
	const rows = await adapter.query<MetaRow & { key: string }>(
		'SELECT key, value FROM _kora_meta WHERE key IN (?, ?, ?, ?)',
		[
			NODE_TOKEN_META_KEY,
			nodeTokenKey(nodeId),
			LAST_ACKED_SERVER_VECTOR_META_KEY,
			OWN_ACKED_THROUGH_META_KEY,
		],
	)
	const nodeIdRows = await adapter.query<MetaRow>(
		"SELECT value FROM _kora_meta WHERE key = 'node_id'",
	)
	const isMetaNode = nodeIdRows[0]?.value === nodeId
	for (const row of rows) {
		if (row.key === nodeTokenKey(nodeId)) return true
		if (row.key === NODE_TOKEN_META_KEY) {
			if (isMetaNode) return true
			continue
		}
		try {
			const parsed = JSON.parse(row.value) as Record<string, unknown>
			if (row.key === LAST_ACKED_SERVER_VECTOR_META_KEY) {
				const own = parsed[nodeId]
				if (typeof own === 'number' && own > 0) return true
			} else if (row.key === OWN_ACKED_THROUGH_META_KEY) {
				if (parsed.nodeId === nodeId && typeof parsed.sequence === 'number' && parsed.sequence > 0)
					return true
			}
		} catch {
			// An unreadable row is no evidence either way.
		}
	}
	return false
}

/** Every registered local node, oldest first. */
export async function listLocalNodes(adapter: StorageAdapter): Promise<LocalNodeRecord[]> {
	const rows = await adapter.query<LocalNodeRow>(
		`SELECT node_id, created_at, accepted, held, refused_cycle FROM ${LOCAL_NODES_TABLE} ORDER BY created_at ASC, node_id ASC`,
	)
	return rows.map(rowToRecord)
}

async function readAcceptedCycle(tx: Transaction): Promise<number> {
	const rows = await tx.query<MetaRow>('SELECT value FROM _kora_meta WHERE key = ?', [
		ACCEPTED_CYCLE_META_KEY,
	])
	const value = Number(rows[0]?.value ?? 0)
	return Number.isFinite(value) ? value : 0
}

/**
 * Record an accepted handshake as `nodeId`: the node is accepted and no longer held,
 * and a new refusal cycle starts (every node may be tried again after a refusal).
 */
export async function markLocalNodeAccepted(
	adapter: StorageAdapter,
	nodeId: string,
): Promise<void> {
	await ensureLocalSyncRecordTables(adapter)
	await adapter.transaction(async (tx) => {
		const cycle = await readAcceptedCycle(tx)
		await tx.execute(
			`INSERT INTO ${LOCAL_NODES_TABLE} (node_id, created_at, accepted, held, refused_cycle) VALUES (?, ?, 1, 0, NULL)
       ON CONFLICT(node_id) DO UPDATE SET accepted = 1, held = 0, refused_cycle = NULL`,
			[nodeId, Date.now()],
		)
		await tx.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
			ACCEPTED_CYCLE_META_KEY,
			String(cycle + 1),
		])
	})
}

/**
 * Record that the server refused `nodeId` (`NODE_ID_CLAIMED`) in the current refusal
 * cycle. `held` marks its unsynced operations as held for the principal owning it.
 */
export async function markLocalNodeRefused(
	adapter: StorageAdapter,
	nodeId: string,
	held: boolean,
): Promise<void> {
	await ensureLocalSyncRecordTables(adapter)
	await adapter.transaction(async (tx) => {
		const cycle = await readAcceptedCycle(tx)
		await tx.execute(
			`INSERT INTO ${LOCAL_NODES_TABLE} (node_id, created_at, accepted, held, refused_cycle) VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET held = MAX(held, excluded.held), refused_cycle = excluded.refused_cycle`,
			[nodeId, Date.now(), held ? 1 : 0, cycle],
		)
	})
}

/**
 * Forget a local node that has nothing left to upload (bounds the registry under per-tab
 * isolation, where every tab adds a node). A node that writes again is registered again
 * when its store opens. Never the database's own node id.
 */
export async function forgetLocalNode(adapter: StorageAdapter, nodeId: string): Promise<void> {
	await ensureLocalSyncRecordTables(adapter)
	await adapter.execute(
		`DELETE FROM ${LOCAL_NODES_TABLE} WHERE node_id = ? AND held = 0 AND node_id NOT IN (SELECT value FROM _kora_meta WHERE key = 'node_id')`,
		[nodeId],
	)
}

/** The current refusal cycle (count of accepted handshakes on this database). */
export async function loadAcceptedCycle(adapter: StorageAdapter): Promise<number> {
	const rows = await adapter.query<MetaRow>('SELECT value FROM _kora_meta WHERE key = ?', [
		ACCEPTED_CYCLE_META_KEY,
	])
	const value = Number(rows[0]?.value ?? 0)
	return Number.isFinite(value) ? value : 0
}

/** Read access to a database (an open adapter, or a reader handed to a delete check). */
export interface DatabaseQuery {
	query<T>(sql: string, params?: unknown[]): Promise<T[]>
}

/**
 * Whether any local node has operations above its contiguous acknowledged prefix that
 * the server did not refuse for good (RT-41): the authoritative "unsynced" (W3), which
 * the outbound queue only approximates. A local node is one in the registry, the
 * database's node id, or the node of the legacy prefix key; a node with no recorded
 * prefix counts from 0. Works on a database no store has opened in this release.
 */
export async function hasUnsyncedOwnOperations(db: DatabaseQuery): Promise<boolean> {
	const tables = new Set(
		(await db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map(
			(row) => row.name,
		),
	)
	const opsTables = [...tables].filter((name) => name.startsWith('_kora_ops_'))
	if (opsTables.length === 0 || !tables.has('_kora_meta')) return false

	const nodes = new Set<string>()
	if (tables.has(LOCAL_NODES_TABLE)) {
		for (const row of await db.query<{ node_id: string }>(
			`SELECT node_id FROM ${LOCAL_NODES_TABLE}`,
		)) {
			nodes.add(row.node_id)
		}
	}
	const meta = await db.query<{ key: string; value: string }>(
		"SELECT key, value FROM _kora_meta WHERE key = 'node_id' OR key = ? OR key LIKE ?",
		[OWN_ACKED_THROUGH_META_KEY, `${OWN_ACKED_THROUGH_META_KEY}:%`],
	)
	const prefixes = new Map<string, number>()
	for (const row of meta) {
		if (row.key === 'node_id') {
			nodes.add(row.value)
		} else if (row.key === OWN_ACKED_THROUGH_META_KEY) {
			try {
				const parsed = JSON.parse(row.value) as { nodeId?: unknown; sequence?: unknown }
				if (typeof parsed.nodeId === 'string') {
					nodes.add(parsed.nodeId)
					if (typeof parsed.sequence === 'number') prefixes.set(parsed.nodeId, parsed.sequence)
				}
			} catch {
				// Unreadable: the node (if known otherwise) counts from 0.
			}
		} else {
			const nodeId = row.key.slice(OWN_ACKED_THROUGH_META_KEY.length + 1)
			// The legacy key wins for its node (loadOwnAckedThrough reads it first).
			const sequence = Number(row.value)
			if (!prefixes.has(nodeId) && Number.isInteger(sequence)) prefixes.set(nodeId, sequence)
		}
	}
	const exclude = tables.has(TERMINAL_REJECTIONS_TABLE)
		? ` AND id NOT IN (SELECT operation_id FROM ${TERMINAL_REJECTIONS_TABLE})`
		: ''
	for (const nodeId of nodes) {
		const prefix = prefixes.get(nodeId) ?? 0
		for (const table of opsTables) {
			const rows = await db.query<{ n: number }>(
				`SELECT COUNT(*) AS n FROM "${table.replace(/"/g, '""')}" WHERE node_id = ? AND sequence_number > ?${exclude}`,
				[nodeId, prefix],
			)
			if (Number(rows[0]?.n ?? 0) > 0) return true
		}
	}
	return false
}
