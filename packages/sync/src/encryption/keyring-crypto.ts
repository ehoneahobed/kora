import { SyncError } from '@korajs/core'
import type {
	KeyRecordRecovery,
	WrappedDataKey,
	WrappedKeyRecord,
	WrappedMasterKey,
} from './key-record'
import {
	RECOVERY_ALGORITHM,
	keyRecordMacInput,
	masterWrapAdditionalData,
	wrapAdditionalData,
} from './key-record'

/**
 * WebCrypto primitives of the key hierarchy (ENC-1, D4b, record format 2):
 *
 *   passphrase --PBKDF2-SHA256(salt, iterations)--> KEK (AES-256-GCM, non-extractable)
 *   KEK --AES-GCM (AAD: keyring, ring)--> master key (32 random bytes)
 *   recovery public key --ECDH P-256, HKDF-SHA256, AES-GCM--> master key (optional)
 *   master key --HKDF-SHA256 "data-key-wrap"--> wrapping key (AES-256-GCM)
 *   master key --HKDF-SHA256 "record-mac"--> MAC key (HMAC-SHA256)
 *   wrapping key --AES-GCM wrap (AAD: keyring, version, keyId)--> data key v1, v2, ...
 *   lowest data key --HMAC-SHA256 "recovery-anchor"--> anchor (16 bytes, in the recovery key)
 *
 * Raw master-key bytes exist only inside the calls that create, re-wrap or open the
 * master key, and are zeroed afterwards. What a device keeps is the two derived keys
 * ({@link MasterKeys}), both non-extractable. Data keys are extractable only for the
 * moment they are wrapped; the copy a device encrypts with is non-extractable.
 */

/** Thrown when a key record cannot be opened with the given passphrase or recovery key. */
export class KeyUnwrapError extends SyncError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, { ...context, errorType: 'KEY_UNWRAP_ERROR' })
		this.name = 'KeyUnwrapError'
	}
}

/** PBKDF2 salt length (bytes). */
export const KEK_SALT_BYTES = 32

/** Master key length (bytes). */
export const MASTER_KEY_BYTES = 32

const GCM_IV_BYTES = 12
const RECOVERY_KEY_PREFIX = 'kora-rk2-'
/** Bytes of a recovery key's ring anchor (see {@link dataKeyAnchor}). */
const RECOVERY_ANCHOR_BYTES = 16
const HKDF_DATA_KEY_WRAP = 'kora/key-record/2/data-key-wrap'
const HKDF_RECORD_MAC = 'kora/key-record/2/record-mac'
const HKDF_RECOVERY_WRAP = 'kora/key-record/2/recovery-wrap'
const RECOVERY_ANCHOR_INFO = 'kora/key-record/2/recovery-anchor'

/** The keys a device derives from (and keeps instead of) a ring's master key. */
export interface MasterKeys {
	/** Wraps and unwraps the ring's data keys. */
	wrapKey: CryptoKey
	/** Authenticates the whole key record. */
	macKey: CryptoKey
}

function subtle(): SubtleCrypto {
	const api = globalThis.crypto?.subtle
	if (!api) {
		throw new SyncError(
			'Web Crypto API (crypto.subtle) is not available. Sync encryption requires a secure context (HTTPS or localhost) in browsers, or Node.js 20+.',
			{ code: 'CRYPTO_UNAVAILABLE' },
		)
	}
	return api
}

function buffer(bytes: Uint8Array): ArrayBuffer {
	return bytes as unknown as ArrayBuffer
}

