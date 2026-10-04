/**
 * The server-stored, passphrase-wrapped key record (ENC-1, decision D4b; format 2 since
 * the final RC red team, RT-95/RT-96/RT-97/RT-104).
 *
 * Key hierarchy of one keyring ("ring"):
 *
 *   passphrase --PBKDF2-SHA256(salt, iterations)--> KEK
 *   KEK --AES-GCM--> master key (random 256 bits, the ring's secret)
 *   recovery public key --ECDH P-256 + HKDF + AES-GCM--> master key (optional)
 *   master key --HKDF "data-key-wrap"--> wrapping key --AES-GCM--> data key v1, v2, ...
 *   master key --HKDF "record-mac"--> MAC key --HMAC-SHA256--> `mac` over the whole record
 *
 * The MAC covers every field except itself (format, keyring, ring id, revision, current
 * version, KDF parameters, the master wrap, every data-key wrap, the recovery block), so
 * a server cannot add or swap a recovery key, relabel or drop a version, or serve
 * another record under the same revision without the device noticing. Only a holder of
 * the master key (the passphrase, a device that opened the ring, or the recovery key)
 * can write a record devices accept. The server stores the record opaquely: it never
 * sees the passphrase, the KEK, the master key or a data key.
 *
 * Shared by the client keyring (which creates, opens and authenticates records) and the
 * sync server (which validates their structure and stores them with compare-and-set).
 */

/** Current record format. Format 1 (beta.13 release candidates only) is not read. */
export const KEY_RECORD_FORMAT = 2 as const

/** Name of the default keyring (one per user). */
export const DEFAULT_KEYRING = 'default'

/** Maximum serialized size of a key record the server accepts. */
export const MAX_KEY_RECORD_BYTES = 64 * 1024

/** Maximum number of key versions in one record. */
export const MAX_KEY_VERSIONS = 256

/** Maximum keyring name length. */
export const MAX_KEYRING_NAME_LENGTH = 128

/**
 * Maximum PBKDF2 iterations a device accepts. A record above it would make an unlock
 * never finish (the floor is the app's own `kdfIterations`).
 */
export const MAX_KDF_ITERATIONS = 10_000_000

/** Recovery wrap algorithm of format 2. */
export const RECOVERY_ALGORITHM = 'ECDH-P256+HKDF-SHA256+AES-GCM' as const

/** Key-derivation parameters of a record's passphrase KEK. */
export interface KeyRecordKdf {
	name: 'PBKDF2'
	hash: 'SHA-256'
	/** PBKDF2 iteration count (600,000 by default). */
	iterations: number
	/** Base64 random 32-byte salt, generated per passphrase. */
	salt: string
}

/** The ring's master key, wrapped by the passphrase KEK (AES-256-GCM). */
export interface WrappedMasterKey {
	/** Base64 12-byte AES-GCM IV. */
	iv: string
	/** Base64 AES-GCM ciphertext of the 32-byte master key (with tag: 48 bytes). */
	wrappedKey: string
}

/** One data key version, wrapped by the master key's wrapping key. */
export interface WrappedDataKey {
	/** Key version (1, 2, ...) in this ring. */
	keyVersion: number
	/** Random key id: the envelope's `keyId`. Never derived from key material. */
	keyId: string
	/** Base64 12-byte AES-GCM IV of the wrap. */
	iv: string
	/** Base64 AES-GCM wrap of the raw 32-byte data key (ciphertext and tag). */
	wrappedKey: string
}

/**
 * Optional recovery: the master key, wrapped to a recovery public key (ephemeral-static
 * ECDH P-256, HKDF-SHA256 over the shared secret and both public keys, AES-256-GCM). The
 * private half is the user's recovery key; it opens the master key, hence every data key.
 */
export interface KeyRecordRecovery {
	alg: typeof RECOVERY_ALGORITHM
	/** Recovery public key (JWK x/y, base64url). */
	publicKey: { x: string; y: string }
	/** Ephemeral public key of the wrap (JWK x/y, base64url). */
	ephemeralPublicKey: { x: string; y: string }
	iv: string
	wrappedKey: string
}

/**
 * The record the sync server stores per (user, keyring). Opaque to the server apart
 * from its structure: it cannot unwrap any key or forge the MAC.
 */
