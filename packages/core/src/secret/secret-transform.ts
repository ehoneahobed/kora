import type { CollectionDefinition } from '../types'
import { decryptSecret, encryptSecret, hashSecret, verifySecret } from './secret-crypto'

/**
 * Provider of the key material used to encrypt reversible (`encrypted`) secret
 * fields. Called at write and reveal time so the key can be loaded lazily (for
 * example derived from a user passphrase after unlock). Returns undefined when
 * no key is available.
 */
export type SecretKeyProvider = () => string | undefined | Promise<string | undefined>

/** Thrown when an `encrypted` secret field is written or read without a key. */
export class MissingSecretKeyError extends Error {
	constructor(readonly field: string) {
		super(
			`Secret field "${field}" is encrypted but no encryption key is configured. ` +
				'Provide sync.encryption.key (or a key provider) to createApp.',
		)
		this.name = 'MissingSecretKeyError'
	}
}

async function resolveKey(provider: SecretKeyProvider | undefined): Promise<string | undefined> {
	if (!provider) {
		return undefined
	}
	return provider()
}

/**
 * Transform the secret fields of a record's write payload into their at-rest
 * form BEFORE the operation is created, so plaintext never enters the operation
 * log, the store, or the sync stream.
 *
 * - `hashed` fields become a one-way salted hash.
 * - `encrypted` fields become ciphertext (requires a key).
 *
 * Non-secret fields, and secret fields not present in `data`, are passed through
 * untouched. Null/undefined secret values are left as-is (nothing to protect).
 *
 * @param data - The validated write payload (plaintext secret values)
 * @param collectionDef - The collection definition (for field kinds/modes)
 * @param keyProvider - Supplies the encryption key for `encrypted` fields
 * @returns A new payload with secret fields replaced by their at-rest form
 */
export async function transformSecretFieldsForWrite(
	data: Record<string, unknown>,
	collectionDef: CollectionDefinition,
	keyProvider?: SecretKeyProvider,
): Promise<Record<string, unknown>> {
	// Fast path: no secret fields in this collection at all.
	const hasSecret = Object.values(collectionDef.fields).some((f) => f.kind === 'secret')
	if (!hasSecret) {
		return data
	}

	const result: Record<string, unknown> = { ...data }
	let key: string | undefined
	let keyResolved = false

	for (const [field, value] of Object.entries(data)) {
		const descriptor = collectionDef.fields[field]
		if (descriptor?.kind !== 'secret') {
			continue
		}
		if (typeof value !== 'string') {
			// Null/undefined or non-string: nothing to transform.
			continue
		}
		const mode = descriptor.secretMode ?? 'encrypted'
		if (mode === 'hashed') {
			result[field] = await hashSecret(value)
			continue
		}
		// encrypted
		if (!keyResolved) {
			key = await resolveKey(keyProvider)
			keyResolved = true
		}
		if (key === undefined) {
			throw new MissingSecretKeyError(field)
		}
		result[field] = await encryptSecret(value, key)
	}

	return result
}

/**
 * Reveal the plaintext of an `encrypted` secret field's stored value. Throws for
 * `hashed` fields, which are one-way and cannot be revealed.
 *
 * @param storedValue - The at-rest value (ciphertext)
 * @param mode - The field's secret mode
 * @param keyProvider - Supplies the decryption key
 * @param field - Field name (for error messages)
 * @returns The decrypted plaintext
 */
export async function revealSecret(
	storedValue: string,
	mode: 'hashed' | 'encrypted',
	keyProvider: SecretKeyProvider | undefined,
	field = 'secret',
): Promise<string> {
	if (mode === 'hashed') {
		throw new Error(
			`Secret field "${field}" is hashed (one-way) and cannot be revealed. Use verifySecretValue to check a candidate.`,
		)
	}
	const key = await resolveKey(keyProvider)
	if (key === undefined) {
		throw new MissingSecretKeyError(field)
	}
	return decryptSecret(storedValue, key)
}

/**
 * Verify a plaintext candidate against a `hashed` secret field's stored value.
 *
 * @param candidate - The plaintext to check (for example a login password)
 * @param storedValue - The stored one-way hash
 * @returns Whether the candidate matches
 */
export async function verifySecretValue(candidate: string, storedValue: string): Promise<boolean> {
	return verifySecret(candidate, storedValue)
}
