import type { HLCTimestamp, Operation, RecordFieldVersions, SchemaDefinition } from '@korajs/core'
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
	 * The record's newest stored HLC timestamp (its latest field write). Used as the
	 * entry's timestamp only when per-field versions are unavailable (a custom store
	 * without {@link ScopeEntryInput.fieldVersions}): a whole-row stamp is then the
	 * best the server can do.
	 */
	timestamp: HLCTimestamp
	/**
	 * Per-field versions folded from the record's stored operations (RT-27). When
	 * present, the entry carries each field's own version and is stamped with the
	 * record's creation time, so a receiver resolves every field by last-write-wins
	 * against its own version of that field and keeps any newer local edit.
	 */
	fieldVersions?: RecordFieldVersions | null
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
 * - **Per-field versions (RT-27).** Every field carries the version of the write
 *   that produced its current value, and the entry's timestamp is the record's
 *   creation, so a receiver resolves each field by last-write-wins against its own
 *   version of it: a device's newer unsynced edit of a field the server last wrote
 *   long ago is kept (it uploads and wins on the server too), and `createdAt` is the
 *   record's real creation time. Without versions (a custom store) the entry falls
 *   back to one stamp, the record's newest HLC.
 *
 * @param input - Trigger, current row, schema and the record's newest timestamp
 * @returns The synthesized insert
 */
export async function buildScopeEntryOperation(input: ScopeEntryInput): Promise<Operation> {
	const { trigger, row, schema } = input
	const definition = schema.collections[trigger.collection]
	const data: Record<string, unknown> = {}
	const versioned = input.fieldVersions ?? null
	const fieldVersions: Record<string, HLCTimestamp> = {}
	for (const field of Object.keys(definition?.fields ?? {})) {
		if (!(field in row)) continue
		const value = row[field]
		if (value === undefined) continue
		data[field] = toWireValue(value)
		if (versioned) {
			// A column no operation ever wrote (a later schema default) is as old as
			// the record itself.
			fieldVersions[field] = { ...(versioned.fields[field] ?? versioned.created) }
		}
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
		timestamp: versioned ? { ...versioned.created } : { ...input.timestamp },
		sequenceNumber: 0,
		causalDeps: [],
		schemaVersion: input.schemaVersion,
		...(versioned ? { fieldVersions } : {}),
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
