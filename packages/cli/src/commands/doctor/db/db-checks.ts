import { createHash } from 'node:crypto'
import type { FieldDescriptor, SchemaDefinition } from '@korajs/core'
import type { DoctorCheckResult } from '../doctor-checks'
import type { DoctorDatabase, DoctorRow } from './database'
import { type PendingMigrationReport, checkPendingMigrations } from './pending-migrations'
import {
	FOLD_PLAN_FINGERPRINT_KEY,
	RELEASED_NODE_OWNER,
	RESERVED_NODE_PREFIX,
	SCOPE_SNAPSHOT_FINGERPRINT_KEY,
	SERVER_EVER_AUTHORITY_KEY,
	SERVER_LEGACY_AUTHORITY_KEY,
	SERVER_LOG_INTEGRITY_META_KEY,
	SERVER_LOG_QUARANTINE_TABLE,
	replannedCollections,
	scopeSnapshotFingerprint,
} from './server-meta'

/** What the database checks need besides the database. */
export interface DatabaseCheckOptions {
	/** The app schema, or null when it could not be loaded (schema checks are skipped). */
	schema: SchemaDefinition | null
	/** True when the app depends on `@korajs/auth` (device node handover applies). */
	usesKoraAuth: boolean
	/** Directory of the app's generated migrations (`kora/migrations`). */
	migrationsDir: string
	/** Milliseconds since the epoch (tests). */
	now?: number
}

/**
 * Throughput used for the startup migration estimate, in operations (or rows) per second
 * on one core. Measured on a 2-core shared machine with Postgres 16 and SQLite (10,000
 * scalar operations re-folded in about 1.3 s, a 600-edit rich-text record in about 1.5 s),
 * then rounded down: the estimate is meant to warn early, not to be precise.
 */
export const MIGRATION_RATES = {
	/** Scalar operations re-folded (fold state, row and scope snapshot written). */
	refold: 5_000,
	/** Rich-text operations re-folded (one Yjs merge each). */
	richtext: 300,
	/** Operations whose scope snapshot is rebuilt from the log. */
	snapshot: 5_000,
	/** Rows read by a one-time full scan (integrity scan, legacy body pass, pair index). */
	scan: 100_000,
	/** Rows rewritten by a table rewrite (column type change, index build). */
	rewrite: 50_000,
} as const

/** A startup longer than this is reported, so the deploy can plan for it. */
export const SLOW_STARTUP_SECONDS = 60

/** Rows of one kind a check lists by id before summarizing. */
const SAMPLE_SIZE = 5

/** Run every database check, in a fixed order. Never writes. */
export async function runDatabaseChecks(
	db: DoctorDatabase,
	options: DatabaseCheckOptions,
): Promise<DoctorCheckResult[]> {
	const layout = await readLayout(db)
	const results: DoctorCheckResult[] = []
	if (!layout.tables.has('operations')) {
		results.push({
			id: 'db-layout',
			title: 'Database',
			status: 'fail',
			message: `${db.displayName} (${db.dialect}) has no Kora operations table: it is not a Kora sync server database, or it is another schema of it.`,
			fix: 'Point --db at the database the sync server uses (for Postgres, include the schema the server writes to, for example ?search_path=...).',
		})
		return results
	}
	results.push({
		id: 'db-layout',
		title: 'Database',
		status: 'pass',
		message: `${db.displayName} (${db.dialect}): ${layout.operationCount} operation(s), ${describeEra(layout)}. Opened read-only.`,
	})

	const schema = options.schema
	if (schema) {
		results.push(await checkSchemaDrift(db, layout, schema))
		results.push(checkConstraintWhere(schema))
		results.push(await checkJsonStrings(db, layout, schema))
	} else {
		for (const [id, title] of [
			['db-schema-drift', 'Schema drift'],
			['db-constraint-where', 'Constraint where clauses'],
			['db-json-strings', 'JSON values stored as strings'],
		] as const) {
			results.push({ id, title, status: 'skip', message: 'Skipped: the app schema did not load.' })
		}
	}
	results.push(await checkOwnerlessNodes(db, layout, options.usesKoraAuth))
	results.push(await checkProtocolOneClients(db, layout))
	results.push(await checkQuarantine(db, layout))
	const pending = await checkPendingMigrations(db, layout.tables, options.migrationsDir)
	results.push(pending.result)
	results.push(
		schema
			? await checkStartupMigration(db, layout, schema, pending)
			: {
					id: 'db-startup-migration',
					title: 'Startup migration dry run',
					status: 'skip',
					message: 'Skipped: the app schema did not load.',
				},
	)
	return results
}

