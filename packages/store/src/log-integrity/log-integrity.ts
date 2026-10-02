import { HybridLogicalClock, quoteIdent } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { COMPACTION_BASELINE_META_KEY } from '../compaction/types'
import { deserializeOperation, serializeOperation } from '../serialization/serializer'
import type { MetaRow, OperationRow, StorageAdapter, Transaction } from '../types'

/**
 * Log-integrity scan (W8 step 0).
 *
 * Every later fold of the operation log (W7 re-materialization, replay, compaction)
 * trusts that each stored row is a canonical operation. Two earlier releases could
 * break that:
 *
 * - beta.12's backup restore wrote `JSON.stringify(timestamp)` into the timestamp
 *   column, which `HybridLogicalClock.deserialize` reads as `wallTime: NaN` (a `null`
 *   once re-exported), and a second restore of such a backup nested the damage;
 * - compaction deletes acknowledged operations, leaving holes in a node's sequence.
 *
 * The scan detects rows that do not round-trip through `deserializeOperation` /
 * `serializeOperation`, repairs the ones whose original value is recoverable from the
 * row itself (the JSON-encoded timestamp), and moves the rest to
 * {@link LOG_QUARANTINE_TABLE} (never deleted), so no fold ever reads them. It also
 * reports sequence gaps in this database's own nodes. Remote nodes' gaps are normal
 * (scoped sync only delivers part of another device's log) and are not reported.
 */

/** Rows that could not be repaired, kept verbatim. Never cleared automatically. */
export const LOG_QUARANTINE_TABLE = '_kora_log_quarantine'

const QUARANTINE_DDL = `CREATE TABLE IF NOT EXISTS ${LOG_QUARANTINE_TABLE} (
  collection TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  node_id TEXT,
  sequence_number INTEGER,
  problem TEXT NOT NULL,
  detail TEXT NOT NULL,
  row_json TEXT NOT NULL,
  quarantined_at INTEGER NOT NULL,
  PRIMARY KEY (collection, operation_id)
)`

/** What is wrong with an operation row. */
export type LogRowProblem =
	/** The timestamp is a JSON-encoded HLC (beta.12 backup restore). Repairable. */
	| 'timestamp-json'
	/** The timestamp cannot be read as an HLC and is not recoverable. */
	| 'timestamp-malformed'
	/** `id`, `node_id` or `record_id` is missing. */
	| 'identity-malformed'
	/** `type` is not insert, update or delete. */
	| 'type-invalid'
	/** `sequence_number` is not a positive integer. */
	| 'sequence-invalid'
	/** `data` or `previous_data` is not a JSON object. */
	| 'data-malformed'
	/** `causal_deps` is not a JSON array of operation ids. */
	| 'causal-deps-malformed'
	/** The row cannot be turned into an operation and back. */
	| 'round-trip-failed'

/** One operation row the scan repaired or quarantined. */
export interface LogIntegrityRow {
	collection: string
	operationId: string
	nodeId: string | null
	sequenceNumber: number | null
	problem: LogRowProblem
	/** Human-readable detail: the bad value, or how it was repaired. */
	detail: string
}

/** Sequence numbers missing from one of this database's own nodes. */
export interface LogSequenceGap {
	nodeId: string
	/** First missing sequence number (inclusive). */
	from: number
	/** Last missing sequence number (inclusive). */
	to: number
}

/**
 * Result of {@link scanLogIntegrity} / `Store.verifyLogIntegrity()`.
 *
 * `clean` is the precondition for rebuilding state from the log (W7): every row is
 * canonical, nothing is quarantined, and this database's own nodes have no holes
 * below their highest stored sequence number.
 */
