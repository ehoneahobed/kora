import {
	HybridLogicalClock,
	canonicalizeLegacyOperation,
	canonicalizeOperationBody,
} from '@korajs/core'
import type { Operation } from '@korajs/core'
import { canonicalize } from '@korajs/core/internal'

/** Rejection code for an upload reusing a stored id with other content (RT-77). */
export const FORGED_DUPLICATE_CODE = 'FORGED_DUPLICATE'

/**
 * Whether an uploaded operation is the SAME operation as the one the server stores under
 * its id (RT-77): every field the id's hash version covers, in canonical form, is equal.
 * Only then may it be acknowledged as a duplicate (free of validators and rate charges)
 * and only the STORED operation's content ever drives effects.
 *
 * Compared per the stored operation's hash version:
 * - version 1: type, collection, recordId, data, timestamp, nodeId, atomicOps (what a
 *   beta.13 id covers; an own operation renumbered by sequence repair keeps its id);
 * - version 2: also previousData, sequenceNumber, causalDeps (as a set) and schemaVersion.
 * Bodies are compared canonical (core canonical-body), version-1 updates in their legacy
 * canonical form (a cleared field stored as null), so a beta.13 client re-sending what
 * the server stored with restored nulls is the same operation. An envelope's ciphertext
 * is not compared (it is re-sealed with a fresh nonce per upload); its header fields,
 * which the envelope's AAD binds, are.
 *
 * An upload that declares no hash version matches a stored one of any version; a
 * declared version must equal the stored one.
 *
 * @param upload - The operation as uploaded (or as the server would store it)
 * @param stored - The operation the store holds under the same id
 * @returns true when they are the same operation
 */
export function isSameStoredOperation(upload: Operation, stored: Operation): boolean {
	if (upload.id !== stored.id) return false
	const storedVersion = stored.hashVersion ?? 1
	if (upload.hashVersion !== undefined && upload.hashVersion !== storedVersion) return false
	const a = contentKey(upload, storedVersion)
	const b = contentKey(stored, storedVersion)
	return a !== null && a === b
}

function contentKey(op: Operation, version: 1 | 2): string | null {
	let body: Operation
	try {
		body = canonicalizeOperationBody(
			version === 1 ? canonicalizeLegacyOperation({ ...op, hashVersion: undefined }) : op,
		)
	} catch {
		// A body with no canonical form is never the same as a stored (canonical) one.
		return null
	}
	const atomicOps =
		body.atomicOps !== undefined && Object.keys(body.atomicOps).length > 0 ? body.atomicOps : null
	const key: Record<string, unknown> = {
		type: op.type,
		collection: op.collection,
		recordId: op.recordId,
		data: body.data,
		timestamp: HybridLogicalClock.serialize(op.timestamp),
		nodeId: op.nodeId,
		atomicOps,
		sealed: op.encrypted !== undefined,
	}
	if (version === 2) {
		key.previousData = body.previousData
		key.sequenceNumber = op.sequenceNumber
		key.causalDeps = [...op.causalDeps].sort()
		key.schemaVersion = op.schemaVersion
	}
	return canonicalize(key)
}
