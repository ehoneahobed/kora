import {
	base64ToBytes,
	bytesToBase64,
	canonicalizeLegacyOperation,
	isKoraBytesValue,
	verifyOperationId,
} from '@korajs/core'
import type { FieldDescriptor, Operation, SchemaDefinition } from '@korajs/core'
import { INVALID_OPERATION_ID } from '../protocol/protocol-version'

/** Prefix of node ids reserved for Kora itself (server-authored and server-synthesized). */
const RESERVED_NODE_PREFIX = 'kora:'

/** Node of server-synthesized scope-entry operations (ids derived from the trigger op). */
const SCOPE_ENTRY_NODE_ID = 'kora:scope-entry'

/**
 * Whether an operation's id is exempt from content verification: it is not a content
 * hash by construction. Only two kinds of operation qualify, both on Kora's reserved
 * nodes, which no device can claim:
 * - scope entries (`kora:scope-entry`): the id names the triggering operation, and the
 *   data is the record's current row;
 * - server-derived operations (cascades, set-nulls, constraint corrections) of a
 *   `kora:server:` node: the id is a keyed HMAC (RT-64) and they declare no hash version.
 *
 * A reserved-node operation that declares a hash version (a server route write, built
 * with `createOperation`) claims a content-addressed id and is verified like any other.
 */
function isExemptFromIdVerification(op: Operation): boolean {
	if (!op.nodeId.startsWith(RESERVED_NODE_PREFIX)) return false
	return op.nodeId === SCOPE_ENTRY_NODE_ID || op.hashVersion === undefined
}

/** Outcome of {@link verifyInboundOperation}. */
export type InboundVerification =
	| {
			ok: true
			/** Whether the id was checked (false: not content-addressed, or not declared). */
			verified: boolean
			/**
			 * The hash version the id matched, when it declared none (`'verify-ids'`): 1, or 2
			 * for a version-2 id whose declaration was lost on the way.
			 */
			matchedVersion?: 1 | 2
			/**
			 * False when the id matched only through the schema-dependent rebuild of a
			 * beta.12 hash (declared nested object members that were `undefined`): a
			 * receiver without the schema cannot repeat that check, so the server must not
			 * declare the matched version on the stored copy. Absent: true.
			 */
			declarable?: boolean
			/**
			 * The update's data with each top-level member beta.12 hashed as `undefined`
			 * restored as `null` (RT-71): beta.12 cleared those fields locally, and `null`
			 * hashes identically under version 1, so the stored copy carries the write the
			 * beta.12 client made, under the same verified id. Present only when the id
			 * matched through that rebuild.
			 */
			restoredData?: Operation['data']
	  }
	| { ok: false; code: typeof INVALID_OPERATION_ID; message: string }

/** How {@link verifyInboundOperation} treats an operation that declares no hash version. */
export type AbsentHashVersionPolicy =
	/**
	 * Not checked (clients). The server declares the version of every id it verified
	 * (1 or 2) when it stores the operation; an absent version marks an id the server
	 * could not verify: a log row from before beta.13, a server-side schema transform
	 * (which rewrites data under the original id), or a protocol-1 encrypted payload.
	 */
	| 'skip'
	/**
	 * Checked (the server, on upload: omitting the version skips nothing): the id must be
	 * the operation's version-1 or version-2 content hash.
	 */
	| 'verify-ids'

/**
 * Verify a delivered (or uploaded) operation's content-addressed id (CORE-1, RT-64).
 * Runs AFTER decryption, on the plaintext the id was computed over, and before any
 * transform or apply. A mismatch means the operation was altered after it was created
 * (in transit, by a relay, or a ciphertext swap that kept its id), or that its id was
 * chosen rather than computed (squatting an id the server derives).
 *
 * Rules:
 * - Scope entries and server-derived operations (reserved `kora:` nodes, no declared hash
 *   version: keyed HMAC ids) are not checked. A reserved-node operation that declares a
 *   hash version (a server route write) is checked like any other.
 * - An operation that arrived in an encryption envelope is always checked, against
 *   the hash version it declares (bound into the envelope's authenticated data).
 * - A plaintext operation declaring hash version 2 or 1 is checked against that version.
 *   Version 1 covers type, collection, recordId, data, timestamp, nodeId and atomicOps;
 *   binary values are accepted in either of their two forms (bytes, or the canonical
 *   `{ $koraBytes }` form a JSON round trip produces), since a version-1 hash was
 *   computed over whichever form the writer held.
 * - A plaintext operation declaring no version follows `absentVersion`: skipped, or
 *   accepted when its id is its version-1 or version-2 content hash.
 * - An unknown declared version fails closed.
 *
 * @param op - The operation, decrypted
 * @param context - Whether it arrived in an encryption envelope, and the policy for an
 *   operation that declares no hash version (default `'skip'`)
 * @returns ok, or the refusal with a code and an explanation
 */
