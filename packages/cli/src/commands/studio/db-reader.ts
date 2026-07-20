import type BetterSqlite3 from 'better-sqlite3'

/**
 * Read-only access layer for Kora Studio.
 *
 * Opens the SQLite database with `readonly: true` — Studio can NEVER write.
 * Any future editing feature must create real operations through the store
 * pipeline (never raw SQL), or it would corrupt the append-only op log and
 * violate content addressing.
 *
 * No schema file is required: collections are introspected as tables that
 * have a companion `_kora_ops_<name>` operation log table.
 */

/** A parsed serialized HLC version stamp ("wallTime:logical:nodeId"). */
export interface ParsedVersion {
	wallTime: number
	logical: number
	nodeId: string
}

export interface StudioCollectionInfo {
	name: string
	liveRecords: number
	tombstones: number
	operations: number
	columns: string[]
}

export interface StudioOverview {
	dbPath: string
	collections: StudioCollectionInfo[]
	versionVector: Array<{ nodeId: string; sequenceNumber: number }>
	meta: Array<{ key: string; value: string }>
	pendingSyncOps: number
	auditTraces: number
}

export interface StudioRecord {
	id: string
	fields: Record<string, unknown>
	createdAt: number
	updatedAt: number
	deleted: boolean
	version: ParsedVersion | null
	fieldVersions: Record<string, ParsedVersion>
}

export interface StudioOperation {
	id: string
	nodeId: string
	type: string
	recordId: string
	data: Record<string, unknown> | null
	previousData: Record<string, unknown> | null
	timestamp: ParsedVersion | null
	sequenceNumber: number
	causalDeps: string[]
	schemaVersion: number
}

export interface StudioAuditTrace {
	id: string
	recordedAt: number
	eventType: string
	collection: string
	recordId: string
	field: string
	strategy: string
	tier: number
	constraintName: string | null
}

const KORA_TABLE_PREFIX = '_kora_'
const OPS_TABLE_PREFIX = '_kora_ops_'
/** Metadata columns present on every materialized row. */
const META_COLUMNS = new Set([
	'id',
	'_created_at',
	'_updated_at',
	'_version',
	'_field_versions',
	'_deleted',
])

/** Parse a serialized HLC stamp; tolerates legacy/empty values with null. */
export function parseVersionStamp(raw: unknown): ParsedVersion | null {
	if (typeof raw !== 'string' || raw.length === 0) {
		return null
	}
	const parts = raw.split(':')
	if (parts.length < 3) {
		return null
	}
	const wallTime = Number.parseInt(parts[0] ?? '', 10)
	const logical = Number.parseInt(parts[1] ?? '', 10)
	if (Number.isNaN(wallTime) || Number.isNaN(logical)) {
		return null
	}
	return { wallTime, logical, nodeId: parts.slice(2).join(':') }
}

function parseFieldVersionsColumn(raw: unknown): Record<string, ParsedVersion> {
	if (typeof raw !== 'string' || raw.length === 0) {
		return {}
	}
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>
		const result: Record<string, ParsedVersion> = {}
		for (const [field, value] of Object.entries(parsed)) {
			const version = parseVersionStamp(value)
			if (version) {
				result[field] = version
			}
		}
		return result
	} catch {
		return {}
	}
}

function safeIdentifier(name: string): string {
	if (!/^[a-zA-Z0-9_]+$/.test(name)) {
		throw new Error(`Unsafe SQL identifier: "${name}"`)
	}
	return name
}

function parseJsonColumn(raw: unknown): Record<string, unknown> | null {
	if (typeof raw !== 'string' || raw.length === 0) {
		return null
	}
	try {
		return JSON.parse(raw) as Record<string, unknown>
	} catch {
		return null
	}
}

function parseJsonArrayColumn(raw: unknown): string[] {
	if (typeof raw !== 'string' || raw.length === 0) {
		return []
	}
	try {
		const parsed = JSON.parse(raw) as unknown
		return Array.isArray(parsed) ? parsed.map(String) : []
	} catch {
		return []
	}
}

/**
 * Read-only Studio access to a Kora SQLite database.
 */
export class StudioDbReader {
	private constructor(
		private readonly db: BetterSqlite3.Database,
		private readonly dbPath: string,
	) {}

	/**
	 * Open a Kora database strictly read-only.
	 * @throws when the file does not exist or is not a Kora database
	 */
	static async open(dbPath: string): Promise<StudioDbReader> {
		// Dynamic import so better-sqlite3 loads only when Studio runs.
		let Database: typeof BetterSqlite3
		try {
			Database = (await import('better-sqlite3')).default
		} catch {
			throw new Error(
				'Kora Studio needs the "better-sqlite3" package to open database files. Install it in your project: pnpm add -D better-sqlite3',
			)
		}
		const db = new Database(dbPath, { readonly: true, fileMustExist: true })
		const reader = new StudioDbReader(db, dbPath)
		if (reader.listCollections().length === 0 && !reader.hasKoraTables()) {
			db.close()
			throw new Error(`"${dbPath}" does not look like a Kora database (no _kora_* tables found).`)
		}
		return reader
	}

