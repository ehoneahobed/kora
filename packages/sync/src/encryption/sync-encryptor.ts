import { SyncError } from '@korajs/core'
import type {
	AtomicOp,
	EncryptedEnvelopeField,
	EncryptedOperationEnvelope,
	HLCTimestamp,
	Operation,
	OperationType,
} from '@korajs/core'
import { canonicalize } from '@korajs/core/internal'
import type { SerializedOperation } from '../protocol/messages'
import { deriveVersionedKey } from './key-derivation'
import type { SyncEncryptionConfig, VersionedKey } from './types'

/**
 * Thrown when encryption of operation data fails.
 */
export class EncryptionError extends SyncError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, { ...context, errorType: 'ENCRYPTION_ERROR' })
		this.name = 'EncryptionError'
	}
}

/**
 * Thrown when decryption of operation data fails.
 * This typically indicates a wrong key, tampered ciphertext, or corrupted data.
 */
export class DecryptionError extends SyncError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, { ...context, errorType: 'DECRYPTION_ERROR' })
		this.name = 'DecryptionError'
	}
}

/** AES-GCM initialization vector length in bytes (96 bits). NIST recommended. */
const IV_LENGTH = 12

/** Marker of the protocol-1 in-`data` payload (no integrity binding; no longer accepted). */
const LEGACY_ENCRYPTED_MARKER = '__kora_e2e_encrypted' as const

/** The members of an operation the envelope protects. */
type EnvelopeMember = 'data' | 'previousData' | 'atomicOps'

/**
 * The operation shape the encryptor works on: a domain {@link Operation} or its wire
 * form {@link SerializedOperation} (same fields).
 */
interface EncryptableOperation {
	id: string
	nodeId: string
	type: OperationType
	collection: string
	recordId: string
	data: Record<string, unknown> | null
	previousData: Record<string, unknown> | null
	timestamp: HLCTimestamp
	sequenceNumber: number
	schemaVersion: number
	atomicOps?: Record<string, AtomicOp>
	hashVersion?: 1 | 2
	encrypted?: EncryptedOperationEnvelope
}

/**
 * End-to-end encryption of operations, envelope v2 (protocol v2; ENC-3, NEW-ENC-1).
 *
 * **Envelope.** The plaintext `data`, `previousData` and `atomicOps` move into
 * `op.encrypted` ({@link EncryptedOperationEnvelope}: alg, keyId, keyVersion and one
 * AES-256-GCM ciphertext per member). On the wire `data` is null, or holds only the
 * collection's documented cleartext scope fields (`cleartextFields`), so a schema-aware
 * server stores the operation opaquely and can still evaluate scopes. Metadata (id,
 * nodeId, collection, recordId, timestamp, sequence, causalDeps, schemaVersion) stays in
 * cleartext so the server can route, deduplicate and order.
 *
 * **Binding (ENC-3).** Every ciphertext is authenticated with AES-GCM additional data
 * canonical(nodeId, collection, recordId, type, timestamp, sequenceNumber, field,
 * keyVersion, hashVersion): a ciphertext moved to another operation, record or member,
 * or an envelope whose metadata was rewritten, fails authentication. `data` and
 * `previousData` are always encrypted, even when null, so a delete is authenticated too.
 * The operation id (the version-2 content hash of the PLAINTEXT) is verified after
 * decryption by the sync engine (`verify-inbound.ts`).
 *
 * **Plaintext.** With encryption enabled an operation without an envelope is refused
 * (a server must not be able to inject unauthenticated writes), unless the config opens
 * a migration window (`allowPlaintextMigration`). Protocol-1 payloads (ciphertext inside
 * `data`, no binding) are refused the same way.
 *
 * **Key id.** The envelope names its key material (`keyId`, a fingerprint of the
 * key-derivation salt), so a device holding different material (ENC-1, Phase 4) reports
 * a diagnosable mismatch rather than a bare authentication failure.
 *
 * @example
 * ```typescript
 * const encryptor = await SyncEncryptor.create({ enabled: true, key: 'user-passphrase' })
 * const sealed = await encryptor.encryptOperation(operation)
 * const opened = await encryptor.decryptOperation(sealed)
 * ```
 */