export async function verifyInboundOperation(
	op: Operation,
	context: {
		encrypted: boolean
		absentVersion?: AbsentHashVersionPolicy
		/** The schema, for rebuilding beta.12 hashes of `undefined` nested members (RT-71). */
		schema?: SchemaDefinition | null
	},
): Promise<InboundVerification> {
	if (isExemptFromIdVerification(op)) return { ok: true, verified: false }
	const declared = op.hashVersion
	if (declared !== undefined && declared !== 1 && declared !== 2) {
		return {
			ok: false,
			code: INVALID_OPERATION_ID,
			message: `Operation "${op.id}" declares unknown content-hash version ${String(declared)}; it cannot be verified and is not applied. Upgrade this client.`,
		}
	}
	if (
		!context.encrypted &&
		declared === undefined &&
		(context.absentVersion ?? 'skip') === 'skip'
	) {
		return { ok: true, verified: false }
	}
	if (declared === undefined && !context.encrypted) {
		if (await verifyOperationId(op)) return { ok: true, verified: true, matchedVersion: 1 }
		if (await verifyOperationId({ ...op, hashVersion: 2 })) {
			return { ok: true, verified: true, matchedVersion: 2 }
		}
		const match = await matchOperationId(op, context.schema ?? null)
		if (match !== null) {
			return {
				ok: true,
				verified: true,
				matchedVersion: 1,
				declarable: !match.usedSchema,
				...(match.usedPrevious ? { restoredData: restoreUndefinedFromPrevious(op) } : {}),
			}
		}
	} else if ((await matchOperationId(op, context.schema ?? null)) !== null) {
		return { ok: true, verified: true }
	}
	return {
		ok: false,
		code: INVALID_OPERATION_ID,
		message: `Operation "${op.id}" from node "${op.nodeId}" does not match its content hash (hash version ${String(declared ?? 1)}${context.encrypted ? ', after decryption' : ''}): it was altered after it was created, or its id was not computed from its content. It is refused, not applied.`,
	}
}

/**
 * Whether the operation's id is its content hash under its declared version (absent:
 * 1). A version-1 id is also accepted over the other form of its binary values, and
 * over the beta.12 form of `undefined` members (see {@link matchOperationId}).
 *
 * @param op - The operation (plaintext)
 * @param schema - Optional schema, to rebuild declared nested members
 * @returns true when the id is the content hash
 */
export async function operationIdMatches(
	op: Operation,
	schema: SchemaDefinition | null = null,
): Promise<boolean> {
	return (await matchOperationId(op, schema)) !== null
}

/** How an id matched: which beta.12 rebuilds (if any) its content needed. */
export interface OperationIdMatch {
	/** Top-level members restored from an update's `previousData` keys. */
	usedPrevious: boolean
	/** Declared nested members restored (needs the schema). */
	usedSchema: boolean
}

/**
 * Match an operation's id against its content hash (RT-64, RT-71).
 *
 * Version 2 is checked as is: its canonical form is the JSON form (an `undefined`
 * member is absent, RT-72), so what was hashed is what arrives.
 *
 * Version 1 (beta.12 and earlier) hashed the in-memory value with `canonicalize`,
 * which writes an `undefined` object member as `"key":null`; the op log and the wire
 * are JSON, so the member is gone on arrival. The forms beta.12 actually produced are
 * rebuilt where they are recoverable:
 * - an update: beta.12 writes `previousData[key]` for every key it validated, so every
 *   `previousData` key absent from `data` was an `undefined` value in `data`
 *   (`update(id, { assignee: undefined })`);
 * - an object field (needs the schema): declared nested members absent from the value
 *   (`{ a: 1, b: undefined }`), recursively for declared nested objects.
 * Each form is also tried with the other form of its binary values (bytes, or the
 * canonical `{ $koraBytes }` form a JSON round trip produces).
 *
 * @param op - The operation (plaintext)
 * @param schema - The schema, or null (no nested rebuild)
 * @returns how the id matched, or null when it is not the content hash
 */
