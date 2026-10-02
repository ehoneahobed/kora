/**
 * Server-side log-integrity scan (W8 step 0), run once per database by the SQLite and
 * Postgres stores' startup migration, before anything materializes or re-materializes
 * from the operation log.
 *
 * A stored operation must be readable back into an `Operation`: valid JSON in its JSON
 * columns, a well-formed HLC (non-negative integer wall time, logical counter in range,
 * timestamp node id), a known type and a positive sequence number. The server's typed
 * columns rule out the client's beta.12 restore damage (`NOT NULL` wall time), so there
 * is nothing to repair in place: a row that fails is moved, verbatim, to
 * {@link SERVER_LOG_QUARANTINE_TABLE} and reported, instead of crashing every fold that
 * reads it.
 */

/** Rows moved out of `operations`, kept verbatim. Never cleared automatically. */
export const SERVER_LOG_QUARANTINE_TABLE = 'operations_quarantine'

/** `kora_server_meta` key recording that the one-time scan ran. */
export const SERVER_LOG_INTEGRITY_META_KEY = 'log_integrity_scan_v1'

/** HLC logical counter bound (matches `HybridLogicalClock.serialize`). */
const MAX_LOGICAL = 99_999
/** Wall times are zero-padded to 15 digits when serialized. */
const WALL_TIME_LIMIT = 1e15

const OPERATION_TYPES = new Set(['insert', 'update', 'delete'])

/** The raw columns of a stored operation row (both SQL dialects). */
export interface ServerOperationRow {
	id: unknown
	node_id: unknown
	type: unknown
	collection: unknown
	record_id: unknown
	data: unknown
	previous_data: unknown
	atomic_ops: unknown
	wall_time: unknown
	logical: unknown
	timestamp_node_id: unknown
	sequence_number: unknown
	causal_deps: unknown
	schema_version: unknown
}

/** A row the scan quarantined. */
export interface ServerLogIntegrityRow {
	operationId: string
	problem: string
	detail: string
}

/** Result of the server scan. */
export interface ServerLogIntegrityReport {
	/** Rows checked by this scan (0 when it already ran on this database). */
	checkedRows: number
	/** Rows this scan moved to the quarantine table. */
	quarantined: ServerLogIntegrityRow[]
	/** False when the one-time scan had already run (only the quarantine is reported). */
	ran: boolean
	/** Every row in the quarantine table. */
	totalQuarantined: number
}

/** DDL of the quarantine table (portable between SQLite and Postgres). */
export const SERVER_LOG_QUARANTINE_DDL = `CREATE TABLE IF NOT EXISTS ${SERVER_LOG_QUARANTINE_TABLE} (
  id TEXT PRIMARY KEY,
  problem TEXT NOT NULL,
  detail TEXT NOT NULL,
  row_json TEXT NOT NULL,
  quarantined_at BIGINT NOT NULL
)`

/**
 * Judge one stored operation row.
 *
 * @returns null when the row is a readable operation, else what is wrong with it
 */
export function checkServerOperationRow(
	row: ServerOperationRow,
): { problem: string; detail: string } | null {
	for (const column of ['id', 'node_id', 'collection', 'record_id', 'timestamp_node_id'] as const) {
		if (typeof row[column] !== 'string' || (row[column] as string).length === 0) {
			return { problem: 'identity-malformed', detail: `${column} is missing` }
		}
	}
	if (typeof row.type !== 'string' || !OPERATION_TYPES.has(row.type)) {
		return { problem: 'type-invalid', detail: `type ${JSON.stringify(row.type)}` }
	}
	const sequence = toInteger(row.sequence_number)
	if (sequence === null || sequence < 1) {
		return { problem: 'sequence-invalid', detail: `sequence_number ${String(row.sequence_number)}` }
	}
	const wall = toInteger(row.wall_time)
	const logical = toInteger(row.logical)
	if (wall === null || wall < 0 || wall >= WALL_TIME_LIMIT) {
		return { problem: 'timestamp-malformed', detail: `wall_time ${String(row.wall_time)}` }
	}
	if (logical === null || logical < 0 || logical > MAX_LOGICAL) {
		return { problem: 'timestamp-malformed', detail: `logical ${String(row.logical)}` }
	}
	for (const column of ['data', 'previous_data', 'atomic_ops'] as const) {
		if (!isJsonObjectOrNull(row[column])) {
			return { problem: 'data-malformed', detail: `${column} is not a JSON object` }
		}
	}
	if (!isJsonStringArray(row.causal_deps)) {
		return { problem: 'causal-deps-malformed', detail: 'causal_deps is not a JSON array of ids' }
	}
	return null
}

/** Serialize a row for the quarantine table (bigint-safe). */
export function quarantineRowJson(row: ServerOperationRow): string {
	return JSON.stringify(row, (_key, value: unknown) =>
		typeof value === 'bigint' ? value.toString() : value,
	)
}

function toInteger(value: unknown): number | null {
	if (typeof value === 'bigint') return Number(value)
	if (typeof value === 'number') return Number.isInteger(value) ? value : null
	// Postgres BIGINT columns arrive as strings.
	if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value)
	return null
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