export class SyncEncryptor {
	/**
	 * Map of key version -> VersionedKey. The current (latest) version is used
	 * for encryption. All versions are available for decryption (key rotation).
	 */
	private readonly keys: Map<number, VersionedKey>
	/** The current key version used for encryption. */
	private currentVersion: number
	/** Fingerprint of each key version's material (cached). */
	private readonly keyIds = new Map<number, Promise<string>>()
	private readonly cleartextFields: Readonly<Record<string, readonly string[]>>
	private readonly allowPlaintextMigration: boolean

	private constructor(
		keys: Map<number, VersionedKey>,
		currentVersion: number,
		options: EncryptorOptions = {},
	) {
		this.keys = keys
		this.currentVersion = currentVersion
		this.cleartextFields = options.cleartextFields ?? {}
		this.allowPlaintextMigration = options.allowPlaintextMigration === true
	}

	/**
	 * Creates a SyncEncryptor from a {@link SyncEncryptionConfig}.
	 *
	 * Derives the encryption key from the passphrase using PBKDF2. The key
	 * derivation is async because it uses the Web Crypto API.
	 *
	 * @param config - Encryption configuration with passphrase
	 * @param salt - Optional salt for deterministic key derivation.
	 *              If omitted, a random salt is generated (ENC-1: shared key
	 *              material across devices is Phase 4 work).
	 * @param iterations - Optional PBKDF2 iteration count. Defaults to the
	 *              production-strength value. Lower it only in tests.
	 * @returns A configured SyncEncryptor instance
	 * @throws {EncryptionError} If configuration is invalid
	 * @throws {KeyDerivationError} If key derivation fails
	 */
	static async create(
		config: SyncEncryptionConfig,
		salt?: Uint8Array,
		iterations?: number,
	): Promise<SyncEncryptor> {
		if (!config.enabled) {
			throw new EncryptionError(
				'Cannot create SyncEncryptor with encryption disabled. ' +
					'Set enabled: true in the encryption config.',
			)
		}

		const passphrase = typeof config.key === 'function' ? await config.key() : config.key

		if (passphrase.length === 0) {
			throw new EncryptionError(
				'Encryption key/passphrase must not be empty. ' +
					'Provide a non-empty string or key provider function.',
			)
		}

		const versionedKey = await deriveVersionedKey(passphrase, 1, salt, iterations)
		const keys = new Map<number, VersionedKey>()
		keys.set(1, versionedKey)

		return new SyncEncryptor(keys, 1, {
			...(config.cleartextFields ? { cleartextFields: config.cleartextFields } : {}),
			...(config.allowPlaintextMigration ? { allowPlaintextMigration: true } : {}),
		})
	}

	/**
	 * Creates a SyncEncryptor from pre-derived versioned keys.
	 *
	 * Use this when you need to support multiple key versions for key rotation,
	 * or when you have already derived the keys externally.
	 *
	 * @param versionedKeys - Array of versioned keys. The highest version is used for encryption.
	 * @param options - Cleartext scope fields and the plaintext migration window
	 * @returns A configured SyncEncryptor instance
	 * @throws {EncryptionError} If no keys are provided
	 */
	static fromKeys(versionedKeys: VersionedKey[], options: EncryptorOptions = {}): SyncEncryptor {
		if (versionedKeys.length === 0) {
			throw new EncryptionError('At least one versioned key must be provided.')
		}

		const keys = new Map<number, VersionedKey>()
		let maxVersion = 0

		for (const vk of versionedKeys) {
			keys.set(vk.version, vk)
			if (vk.version > maxVersion) {
				maxVersion = vk.version
			}
		}

		return new SyncEncryptor(keys, maxVersion, options)
	}

