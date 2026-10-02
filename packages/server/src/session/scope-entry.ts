import type { HLCTimestamp, Operation, SchemaDefinition } from '@korajs/core'
import { hashBlob } from '@korajs/core'
import type { MaterializedRecord } from '../store/server-store'

/**
 * Node id of server-synthesized scope-entry operations (RT-19). Reserved (`kora:`
 * prefix): no device can claim it, and no device ever uploads it, because every
 * scope-entry operation has sequence number 0, which no version-vector range covers.
 */
export const SCOPE_ENTRY_NODE_ID = 'kora:scope-entry'

/** True when an operation is a server-synthesized scope entry. */
export function isScopeEntryOperation(op: Operation): boolean {
	return op.nodeId === SCOPE_ENTRY_NODE_ID
}

/** Input to {@link buildScopeEntryOperation}. */
export interface ScopeEntryInput {
	/** The stored operation that moved the record into the session's scope. */
	trigger: Operation
	/** The record's current materialized row (live, inside the session's scope). */
	row: MaterializedRecord
	/** The server schema (decides which row columns are record fields). */
	schema: SchemaDefinition
	/**
	 * The record's newest stored HLC timestamp (its latest field write). The entry
	 * carries it so that, under per-field last-write-wins, it never overrides a field
	 * a client wrote more recently.
	 */
	timestamp: HLCTimestamp
	/** Server schema version stamped on the entry. */
	schemaVersion: number
}

/**
 * Build the scope-entry operation for a record that moved INTO a session's download
 * scope (RT-19, SRV-2, NEW-SRV-3).
 *
 * Since RT-14 a record's earlier operations are judged on the scope values they had
 * when applied, so a new owner never receives the history written while the record
 * belonged to someone else. Without more, the new owner receives only the
 * scope-changing update, which a client cannot materialize (it has no row). The
 * entry closes that gap: an `insert` carrying the record's CURRENT values (never its
 * history), so the client materializes exactly what the server holds now.
 *
 * Properties:
 * - **Deterministic id.** Derived from (collection, recordId, trigger op id), so
 *   every path and every resend yields the same id and a client applies it once
 *   (content-addressed dedup).
 * - **System node.** {@link SCOPE_ENTRY_NODE_ID}, sequence 0, no causal deps: it
 *   never enters a client's version vector or upload delta.
 * - **Never newer than the record.** Its timestamp is the record's newest HLC, so
 *   per-field LWW keeps any field a client wrote later; on a client that already
 *   holds the record (a stale retained copy) it merges like an insert collision.
 *
 * @param input - Trigger, current row, schema and the record's newest timestamp
 * @returns The synthesized insert
 */
export async function buildScopeEntryOperation(input: ScopeEntryInput): Promise<Operation> {
	const { trigger, row, schema } = input
	const definition = schema.collections[trigger.collection]
	const data: Record<string, unknown> = {}
	for (const field of Object.keys(definition?.fields ?? {})) {
		if (!(field in row)) continue
		const value = row[field]
		if (value === undefined) continue
		data[field] = toWireValue(value)
	}
	const id = await hashBlob(
		new TextEncoder().encode(
			`scope-entry\u0000${trigger.collection}\u0000${trigger.recordId}\u0000${trigger.id}`,
		),
	)
	return {
		id: `scope-entry-${id}`,
		nodeId: SCOPE_ENTRY_NODE_ID,
		type: 'insert',
		collection: trigger.collection,
		recordId: trigger.recordId,
		data,
		previousData: null,
		timestamp: { ...input.timestamp },
		sequenceNumber: 0,
		causalDeps: [],
		schemaVersion: input.schemaVersion,
	}
}

/**
 * Binary column values (richtext state) travel as the canonical tagged
 * `{ $koraBytes: base64 }` form, like client-authored operations.
 */
function toWireValue(value: unknown): unknown {
	if (value instanceof Uint8Array) {
		let binary = ''
		for (const byte of value) binary += String.fromCharCode(byte)
		return { $koraBytes: btoa(binary) }
	}
	return value
}