/** What the database holds, read once. */
interface Layout {
	tables: Set<string>
	/** `kora_server_meta`, empty when the table is missing (beta.12 and earlier). */
	meta: Map<string, string>
	operationsColumns: Map<string, string>
	operationCount: number
	/** Node ids the server authors (or authored) under, besides the `kora:` namespace. */
	serverNodeIds: Set<string>
}

async function readLayout(db: DoctorDatabase): Promise<Layout> {
	const tableRows =
		db.dialect === 'postgres'
			? await db.all(
					'SELECT table_name::text AS name FROM information_schema.tables WHERE table_schema = current_schema()',
				)
			: await db.all(`SELECT name FROM sqlite_master WHERE type = 'table'`)
	const tables = new Set(tableRows.map((row) => String(row.name)))
	const meta = new Map<string, string>()
	if (tables.has('kora_server_meta')) {
		for (const row of await db.all('SELECT key, value FROM kora_server_meta')) {
			meta.set(String(row.key), String(row.value))
		}
	}
	const operationsColumns = tables.has('operations')
		? await columnsOf(db, 'operations')
		: new Map<string, string>()
	const operationCount = tables.has('operations')
		? count(await db.all('SELECT COUNT(*) AS n FROM operations'))
		: 0
	const serverNodeIds = new Set<string>()
	for (const key of [SERVER_LEGACY_AUTHORITY_KEY, SERVER_EVER_AUTHORITY_KEY]) {
		for (const id of parseIdList(meta.get(key))) serverNodeIds.add(id)
	}
	return { tables, meta, operationsColumns, operationCount, serverNodeIds }
}

function describeEra(layout: Layout): string {
	if (!layout.meta.has(SERVER_LOG_INTEGRITY_META_KEY)) {
		return 'never started by Kora 1.0.0-beta.13 or later'
	}
	const since = Number(layout.meta.get(SERVER_LOG_INTEGRITY_META_KEY))
	return Number.isFinite(since) && since > 0
		? `served by Kora 1.0.0-beta.13 or later since ${new Date(since).toISOString()}`
		: 'served by Kora 1.0.0-beta.13 or later'
}

// ---------------------------------------------------------------------------
// Schema drift
// ---------------------------------------------------------------------------

/** The column type the server store creates for a field (`@korajs/server` materialization). */
export function expectedColumnType(
	descriptor: Pick<FieldDescriptor, 'kind'>,
	dialect: DoctorDatabase['dialect'],
): string {
	switch (descriptor.kind) {
		case 'number':
			return dialect === 'postgres' ? 'double precision' : 'REAL'
		case 'boolean':
			return dialect === 'postgres' ? 'integer' : 'INTEGER'
		case 'timestamp':
			return dialect === 'postgres' ? 'bigint' : 'INTEGER'
		case 'array':
		case 'object':
		case 'json':
			return dialect === 'postgres' ? 'jsonb' : 'TEXT'
		case 'richtext':
			return dialect === 'postgres' ? 'bytea' : 'BLOB'
		default:
			return dialect === 'postgres' ? 'text' : 'TEXT'
	}
}

async function columnsOf(db: DoctorDatabase, table: string): Promise<Map<string, string>> {
	const rows =
		db.dialect === 'postgres'
			? await db.all(
					'SELECT column_name::text AS name, data_type::text AS type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?',
					[table],
				)
			: await db.all('SELECT name, type FROM pragma_table_info(?)', [table])
	return new Map(rows.map((row) => [String(row.name), String(row.type)]))
}

/** SQLite numeric affinities convert losslessly between each other (1 stays 1, 1.5 stays 1.5). */
const SQLITE_NUMERIC = new Set(['INTEGER', 'REAL'])

function sameType(actual: string, expected: string, dialect: DoctorDatabase['dialect']): boolean {
	if (dialect === 'postgres') return actual.toLowerCase() === expected
	const a = actual.toUpperCase()
	const e = expected.toUpperCase()
	return a === e || (SQLITE_NUMERIC.has(a) && SQLITE_NUMERIC.has(e))
}