/** Cryptographically random bytes. */
export function randomBytes(length: number): Uint8Array {
	return globalThis.crypto.getRandomValues(new Uint8Array(length))
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** A fresh random key id (`k2-` and 32 hex digits). Names a key; reveals nothing about it. */
export function newKeyId(): string {
	return `k2-${hex(randomBytes(16))}`
}

/** A fresh random ring id (`r-` and 32 hex digits). */
export function newRingId(): string {
	return `r-${hex(randomBytes(16))}`
}

/**
 * Derive the key-encryption key from a passphrase. Non-extractable; usable only to
 * seal and open the ring's master key.
 *
 * @param passphrase - The user's passphrase (non-empty)
 * @param salt - The record's random salt
 * @param iterations - PBKDF2 iterations
 */
export async function deriveKeyEncryptionKey(
	passphrase: string,
	salt: Uint8Array,
	iterations: number,
): Promise<CryptoKey> {
	if (passphrase.length === 0) {
		throw new KeyUnwrapError('The encryption passphrase must not be empty.', {
			code: 'EMPTY_PASSPHRASE',
		})
	}
	const base = await subtle().importKey(
		'raw',
		buffer(new TextEncoder().encode(passphrase)),
		'PBKDF2',
		false,
		['deriveKey'],
	)
	return subtle().deriveKey(
		{ name: 'PBKDF2', salt: buffer(salt), iterations, hash: 'SHA-256' },
		base,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	)
}

/** New random master-key bytes. The caller zeroes them once wrapped and imported. */
export function generateMasterKey(): Uint8Array {
	return randomBytes(MASTER_KEY_BYTES)
}

/**
 * Derive the non-extractable wrapping and MAC keys of a master key (HKDF-SHA256 with
 * distinct info strings).
 */
export async function importMasterKey(raw: Uint8Array): Promise<MasterKeys> {
	const base = await subtle().importKey('raw', buffer(raw), 'HKDF', false, ['deriveKey'])
	const hkdf = (info: string): HkdfParams => ({
		name: 'HKDF',
		hash: 'SHA-256',
		salt: new ArrayBuffer(0),
		info: buffer(new TextEncoder().encode(info)),
	})
	const [wrapKey, macKey] = await Promise.all([
		subtle().deriveKey(hkdf(HKDF_DATA_KEY_WRAP), base, { name: 'AES-GCM', length: 256 }, false, [
			'wrapKey',
			'unwrapKey',
		]),
		subtle().deriveKey(
			hkdf(HKDF_RECORD_MAC),
			base,
			{ name: 'HMAC', hash: 'SHA-256', length: 256 },
			false,
			['sign', 'verify'],
		),
	])
	return { wrapKey, macKey }
}

/** Seal the master key under the passphrase KEK. */
export async function wrapMasterKey(
	raw: Uint8Array,
	kek: CryptoKey,
	keyring: string,
	ringId: string,
): Promise<WrappedMasterKey> {
	const iv = randomBytes(GCM_IV_BYTES)
	const sealed = await subtle().encrypt(
		{
			name: 'AES-GCM',
			iv: buffer(iv),
			additionalData: buffer(masterWrapAdditionalData(keyring, ringId, 'passphrase')),
		},
		kek,
		buffer(raw),
	)
	return { iv: toBase64(iv), wrappedKey: toBase64(new Uint8Array(sealed)) }
}

/**
 * Open the master key with the passphrase KEK. The returned bytes must be zeroed by
 * the caller once imported (or re-wrapped).
 *
 * @throws {KeyUnwrapError} WRONG_PASSPHRASE when the wrap does not authenticate
 */
export async function unwrapMasterKey(
	wrap: WrappedMasterKey,
	kek: CryptoKey,
	keyring: string,
	ringId: string,
): Promise<Uint8Array> {
	try {
		const raw = await subtle().decrypt(
			{
				name: 'AES-GCM',
				iv: buffer(fromBase64(wrap.iv)),
				additionalData: buffer(masterWrapAdditionalData(keyring, ringId, 'passphrase')),
			},
			kek,
			buffer(fromBase64(wrap.wrappedKey)),
		)
		return new Uint8Array(raw)
	} catch (cause) {
		throw new KeyUnwrapError(
			`The passphrase does not open keyring "${keyring}". Check the passphrase.`,
			{
				code: 'WRONG_PASSPHRASE',
				cause: cause instanceof Error ? cause.message : String(cause),
			},
		)
	}
}

/**
 * Wrap a data key with the ring's wrapping key.
 *
 * @param dataKey - An extractable data key
 * @param wrapKey - The master key's wrapping key
 * @param keyring - Keyring name (bound as AAD)
 * @param keyVersion - Key version (bound as AAD)
 * @param keyId - Key id (bound as AAD)
 */
export async function wrapDataKey(
	dataKey: CryptoKey,
	wrapKey: CryptoKey,
	keyring: string,
	keyVersion: number,
	keyId: string,
): Promise<WrappedDataKey> {
	const iv = randomBytes(GCM_IV_BYTES)
	const wrapped = await subtle().wrapKey('raw', dataKey, wrapKey, {
		name: 'AES-GCM',
		iv: buffer(iv),
		additionalData: buffer(wrapAdditionalData(keyring, keyVersion, keyId)),
	})
	return { keyVersion, keyId, iv: toBase64(iv), wrappedKey: toBase64(new Uint8Array(wrapped)) }
}

/**
 * Unwrap a data key with the ring's wrapping key. A tampered wrap, or one relabelled to
 * another version, fails authentication.
 *
 * @param entry - The wrapped key
 * @param wrapKey - The master key's wrapping key
 * @param keyring - Keyring name
 * @param extractable - True only to re-wrap it right away; the kept copy is non-extractable
 * @throws {KeyUnwrapError} When the wrap does not authenticate under this key
 */
export async function unwrapDataKey(
	entry: WrappedDataKey,
	wrapKey: CryptoKey,
	keyring: string,
	extractable = false,
): Promise<CryptoKey> {
	try {
		return await subtle().unwrapKey(
			'raw',
			buffer(fromBase64(entry.wrappedKey)),
			wrapKey,
			{
				name: 'AES-GCM',
				iv: buffer(fromBase64(entry.iv)),
				additionalData: buffer(wrapAdditionalData(keyring, entry.keyVersion, entry.keyId)),
			},
			{ name: 'AES-GCM', length: 256 },
			extractable,
			['encrypt', 'decrypt'],
		)
	} catch (cause) {
		throw new KeyUnwrapError(
			`Key version ${entry.keyVersion} of keyring "${keyring}" does not open under this ring's master key.`,
			{
				code: 'KEY_UNWRAP_FAILED',
				keyVersion: entry.keyVersion,
				cause: cause instanceof Error ? cause.message : String(cause),
			},
		)
	}
}

/** The record's MAC (base64 HMAC-SHA256) under a master key's MAC key. */
export async function computeRecordMac(
	record: Omit<WrappedKeyRecord, 'mac'> | WrappedKeyRecord,
	macKey: CryptoKey,
): Promise<string> {
	const mac = await subtle().sign('HMAC', macKey, buffer(keyRecordMacInput(record)))
	return toBase64(new Uint8Array(mac))
}

/** A copy of `record` with its MAC computed under `macKey`. */
export async function sealRecord(
	record: Omit<WrappedKeyRecord, 'mac'> | WrappedKeyRecord,
	macKey: CryptoKey,
): Promise<WrappedKeyRecord> {
	const { mac: _old, ...body } = record as WrappedKeyRecord
	return { ...body, mac: await computeRecordMac(body, macKey) } as WrappedKeyRecord
}

/** Whether the record's MAC verifies under `macKey` (constant-time, WebCrypto verify). */
export async function verifyRecordMac(
	record: WrappedKeyRecord,
	macKey: CryptoKey,
): Promise<boolean> {
	try {
		return await subtle().verify(
			'HMAC',
			macKey,
			buffer(fromBase64(record.mac)),
			buffer(keyRecordMacInput(record)),
		)
	} catch {
		return false
	}
}

/**
 * A new recovery key pair. The public half goes in the record; the user gets the
 * private scalar together with the ring anchor (`kora-rk2-<d>.<anchor>`).
 *
 * The anchor ties the recovery key to the ring it was made for. Anyone who knows the
 * recovery PUBLIC key (the server stores it) can wrap a master key of their own to it,
 * so opening a master key with the recovery key proves nothing about whose ring it is.
 * The anchor is a fingerprint of one of the ring's data keys ({@link dataKeyAnchor}):
 * only a ring that really holds that data key matches it, and nobody without the key
 * can build one that does.
 *
 * @param anchor - The ring anchor ({@link dataKeyAnchor}); random when omitted (tests)
 */
export async function generateRecoveryKeyPair(
	anchor: Uint8Array = randomBytes(RECOVERY_ANCHOR_BYTES),
): Promise<{
	publicKey: { x: string; y: string }
	recoveryKey: string
}> {
	if (anchor.length !== RECOVERY_ANCHOR_BYTES) {
		throw new SyncError('A recovery key anchor is 16 bytes.', { code: 'RECOVERY_KEY_EXPORT' })
	}
	const pair = (await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
		'deriveBits',
	])) as CryptoKeyPair
	const jwk = await subtle().exportKey('jwk', pair.privateKey)
	if (typeof jwk.d !== 'string' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
		throw new SyncError('Failed to export the recovery key.', { code: 'RECOVERY_KEY_EXPORT' })
	}
	return {
		publicKey: { x: jwk.x, y: jwk.y },
		recoveryKey: `${RECOVERY_KEY_PREFIX}${jwk.d}.${toBase64Url(anchor)}`,
	}
}