export interface LogIntegrityReport {
	/** True when the log can be folded as-is (no quarantined rows, no own-node gaps). */
	clean: boolean
	/** `full`: every row was checked in JS. `quick`: SQL prefilter, suspects checked in JS. */
	mode: 'full' | 'quick'
	/** Rows checked in JS (all rows in full mode, suspects in quick mode). */
	checkedRows: number
	/** Rows this scan repaired in place. */
	repaired: LogIntegrityRow[]
	/** Rows this scan moved to the quarantine table. */
	newlyQuarantined: LogIntegrityRow[]
	/** Every row in the quarantine table (this scan's and earlier ones'). */
	quarantined: LogIntegrityRow[]
	/** Holes in this database's own nodes' sequences (compaction, a lost tail). */
	gaps: LogSequenceGap[]
	/** When the log was last compacted (epoch ms), or null when never. */
	compactedAt: number | null
	/** False when the scan only reported (`repair: false`). */
	repairApplied: boolean
}

/** Options for {@link scanLogIntegrity}. */
export interface LogIntegrityScanOptions {
	/** Check every row in JS (default) or only the rows a SQL prefilter flags. */
	mode?: 'full' | 'quick'
	/** Repair and quarantine (default true). False only reports. */
	repair?: boolean
	/** Node ids this database authors under (gaps are reported for these only). */
	localNodeIds: readonly string[]
}

const OPERATION_TYPES = new Set(['insert', 'update', 'delete'])
const CANONICAL_TIMESTAMP = /^\d{15}:\d{5}:.+$/
const PAGE_SIZE = 500

/**
 * SQL prefilter: rows that cannot be canonical. Cheap enough to run on every open; the
 * JS check then confirms each suspect. `CASE` keeps `json_type` from seeing invalid JSON.
 */
const SUSPECT_WHERE = `id IS NULL OR node_id IS NULL OR record_id IS NULL
 OR type NOT IN ('insert', 'update', 'delete')
 OR typeof(sequence_number) != 'integer' OR sequence_number < 1
 OR typeof(timestamp) != 'text' OR length(timestamp) < 23
 OR substr(timestamp, 16, 1) != ':' OR substr(timestamp, 22, 1) != ':'
 OR substr(timestamp, 1, 15) GLOB '*[^0-9]*' OR substr(timestamp, 17, 5) GLOB '*[^0-9]*'
 OR causal_deps IS NULL
 OR (CASE WHEN json_valid(causal_deps) THEN json_type(causal_deps) != 'array' ELSE 1 END)
 OR (data IS NOT NULL AND (CASE WHEN json_valid(data) THEN json_type(data) != 'object' ELSE 1 END))
 OR (previous_data IS NOT NULL AND (CASE WHEN json_valid(previous_data) THEN json_type(previous_data) != 'object' ELSE 1 END))`

type RowWithRowid = OperationRow & { __rowid: number }

/** Outcome of {@link checkOperationRow}. */
export type LogRowVerdict =
	| { kind: 'ok' }
	| { kind: 'repair'; problem: LogRowProblem; detail: string; timestamp: string }
	| { kind: 'quarantine'; problem: LogRowProblem; detail: string }

/**
 * Scan the operation log of every schema collection; repair and quarantine (unless
 * `repair: false`), then report. Repairs and quarantine moves run in one transaction.
 *
 * @param adapter - An opened storage adapter
 * @param schema - The schema whose operation tables are scanned
 * @param options - Scan mode, repair switch and this database's own node ids
 */