async function checkSchemaDrift(
	db: DoctorDatabase,
	layout: Layout,
	schema: SchemaDefinition,
): Promise<DoctorCheckResult> {
	const mismatched: string[] = []
	const added: string[] = []
	const newTables: string[] = []
	const leftover: string[] = []
	for (const [collection, definition] of Object.entries(schema.collections)) {
		if (!layout.tables.has(collection)) {
			newTables.push(collection)
			continue
		}
		const columns = await columnsOf(db, collection)
		for (const [field, descriptor] of Object.entries(definition.fields)) {
			const actual = columns.get(field)
			if (actual === undefined) {
				added.push(`${collection}.${field}`)
				continue
			}
			const expected = expectedColumnType(descriptor, db.dialect)
			if (!sameType(actual, expected, db.dialect)) {
				mismatched.push(
					`${collection}.${field} is ${actual}, the schema's ${descriptor.kind} field needs ${expected}`,
				)
			}
		}
		for (const column of columns.keys()) {
			if (column === 'id' || column.startsWith('_')) continue
			if (!(column in definition.fields)) leftover.push(`${collection}.${column}`)
		}
	}

	// Collections the log holds that the schema no longer has: kept, never served.
	const orphaned: string[] = []
	for (const row of await db.all(
		'SELECT collection, COUNT(*) AS n FROM operations GROUP BY collection ORDER BY collection',
	)) {
		const name = String(row.collection)
		if (!(name in schema.collections)) orphaned.push(`${name} (${count([row])} operations)`)
	}

	// The newest schema version the log holds: a lower app version is a schema rollback.
	const newest = count(
		await db.all(
			`SELECT COALESCE(MAX(schema_version), 0) AS n FROM operations WHERE node_id NOT LIKE '${RESERVED_NODE_PREFIX}%'`,
		),
	)

	const notes: string[] = []
	if (newTables.length > 0)
		notes.push(`new collection(s) created at the next start: ${newTables.join(', ')}`)
	if (added.length > 0) notes.push(`column(s) added at the next start: ${list(added)}`)
	if (leftover.length > 0)
		notes.push(`column(s) the schema no longer has (kept, unused): ${list(leftover)}`)
	if (orphaned.length > 0)
		notes.push(
			`operations of collections the schema no longer has (kept, not served): ${list(orphaned)}`,
		)

	if (mismatched.length > 0) {
		return {
			id: 'db-schema-drift',
			title: 'Schema drift',
			status: 'fail',
			message: `Column types differ from what the schema's field kinds need, and the server does not change a column's type on start: ${list(mismatched)}.${notes.length > 0 ? ` Also: ${notes.join('; ')}.` : ''}`,
			fix: 'Generate and apply the migration for the field kind change: `kora migrate`, then `kora migrate --apply` against this database before deploying.',
		}
	}
	if (newest > schema.version) {
		return {
			id: 'db-schema-drift',
			title: 'Schema drift',
			status: 'warn',
			message: `The database holds operations written under schema v${newest}, but the app's schema is v${schema.version}: this deploy would roll the schema back (unless the server accepts newer client schemas on purpose).${notes.length > 0 ? ` Also: ${notes.join('; ')}.` : ''}`,
			fix: 'Deploy the schema the database was last served with (or a later one), not an older build.',
		}
	}
	return {
		id: 'db-schema-drift',
		title: 'Schema drift',
		status: 'pass',
		message:
			notes.length > 0
				? `Every existing column has the type its field needs. ${capitalize(notes.join('; '))}.`
				: `Tables and columns match schema v${schema.version}.`,
	}
}

// ---------------------------------------------------------------------------
// Constraint where clauses
// ---------------------------------------------------------------------------

/** Field kinds stored serialized or opaque: an equality `where` on them never matches. */
const UNMATCHABLE_KINDS = new Set(['array', 'object', 'json', 'richtext', 'blob', 'secret'])

/**
 * Why a unique / capacity constraint's `where` entry can never select a record, or null.
 * `defineSchema` already refuses operator objects and unknown fields (F2); these are the
 * values it accepts that still never match: devices compare with `===` against the
 * record's value, the server with SQL `=` against the stored column.
 */
export function unmatchableWhereReason(
	descriptor: FieldDescriptor | undefined,
	field: string,
	value: unknown,
): string | null {
	if (value === null || value === undefined) {
		return `${field}: null (SQL "= NULL" is never true, so the server never applies the constraint, while devices do)`
	}
	if (field === 'id')
		return typeof value === 'string' ? null : `id: ${JSON.stringify(value)} is not a string`
	if (!descriptor) return null
	if (UNMATCHABLE_KINDS.has(descriptor.kind)) {
		return `${field}: a ${descriptor.kind} field is stored serialized, so it never equals a where value`
	}
	switch (descriptor.kind) {
		case 'boolean':
			return typeof value === 'boolean'
				? `${field}: ${String(value)} (the server stores booleans as 0/1 and cannot bind a boolean, so its constraint query fails)`
				: `${field}: ${JSON.stringify(value)} is not a boolean`
		case 'number':
			return typeof value === 'number' ? null : `${field}: ${JSON.stringify(value)} is not a number`
		case 'timestamp':
			return typeof value === 'number' && Number.isInteger(value)
				? null
				: `${field}: ${JSON.stringify(value)} is not a timestamp (integer milliseconds)`
		case 'enum':
			if (typeof value !== 'string') return `${field}: ${JSON.stringify(value)} is not a string`
			return descriptor.enumValues && !descriptor.enumValues.includes(value)
				? `${field}: "${value}" is not one of the enum's values (${descriptor.enumValues.join(', ')})`
				: null
		case 'string':
			return typeof value === 'string' ? null : `${field}: ${JSON.stringify(value)} is not a string`
		default:
			return null
	}
}