	close(): void {
		this.db.close()
	}

	private hasKoraTables(): boolean {
		const row = this.db
			.prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name LIKE ?")
			.get(`${KORA_TABLE_PREFIX}%`) as { count: number }
		return row.count > 0
	}

	/** Collections = tables that have a companion _kora_ops_<name> table. */
	listCollections(): string[] {
		const tables = this.db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as Array<{ name: string }>
		const names = new Set(tables.map((t) => t.name))
		const collections: string[] = []
		for (const { name } of tables) {
			if (name.startsWith(OPS_TABLE_PREFIX)) {
				const collection = name.slice(OPS_TABLE_PREFIX.length)
				if (names.has(collection)) {
					collections.push(collection)
				}
			}
		}
		return collections.sort()
	}

	overview(): StudioOverview {
		const collections: StudioCollectionInfo[] = this.listCollections().map((name) => {
			const table = safeIdentifier(name)
			const live = this.db
				.prepare(`SELECT COUNT(*) as count FROM ${table} WHERE _deleted = 0`)
				.get() as { count: number }
			const tombstones = this.db
				.prepare(`SELECT COUNT(*) as count FROM ${table} WHERE _deleted = 1`)
				.get() as { count: number }
			const operations = this.db
				.prepare(`SELECT COUNT(*) as count FROM ${OPS_TABLE_PREFIX}${table}`)
				.get() as { count: number }
			const columnRows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
				name: string
			}>
			return {
				name,
				liveRecords: live.count,
				tombstones: tombstones.count,
				operations: operations.count,
				columns: columnRows.map((c) => c.name).filter((c) => !META_COLUMNS.has(c)),
			}
		})

		const versionVector = this.tableExists('_kora_version_vector')
			? (this.db
					.prepare(
						'SELECT node_id as nodeId, sequence_number as sequenceNumber FROM _kora_version_vector ORDER BY node_id',
					)
					.all() as Array<{ nodeId: string; sequenceNumber: number }>)
			: []

		const meta = this.tableExists('_kora_meta')
			? (this.db.prepare('SELECT key, value FROM _kora_meta ORDER BY key').all() as Array<{
					key: string
					value: string
				}>)
			: []

		const pendingSyncOps = this.tableExists('_kora_sync_queue')
			? (
					this.db.prepare('SELECT COUNT(*) as count FROM _kora_sync_queue').get() as {
						count: number
					}
				).count
			: 0

		const auditTraces = this.tableExists('_kora_audit_traces')
			? (
					this.db.prepare('SELECT COUNT(*) as count FROM _kora_audit_traces').get() as {
						count: number
					}
				).count
			: 0

