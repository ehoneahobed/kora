import { generateUUIDv7 } from '@korajs/core'
import type { KoraEvent, MergeTrace } from '@korajs/core'
import type { StorageAdapter } from '../types'
import { deserializeAuditJson, serializeAuditJson } from './audit-json'
import type { AuditTraceQuery, PersistedAuditTrace } from './types'

interface AuditTraceRow {
	id: string
	recorded_at: number
	event_type: string
	collection: string
	record_id: string
	field: string
	strategy: string
	tier: number
	constraint_name: string | null
	trace_json: string
}

/**
 * Build a {@link PersistedAuditTrace} from a merge-related Kora event.
 */
export function persistedAuditTraceFromEvent(
	event: Extract<KoraEvent, { type: 'merge:completed' | 'merge:conflict' | 'constraint:violated' }>,
): PersistedAuditTrace {
	return {
		id: generateUUIDv7(),
		recordedAt: Date.now(),
		eventType: event.type,
		constraint: event.type === 'constraint:violated' ? event.constraint : undefined,
		trace: event.trace,
	}
}

function auditInsertStatement(trace: PersistedAuditTrace): { sql: string; params: unknown[] } {
	const collection = trace.trace.operationA.collection
	const recordId = trace.trace.operationA.recordId
	return {
		sql: `INSERT INTO _kora_audit_traces (
			id, recorded_at, event_type, collection, record_id, field, strategy, tier, constraint_name, trace_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		params: [
			trace.id,
			trace.recordedAt,
			trace.eventType,
			collection,
			recordId,
			trace.trace.field,
			trace.trace.strategy,
			trace.trace.tier,
			trace.constraint ?? null,
			serializeAuditJson(trace),
		],
	}
}

/**
 * Append a merge trace to the durable audit log.
 */
export async function appendAuditTrace(
	adapter: StorageAdapter,
	trace: PersistedAuditTrace,
): Promise<void> {
	const statement = auditInsertStatement(trace)
	await adapter.execute(statement.sql, statement.params)
}

/**
 * Append several merge traces in one transaction (C3b): a delivery batch with many
 * conflicts used to cost one autocommit write, and on OPFS one journal commit, per trace.
 * All or none land; the caller falls back to {@link appendAuditTrace} per trace when this
 * rejects, so one bad row never costs the others.
 */
export async function appendAuditTraces(
	adapter: StorageAdapter,
	traces: readonly PersistedAuditTrace[],
): Promise<void> {
	const statements = traces.map(auditInsertStatement)
	await adapter.transaction(async (tx) => {
		if (tx.executeBatch) {
			await tx.executeBatch(statements)
			return
		}
		for (const statement of statements) await tx.execute(statement.sql, statement.params)
	})
}

/**
 * Load persisted audit traces with optional filters.
 */
export async function readAuditTraces(
	adapter: StorageAdapter,
	query?: AuditTraceQuery,
): Promise<PersistedAuditTrace[]> {
	const conditions: string[] = []
	const params: unknown[] = []

	if (query?.collections && query.collections.length > 0) {
		const placeholders = query.collections.map(() => '?').join(', ')
		conditions.push(`collection IN (${placeholders})`)
		params.push(...query.collections)
	}
	if (query?.since !== undefined) {
		conditions.push('recorded_at >= ?')
		params.push(query.since)
	}
	if (query?.until !== undefined) {
		conditions.push('recorded_at <= ?')
		params.push(query.until)
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
	const rows = await adapter.query<AuditTraceRow>(
		`SELECT * FROM _kora_audit_traces ${whereClause} ORDER BY recorded_at ASC, id ASC`,
		params,
	)

	return rows.map(rowToPersistedTrace)
}

function rowToPersistedTrace(row: AuditTraceRow): PersistedAuditTrace {
	return deserializeAuditJson<PersistedAuditTrace>(row.trace_json)
}

/**
 * Count persisted audit traces (for diagnostics).
 */
export async function countAuditTraces(adapter: StorageAdapter): Promise<number> {
	const rows = await adapter.query<{ count: number }>(
		'SELECT COUNT(*) as count FROM _kora_audit_traces',
	)
	return rows[0]?.count ?? 0
}

/**
 * Extract collection and record id from a merge trace for indexing.
 */
export function auditTraceIndexFields(trace: MergeTrace): {
	collection: string
	recordId: string
} {
	return {
		collection: trace.operationA.collection,
		recordId: trace.operationA.recordId,
	}
}