function checkConstraintWhere(schema: SchemaDefinition): DoctorCheckResult {
	const problems: string[] = []
	let declared = 0
	for (const [collection, definition] of Object.entries(schema.collections)) {
		;(definition.constraints ?? []).forEach((constraint, index) => {
			if (constraint.type === 'referential' || constraint.where === undefined) return
			declared++
			for (const [field, value] of Object.entries(constraint.where)) {
				const reason = unmatchableWhereReason(definition.fields[field], field, value)
				if (reason)
					problems.push(
						`${collection} constraint #${index + 1} (${constraint.type}) where ${reason}`,
					)
			}
		})
	}
	if (problems.length > 0) {
		return {
			id: 'db-constraint-where',
			title: 'Constraint where clauses',
			status: 'fail',
			message: `Constraint where clause(s) that can never select a record, so the constraint is not enforced as declared: ${problems.join('; ')}.`,
			fix: 'Use a string, number or enum field with a value of its type in the where (for a flag, a t.enum such as status: "active"), or enforce the rule in validateOperation.',
		}
	}
	return {
		id: 'db-constraint-where',
		title: 'Constraint where clauses',
		status: 'pass',
		message:
			declared === 0
				? 'No unique or capacity constraint uses a where clause.'
				: `${declared} constraint where clause(s) can match records.`,
	}
}

// ---------------------------------------------------------------------------
// JSON values stored as encoded strings (F14)
// ---------------------------------------------------------------------------

/** True when operations were stored before the database's first beta.13+ start. */
async function hasLegacyHistory(db: DoctorDatabase, layout: Layout): Promise<boolean> {
	const since = Number(layout.meta.get(SERVER_LOG_INTEGRITY_META_KEY))
	if (!Number.isFinite(since) || since <= 0) return layout.operationCount > 0
	return (
		count(
			await db.all(
				'SELECT COUNT(*) AS n FROM (SELECT 1 FROM operations WHERE received_at < ? LIMIT 1) x',
				[since],
			),
		) > 0
	)
}

/** A string whose content parses as a JSON object, array or string (one encoded layer). */
export function isEncodedJson(value: unknown): boolean {
	if (typeof value !== 'string') return false
	const trimmed = value.trim()
	const first = trimmed[0]
	if (first !== '{' && first !== '[' && first !== '"') return false
	try {
		JSON.parse(trimmed)
		return true
	} catch {
		return false
	}
}

async function checkJsonStrings(
	db: DoctorDatabase,
	layout: Layout,
	schema: SchemaDefinition,
): Promise<DoctorCheckResult> {
	const found: string[] = []
	let total = 0
	// F14 is an upgrade artifact: since beta.13 a row holds exactly what was written, so a
	// json string on a database that never ran an older server is the app's own value.
	if (!(await hasLegacyHistory(db, layout))) {
		return {
			id: 'db-json-strings',
			title: 'JSON values stored as strings',
			status: 'pass',
			message:
				'The log holds no history from a server older than 1.0.0-beta.13, so stored json values are exactly what the app wrote.',
		}
	}
	for (const [collection, definition] of Object.entries(schema.collections)) {
		if (!layout.tables.has(collection)) continue
		const columns = await columnsOf(db, collection)
		for (const [field, descriptor] of Object.entries(definition.fields)) {
			if (descriptor.kind !== 'json' && descriptor.kind !== 'object') continue
			if (!columns.has(field)) continue
			const hits = await encodedJsonRows(db, collection, field, descriptor.kind)
			if (hits.count === 0) continue
			total += hits.count
			found.push(
				`${collection}.${field}: ${hits.count} row(s)${hits.sample.length > 0 ? ` (e.g. ${hits.sample.join(', ')})` : ''}`,
			)
		}
	}
	if (found.length > 0) {
		return {
			id: 'db-json-strings',
			title: 'JSON values stored as strings',
			status: 'warn',
			message: `${total} live row(s) of t.json()/t.object() fields hold a JSON-encoded string where the app likely expects an object (F14; servers before beta.13 decoded one layer of these): ${found.join('; ')}. A string is also a valid json value, so check what your app writes.`,
			fix: 'If these should be objects, rewrite them with server-authored updates (server.kora.apply); findJsonStringValues(store) in @korajs/server lists them.',
		}
	}
	return {
		id: 'db-json-strings',
		title: 'JSON values stored as strings',
		status: 'pass',
		message: 'No t.json()/t.object() value is a JSON-encoded string.',
	}
}