	/**
	 * Add a new key version for key rotation.
	 *
	 * After adding, the new key becomes the current version used for encryption
	 * if its version number is higher than the current version. Previously-versioned
	 * keys remain available for decrypting older operations.
	 *
	 * @param key - The new versioned key to add
	 * @throws {EncryptionError} If the key version already exists
	 */
	addKey(key: VersionedKey): void {
		if (this.keys.has(key.version)) {
			throw new EncryptionError(
				`Key version ${key.version} already exists. Use a higher version number for rotation.`,
				{ existingVersion: key.version },
			)
		}

		this.keys.set(key.version, key)
		if (key.version > this.currentVersion) {
			this.currentVersion = key.version
		}
	}

	/**
	 * Get the current encryption key version number.
	 */
	getCurrentKeyVersion(): number {
		return this.currentVersion
	}

	/**
	 * The key id written into envelopes for a key version: a fingerprint of its
	 * key-derivation salt (never the key itself).
	 *
	 * @param version - Key version (defaults to the current one)
	 */
	async getKeyId(version: number = this.currentVersion): Promise<string> {
		const key = this.keys.get(version)
		if (!key) {
			throw new EncryptionError(`Encryption key version ${version} not found.`, { version })
		}
		let cached = this.keyIds.get(version)
		if (!cached) {
			cached = keyFingerprint(key.salt)
			this.keyIds.set(version, cached)
		}
		return cached
	}

	/**
	 * Seal an operation into an envelope v2.
	 *
	 * Returns a new operation (operations are immutable): `encrypted` holds the
	 * ciphertexts, `data` is null or the collection's cleartext scope fields, and
	 * `previousData`/`atomicOps` are removed. An operation that already carries an
	 * envelope is returned unchanged.
	 *
	 * @param operation - The plaintext operation
	 * @returns The sealed operation
	 * @throws {EncryptionError} If encryption fails
	 */
	async encryptOperation(operation: Operation): Promise<Operation> {
		return this.seal(operation)
	}

	/**
	 * Open an envelope v2 and restore the plaintext `data`, `previousData` and
	 * `atomicOps`. The returned operation has no `encrypted` member.
	 *
	 * @param operation - The sealed operation
	 * @returns The plaintext operation (its id is NOT verified here; the caller does)
	 * @throws {DecryptionError} On a plaintext operation (unless the migration window
	 *   is open), a protocol-1 payload, an unknown key, a key-id mismatch, or a
	 *   ciphertext that fails authentication (tampered, transplanted, wrong key)
	 */
	async decryptOperation(operation: Operation): Promise<Operation> {
		return this.open(operation)
	}

	/**
	 * Same as {@link encryptOperation} for the wire form.
	 *
	 * @param serialized - The serialized operation to encrypt
	 * @returns The sealed serialized operation
	 */
	async encryptSerializedOperation(serialized: SerializedOperation): Promise<SerializedOperation> {
		return this.seal(serialized)
	}

	/**
	 * Same as {@link decryptOperation} for the wire form.
	 *
	 * @param serialized - The serialized operation to decrypt
	 * @returns The plaintext serialized operation
	 */
	async decryptSerializedOperation(serialized: SerializedOperation): Promise<SerializedOperation> {
		return this.open(serialized)
	}

	/**
	 * Encrypt a batch of operations in parallel.
	 *
	 * @param operations - Operations to encrypt
	 * @returns New operations with encrypted data fields
	 */
	async encryptBatch(operations: Operation[]): Promise<Operation[]> {
		return Promise.all(operations.map((op) => this.encryptOperation(op)))
	}

	/**
	 * Decrypt a batch of operations in parallel.
	 *
	 * @param operations - Operations to decrypt
	 * @returns New operations with decrypted data fields
	 */
	async decryptBatch(operations: Operation[]): Promise<Operation[]> {
		return Promise.all(operations.map((op) => this.decryptOperation(op)))
	}

	/**
	 * Check if an operation `data` field holds a protocol-1 encrypted payload (the
	 * pre-envelope format, refused since protocol v2).
	 *
	 * @param field - An operation's `data` or `previousData` field
	 */
	static isEncryptedPayload(field: Record<string, unknown> | null): boolean {
		return isEncryptedPayload(field)
	}