export async function scanLogIntegrity(
	adapter: StorageAdapter,
	schema: SchemaDefinition,
	options: LogIntegrityScanOptions,
): Promise<LogIntegrityReport> {
	const repair = options.repair ?? true
	let mode = options.mode ?? 'full'
	await adapter.execute(QUARANTINE_DDL)

	const actions: Array<{ collection: string; row: RowWithRowid; verdict: LogRowVerdict }> = []
	let checkedRows = 0
	for (const collection of Object.keys(schema.collections)) {
		const table = quoteIdent(`_kora_ops_${collection}`)
		let rows: RowWithRowid[] | null = null
		if (mode === 'quick') {
			try {
				rows = await adapter.query<RowWithRowid>(
					`SELECT rowid AS __rowid, * FROM ${table} WHERE ${SUSPECT_WHERE}`,
				)
			} catch {
				// No JSON functions in this SQLite build: check every row instead.
				mode = 'full'
			}
		}
		if (rows !== null) {
			for (const row of rows) {
				checkedRows++
				const verdict = checkOperationRow(row)
				if (verdict.kind !== 'ok') actions.push({ collection, row, verdict })
			}
			continue
		}
		let after = 0
		for (;;) {
			const page = await adapter.query<RowWithRowid>(
				`SELECT rowid AS __rowid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE_SIZE}`,
				[after],
			)
			for (const row of page) {
				checkedRows++
				const verdict = checkOperationRow(row)
				if (verdict.kind !== 'ok') actions.push({ collection, row, verdict })
			}
			if (page.length < PAGE_SIZE) break
			after = page[page.length - 1]?.__rowid ?? after
		}
	}

	const repaired: LogIntegrityRow[] = []
	const newlyQuarantined: LogIntegrityRow[] = []
	for (const { collection, row, verdict } of actions) {
		if (verdict.kind === 'ok') continue
		const entry = describeRow(collection, row, verdict.problem, verdict.detail)
		if (verdict.kind === 'repair') repaired.push(entry)
		else newlyQuarantined.push(entry)
	}

	if (repair && actions.length > 0) {
		const now = Date.now()
		await adapter.transaction(async (tx) => {
			for (const { collection, row, verdict } of actions) {
				const table = quoteIdent(`_kora_ops_${collection}`)
				if (verdict.kind === 'repair') {
					await tx.execute(`UPDATE ${table} SET timestamp = ? WHERE rowid = ?`, [
						verdict.timestamp,
						row.__rowid,
					])
				} else if (verdict.kind === 'quarantine') {
					await quarantineRow(tx, collection, row, verdict.problem, verdict.detail, now)
					await tx.execute(`DELETE FROM ${table} WHERE rowid = ?`, [row.__rowid])
				}
			}
		})
	}

	const quarantined = await loadQuarantine(adapter)
	const gaps = await findOwnSequenceGaps(adapter, schema, options.localNodeIds)
	const compactedAt = await loadCompactedAt(adapter)
	const pendingQuarantine = repair ? 0 : newlyQuarantined.length
	return {
		clean: quarantined.length === 0 && pendingQuarantine === 0 && gaps.length === 0,
		mode,
		checkedRows,
		repaired,
		newlyQuarantined,
		quarantined,
		gaps,
		compactedAt,
		repairApplied: repair,
	}
}

/**
 * Judge one operation row: canonical, repairable (with the repaired timestamp), or
 * to be quarantined.
 */
export function checkOperationRow(row: OperationRow): LogRowVerdict {
	if (
		!isNonEmptyString(row.id) ||
		!isNonEmptyString(row.node_id) ||
		!isNonEmptyString(row.record_id)
	) {
		return {
			kind: 'quarantine',
			problem: 'identity-malformed',
			detail: 'id, node_id or record_id is missing',
		}
	}
	if (!OPERATION_TYPES.has(row.type)) {
		return {
			kind: 'quarantine',
			problem: 'type-invalid',
			detail: `type ${JSON.stringify(row.type)}`,
		}
	}
	if (!Number.isInteger(row.sequence_number) || row.sequence_number < 1) {
		return {
			kind: 'quarantine',
			problem: 'sequence-invalid',
			detail: `sequence_number ${JSON.stringify(row.sequence_number)}`,
		}
	}
	if (!isJsonObjectOrNull(row.data) || !isJsonObjectOrNull(row.previous_data)) {
		return {
			kind: 'quarantine',
			problem: 'data-malformed',
			detail: 'data or previous_data is not a JSON object',
		}
	}
	if (!isJsonStringArray(row.causal_deps)) {
		return {
			kind: 'quarantine',
			problem: 'causal-deps-malformed',
			detail: `causal_deps ${truncate(String(row.causal_deps))}`,
		}
	}

	let timestamp = row.timestamp
	let repairedFrom: string | null = null
	if (!isCanonicalTimestamp(timestamp)) {
		const recovered = recoverTimestamp(timestamp)
		if (recovered === null) {
			return {
				kind: 'quarantine',
				problem: 'timestamp-malformed',
				detail: `timestamp ${truncate(String(timestamp))}`,
			}
		}
		repairedFrom = String(timestamp)
		timestamp = recovered
	}

	try {
		const op = deserializeOperation({ ...row, timestamp })
		const again = serializeOperation({ ...op, collection: '' })
		if (again.timestamp !== timestamp) {
			throw new Error(`timestamp ${again.timestamp} != ${timestamp}`)
		}
	} catch (error) {
		return {
			kind: 'quarantine',
			problem: 'round-trip-failed',
			detail: error instanceof Error ? error.message : String(error),
		}
	}

	if (repairedFrom !== null) {
		return {
			kind: 'repair',
			problem: 'timestamp-json',
			detail: `timestamp ${truncate(repairedFrom)} -> ${timestamp}`,
			timestamp,
		}
	}
	return { kind: 'ok' }
}