/**
 * Rows whose field reads back (as the server deserializes it) as a string holding JSON.
 * Postgres `object` columns are skipped: the server parses a JSONB string of an object
 * field, so the app receives an object, never the string.
 */
async function encodedJsonRows(
	db: DoctorDatabase,
	collection: string,
	field: string,
	kind: 'json' | 'object',
): Promise<{ count: number; sample: string[] }> {
	const table = quote(collection)
	const column = quote(field)
	let rows: DoctorRow[]
	if (db.dialect === 'postgres') {
		if (kind === 'object') return { count: 0, sample: [] }
		rows = await db.all(
			`SELECT id, ${column} #>> '{}' AS v FROM ${table}
				WHERE _deleted = 0 AND jsonb_typeof(${column}) = 'string' AND (${column} #>> '{}') ~ '^\\s*[\\[{"]'
				ORDER BY id`,
		)
	} else {
		rows = await db.all(
			`SELECT id, json_extract(${column}, '$') AS v FROM ${table}
				WHERE _deleted = 0 AND (CASE WHEN json_valid(${column}) THEN json_type(${column}) END) = 'text'
				AND substr(ltrim(json_extract(${column}, '$'), ' ' || char(9, 10, 13)), 1, 1) IN ('{', '[', '"')
				ORDER BY id`,
		)
	}
	const sample: string[] = []
	let hits = 0
	for (const row of rows) {
		if (!isEncodedJson(row.v)) continue
		hits++
		if (sample.length < SAMPLE_SIZE) sample.push(String(row.id))
	}
	return { count: hits, sample }
}

// ---------------------------------------------------------------------------
// Ownerless nodes
// ---------------------------------------------------------------------------

async function checkOwnerlessNodes(
	db: DoctorDatabase,
	layout: Layout,
	usesKoraAuth: boolean,
): Promise<DoctorCheckResult> {
	const title = 'Ownerless nodes'
	const hasClaims = layout.tables.has('node_claims')
	const rows = await db.all(
		`SELECT o.node_id AS node_id, COUNT(*) AS n FROM operations o
			WHERE o.node_id NOT LIKE '${RESERVED_NODE_PREFIX}%'
			${hasClaims ? `AND NOT EXISTS (SELECT 1 FROM node_claims c WHERE c.node_id = o.node_id AND c.user_id <> '${RELEASED_NODE_OWNER}')` : ''}
			GROUP BY o.node_id ORDER BY o.node_id`,
	)
	const ownerless = rows.filter((row) => !layout.serverNodeIds.has(String(row.node_id)))
	if (ownerless.length === 0) {
		return {
			id: 'db-ownerless-nodes',
			title,
			status: 'pass',
			message: 'Every device node with history has an owner.',
		}
	}
	const ops = ownerless.reduce((sum, row) => sum + Number(row.n), 0)
	const summary = `${ownerless.length} device node(s) hold ${ops} operation(s) but no owner (written before node claims existed, or released)`
	if (!hasClaims) {
		return {
			id: 'db-ownerless-nodes',
			title,
			status: 'warn',
			message: `${summary}: this database was written by Kora 1.0.0-beta.12 or earlier. With authentication, each such device must be bound to its user before it can sync again${usesKoraAuth ? ' (@korajs/auth devices are handed over automatically at their next signed-in handshake, provided their accounts still exist)' : ''}.`,
			fix: 'Read "Upgrading a beta.12 server database with authentication" in docs/guide/production-server.md before deploying.',
		}
	}
	const realClaims = count(
		await db.all(`SELECT COUNT(*) AS n FROM node_claims WHERE user_id <> '${RELEASED_NODE_OWNER}'`),
	)
	if (realClaims === 0) {
		return {
			id: 'db-ownerless-nodes',
			title,
			status: 'pass',
			message:
				'No node is claimed: the server runs without authentication, so node ownership does not apply.',
		}
	}
	// Already served by a release with node claims: this deploy changes nothing for these
	// nodes, so it is reported, never warned about (a warning on every healthy deploy
	// would teach operators to ignore the doctor).
	return {
		id: 'db-ownerless-nodes',
		title,
		status: 'pass',
		message: usesKoraAuth
			? `${summary}. With @korajs/auth the server hands such a node to its device's user at the next signed-in handshake (deviceNodeHandover).`
			: `${summary}. A signed-in device presenting one is refused (NODE_ID_CLAIMED) until it is bound, unless the AuthProvider reports a verified metadata.deviceId; node ids an older server wrote under itself are counted too. See docs/guide/production-server.md.`,
	}
}

// ---------------------------------------------------------------------------
// Protocol-1 clients
// ---------------------------------------------------------------------------