		return { dbPath: this.dbPath, collections, versionVector, meta, pendingSyncOps, auditTraces }
	}

	records(
		collection: string,
		options: {
			limit?: number
			offset?: number
			includeDeleted?: boolean
			search?: string
		} = {},
	): { records: StudioRecord[]; total: number } {
		const table = safeIdentifier(collection)
		const limit = Math.min(Math.max(options.limit ?? 50, 1), 500)
		const offset = Math.max(options.offset ?? 0, 0)

		const clauses: string[] = []
		const params: unknown[] = []
		if (!options.includeDeleted) {
			clauses.push('_deleted = 0')
		}
		if (options.search && options.search.trim().length > 0) {
			// Search across id and every TEXT-affinity column.
			const textColumns = (
				this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
					name: string
					type: string
				}>
			).filter((c) => c.type.toUpperCase().includes('TEXT') || c.name === 'id')
			const term = `%${options.search.trim()}%`
			const likes = textColumns.map((c) => {
				params.push(term)
				return `${safeIdentifier(c.name)} LIKE ?`
			})
			if (likes.length > 0) {
				clauses.push(`(${likes.join(' OR ')})`)
			}
		}
		const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''

		const total = (
			this.db.prepare(`SELECT COUNT(*) as count FROM ${table} ${where}`).get(...params) as {
				count: number
			}
		).count
		const rows = this.db
			.prepare(`SELECT * FROM ${table} ${where} ORDER BY _updated_at DESC LIMIT ? OFFSET ?`)
			.all(...params, limit, offset) as Array<Record<string, unknown>>

		return { records: rows.map((row) => this.toStudioRecord(row)), total }
	}

	/** Full operation log for one collection (capped), for replay and the DAG. */
	allOperations(collection: string, cap = 5000): StudioOperation[] {
		const table = safeIdentifier(collection)
		const rows = this.db
			.prepare(`SELECT * FROM ${OPS_TABLE_PREFIX}${table} ORDER BY timestamp ASC LIMIT ?`)
			.all(Math.min(Math.max(cap, 1), 20000)) as Array<Record<string, unknown>>
		return rows.map((row) => this.toStudioOperation(row))
	}

	/**
	 * Cheap change fingerprint for live updates. SQLite's `data_version` PRAGMA
	 * increments whenever ANOTHER connection commits — exactly what a read-only
	 * watcher needs to know "something changed, refetch".
	 */
	fingerprint(): string {
		const row = this.db.prepare('PRAGMA data_version').get() as { data_version: number }
		return String(row.data_version)
	}

	/** Raw value of a single column on a record (for richtext preview decode). */
	rawFieldValue(collection: string, recordId: string, field: string): unknown {
		const table = safeIdentifier(collection)
		const column = safeIdentifier(field)
		const row = this.db
			.prepare(`SELECT ${column} as value FROM ${table} WHERE id = ?`)
			.get(recordId) as { value: unknown } | undefined
		return row?.value
	}

	record(collection: string, recordId: string): StudioRecord | null {
		const table = safeIdentifier(collection)
		const row = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(recordId) as
			| Record<string, unknown>
			| undefined
		return row ? this.toStudioRecord(row) : null
	}

	/** Full operation history for one record, newest first. */
	recordOperations(collection: string, recordId: string): StudioOperation[] {
		const table = safeIdentifier(collection)
		const rows = this.db
			.prepare(
				`SELECT * FROM ${OPS_TABLE_PREFIX}${table} WHERE record_id = ? ORDER BY timestamp DESC`,
			)
			.all(recordId) as Array<Record<string, unknown>>
		return rows.map((row) => this.toStudioOperation(row))
	}

	operations(
		collection: string,
		options: { limit?: number; offset?: number } = {},
	): { operations: StudioOperation[]; total: number } {
		const table = safeIdentifier(collection)
		const limit = Math.min(Math.max(options.limit ?? 50, 1), 500)
		const offset = Math.max(options.offset ?? 0, 0)
		const total = (
			this.db.prepare(`SELECT COUNT(*) as count FROM ${OPS_TABLE_PREFIX}${table}`).get() as {
				count: number
			}
		).count
		const rows = this.db
			.prepare(`SELECT * FROM ${OPS_TABLE_PREFIX}${table} ORDER BY timestamp DESC LIMIT ? OFFSET ?`)
			.all(limit, offset) as Array<Record<string, unknown>>
		return { operations: rows.map((row) => this.toStudioOperation(row)), total }
	}

	auditTraces(limit = 100): StudioAuditTrace[] {
		if (!this.tableExists('_kora_audit_traces')) {
			return []
		}
		const rows = this.db
			.prepare(
				`SELECT id, recorded_at, event_type, collection, record_id, field, strategy, tier, constraint_name
				 FROM _kora_audit_traces ORDER BY recorded_at DESC LIMIT ?`,
			)
			.all(Math.min(Math.max(limit, 1), 500)) as Array<Record<string, unknown>>
		return rows.map((row) => ({
			id: String(row.id),
			recordedAt: Number(row.recorded_at),
			eventType: String(row.event_type),
			collection: String(row.collection),
			recordId: String(row.record_id),
			field: String(row.field),
			strategy: String(row.strategy),
			tier: Number(row.tier),
			constraintName: row.constraint_name === null ? null : String(row.constraint_name),
		}))
	}

	private tableExists(name: string): boolean {
		const row = this.db
			.prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name = ?")
			.get(name) as { count: number }
		return row.count > 0
	}

	private toStudioRecord(row: Record<string, unknown>): StudioRecord {
		const fields: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(row)) {
			if (!META_COLUMNS.has(key)) {
				// BLOBs (richtext Yjs state) are summarized, not dumped raw.
				fields[key] =
					value instanceof Uint8Array || Buffer.isBuffer(value)
						? `<binary ${(value as Uint8Array).byteLength} bytes>`
						: value
			}
		}
		return {
			id: String(row.id),
			fields,
			createdAt: Number(row._created_at),
			updatedAt: Number(row._updated_at),
			deleted: row._deleted === 1,
			version: parseVersionStamp(row._version),
			fieldVersions: parseFieldVersionsColumn(row._field_versions),
		}
	}

	private toStudioOperation(row: Record<string, unknown>): StudioOperation {
		return {
			id: String(row.id),
			nodeId: String(row.node_id),
			type: String(row.type),
			recordId: String(row.record_id),
			data: parseJsonColumn(row.data),
			previousData: parseJsonColumn(row.previous_data),
			timestamp: parseVersionStamp(row.timestamp),
			sequenceNumber: Number(row.sequence_number),
			causalDeps: parseJsonArrayColumn(row.causal_deps),
			schemaVersion: Number(row.schema_version),
		}
	}
}