/** Whether `value` is the zero-padded `wall:logical:node` form that sorts like HLC order. */
function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)) return false
	try {
		return HybridLogicalClock.serialize(HybridLogicalClock.deserialize(value)) === value
	} catch {
		return false
	}
}

interface LooseTimestamp {
	wallTime: unknown
	logical: unknown
	nodeId: unknown
}

/**
 * Recover the canonical timestamp from a JSON-encoded HLC (beta.12 restore wrote
 * `JSON.stringify(timestamp)`). A backup exported from such a database and restored
 * again nests the damage: `deserialize` read the JSON as `wallTime: NaN` (exported as
 * `null`), `logical: <wallTime>` and `nodeId: '<logical>,"nodeId":"<nodeId>"}'`, which
 * is undone level by level.
 */
export function recoverTimestamp(value: unknown): string | null {
	if (typeof value !== 'string' || !value.startsWith('{')) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch {
		return null
	}
	let candidate = parsed as LooseTimestamp
	for (let depth = 0; depth < 8; depth++) {
		if (candidate === null || typeof candidate !== 'object') return null
		const { wallTime, logical, nodeId } = candidate
		if (Number.isInteger(wallTime) && Number.isInteger(logical) && isNonEmptyString(nodeId)) {
			try {
				return HybridLogicalClock.serialize({
					wallTime: wallTime as number,
					logical: logical as number,
					nodeId,
				})
			} catch {
				return null
			}
		}
		// One level of nesting: wallTime lost, logical holds the wall time, and nodeId
		// holds the rest of the inner JSON object.
		if (wallTime !== null || !Number.isInteger(logical) || typeof nodeId !== 'string') return null
		const match = /^(\d+),"nodeId":(".*")\}$/.exec(nodeId)
		if (!match?.[1] || !match[2]) return null
		let innerNode: unknown
		try {
			innerNode = JSON.parse(match[2])
		} catch {
			return null
		}
		candidate = { wallTime: logical, logical: Number(match[1]), nodeId: innerNode }
	}
	return null
}