async function checkProtocolOneClients(
	db: DoctorDatabase,
	layout: Layout,
): Promise<DoctorCheckResult> {
	const title = 'Protocol-1 clients'
	const since = Number(layout.meta.get(SERVER_LOG_INTEGRITY_META_KEY))
	if (!layout.operationsColumns.has('hash_version') || !Number.isFinite(since) || since <= 0) {
		return {
			id: 'db-protocol-1',
			title,
			status: 'skip',
			message:
				'Not determinable: the database was never served by Kora 1.0.0-beta.13 or later, so every client so far spoke protocol 1.',
		}
	}
	// Protocol-2 clients write version-2 ids. An operation stamped after this database's
	// first beta.13+ start that is not version 2 was created by Kora <= beta.12 software
	// (verified version-1 ids, and unverifiable protocol-1 uploads stored with none).
	// Server-authored operations (the kora: namespace, legacy server ids) are excluded.
	// A device that later wrote a version-2 operation has upgraded: only nodes whose
	// newest write is still protocol 1 are reported, so the warning goes away on its own.
	const rows = await db.all(
		`SELECT p.node_id AS node_id, p.n AS n, p.last AS last FROM (
			SELECT node_id, COUNT(*) AS n, MAX(received_at) AS last, MAX(wall_time) AS newest
			FROM operations
			WHERE (hash_version IS NULL OR hash_version <> 2) AND wall_time > ?
			AND node_id NOT LIKE '${RESERVED_NODE_PREFIX}%'
			GROUP BY node_id
		) p
		WHERE NOT EXISTS (
			SELECT 1 FROM operations v WHERE v.node_id = p.node_id AND v.hash_version = 2
			AND v.wall_time > p.newest
		)`,
		[since],
	)
	const nodes = rows.filter((row) => !layout.serverNodeIds.has(String(row.node_id)))
	if (nodes.length === 0) {
		return {
			id: 'db-protocol-1',
			title,
			status: 'pass',
			message: `No operation written since ${new Date(since).toISOString()} came from a protocol-1 (Kora <= beta.12) client. Clients that only read are not recorded in the database.`,
		}
	}
	const last = Math.max(...nodes.map((row) => Number(row.last)))
	const ops = nodes.reduce((sum, row) => sum + Number(row.n), 0)
	return {
		id: 'db-protocol-1',
		title,
		status: 'warn',
		message: `${nodes.length} device(s) were still on Kora 1.0.0-beta.12 or earlier (protocol 1) at their latest write (${ops} operation(s) since the upgrade, the last received at ${new Date(last).toISOString()}). A server that no longer accepts protocol 1 refuses such devices, and their offline writes stay on the device. A device that has upgraded since but not written yet is counted too.`,
		fix: 'Make sure those devices have loaded the current app (a service worker update, a reload) before deploying a server that drops protocol 1.',
	}
}

// ---------------------------------------------------------------------------
// Quarantined rows
// ---------------------------------------------------------------------------

async function checkQuarantine(db: DoctorDatabase, layout: Layout): Promise<DoctorCheckResult> {
	if (!layout.tables.has(SERVER_LOG_QUARANTINE_TABLE)) {
		return {
			id: 'db-quarantine',
			title: 'Quarantined operations',
			status: 'pass',
			message: 'No quarantine table: nothing was quarantined.',
		}
	}
	const n = count(await db.all(`SELECT COUNT(*) AS n FROM ${SERVER_LOG_QUARANTINE_TABLE}`))
	if (n === 0) {
		return {
			id: 'db-quarantine',
			title: 'Quarantined operations',
			status: 'pass',
			message: 'No operation row is quarantined.',
		}
	}
	return {
		id: 'db-quarantine',
		title: 'Quarantined operations',
		status: 'warn',
		message: `${n} unreadable operation row(s) are kept in ${SERVER_LOG_QUARANTINE_TABLE}: the records they belong to are materialized from an incomplete log.`,
		fix: 'See "Operation log integrity" in docs/guide/production-server.md to repair or release them.',
	}
}

// ---------------------------------------------------------------------------
// Startup migration dry run
// ---------------------------------------------------------------------------

/** One unit of startup work the next start will do. */
interface StartupStep {
	what: string
	seconds: number
}

