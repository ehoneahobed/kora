import type { EncryptedOperationEnvelope, Operation } from '@korajs/core'

/**
 * The `encrypted` column value of an operation row (protocol v2 envelope, W9): the
 * envelope as JSON, or null for a plaintext operation. The envelope is opaque to the
 * server; it is stored verbatim so a relayed operation keeps its ciphertext (and the
 * receiver can decrypt it and verify its id).
 *
 * @param op - The operation being stored
 * @returns The column value
 */
export function envelopeColumn(op: Operation): string | null {
	return op.encrypted !== undefined ? JSON.stringify(op.encrypted) : null
}

/**
 * Read the `encrypted` column back. An unreadable value throws, so the startup
 * log-integrity scan quarantines the row instead of relaying a ciphertext-less copy
 * of an encrypted operation as if it were plaintext.
 *
 * @param value - The stored column value
 * @returns The envelope, or undefined for a plaintext operation
 */
export function parseEnvelopeColumn(
	value: string | null | undefined,
): EncryptedOperationEnvelope | undefined {
	if (value === null || value === undefined) return undefined
	const parsed: unknown = JSON.parse(value)
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		(parsed as { v?: unknown }).v !== 2 ||
		typeof (parsed as { keyId?: unknown }).keyId !== 'string'
	) {
		throw new TypeError(`Unreadable encryption envelope column: ${value.slice(0, 80)}`)
	}
	return parsed as EncryptedOperationEnvelope
}
