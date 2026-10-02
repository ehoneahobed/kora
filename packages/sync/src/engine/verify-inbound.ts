import { verifyOperationId } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { INVALID_OPERATION_ID } from '../protocol/protocol-version'

/** Prefix of node ids reserved for Kora itself (server-synthesized scope entries). */
const RESERVED_NODE_PREFIX = 'kora:'

/** Outcome of {@link verifyInboundOperation}. */
export type InboundVerification =
	| {
			ok: true
			/** Whether the id was checked (false: not content-addressed, or a version-1 id). */
			verified: boolean
	  }
	| { ok: false; code: typeof INVALID_OPERATION_ID; message: string }

/**
 * Verify a delivered operation's content-addressed id on the client (CORE-1, protocol
 * v2). Runs AFTER decryption, on the plaintext the id was computed over, and before
 * any transform or apply. A mismatch means the operation was altered after it was
 * created (in transit, by a relay, or a ciphertext swap that kept its id); the engine
 * quarantines it and emits `sync:apply-failed` with `INVALID_OPERATION_ID`.
 *
 * Rules:
 * - Operations of reserved system nodes (`kora:` prefix, server-synthesized scope
 *   entries) are not content-addressed and are not checked.
 * - An operation that arrived in an encryption envelope is always checked, against
 *   the hash version it declares (bound into the envelope's authenticated data).
 * - A plaintext operation declaring hash version 2 is checked.
 * - A version-1 operation (absent or 1) is not checked: version-1 ops stored before
 *   beta.14 are never judged by version-2 rules, and a server's schema transform
 *   legitimately rewrites an op under its original id (the server verifies BEFORE it
 *   transforms, and stores the transformed copy as version 1).
 * - An unknown declared version fails closed.
 *
 * @param op - The delivered operation, decrypted
 * @param context - Whether it arrived in an encryption envelope
 * @returns ok, or the refusal with a code and an explanation
 */
export async function verifyInboundOperation(
	op: Operation,
	context: { encrypted: boolean },
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
	if (!context.encrypted && declared !== 2) return { ok: true, verified: false }
	if (await verifyOperationId(op)) return { ok: true, verified: true }
	return {
		ok: false,
		code: INVALID_OPERATION_ID,
		message: `Operation "${op.id}" from node "${op.nodeId}" does not match its content hash (hash version ${String(declared ?? 1)}${context.encrypted ? ', after decryption' : ''}): it was altered after it was created. It is quarantined, not applied.`,
	}
}
