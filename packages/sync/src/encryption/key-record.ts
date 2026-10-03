/**
 * The server-stored, passphrase-wrapped key record (ENC-1, decision D4b).
 *
 * Each user (or encryption scope, "keyring") owns random 256-bit data keys, one per
 * key version. Each data key is wrapped with AES-256-GCM by a key-encryption key (KEK)
 * derived from the user's passphrase with PBKDF2-SHA256 and a per-record random salt.
 * The server stores only this record: salt, KDF parameters, wrapped keys, key ids and
 * versions. It never sees the passphrase, the KEK or a data key.
 *
 * Shared by the client keyring (which creates and opens records) and the sync server
 * (which validates their structure and stores them with compare-and-set).
 */

/** Current record format. */
export const KEY_RECORD_FORMAT = 1 as const

/** Name of the default keyring (one per user). */
export const DEFAULT_KEYRING = 'default'

/** Maximum serialized size of a key record the server accepts. */
export const MAX_KEY_RECORD_BYTES = 64 * 1024

/** Maximum number of key versions in one record. */
export const MAX_KEY_VERSIONS = 256

/** Maximum keyring name length. */
export const MAX_KEYRING_NAME_LENGTH = 128

/** Key-derivation parameters of a record's passphrase KEK. */
export interface KeyRecordKdf {
	name: 'PBKDF2'
	hash: 'SHA-256'
	/** PBKDF2 iteration count (600,000 by default). */
	iterations: number
	/** Base64 random 32-byte salt, generated per record (and per passphrase change). */
	salt: string
}

/** One data key version, wrapped by the passphrase KEK. */
export interface WrappedDataKey {
	/** Key version (1, 2, ...): the envelope's `keyVersion`. */
	keyVersion: number
	/** Random key id: the envelope's `keyId`. Never derived from key material. */
	keyId: string
	/** Base64 12-byte AES-GCM IV of the wrap. */
	iv: string
	/** Base64 AES-GCM wrap of the raw 32-byte data key (ciphertext and tag). */
	wrappedKey: string
}

/** One data key version, wrapped for the recovery key (ECDH P-256 + AES-GCM). */
export interface RecoveryWrappedDataKey {
	keyVersion: number
	keyId: string
	/** Ephemeral P-256 public key of this wrap (JWK x/y, base64url). */
	ephemeralPublicKey: { x: string; y: string }
	iv: string
	wrappedKey: string
}

/** Optional recovery wraps: every data key is also wrapped to a recovery public key. */
export interface KeyRecordRecovery {
	alg: 'ECDH-P256+AES-GCM'
	/** Recovery public key (JWK x/y, base64url). The private half is the recovery key. */
	publicKey: { x: string; y: string }
	keys: RecoveryWrappedDataKey[]
}

/**
 * The record the sync server stores per (user, keyring). Opaque to the server apart
 * from its structure: it cannot unwrap any key.
 */
export interface WrappedKeyRecord {
	format: typeof KEY_RECORD_FORMAT
	keyring: string
	/** Compare-and-set counter: 1 at creation, +1 on every write. */
	revision: number
	/** The key version new operations are encrypted with (the highest one). */
	currentVersion: number
	kdf: KeyRecordKdf
	/** Every key version ever created. Never shrinks: old history must stay readable. */
	keys: WrappedDataKey[]
	recovery?: KeyRecordRecovery
}

/** Result of a structural validation. */
export type KeyRecordValidation = { ok: true } | { ok: false; reason: string }

/**
 * Structural validation of a key record (server and client). It does not and cannot
 * check that the wraps open: only a holder of the passphrase can.
 *
 * @param value - A decoded record
 * @param keyring - The keyring the record must belong to
 */