export interface WrappedKeyRecord {
	format: typeof KEY_RECORD_FORMAT
	keyring: string
	/** Random id of this ring (`r-` and 32 hex digits). Two rings of one keyring are a fork. */
	ringId: string
	/** Compare-and-set counter: grows on every write; devices never accept a lower one. */
	revision: number
	/** The key version new operations are encrypted with (the highest one). */
	currentVersion: number
	kdf: KeyRecordKdf
	master: WrappedMasterKey
	/** Every key version ever created. Never shrinks: old history must stay readable. */
	keys: WrappedDataKey[]
	recovery?: KeyRecordRecovery
	/**
	 * Ids (`m-` and 32 hex digits) of master keys a passphrase change retired (RT-107).
	 * Append-only. A device that authenticated a record listing them refuses every later
	 * record authenticated only by one of them, however it was opened (held master key,
	 * a stale configured passphrase, the old passphrase typed again). Absent until the
	 * first passphrase change.
	 */
	retiredMasters?: string[]
	/** Base64 HMAC-SHA256 of every other field (see {@link keyRecordMacInput}). */
	mac: string
}

/** Result of a structural validation. */
export type KeyRecordValidation = { ok: true } | { ok: false; reason: string }

const RECORD_FIELDS: ReadonlySet<string> = new Set([
	'format',
	'keyring',
	'ringId',
	'revision',
	'currentVersion',
	'kdf',
	'master',
	'keys',
	'recovery',
	'retiredMasters',
	'mac',
])

/**
 * Structural validation of a key record (server and client). It does not and cannot
 * check the MAC or that the wraps open: only a holder of the master key can.
 *
 * @param value - A decoded record
 * @param keyring - The keyring the record must belong to
 */
export function validateKeyRecord(value: unknown, keyring: string): KeyRecordValidation {
	if (!isObject(value)) return fail('record is not an object')
	if (value.format !== KEY_RECORD_FORMAT) return fail(`unsupported format ${String(value.format)}`)
	for (const field of Object.keys(value)) {
		// Strict: every field is covered by the MAC, and an unknown one has no meaning.
		if (!RECORD_FIELDS.has(field)) return fail(`unknown field "${field}"`)
	}
	if (value.keyring !== keyring) return fail('keyring does not match')
	if (!isRingId(value.ringId)) return fail('ringId is malformed')
	if (!isPositiveInteger(value.revision)) return fail('revision must be a positive integer')
	if (!isPositiveInteger(value.currentVersion)) return fail('currentVersion must be positive')
	const kdf = value.kdf
	if (!isObject(kdf) || kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256') {
		return fail('kdf must be PBKDF2 with SHA-256')
	}
	if (!isPositiveInteger(kdf.iterations) || kdf.iterations > MAX_KDF_ITERATIONS) {
		return fail(`kdf.iterations must be 1 to ${MAX_KDF_ITERATIONS}`)
	}
	if (!isBase64(kdf.salt, 16, 64)) return fail('kdf.salt must be 16 to 64 base64 bytes')
	const master = value.master
	if (!isObject(master) || !isBase64(master.iv, 12, 12) || !isBase64(master.wrappedKey, 48, 48)) {
		return fail('master wrap is malformed')
	}
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
		if (!isObject(recovery) || recovery.alg !== RECOVERY_ALGORITHM) {
			return fail(`recovery.alg must be ${RECOVERY_ALGORITHM}`)
		}
		if (!isPoint(recovery.publicKey)) return fail('recovery.publicKey is malformed')
		if (!isPoint(recovery.ephemeralPublicKey)) return fail('recovery ephemeral key is malformed')
		if (!isBase64(recovery.iv, 12, 12) || !isBase64(recovery.wrappedKey, 48, 48)) {
			return fail('recovery wrap is malformed')
		}
	}
	if (value.retiredMasters !== undefined) {
		const retired = value.retiredMasters
		if (!Array.isArray(retired) || retired.length > MAX_KEY_VERSIONS) {
			return fail(`retiredMasters must be an array of at most ${MAX_KEY_VERSIONS} ids`)
		}
		if (!retired.every((id) => isMasterId(id)) || new Set(retired).size !== retired.length) {
			return fail('retiredMasters must hold distinct master ids')
		}
	}
	if (!isBase64(value.mac, 32, 32)) return fail('mac must be 32 base64 bytes')
	return { ok: true }
}