	/**
	 * Whether a plaintext operation touches only data the server can already read: its
	 * `data` (and, except for a delete, its `previousData`) names only the collection's
	 * cleartext scope fields, and it has no atomic ops. The sync engine accepts such an
	 * operation from a server-authored node (a cascade, a set-null of a cleartext
	 * reference, a constraint correction of a cleartext field) under end-to-end
	 * encryption: the server cannot seal it (it has no key), and it reveals or forges
	 * nothing the server does not already hold in cleartext. Any sealed field makes it
	 * false, so the operation is refused as plaintext.
	 *
	 * @param operation - A delivered operation without an envelope
	 */
	isCleartextOnly(operation: Operation): boolean {
		if (operation.encrypted !== undefined) return false
		if (operation.atomicOps !== undefined && Object.keys(operation.atomicOps).length > 0) {
			return false
		}
		const allowed = new Set(this.cleartextFields[operation.collection] ?? [])
		const within = (value: Record<string, unknown> | null): boolean =>
			value === null || Object.keys(value).every((field) => allowed.has(field))
		if (!within(operation.data)) return false
		// A delete's previousData is informational: the fold never reads it.
		return operation.type === 'delete' || within(operation.previousData)
	}

	/** Whether an operation carries an envelope v2. */
	static isEncryptedOperation(operation: { encrypted?: unknown }): boolean {
		return operation.encrypted !== undefined && operation.encrypted !== null
	}

	// --- Private helpers ---

	private async seal<T extends EncryptableOperation>(operation: T): Promise<T> {
		if (operation.encrypted !== undefined) return operation
		const keyVersion = this.currentVersion
		const key = this.keys.get(keyVersion)
		if (!key) {
			throw new EncryptionError(`Current encryption key version ${keyVersion} not found.`, {
				operationId: operation.id,
			})
		}
		const keyId = await this.getKeyId(keyVersion)
		const hasAtomicOps =
			operation.atomicOps !== undefined && Object.keys(operation.atomicOps).length > 0
		const [data, previousData, atomicOps] = await Promise.all([
			this.encryptMember(operation, 'data', operation.data, key, keyVersion),
			this.encryptMember(operation, 'previousData', operation.previousData, key, keyVersion),
			hasAtomicOps
				? this.encryptMember(operation, 'atomicOps', operation.atomicOps ?? null, key, keyVersion)
				: Promise.resolve(null),
		])
		const envelope: EncryptedOperationEnvelope = {
			v: 2,
			alg: 'aes-256-gcm',
			keyId,
			keyVersion,
			data,
			previousData,
			...(atomicOps !== null ? { atomicOps } : {}),
		}
		const { atomicOps: _plainAtomic, ...rest } = operation
		return {
			...rest,
			data: this.cleartextScope(operation),
			previousData: null,
			encrypted: envelope,
		} as T
	}

