import {
	HybridLogicalClock,
	canonicalizeLegacyOperation,
	canonicalizeOperationBody,
} from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import { canonicalize } from '@korajs/core/internal'
import { operationIdMatches } from '@korajs/sync/internal'

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
 *   beta.12 id covers; an own operation renumbered by sequence repair keeps its id);
 * - version 2: also previousData, sequenceNumber, causalDeps (as a set) and schemaVersion.
 * Bodies are compared canonical (core canonical-body), version-1 updates in their legacy
 * canonical form (a cleared field stored as null), so a beta.12 client re-sending what
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

/**
 * {@link isSameStoredOperation}, plus the stored copies earlier releases REWROTE under
 * the original id (RT-84): before transforms ran at fold time, a server stored a
 * schema-transformed operation (and beta.12 servers stored protocol-1 ciphertext
 * re-encrypted per upload) under the id of what the client sent, without a hash
 * version. Such a copy is not the content its id names, so its body can never equal an
 * honest re-upload. It is recognised by exactly that: it declares no hash version and
 * its id does not verify against its own content (with every beta.12 hash rebuild).
 * For it, identity is the header the id was computed with and the server never
 * rewrote: id, node, type, collection, record and timestamp. Effects of a duplicate are
 * still derived from the STORED copy only (RT-77), so this widens nothing an upload
 * could influence.
 *
 * Copies stored by this release are the operation as uploaded (plus a verified hash
 * version declaration and a beta.12 clear made explicit, both identical under the id),
 * so they always take the exact comparison.
 *
 * @param upload - The operation as uploaded
 * @param stored - The operation the store holds under the same id
 * @param schema - The server schema (for beta.12 nested-member hash rebuilds)
 */
export async function isSameOperationAsStored(
	upload: Operation,
	stored: Operation,
	schema: SchemaDefinition | null,
): Promise<boolean> {
	if (isSameStoredOperation(upload, stored)) return true
	if (upload.id !== stored.id) return false
	if (stored.hashVersion !== undefined || stored.encrypted !== undefined) return false
	if (await operationIdMatches(stored, schema)) return false
	return sameHeader(upload, stored)
}

/**
 * Whether an upload is a device's echo of ANOTHER node's operation that the device's
 * earlier release stored REWRITTEN (RT-84): before transforms ran at fold time, devices
 * stored a delivered operation of another schema version as its transformed copy under
 * the original id (keeping its declared hash version). Such a body does not verify
 * against its id; with the header the id covers equal to the stored operation's, the
 * echo is that operation. The caller acknowledges it as a duplicate (effects come from
 * the stored copy only, RT-77) instead of refusing it, which would make the echoing
 * device record a refusal of someone else's write.
 *
 * @param upload - The echoed operation (of a node other than the session's)
 * @param stored - The operation the store holds under the same id
 * @param schema - The server schema (for beta.12 hash rebuilds)
 */
export async function isRewrittenEcho(
	upload: Operation,
	stored: Operation,
	schema: SchemaDefinition | null,
): Promise<boolean> {
	if (upload.id !== stored.id || !sameHeader(upload, stored)) return false
	if (upload.encrypted !== undefined) return false
	return !(await operationIdMatches(upload, schema))
}

function sameHeader(a: Operation, b: Operation): boolean {
	return (
		a.nodeId === b.nodeId &&
		a.type === b.type &&
		a.collection === b.collection &&
		a.recordId === b.recordId &&
		HybridLogicalClock.serialize(a.timestamp) === HybridLogicalClock.serialize(b.timestamp)
	)
}
