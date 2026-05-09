import { KoraError } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { decryptData, encryptData } from './database-encryption'

// ============================================================================
// Constants
// ============================================================================

/** Marker field indicating that an operation's data has been encrypted. */
const ENCRYPTED_MARKER = '__kora_encrypted' as const

/** Current encryption envelope version for forward compatibility. */
const ENCRYPTION_VERSION = 1

// ============================================================================
// Types
// ============================================================================

/**
 * The envelope structure stored in an operation's `data` or `previousData`
 * field when encrypted. The original field contents are replaced with this
 * envelope, which the server relays opaquely.
 */
interface EncryptedFieldEnvelope {
	/** Marker flag — always true. Used to detect encrypted fields. */
	[ENCRYPTED_MARKER]: true
	/** Base64url-encoded AES-256-GCM ciphertext */
	ciphertext: string
	/** Base64url-encoded 12-byte initialization vector */
	iv: string
	/** Algorithm identifier for forward compatibility */
	algorithm: 'AES-256-GCM'
	/** Envelope version for schema evolution */
	version: number
}

/**
 * Configuration for the operation encryptor.
 */
export interface OperationEncryptorConfig {
	/**
	 * The AES-256-GCM CryptoKey used to encrypt and decrypt operation data.
	 *
	 * This can be:
	 * - A key derived from a user passphrase via `deriveEncryptionKey`
	 * - A randomly generated key from `generateEncryptionKey`
	 * - A key imported from raw bytes via `importKey`
	 *
	 * All devices that need to read each other's operations must share
	 * the same encryption key (or keys, if key rotation is implemented).
	 */
	key: CryptoKey
}

// ============================================================================
// Errors
// ============================================================================

/**
 * Thrown when operation encryption or decryption fails.
 */
export class OperationEncryptionError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'OPERATION_ENCRYPTION_ERROR', context)
		this.name = 'OperationEncryptionError'
	}
}

// ============================================================================
// Base64url encoding helpers
// ============================================================================

function toBase64Url(bytes: Uint8Array): string {
	let binary = ''
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i] as number)
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(str: string): Uint8Array {
	let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
	const paddingNeeded = (4 - (base64.length % 4)) % 4
	base64 += '='.repeat(paddingNeeded)

	const binary = atob(base64)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}
	return bytes
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Encrypts and decrypts the `data` and `previousData` fields of Kora operations.
 *
 * This provides end-to-end encryption for sync: the server relays operations
 * without being able to read the user's data. Only metadata needed for sync
 * orchestration (id, nodeId, collection, timestamp, causalDeps, etc.) remains
 * in cleartext so the server can route, deduplicate, and order operations.
 *
 * **How it works:**
 * 1. `encryptOperation` replaces `data` and `previousData` with encrypted envelopes
 *    containing base64url-encoded AES-256-GCM ciphertext
 * 2. The encrypted operation is sent through the normal sync pipeline
 * 3. The server stores and relays the operation without modification
 * 4. `decryptOperation` on receiving clients restores the original field values
 *
 * **What stays in cleartext (needed for sync):**
 * - `id` (content-addressed hash — used for deduplication)
 * - `nodeId`, `sequenceNumber` (version vectors)
 * - `timestamp` (causal ordering)
 * - `type`, `collection`, `recordId` (routing and storage)
 * - `causalDeps` (dependency tracking)
 * - `schemaVersion` (migration)
 *
 * **What gets encrypted (user data):**
 * - `data` (record field values for inserts/updates)
 * - `previousData` (previous field values for 3-way merge)
 *
 * @example
 * ```typescript
 * import { OperationEncryptor, generateEncryptionKey } from '@korajs/auth'
 *
 * const key = await generateEncryptionKey()
 * const encryptor = new OperationEncryptor({ key })
 *
 * // Before sending via sync
 * const encrypted = await encryptor.encryptOperation(operation)
 * syncEngine.send(encrypted)
 *
 * // After receiving from sync
 * const decrypted = await encryptor.decryptOperation(receivedOp)
 * store.apply(decrypted)
 * ```
 */
export class OperationEncryptor {
	private readonly key: CryptoKey

	constructor(config: OperationEncryptorConfig) {
		this.key = config.key
	}

	/**
	 * Encrypt an operation's data fields.
	 *
	 * Returns a new Operation with `data` and `previousData` replaced by
	 * encrypted envelopes. The original operation is not mutated.
	 *
	 * If `data` or `previousData` is null (e.g., delete operations),
	 * that field remains null — there is nothing to encrypt.
	 *
	 * @param operation - The operation to encrypt
	 * @returns A new operation with encrypted data fields
	 * @throws {OperationEncryptionError} If encryption fails
	 */
	async encryptOperation(operation: Operation): Promise<Operation> {
		const [encryptedData, encryptedPreviousData] = await Promise.all([
			this.encryptField(operation.data, operation.id, 'data'),
			this.encryptField(operation.previousData, operation.id, 'previousData'),
		])

		return {
			...operation,
			data: encryptedData,
			previousData: encryptedPreviousData,
		}
	}