/**
 * The ring anchor of a data key: the first 16 bytes of HMAC-SHA256 keyed with the raw
 * data key over the keyring and key id. Reveals nothing about the key; matching it
 * requires the key itself.
 *
 * @param dataKey - An extractable data key
 * @param keyring - Keyring name
 * @param keyId - The data key's key id
 */
export async function dataKeyAnchor(
	dataKey: CryptoKey,
	keyring: string,
	keyId: string,
): Promise<Uint8Array> {
	const raw = new Uint8Array(await subtle().exportKey('raw', dataKey))
	try {
		const hmac = await subtle().importKey(
			'raw',
			buffer(raw),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		)
		const tag = await subtle().sign(
			'HMAC',
			hmac,
			buffer(new TextEncoder().encode(JSON.stringify([RECOVERY_ANCHOR_INFO, keyring, keyId]))),
		)
		return new Uint8Array(tag).slice(0, RECOVERY_ANCHOR_BYTES)
	} finally {
		raw.fill(0)
	}
}

/**
 * Split a recovery key into its private scalar and ring anchor.
 *
 * @throws {KeyUnwrapError} WRONG_RECOVERY_KEY when it is not a `kora-rk2-` recovery key
 */
export function parseRecoveryKey(recoveryKey: string): { d: string; anchor: Uint8Array } {
	const match = /^kora-rk2-([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})$/.exec(recoveryKey.trim())
	if (match === null) {
		throw new KeyUnwrapError(
			`A recovery key has the form "${RECOVERY_KEY_PREFIX}<key>.<anchor>", as enableRecovery() returned it.`,
			{ code: 'WRONG_RECOVERY_KEY' },
		)
	}
	return { d: match[1] as string, anchor: fromBase64Url(match[2] as string) }
}