async function checkStartupMigration(
	db: DoctorDatabase,
	layout: Layout,
	schema: SchemaDefinition,
	pending: PendingMigrationReport,
): Promise<DoctorCheckResult> {
	const steps: StartupStep[] = []
	const collections = Object.keys(schema.collections)
	const inList = collections.map(() => '?').join(', ')
	const perCollection =
		collections.length === 0
			? []
			: await db.all(
					`SELECT collection, COUNT(DISTINCT record_id) AS records, COUNT(*) AS ops FROM operations
						WHERE collection IN (${inList}) GROUP BY collection`,
					collections,
				)
	const totalRecords = perCollection.reduce((sum, row) => sum + Number(row.records), 0)
	const totalOps = perCollection.reduce((sum, row) => sum + Number(row.ops), 0)

	// Re-materialization (record fold states).
	const stored = layout.meta.get(FOLD_PLAN_FINGERPRINT_KEY)
	let refoldReason: string | null = null
	if (!layout.tables.has('kora_fold_state') || stored === undefined) {
		refoldReason = 'first start of a release with fold states (from beta.12 or earlier)'
	} else {
		const plan = replannedCollections(stored, schema)
		if (plan.formatChanged) refoldReason = 'the fold-state format changed'
		else if (plan.collections.length > 0)
			refoldReason = `the merge plan of ${plan.collections.join(', ')} changed`
		else if (plan.hasTransforms && !stored.includes(`xf@v${schema.version}(`))
			refoldReason = `the schema version changed to v${schema.version} with operation transforms registered`
	}
	if (refoldReason !== null && totalRecords > 0) {
		const richtext = await countRichtextOperations(db, schema)
		steps.push({
			what: `re-fold every record (${totalRecords} record(s), ${totalOps} operation(s)${richtext > 0 ? `, ${richtext} rich-text` : ''}) because ${refoldReason}`,
			seconds: (totalOps - richtext) / MIGRATION_RATES.refold + richtext / MIGRATION_RATES.richtext,
		})
	} else if (refoldReason === null && collections.length > 0 && stored !== undefined) {
		const stale = await staleRecords(
			db,
			collections,
			stored,
			await columnsOf(db, 'kora_fold_state'),
		)
		if (stale.records > 0) {
			steps.push({
				what: `re-fold ${stale.records} record(s) with a missing or outdated fold state (${stale.ops} operation(s))`,
				seconds: stale.ops / MIGRATION_RATES.refold,
			})
		}
	}

	// Scope snapshots.
	const snapshotColumn = layout.operationsColumns.has('scope_snapshot')
	const snapshotStored = layout.meta.get(SCOPE_SNAPSHOT_FINGERPRINT_KEY)
	if (!snapshotColumn || snapshotStored !== scopeSnapshotFingerprint(schema)) {
		if (totalOps > 0) {
			steps.push({
				what: `rebuild the scope snapshot of every operation (${totalOps}) because ${!snapshotColumn || snapshotStored === undefined ? 'none were captured yet' : 'the scalar fields of the schema changed'}`,
				seconds:
					totalOps / MIGRATION_RATES.snapshot + layout.operationCount / MIGRATION_RATES.rewrite,
			})
		}
	} else if (collections.length > 0) {
		const missing = count(
			await db.all(
				`SELECT COUNT(*) AS n FROM operations WHERE scope_snapshot IS NULL AND collection IN (${inList})`,
				collections,
			),
		)
		if (missing > 0) {
			steps.push({
				what: `capture ${missing} missing scope snapshot(s)`,
				seconds: missing / MIGRATION_RATES.snapshot,
			})
		}
	}

	// One-time passes of the first beta.13+ start.
	if (!layout.meta.has(SERVER_LOG_INTEGRITY_META_KEY) && layout.operationCount > 0) {
		steps.push({
			what: `one-time passes over the whole log (integrity scan, legacy bodies, sequence pairs; ${layout.operationCount} row(s))`,
			seconds: (3 * layout.operationCount) / MIGRATION_RATES.scan,
		})
	}
	if (layout.operationsColumns.has('delivery_seq')) {
		const unsequenced = count(
			await db.all('SELECT COUNT(*) AS n FROM operations WHERE delivery_seq IS NULL'),
		)
		if (unsequenced > 0) {
			steps.push({
				what: `assign delivery sequences to ${unsequenced} operation(s)`,
				seconds: unsequenced / MIGRATION_RATES.rewrite,
			})
		}
	}
	if (db.dialect === 'postgres') {
		const narrow = await db.all(
			`SELECT table_name::text AS t FROM information_schema.columns WHERE table_schema = current_schema()
				AND data_type = 'integer' AND ((table_name = 'operations' AND column_name = 'sequence_number')
				OR (table_name = 'sync_state' AND column_name = 'max_sequence_number'))`,
		)
		if (narrow.some((row) => row.t === 'operations') && layout.operationCount > 0) {
			steps.push({
				what: `widen operations.sequence_number to BIGINT (rewrites the operations table, ${layout.operationCount} row(s), under an exclusive lock: writes wait)`,
				seconds: layout.operationCount / MIGRATION_RATES.rewrite,
			})
		}
	}

	const seconds = steps.reduce((sum, step) => sum + step.seconds, 0)
	const migrations =
		pending.unapplied > 0
			? ` (${pending.unapplied} generated migration(s) are not recorded as applied; see above)`
			: ''
	if (steps.length === 0) {
		return {
			id: 'db-startup-migration',
			title: 'Startup migration dry run',
			status: 'pass',
			message: `The next start with schema v${schema.version} re-folds nothing: setup is a few catalog statements${migrations}.`,
		}
	}
	const message = `The next start with schema v${schema.version} will ${steps.map((step) => step.what).join('; ')}. Estimated ${formatDuration(seconds)} before the server answers /health (rough: measured on 2 cores; a slower or remote database can take several times longer)${migrations}.`
	if (seconds > SLOW_STARTUP_SECONDS) {
		return {
			id: 'db-startup-migration',
			title: 'Startup migration dry run',
			status: 'warn',
			message,
			fix: 'Give the startup probe a budget that covers it for this deploy (or raise its failure threshold), and expect sync to be unavailable meanwhile. A killed start resumes where it stopped.',
		}
	}
	return { id: 'db-startup-migration', title: 'Startup migration dry run', status: 'pass', message }
}