async function quarantineRow(
	tx: Transaction,
	collection: string,
	row: RowWithRowid,
	problem: LogRowProblem,
	detail: string,
	now: number,
): Promise<void> {
	const { __rowid: _rowid, ...original } = row
	await tx.execute(
		`INSERT OR REPLACE INTO ${LOG_QUARANTINE_TABLE} (collection, operation_id, node_id, sequence_number, problem, detail, row_json, quarantined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			collection,
			typeof row.id === 'string' ? row.id : `rowid:${row.__rowid}`,
			typeof row.node_id === 'string' ? row.node_id : null,
			Number.isInteger(row.sequence_number) ? row.sequence_number : null,
			problem,
			detail,
			JSON.stringify(original, bytesReplacer),
			now,
		],
	)
}

interface QuarantineRow {
	collection: string
	operation_id: string
	node_id: string | null
	sequence_number: number | null
	problem: string
	detail: string
}

async function loadQuarantine(adapter: StorageAdapter): Promise<LogIntegrityRow[]> {
	const rows = await adapter.query<QuarantineRow>(
		`SELECT collection, operation_id, node_id, sequence_number, problem, detail FROM ${LOG_QUARANTINE_TABLE} ORDER BY quarantined_at ASC, collection ASC, operation_id ASC`,
	)
	return rows.map((row) => ({
		collection: row.collection,
		operationId: row.operation_id,
		nodeId: row.node_id,
		sequenceNumber: row.sequence_number,
		problem: row.problem as LogRowProblem,
		detail: row.detail,
	}))
}

/**
 * Holes in each own node's sequence below its highest stored number. Numbers held only
 * by `_kora_seq_conflicts` re-emissions are in the log under their new number, so the
 * log tables alone decide.
 */
async function findOwnSequenceGaps(
	adapter: StorageAdapter,
	schema: SchemaDefinition,
	nodeIds: readonly string[],
): Promise<LogSequenceGap[]> {
	const collections = Object.keys(schema.collections)
	if (collections.length === 0) return []
	const gaps: LogSequenceGap[] = []
	const union = collections
		.map((c) => `SELECT sequence_number FROM ${quoteIdent(`_kora_ops_${c}`)} WHERE node_id = ?`)
		.join(' UNION ALL ')
	for (const nodeId of [...new Set(nodeIds)]) {
		const params = collections.map(() => nodeId)
		const summary = await adapter.query<{ n: number; m: number | null }>(
			`SELECT COUNT(DISTINCT sequence_number) AS n, MAX(sequence_number) AS m FROM (${union})`,
			params,
		)
		const count = summary[0]?.n ?? 0
		const max = summary[0]?.m ?? 0
		if (max === null || max === 0 || count === max) continue
		const present = await adapter.query<{ sequence_number: number }>(
			`SELECT DISTINCT sequence_number FROM (${union}) ORDER BY sequence_number ASC`,
			params,
		)
		let expected = 1
		for (const { sequence_number: seq } of present) {
			if (seq > expected) gaps.push({ nodeId, from: expected, to: seq - 1 })
			expected = Math.max(expected, seq + 1)
		}
	}
	return gaps
}

async function loadCompactedAt(adapter: StorageAdapter): Promise<number | null> {
	const rows = await adapter.query<MetaRow>('SELECT value FROM _kora_meta WHERE key = ?', [
		COMPACTION_BASELINE_META_KEY,
	])
	const value = Number(rows[0]?.value)
	return rows[0] && Number.isFinite(value) ? value : null
}

function describeRow(
	collection: string,
	row: OperationRow,
	problem: LogRowProblem,
	detail: string,
): LogIntegrityRow {
	return {
		collection,
		operationId: typeof row.id === 'string' ? row.id : '',
		nodeId: typeof row.node_id === 'string' ? row.node_id : null,
		sequenceNumber: Number.isInteger(row.sequence_number) ? row.sequence_number : null,
		problem,
		detail,
	}
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0
}

function isJsonObjectOrNull(value: unknown): boolean {
	if (value === null || value === undefined) return true
	if (typeof value !== 'string') return false
	try {
		const parsed: unknown = JSON.parse(value)
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
	} catch {
		return false
	}
}

function isJsonStringArray(value: unknown): boolean {
	if (typeof value !== 'string') return false
	try {
		const parsed: unknown = JSON.parse(value)
		return Array.isArray(parsed) && parsed.every((id) => typeof id === 'string')
	} catch {
		return false
	}
}

function truncate(value: string): string {
	return value.length > 120 ? `${value.slice(0, 117)}...` : value
}

function bytesReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Uint8Array) return { $bytes: Array.from(value) }
	return value
}