	/**
	 * Decrypt an operation's data fields.
	 *
	 * Returns a new Operation with the original `data` and `previousData`
	 * restored from their encrypted envelopes. The original operation is
	 * not mutated.
	 *
	 * If a field is null or not encrypted (no marker), it passes through unchanged.
	 * This enables mixed plaintext/encrypted operations during migration.
	 *
	 * @param operation - The operation to decrypt
	 * @returns A new operation with decrypted data fields
	 * @throws {OperationEncryptionError} If decryption fails (wrong key, tampered data)
	 */
	async decryptOperation(operation: Operation): Promise<Operation> {
		const [decryptedData, decryptedPreviousData] = await Promise.all([
			this.decryptField(operation.data, operation.id, 'data'),
			this.decryptField(operation.previousData, operation.id, 'previousData'),
		])

		return {
			...operation,
			data: decryptedData,
			previousData: decryptedPreviousData,
		}
	}

	/**
	 * Check if an operation's data fields are encrypted.
	 *
	 * Returns true if either `data` or `previousData` contains an encrypted
	 * envelope marker. Useful for determining whether decryption is needed
	 * before applying an operation.
	 *
	 * @param operation - The operation to check
	 * @returns true if any data field is encrypted
	 */
	isEncrypted(operation: Operation): boolean {
		return isEncryptedEnvelope(operation.data) || isEncryptedEnvelope(operation.previousData)
	}

	/**
	 * Encrypt a batch of operations.
	 *
	 * Convenience method for encrypting multiple operations at once.
	 * Operations are encrypted in parallel for performance.
	 *
	 * @param operations - The operations to encrypt
	 * @returns New operations with encrypted data fields
	 */
	async encryptBatch(operations: Operation[]): Promise<Operation[]> {
		return Promise.all(operations.map((op) => this.encryptOperation(op)))
	}

	/**
	 * Decrypt a batch of operations.
	 *
	 * Convenience method for decrypting multiple operations at once.
	 * Operations are decrypted in parallel for performance.
	 *
	 * @param operations - The operations to decrypt
	 * @returns New operations with decrypted data fields
	 */
	async decryptBatch(operations: Operation[]): Promise<Operation[]> {
		return Promise.all(operations.map((op) => this.decryptOperation(op)))
	}

	// --- Private helpers ---

	private async encryptField(
		field: Record<string, unknown> | null,
		operationId: string,
		fieldName: string,
	): Promise<Record<string, unknown> | null> {
		if (field === null) {
			return null
		}

		const plaintext = new TextEncoder().encode(JSON.stringify(field))

		try {
			const { ciphertext, iv } = await encryptData(this.key, plaintext)

			const envelope: EncryptedFieldEnvelope = {
				[ENCRYPTED_MARKER]: true,
				ciphertext: toBase64Url(ciphertext),
				iv: toBase64Url(iv),
				algorithm: 'AES-256-GCM',
				version: ENCRYPTION_VERSION,
			}

			return envelope as unknown as Record<string, unknown>
		} catch (cause) {
			if (cause instanceof OperationEncryptionError) {
				throw cause
			}
			throw new OperationEncryptionError(`Failed to encrypt operation ${fieldName} field.`, {
				operationId,
				fieldName,
				cause: cause instanceof Error ? cause.message : String(cause),
			})
		}
	}

	private async decryptField(
		field: Record<string, unknown> | null,
		operationId: string,
		fieldName: string,
	): Promise<Record<string, unknown> | null> {
		if (field === null) {
			return null
		}

		// Pass through unencrypted fields (backward compatibility)
		if (!isEncryptedEnvelope(field)) {
			return field
		}

		const envelope = field as unknown as EncryptedFieldEnvelope

		if (envelope.version > ENCRYPTION_VERSION) {
			throw new OperationEncryptionError(
				`Encrypted field uses version ${envelope.version}, but this client only supports version ${ENCRYPTION_VERSION}. Update your @korajs/auth package to decrypt this operation.`,
				{ operationId, fieldName, version: envelope.version },
			)
		}

		try {
			const ciphertext = fromBase64Url(envelope.ciphertext)
			const iv = fromBase64Url(envelope.iv)

			const plaintextBytes = await decryptData(this.key, ciphertext, iv)
			const json = new TextDecoder().decode(plaintextBytes)
			const parsed: unknown = JSON.parse(json)

			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				throw new OperationEncryptionError(`Decrypted ${fieldName} is not a valid record object.`, {
					operationId,
					fieldName,
				})
			}

			return parsed as Record<string, unknown>
		} catch (cause) {
			if (cause instanceof OperationEncryptionError) {
				throw cause
			}
			throw new OperationEncryptionError(
				`Failed to decrypt operation ${fieldName} field. This may indicate a wrong encryption key or tampered data.`,
				{
					operationId,
					fieldName,
					cause: cause instanceof Error ? cause.message : String(cause),
				},
			)
		}
	}
}

// ============================================================================
// Utility functions
// ============================================================================

/**
 * Check if a field value is an encrypted envelope.
 *
 * This is a standalone utility function that can be used without constructing
 * an OperationEncryptor instance. Useful for routing logic that needs to
 * detect encrypted operations.
 *
 * @param field - An operation's `data` or `previousData` field
 * @returns true if the field is an encrypted envelope
 */
export function isEncryptedField(field: Record<string, unknown> | null): boolean {
	return isEncryptedEnvelope(field)
}

function isEncryptedEnvelope(field: Record<string, unknown> | null): boolean {
	if (field === null || typeof field !== 'object') {
		return false
	}
	return (
		field[ENCRYPTED_MARKER] === true &&
		typeof field.ciphertext === 'string' &&
		typeof field.iv === 'string' &&
		field.algorithm === 'AES-256-GCM'
	)
}