export function validateKeyRecord(value: unknown, keyring: string): KeyRecordValidation {
	if (!isObject(value)) return fail('record is not an object')
	if (value.format !== KEY_RECORD_FORMAT) return fail(`unsupported format ${String(value.format)}`)
	if (value.keyring !== keyring) return fail('keyring does not match')
	if (!isPositiveInteger(value.revision)) return fail('revision must be a positive integer')
	if (!isPositiveInteger(value.currentVersion)) return fail('currentVersion must be positive')
	const kdf = value.kdf
	if (!isObject(kdf) || kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256') {
		return fail('kdf must be PBKDF2 with SHA-256')
	}
	if (!isPositiveInteger(kdf.iterations)) return fail('kdf.iterations must be positive')
	if (!isBase64(kdf.salt, 16, 64)) return fail('kdf.salt must be 16 to 64 base64 bytes')
	if (!Array.isArray(value.keys) || value.keys.length === 0) return fail('keys must not be empty')
	if (value.keys.length > MAX_KEY_VERSIONS) return fail('too many key versions')
	const versions = new Set<number>()
	const ids = new Set<string>()
	let max = 0
	for (const key of value.keys) {
		if (!isObject(key)) return fail('key entry is not an object')
		if (!isPositiveInteger(key.keyVersion)) return fail('keyVersion must be positive')
		if (!isKeyId(key.keyId)) return fail('keyId is malformed')
		if (!isBase64(key.iv, 12, 12)) return fail('iv must be 12 base64 bytes')
		if (!isBase64(key.wrappedKey, 48, 48)) return fail('wrappedKey must be 48 base64 bytes')
		if (versions.has(key.keyVersion) || ids.has(key.keyId)) return fail('duplicate key version')
		versions.add(key.keyVersion)
		ids.add(key.keyId)
		max = Math.max(max, key.keyVersion)
	}
	if (value.currentVersion !== max) return fail('currentVersion must be the highest key version')
	if (value.recovery !== undefined) {
		const recovery = value.recovery
		if (!isObject(recovery) || recovery.alg !== 'ECDH-P256+AES-GCM') {
			return fail('recovery.alg must be ECDH-P256+AES-GCM')
		}
		if (!isPoint(recovery.publicKey)) return fail('recovery.publicKey is malformed')
		if (!Array.isArray(recovery.keys)) return fail('recovery.keys must be an array')
		for (const key of recovery.keys) {
			if (!isObject(key)) return fail('recovery key entry is not an object')
			if (!isPositiveInteger(key.keyVersion) || !versions.has(key.keyVersion)) {
				return fail('recovery keyVersion is unknown')
			}
			if (!isKeyId(key.keyId)) return fail('recovery keyId is malformed')
			if (!isPoint(key.ephemeralPublicKey)) return fail('recovery ephemeral key is malformed')
			if (!isBase64(key.iv, 12, 12) || !isBase64(key.wrappedKey, 48, 48)) {
				return fail('recovery wrap is malformed')
			}
		}
	}
	return { ok: true }
}

/**
 * Whether `next` may replace `previous` (server write rule, also the client's
 * rollback check): the revision advances by exactly one, and every key version of
 * `previous` is still present under the same key id, so no history becomes
 * unreadable. Wraps may change (a passphrase change re-wraps every version).
 *
 * @param previous - The stored record, or null when none exists
 * @param next - The proposed record
 */
export function isKeyRecordSuccessor(
	previous: WrappedKeyRecord | null,
	next: WrappedKeyRecord,
): KeyRecordValidation {
	const expectedRevision = (previous?.revision ?? 0) + 1
	if (next.revision !== expectedRevision) {
		return fail(`revision must be ${expectedRevision}`)
	}
	if (previous === null) return { ok: true }
	const nextIds = new Map(next.keys.map((key) => [key.keyVersion, key.keyId]))
	for (const key of previous.keys) {
		if (nextIds.get(key.keyVersion) !== key.keyId) {
			return fail(`key version ${key.keyVersion} must be kept`)
		}
	}
	return { ok: true }
}

/**
 * Additional authenticated data of one wrap: binds a wrapped data key to its keyring,
 * version and key id, so a server cannot relabel one version's key as another's.
 *
 * @param keyring - Keyring name
 * @param keyVersion - Key version
 * @param keyId - Key id
 * @param purpose - 'passphrase' or 'recovery'
 */
export function wrapAdditionalData(
	keyring: string,
	keyVersion: number,
	keyId: string,
	purpose: 'passphrase' | 'recovery',
): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify(['kora-key-wrap', 1, purpose, keyring, keyVersion, keyId]),
	)
}

/** Parse a record from JSON, returning null when it is not one. */
export function parseKeyRecord(json: string, keyring: string): WrappedKeyRecord | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(json)
	} catch {
		return null
	}
	return validateKeyRecord(parsed, keyring).ok ? (parsed as WrappedKeyRecord) : null
}

/** Whether a keyring name is acceptable. */
export function isValidKeyringName(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= MAX_KEYRING_NAME_LENGTH &&
		/^[A-Za-z0-9._:-]+$/.test(value)
	)
}

function fail(reason: string): KeyRecordValidation {
	return { ok: false, reason }
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isKeyId(value: unknown): value is string {
	return typeof value === 'string' && /^k2-[0-9a-f]{32}$/.test(value)
}

function isBase64(value: unknown, minBytes: number, maxBytes: number): boolean {
	if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false
	if (value.length % 4 !== 0) return false
	const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
	const bytes = (value.length / 4) * 3 - padding
	return bytes >= minBytes && bytes <= maxBytes
}

function isPoint(value: unknown): value is { x: string; y: string } {
	return (
		isObject(value) &&
		typeof value.x === 'string' &&
		typeof value.y === 'string' &&
		/^[A-Za-z0-9_-]{43}$/.test(value.x) &&
		/^[A-Za-z0-9_-]{43}$/.test(value.y)
	)
}