/** Whether two byte strings are equal (no early exit). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number)
	return diff === 0
}

/**
 * HKDF-SHA256 over the ECDH shared secret, with both public keys in the info, to the
 * AES-GCM key of a recovery wrap (never the raw shared secret as a key).
 */
async function recoveryWrappingKey(
	privateKey: CryptoKey,
	peer: CryptoKey,
	ephemeral: { x: string; y: string },
	recipient: { x: string; y: string },
	usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
	const secret = new Uint8Array(
		await subtle().deriveBits({ name: 'ECDH', public: peer }, privateKey, 256),
	)
	try {
		const base = await subtle().importKey('raw', buffer(secret), 'HKDF', false, ['deriveKey'])
		return await subtle().deriveKey(
			{
				name: 'HKDF',
				hash: 'SHA-256',
				salt: new ArrayBuffer(0),
				info: buffer(
					new TextEncoder().encode(
						JSON.stringify([
							HKDF_RECOVERY_WRAP,
							ephemeral.x,
							ephemeral.y,
							recipient.x,
							recipient.y,
						]),
					),
				),
			},
			base,
			{ name: 'AES-GCM', length: 256 },
			false,
			[usage],
		)
	} finally {
		secret.fill(0)
	}
}

/**
 * Wrap the master key for the recovery public key (ephemeral-static ECDH P-256).
 * Needs only the public key.
 */
