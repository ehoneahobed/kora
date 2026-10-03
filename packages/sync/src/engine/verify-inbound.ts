import { base64ToBytes, bytesToBase64, isKoraBytesValue, verifyOperationId } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { INVALID_OPERATION_ID } from '../protocol/protocol-version'

/** Prefix of node ids reserved for Kora itself (server-authored and server-synthesized). */
const RESERVED_NODE_PREFIX = 'kora:'

/** Outcome of {@link verifyInboundOperation}. */
export type InboundVerification =
	| {
			ok: true
			/** Whether the id was checked (false: not content-addressed, or not declared). */
			verified: boolean
	  }
	| { ok: false; code: typeof INVALID_OPERATION_ID; message: string }

/** How {@link verifyInboundOperation} treats an operation that declares no hash version. */
export type AbsentHashVersionPolicy =
	/**
	 * Not checked (clients). The server declares the version of every id it verified
	 * (1 or 2) when it stores the operation; an absent version marks an id the server
	 * could not verify: a log row from before beta.14, a server-side schema transform
	 * (which rewrites data under the original id), or a protocol-1 encrypted payload.
	 */
	| 'skip'
	/** Checked as a version-1 id (the server, on upload: omitting the version skips nothing). */
	| 'verify-v1'

/**
 * Verify a delivered (or uploaded) operation's content-addressed id (CORE-1, RT-64).
 * Runs AFTER decryption, on the plaintext the id was computed over, and before any
 * transform or apply. A mismatch means the operation was altered after it was created
 * (in transit, by a relay, or a ciphertext swap that kept its id), or that its id was
 * chosen rather than computed (squatting an id the server derives).
 *
 * Rules:
 * - Operations of reserved nodes (`kora:` prefix: the server's own `kora:server:` nodes,
 *   whose derived ids are keyed and not content hashes, and synthesized scope entries)
 *   are not checked.
 * - An operation that arrived in an encryption envelope is always checked, against
 *   the hash version it declares (bound into the envelope's authenticated data).
 * - A plaintext operation declaring hash version 2 or 1 is checked against that version.
 *   Version 1 covers type, collection, recordId, data, timestamp, nodeId and atomicOps;
 *   binary values are accepted in either of their two forms (bytes, or the canonical
 *   `{ $koraBytes }` form a JSON round trip produces), since a version-1 hash was
 *   computed over whichever form the writer held.
 * - A plaintext operation declaring no version follows `absentVersion`.
 * - An unknown declared version fails closed.
 *
 * @param op - The operation, decrypted
 * @param context - Whether it arrived in an encryption envelope, and the policy for an
 *   operation that declares no hash version (default `'skip'`)
 * @returns ok, or the refusal with a code and an explanation
 */
export async function verifyInboundOperation(
	op: Operation,
	context: { encrypted: boolean; absentVersion?: AbsentHashVersionPolicy },
): Promise<InboundVerification> {
	if (op.nodeId.startsWith(RESERVED_NODE_PREFIX)) return { ok: true, verified: false }
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
	if (await operationIdMatches(op)) return { ok: true, verified: true }
	return {
		ok: false,
		code: INVALID_OPERATION_ID,
		message: `Operation "${op.id}" from node "${op.nodeId}" does not match its content hash (hash version ${String(declared ?? 1)}${context.encrypted ? ', after decryption' : ''}): it was altered after it was created, or its id was not computed from its content. It is refused, not applied.`,
	}
}

/**
 * Whether the operation's id is its content hash under its declared version (absent:
 * 1). A version-1 id is also accepted over the other form of its binary values.
 */
export async function operationIdMatches(op: Operation): Promise<boolean> {
	if (await verifyOperationId(op)) return true
	if ((op.hashVersion ?? 1) !== 1) return false
	for (const convert of [toBytesForm, toKoraBytesForm]) {
		const data = convert(op.data)
		const atomicOps = op.atomicOps === undefined ? undefined : convert(op.atomicOps)
		if (data.changed || atomicOps?.changed) {
			const variant: Operation = {
				...op,
				data: data.value as Operation['data'],
				...(atomicOps ? { atomicOps: atomicOps.value as Operation['atomicOps'] } : {}),
			}
			if (await verifyOperationId(variant)) return true
		}
	}
	return false
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