/**
 * Whether `next` may replace `previous` (the server's write rule): the revision grows,
 * the ring id stays, and every key version of `previous` is still present under the
 * same key id, so no history becomes unreadable. Wraps may change (a passphrase change
 * re-wraps every version). A first record (or one re-uploaded after the server lost
 * it) may carry any revision: devices pin the highest revision they accepted, so a
 * restore must keep the revision it had.
 *
 * @param previous - The stored record, or null when none exists
 * @param next - The proposed record
 */
export function isKeyRecordSuccessor(
	previous: WrappedKeyRecord | null,
	next: WrappedKeyRecord,
): KeyRecordValidation {
	if (previous === null) return { ok: true }
	if (next.revision <= previous.revision) {
		return fail(`revision must be greater than ${previous.revision}`)
	}
	if (next.ringId !== previous.ringId) return fail('ringId must not change')
	const nextIds = new Map(next.keys.map((key) => [key.keyVersion, key.keyId]))
	for (const key of previous.keys) {
		if (nextIds.get(key.keyVersion) !== key.keyId) {
			return fail(`key version ${key.keyVersion} must be kept`)
		}
	}
	const nextRetired = new Set(next.retiredMasters ?? [])
	for (const id of previous.retiredMasters ?? []) {
		if (!nextRetired.has(id)) return fail(`retired master ${id} must be kept`)
	}
	return { ok: true }
}

/**
 * Additional authenticated data of one data-key wrap: binds a wrapped data key to its
 * keyring, version and key id, so a wrap cannot be relabelled as another version's.
 *
 * @param keyring - Keyring name
 * @param keyVersion - Key version
 * @param keyId - Key id
 */
export function wrapAdditionalData(keyring: string, keyVersion: number, keyId: string): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify(['kora-key-wrap', KEY_RECORD_FORMAT, 'data-key', keyring, keyVersion, keyId]),
	)
}

/**
 * Additional authenticated data of a master-key wrap (passphrase or recovery): binds it
 * to the keyring and ring, and a recovery wrap to its recipient public key.
 */
export function masterWrapAdditionalData(
	keyring: string,
	ringId: string,
	purpose: 'passphrase' | 'recovery',
	recipient?: { x: string; y: string },
): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify([
			'kora-master-wrap',
			KEY_RECORD_FORMAT,
			purpose,
			keyring,
			ringId,
			recipient?.x ?? null,
			recipient?.y ?? null,
		]),
	)
}

/**
 * The bytes the record MAC covers: a domain prefix and the canonical JSON (sorted keys,
 * no whitespace) of every field except `mac`.
 *
 * @param record - The record (its `mac`, if any, is ignored)
 */
export function keyRecordMacInput(
	record: WrappedKeyRecord | Omit<WrappedKeyRecord, 'mac'>,
): Uint8Array {
	const { mac: _mac, ...rest } = record as WrappedKeyRecord
	return new TextEncoder().encode(
		`kora-key-record-mac\u0000${KEY_RECORD_FORMAT}\u0000${canonicalJson(rest)}`,
	)
}

/** Deterministic JSON: object keys sorted, undefined members dropped, no whitespace. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		const encoded = JSON.stringify(value)
		return encoded === undefined ? 'null' : encoded
	}
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
	const entries = Object.keys(value as Record<string, unknown>)
		.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
		.sort()
		.map(
			(key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
		)
	return `{${entries.join(',')}}`
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

/** Whether a value is a key id (`k2-` and 32 hex digits). */
export function isKeyId(value: unknown): value is string {
	return typeof value === 'string' && /^k2-[0-9a-f]{32}$/.test(value)
}

/** Whether a value is a master id (`m-` and 32 hex digits). */
export function isMasterId(value: unknown): value is string {
	return typeof value === 'string' && /^m-[0-9a-f]{32}$/.test(value)
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

function isRingId(value: unknown): value is string {
	return typeof value === 'string' && /^r-[0-9a-f]{32}$/.test(value)
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