	private async open<T extends EncryptableOperation>(operation: T): Promise<T> {
		const envelope = operation.encrypted
		if (envelope === undefined || envelope === null) {
			if (isEncryptedPayload(operation.data) || isEncryptedPayload(operation.previousData)) {
				throw new DecryptionError(
					`Operation ${operation.id} carries a protocol-1 encrypted payload (ciphertext inside data, not bound to the operation). Protocol v2 accepts only the encryption envelope; re-sync from an upgraded client.`,
					{ operationId: operation.id, code: 'LEGACY_ENCRYPTED_PAYLOAD' },
				)
			}
			if (this.allowPlaintextMigration) return operation
			throw new DecryptionError(
				`Operation ${operation.id} is not encrypted, but end-to-end encryption is enabled: a plaintext operation could have been written by anyone who can reach the sync server. It is refused. During a migration from plaintext sync, set encryption.allowPlaintextMigration.`,
				{ operationId: operation.id, code: 'PLAINTEXT_REJECTED' },
			)
		}
		if (envelope.v !== 2 || envelope.alg !== 'aes-256-gcm') {
			throw new DecryptionError(
				`Unsupported encryption envelope (v${String(envelope.v)}, ${String(envelope.alg)}) on operation ${operation.id}. Update @korajs/sync.`,
				{ operationId: operation.id },
			)
		}
		const key = this.keys.get(envelope.keyVersion)
		if (!key) {
			throw new DecryptionError(
				`No encryption key available for version ${envelope.keyVersion} (key id ${envelope.keyId}). This operation was encrypted with a key that is not registered. If you rotated keys, ensure all previous key versions are provided.`,
				{
					operationId: operation.id,
					keyVersion: envelope.keyVersion,
					keyId: envelope.keyId,
					availableVersions: [...this.keys.keys()],
				},
			)
		}
		const localKeyId = await this.getKeyId(envelope.keyVersion)
		if (localKeyId !== envelope.keyId) {
			throw new DecryptionError(
				`Operation ${operation.id} was encrypted with key material "${envelope.keyId}" (version ${envelope.keyVersion}), but this device holds "${localKeyId}". The devices derived different keys: they need the same passphrase AND the same key-derivation salt.`,
				{
					operationId: operation.id,
					code: 'KEY_ID_MISMATCH',
					keyId: envelope.keyId,
					localKeyId,
					keyVersion: envelope.keyVersion,
				},
			)
		}
		if (envelope.data === null || envelope.previousData === null) {
			throw new DecryptionError(
				`Operation ${operation.id} has an incomplete encryption envelope (data and previousData must both be sealed).`,
				{ operationId: operation.id },
			)
		}
		const [data, previousData, atomicOps] = await Promise.all([
			this.decryptMember(operation, 'data', envelope.data, key, envelope.keyVersion),
			this.decryptMember(
				operation,
				'previousData',
				envelope.previousData,
				key,
				envelope.keyVersion,
			),
			envelope.atomicOps
				? this.decryptMember(operation, 'atomicOps', envelope.atomicOps, key, envelope.keyVersion)
				: Promise.resolve(null),
		])
		const { encrypted: _sealed, atomicOps: _unsealedAtomic, ...rest } = operation
		return {
			...rest,
			data,
			previousData,
			...(atomicOps !== null ? { atomicOps: atomicOps as Record<string, AtomicOp> } : {}),
		} as T
	}

	/** The collection's documented cleartext scope fields, or null when none. */
	private cleartextScope(operation: EncryptableOperation): Record<string, unknown> | null {
		const fields = this.cleartextFields[operation.collection]
		if (!fields || fields.length === 0 || operation.data === null) return null
		const scope: Record<string, unknown> = {}
		for (const field of fields) {
			if (field in operation.data) scope[field] = operation.data[field]
		}
		return Object.keys(scope).length > 0 ? scope : null
	}

	private async encryptMember(
		operation: EncryptableOperation,
		member: EnvelopeMember,
		value: Record<string, unknown> | null,
		key: VersionedKey,
		keyVersion: number,
	): Promise<EncryptedEnvelopeField> {
		try {
			const plaintext = new TextEncoder().encode(JSON.stringify(value))
			// A fresh random IV per member encryption (NIST SP 800-38D, 96-bit IV).
			const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LENGTH))
			const ciphertext = await globalThis.crypto.subtle.encrypt(
				{
					name: 'AES-GCM',
					iv: iv as unknown as ArrayBuffer,
					additionalData: additionalData(operation, member, keyVersion) as unknown as ArrayBuffer,
				},
				key.key,
				plaintext as unknown as ArrayBuffer,
			)
			return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ciphertext)) }
		} catch (cause) {
			throw new EncryptionError(
				`Failed to encrypt operation ${member}. Ensure the encryption key is valid and crypto.subtle is available.`,
				{
					operationId: operation.id,
					fieldName: member,
					cause: cause instanceof Error ? cause.message : String(cause),
				},
			)
		}
	}

	private async decryptMember(
		operation: EncryptableOperation,
		member: EnvelopeMember,
		sealed: EncryptedEnvelopeField,
		key: VersionedKey,
		keyVersion: number,
	): Promise<Record<string, unknown> | null> {
		let parsed: unknown
		try {
			const plaintext = await globalThis.crypto.subtle.decrypt(
				{
					name: 'AES-GCM',
					iv: fromBase64(sealed.iv) as unknown as ArrayBuffer,
					additionalData: additionalData(operation, member, keyVersion) as unknown as ArrayBuffer,
				},
				key.key,
				fromBase64(sealed.ct) as unknown as ArrayBuffer,
			)
			parsed = JSON.parse(new TextDecoder().decode(plaintext))
		} catch (cause) {
			throw new DecryptionError(
				`Failed to decrypt operation ${member}: the ciphertext does not authenticate against this operation. It was tampered with, moved from another operation, record or field, or encrypted with a different key.`,
				{
					operationId: operation.id,
					fieldName: member,
					keyVersion,
					cause: cause instanceof Error ? cause.message : String(cause),
				},
			)
		}
		if (parsed === null) return null
		if (typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new DecryptionError(`Decrypted ${member} is not a valid record object.`, {
				operationId: operation.id,
				fieldName: member,
			})
		}
		return parsed as Record<string, unknown>
	}
}