/** Records the next start re-folds under an unchanged plan (the server's own staleness test). */
async function staleRecords(
	db: DoctorDatabase,
	collections: string[],
	storedFingerprint: string,
	foldColumns: ReadonlyMap<string, string>,
): Promise<{ records: number; ops: number }> {
	const stamp = createHash('sha256').update(storedFingerprint).digest('hex').slice(0, 16)
	// beta.13 and beta.14 fold states have no `plan` column; the server adds it as '' on
	// start, which matches every plan, so its absence marks nothing stale.
	const planTest = foldColumns.has('plan') ? `OR (f.plan <> '' AND f.plan <> ?)` : ''
	const coveredTest = foldColumns.has('covered_op_id')
		? 'OR NOT EXISTS (SELECT 1 FROM operations x WHERE x.id = f.covered_op_id AND x.delivery_seq = f.covered_seq)'
		: ''
	const rows = await db.all(
		`SELECT COUNT(*) AS records, COALESCE(SUM(r.op_count), 0) AS ops FROM (
			SELECT o.collection AS collection, o.record_id AS record_id, MAX(o.delivery_seq) AS max_seq, COUNT(*) AS op_count
			FROM operations o WHERE o.collection IN (${collections.map(() => '?').join(', ')})
			GROUP BY o.collection, o.record_id
		) r LEFT JOIN kora_fold_state f ON f.collection = r.collection AND f.record_id = r.record_id
		WHERE f.covered_seq IS NULL OR f.covered_seq <> r.max_seq
			${coveredTest}
			${planTest}`,
		foldColumns.has('plan') ? [...collections, stamp] : collections,
	)
	return { records: count(rows), ops: Number(rows[0]?.ops ?? 0) }
}

/** Operations writing a rich-text field (one Yjs merge each when re-folded). */
async function countRichtextOperations(
	db: DoctorDatabase,
	schema: SchemaDefinition,
): Promise<number> {
	let total = 0
	for (const [collection, definition] of Object.entries(schema.collections)) {
		const fields = Object.entries(definition.fields)
			.filter(([, descriptor]) => descriptor.kind === 'richtext')
			.map(([name]) => name)
		if (fields.length === 0) continue
		const likes = fields.map(() => 'data LIKE ?').join(' OR ')
		total += count(
			await db.all(`SELECT COUNT(*) AS n FROM operations WHERE collection = ? AND (${likes})`, [
				collection,
				...fields.map((field) => `%"${field}":%`),
			]),
		)
	}
	return total
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function count(rows: DoctorRow[]): number {
	const value = rows[0]?.n ?? rows[0]?.records ?? 0
	const n = Number(value)
	return Number.isFinite(n) ? n : 0
}

function parseIdList(raw: string | undefined): string[] {
	if (!raw) return []
	try {
		const parsed: unknown = JSON.parse(raw)
		return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
	} catch {
		return []
	}
}

function quote(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`
}

function list(items: string[]): string {
	return items.length <= 8
		? items.join(', ')
		: `${items.slice(0, 8).join(', ')} and ${items.length - 8} more`
}

function capitalize(text: string): string {
	return text.length > 0 ? `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}` : text
}

/** A duration for people: seconds under two minutes, else minutes (or hours). */
export function formatDuration(seconds: number): string {
	if (seconds < 1) return 'under a second'
	if (seconds < 120) return `about ${Math.round(seconds)} s`
	if (seconds < 7_200) return `about ${Math.round(seconds / 60)} min`
	return `about ${(seconds / 3_600).toFixed(1)} h`
}
