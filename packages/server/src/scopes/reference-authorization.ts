import type { Operation, SchemaDefinition } from '@korajs/core'
import { type BlobAccessIndex, asBlobRef, referencedHashes } from '../richtext/blob-access-index'
import type { MaterializedRecord } from '../store/server-store'
import {
	type ScopeMap,
	type UplinkAuthorizationResult,
	recordMatchesScopes,
} from './server-scope-filter'

/** Reads a record as stored (including a soft-deleted one), or null when never written. */
export type StoredRowReader = (
	collection: string,
	recordId: string,
) => Promise<MaterializedRecord | null>

/** What an untrusted write may point at, beyond the record it writes. */
export interface ReferenceAuthorizationContext {
	/** The server schema (relations and blob fields). */
	schema: SchemaDefinition | null
	/**
	 * What the writer may READ (its download scope). A reference is authorized against
	 * it: a writer may only point at records and content it could receive itself.
	 * Undefined means an unscoped writer (no tenant boundary): nothing is checked.
	 */
	downlinkScopes: ScopeMap | undefined
	/**
	 * What the writer may WRITE (its uplink scope), when it differs from what it may
	 * read. A foreign-key parent inside it is accepted too (RT-22): a respondent may
	 * attach answers to the submission it just created even though it can never read
	 * submissions back. Blob references are still judged on the download scope only.
	 */
	uplinkScopes?: ScopeMap | undefined
	/** Reads a stored row, inside the writer's transaction when one is available. */
	readRow: StoredRowReader
	/** Blob reference authority (RT-11). Without it blob fields are not checked. */
	blobs?: BlobAccessIndex
	/** Ownership key of the writer for blob claims (see `BlobReferenceRequest.owner`). */
	blobOwner?: string
}

/**
 * Authorize the references an untrusted write makes (RT-11, RT-13), after its own
 * record passed `authorizeUplinkWrite`:
 *
 * - **Foreign keys (RT-13).** For an insert, or an update that sets a relation field,
 *   the referenced parent must exist (a soft-deleted parent counts, as stored) and be
 *   inside the writer's download scope or its upload scope (RT-22: a record the writer
 *   was allowed to create, even if it cannot read it back). Otherwise a tenant could hang a child under
 *   another tenant's record (leaving its owner unable to delete it under `restrict`,
 *   or probing which ids exist).
 * - **Blob references (RT-11).** Every hash a blob field makes readable (its
 *   `manifestHash`, or `hash` for a bare reference; see `referencedHashes`) must be
 *   one the writer may reference: see `BlobAccessIndex.authorizeReference`. A
 *   content hash is not a secret, so naming one grants nothing.
 *
 * Refusals are `SCOPE_VIOLATION` and name only the writer's own record and field.
 *
 * @param op - The (already uplink-authorized) operation
 * @param stored - The written record as stored now, or null
 * @param context - Schema, writer scope, row reader and blob authority
 */
export async function authorizeOperationReferences(
	op: Operation,
	stored: MaterializedRecord | null,
	context: ReferenceAuthorizationContext,
): Promise<UplinkAuthorizationResult> {
	const { schema, downlinkScopes } = context
	if (!schema || downlinkScopes === undefined) return { allowed: true }
	if (op.type === 'delete') return { allowed: true }
	const data = asRecord(op.data)
	if (!data) return { allowed: true }

	for (const relation of Object.values(schema.relations ?? {})) {
		if (relation.from !== op.collection || !(relation.field in data)) continue
		const target = data[relation.field]
		if (target === null || target === undefined) continue
		// An unchanged reference was already authorized when it was written.
		if (stored && Object.is(stored[relation.field], target)) continue
		if (typeof target !== 'string') {
			return violation(op, relation.field, 'the referenced record id is not a string')
		}
		const parent = await context.readRow(relation.to, target)
		const parentRow = parent ? { ...parent, id: target } : null
		// The parent must be a record the writer could read OR could have written itself
		// (RT-22). A parent in neither scope belongs to another tenant (RT-13).
		const reachable =
			parentRow !== null &&
			(recordMatchesScopes(relation.to, parentRow, downlinkScopes) ||
				(context.uplinkScopes !== undefined &&
					recordMatchesScopes(relation.to, parentRow, context.uplinkScopes)))
		if (!reachable) {
			return violation(
				op,
				relation.field,
				`the referenced "${relation.to}" record does not exist inside the writer's scope`,
			)
		}
	}

	const blobs = context.blobs
	const owner = context.blobOwner
	const collection = schema.collections[op.collection]
	if (blobs && owner !== undefined && collection) {
		const alreadyReferenced = new Set<string>()
		for (const [field, descriptor] of Object.entries(collection.fields)) {
			if (descriptor.kind !== 'blob' || !stored) continue
			const ref = asBlobRef(stored[field])
			if (ref) for (const hash of referencedHashes(ref)) alreadyReferenced.add(hash)
		}
		for (const [field, descriptor] of Object.entries(collection.fields)) {
			if (descriptor.kind !== 'blob' || !(field in data)) continue
			const value = data[field]
			if (value === null || value === undefined) continue
			const ref = asBlobRef(value)
			if (!ref) return violation(op, field, 'the value is not a blob reference')
			for (const hash of referencedHashes(ref)) {
				const allowed = await blobs.authorizeReference({
					hash,
					scopes: downlinkScopes,
					owner,
					alreadyReferenced,
				})
				if (!allowed) {
					return violation(
						op,
						field,
						'it references blob content the writer cannot read and has not uploaded',
					)
				}
			}
		}
	}
	return { allowed: true }
}

/**
 * True when an operation sets a relation field or a blob field, so its references
 * need authorizing (cheap pre-check that avoids a store read for every other write).
 */
export function operationHasReferences(op: Operation, schema: SchemaDefinition): boolean {
	if (op.type === 'delete') return false
	const data = asRecord(op.data)
	if (!data) return false
	for (const relation of Object.values(schema.relations ?? {})) {
		if (relation.from === op.collection && relation.field in data) return true
	}
	const fields = schema.collections[op.collection]?.fields ?? {}
	return Object.entries(fields).some(([name, field]) => field.kind === 'blob' && name in data)
}

function violation(op: Operation, field: string, reason: string): UplinkAuthorizationResult {
	return {
		allowed: false,
		code: 'SCOPE_VIOLATION',
		message: `Operation "${op.id}" on "${op.collection}" record "${op.recordId}" field "${field}" is outside the accepted scope: ${reason}.`,
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}