export async function wrapMasterForRecovery(
	raw: Uint8Array,
	recoveryPublicKey: { x: string; y: string },
	keyring: string,
	ringId: string,
): Promise<KeyRecordRecovery> {
	const recipient = await importPoint(recoveryPublicKey)
	const ephemeral = (await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
		'deriveBits',
	])) as CryptoKeyPair
	const ephemeralJwk = await subtle().exportKey('jwk', ephemeral.publicKey)
	const ephemeralPublicKey = { x: String(ephemeralJwk.x), y: String(ephemeralJwk.y) }
	const key = await recoveryWrappingKey(
		ephemeral.privateKey,
		recipient,
		ephemeralPublicKey,
		recoveryPublicKey,
		'encrypt',
	)
	const iv = randomBytes(GCM_IV_BYTES)
	const sealed = await subtle().encrypt(
		{
			name: 'AES-GCM',
			iv: buffer(iv),
			additionalData: buffer(
				masterWrapAdditionalData(keyring, ringId, 'recovery', recoveryPublicKey),
			),
		},
		key,
		buffer(raw),
	)
	return {
		alg: RECOVERY_ALGORITHM,
		publicKey: { x: recoveryPublicKey.x, y: recoveryPublicKey.y },
		ephemeralPublicKey,
		iv: toBase64(iv),
		wrappedKey: toBase64(new Uint8Array(sealed)),
	}
}

/**
 * Open the master key with the recovery key. The caller zeroes the returned bytes.
 *
 * @throws {KeyUnwrapError} WRONG_RECOVERY_KEY when the key is malformed or does not open it
 */
export async function unwrapMasterWithRecovery(
	recovery: KeyRecordRecovery,
	recoveryKey: string,
	keyring: string,
	ringId: string,
): Promise<Uint8Array> {
	const { d } = parseRecoveryKey(recoveryKey)
	try {
		const privateKey = await subtle().importKey(
			'jwk',
			{
				kty: 'EC',
				crv: 'P-256',
				x: recovery.publicKey.x,
				y: recovery.publicKey.y,
				d,
				ext: false,
			},
			{ name: 'ECDH', namedCurve: 'P-256' },
			false,
			['deriveBits'],
		)
		const ephemeral = await importPoint(recovery.ephemeralPublicKey)
		const key = await recoveryWrappingKey(
			privateKey,
			ephemeral,
			recovery.ephemeralPublicKey,
			recovery.publicKey,
			'decrypt',
		)
		const raw = await subtle().decrypt(
			{
				name: 'AES-GCM',
				iv: buffer(fromBase64(recovery.iv)),
				additionalData: buffer(
					masterWrapAdditionalData(keyring, ringId, 'recovery', recovery.publicKey),
				),
			},
			key,
			buffer(fromBase64(recovery.wrappedKey)),
		)
		return new Uint8Array(raw)
	} catch (cause) {
		throw new KeyUnwrapError(`The recovery key does not open keyring "${keyring}".`, {
			code: 'WRONG_RECOVERY_KEY',
			cause: cause instanceof Error ? cause.message : String(cause),
		})
	}
}

/** A new random data key, extractable so it can be wrapped (then discarded). */
export async function generateDataKey(): Promise<CryptoKey> {
	return subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

/**
 * Re-import an extractable data key as a non-extractable one (the copy a device
 * keeps). Exports the raw bytes transiently, inside this call only.
 */
export async function toNonExtractable(dataKey: CryptoKey): Promise<CryptoKey> {
	if (!dataKey.extractable) return dataKey
	const raw = await subtle().exportKey('raw', dataKey)
	try {
		return await subtle().importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, [
			'encrypt',
			'decrypt',
		])
	} finally {
		new Uint8Array(raw).fill(0)
	}
}

async function importPoint(point: { x: string; y: string }): Promise<CryptoKey> {
	return subtle().importKey(
		'jwk',
		{ kty: 'EC', crv: 'P-256', x: point.x, y: point.y, ext: true },
		{ name: 'ECDH', namedCurve: 'P-256' },
		true,
		[],
	)
}

/** Standard base64 of bytes. */
export function toBase64(bytes: Uint8Array): string {
	let binary = ''
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number)
	return btoa(binary)
}

function toBase64Url(bytes: Uint8Array): string {
	return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/')
	return fromBase64(padded + '='.repeat((4 - (padded.length % 4)) % 4))
}

/** Bytes of standard base64. */
export function fromBase64(value: string): Uint8Array {
	const binary = atob(value)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
	return bytes
}