export async function matchOperationId(
	op: Operation,
	schema: SchemaDefinition | null,
): Promise<OperationIdMatch | null> {
	if (await verifyOperationId(op)) return { usedPrevious: false, usedSchema: false }
	if ((op.hashVersion ?? 1) !== 1) return null
	const candidates: Array<{ data: Operation['data']; kind: OperationIdMatch }> = [
		{ data: op.data, kind: { usedPrevious: false, usedSchema: false } },
	]
	const filled = restoreUndefinedFromPrevious(op)
	if (filled !== op.data) {
		candidates.push({ data: filled, kind: { usedPrevious: true, usedSchema: false } })
	}
	if (schema) {
		for (const candidate of [...candidates]) {
			const nested = fillDeclaredNestedMembers(candidate.data, op.collection, schema)
			if (nested !== null) {
				candidates.push({ data: nested, kind: { ...candidate.kind, usedSchema: true } })
			}
		}
	}
	for (const candidate of candidates) {
		if (candidate.data !== op.data && (await verifyOperationId({ ...op, data: candidate.data }))) {
			return candidate.kind
		}
		for (const convert of [toBytesForm, toKoraBytesForm]) {
			const data = convert(candidate.data)
			const atomicOps = op.atomicOps === undefined ? undefined : convert(op.atomicOps)
			if (data.changed || atomicOps?.changed) {
				const variant: Operation = {
					...op,
					data: data.value as Operation['data'],
					...(atomicOps ? { atomicOps: atomicOps.value as Operation['atomicOps'] } : {}),
				}
				if (await verifyOperationId(variant)) return candidate.kind
			}
		}
	}
	return null
}

/**
 * A beta.12 update's data with every `previousData` key it lacks restored as `null`
 * (RT-71). beta.12 writes `previousData[key]` for every key it validated, so such a key
 * held `undefined` in `data`: hashed as `null`, applied locally as a cleared field, and
 * dropped by the JSON upload. Returns `op.data` itself when there is none to restore.
 *
 * @param op - A plaintext operation
 * @returns The restored data, or `op.data` unchanged
 */
export function restoreUndefinedFromPrevious(op: Operation): Operation['data'] {
	// One rule for every replica: core's legacy canonical body (RT-71, RT-83).
	return canonicalizeLegacyOperation({ ...op, hashVersion: undefined }).data
}

/**
 * The data with each declared nested member an object value lacks restored as `null`
 * (recursively), or null when nothing was restored.
 */
function fillDeclaredNestedMembers(
	data: Operation['data'],
	collection: string,
	schema: SchemaDefinition,
): Operation['data'] {
	const fields = schema.collections[collection]?.fields
	if (data === null || fields === undefined) return null
	let changed = false
	const out: Record<string, unknown> = { ...data }
	for (const [name, value] of Object.entries(data)) {
		const descriptor = fields[name]
		if (descriptor === undefined) continue
		const filled = fillNested(value, descriptor)
		if (filled !== value) {
			out[name] = filled
			changed = true
		}
	}
	return changed ? out : null
}

function fillNested(value: unknown, descriptor: FieldDescriptor): unknown {
	const nested = descriptor.nestedFields
	if (descriptor.kind !== 'object' || !nested) return value
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
	const record = value as Record<string, unknown>
	let changed = false
	const out: Record<string, unknown> = { ...record }
	for (const [name, child] of Object.entries(nested)) {
		if (!(name in record)) {
			out[name] = null
			changed = true
			continue
		}
		const filled = fillNested(record[name], child)
		if (filled !== record[name]) {
			out[name] = filled
			changed = true
		}
	}
	return changed ? out : value
}

interface Converted {
	value: unknown
	changed: boolean
}

/** `{ $koraBytes }` values replaced by the bytes they encode. */
function toBytesForm(value: unknown): Converted {
	if (isKoraBytesValue(value)) {
		try {
			return { value: base64ToBytes(value.$koraBytes), changed: true }
		} catch {
			return { value, changed: false }
		}
	}
	return mapMembers(value, toBytesForm)
}

/** Byte values replaced by their canonical `{ $koraBytes }` form. */
function toKoraBytesForm(value: unknown): Converted {
	if (value instanceof Uint8Array)
		return { value: { $koraBytes: bytesToBase64(value) }, changed: true }
	return mapMembers(value, toKoraBytesForm)
}

function mapMembers(value: unknown, convert: (member: unknown) => Converted): Converted {
	if (Array.isArray(value)) {
		let changed = false
		const out = value.map((member) => {
			const result = convert(member)
			changed ||= result.changed
			return result.value
		})
		return changed ? { value: out, changed } : { value, changed: false }
	}
	if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
		let changed = false
		const out: Record<string, unknown> = {}
		for (const [key, member] of Object.entries(value)) {
			const result = convert(member)
			changed ||= result.changed
			out[key] = result.value
		}
		return changed ? { value: out, changed } : { value, changed: false }
	}
	return { value, changed: false }
}