/** Options of {@link SyncEncryptor.fromKeys}. */
export interface EncryptorOptions {
	/** Per collection, the data fields kept in cleartext beside the envelope (for scopes). */
	cleartextFields?: Readonly<Record<string, readonly string[]>>
	/** Accept plaintext (envelope-less) inbound operations during a migration window. */
	allowPlaintextMigration?: boolean
}

/**
 * AES-GCM additional authenticated data of one envelope member (ENC-3): canonical
 * JSON of (nodeId, collection, recordId, type, timestamp, sequenceNumber, field,
 * keyVersion, hashVersion). The declared hash version is bound too, so an envelope's
 * id cannot be downgraded to the weaker version-1 hash in transit.
 */
function additionalData(
	operation: EncryptableOperation,
	member: EnvelopeMember,
	keyVersion: number,
): Uint8Array {
	return new TextEncoder().encode(
		canonicalize({
			nodeId: operation.nodeId,
			collection: operation.collection,
			recordId: operation.recordId,
			type: operation.type,
			timestamp: {
				wallTime: operation.timestamp.wallTime,
				logical: operation.timestamp.logical,
				nodeId: operation.timestamp.nodeId,
			},
			sequenceNumber: operation.sequenceNumber,
			field: member,
			keyVersion,
			hashVersion: operation.hashVersion ?? 1,
		}),
	)
}

/** First 16 hex chars of SHA-256("kora-key-id" || salt): names key material, reveals nothing. */
async function keyFingerprint(salt: Uint8Array): Promise<string> {
	const prefix = new TextEncoder().encode('kora-key-id\u0000')
	const input = new Uint8Array(prefix.length + salt.length)
	input.set(prefix, 0)
	input.set(salt, prefix.length)
	const digest = new Uint8Array(
		await globalThis.crypto.subtle.digest('SHA-256', input as unknown as ArrayBuffer),
	)
	return `k1-${Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')}`
}

// --- Utility functions ---

/**
 * Check if a field value contains a protocol-1 encrypted payload (ciphertext inside
 * `data`). Protocol v2 refuses such payloads; the envelope lives in `op.encrypted`.
 *
 * @param field - An operation's `data` or `previousData` field
 * @returns true if the field contains a protocol-1 encrypted payload
 */
export function isEncryptedPayload(field: Record<string, unknown> | null): boolean {
	if (field === null || typeof field !== 'object') {
		return false
	}
	return (
		field[LEGACY_ENCRYPTED_MARKER] === true &&
		typeof field.v === 'number' &&
		typeof field.iv === 'string' &&
		typeof field.ct === 'string' &&
		typeof field.alg === 'string'
	)
}

// --- Base64 helpers ---

function toBase64(bytes: Uint8Array): string {
	let binary = ''
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i] as number)
	}
	return btoa(binary)
}

function fromBase64(str: string): Uint8Array {
	const binary = atob(str)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}
	return bytes
}
