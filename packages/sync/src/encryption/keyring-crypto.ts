import { SyncError } from '@korajs/core'
import type { RecoveryWrappedDataKey, WrappedDataKey } from './key-record'
import { wrapAdditionalData } from './key-record'

/**
 * WebCrypto primitives of the key hierarchy (ENC-1, D4b):
 *
 *   passphrase --PBKDF2-SHA256(salt, iterations)--> KEK (AES-256-GCM, non-extractable)
 *   KEK --AES-GCM wrap (AAD = keyring, version, keyId)--> data key v1, v2, ...
 *   recovery public key --ECDH P-256 + AES-GCM wrap--> data key v1, v2, ... (optional)
 *
 * Data keys are random 256-bit AES-GCM keys. They are extractable only for the moment
 * they are wrapped (creation, rotation, passphrase change, recovery set-up); the copy
 * a device keeps and encrypts with is always imported non-extractable.
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

const GCM_IV_BYTES = 12
const RECOVERY_KEY_PREFIX = 'kora-rk1-'

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

/** Cryptographically random bytes. */
export function randomBytes(length: number): Uint8Array {
	return globalThis.crypto.getRandomValues(new Uint8Array(length))
}

/** A fresh random key id (`k2-` and 32 hex digits). Names a key; reveals nothing about it. */
export function newKeyId(): string {
	return `k2-${Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Derive the key-encryption key from a passphrase. Non-extractable; usable only to
 * wrap and unwrap data keys.
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
		new TextEncoder().encode(passphrase) as unknown as ArrayBuffer,
		'PBKDF2',
		false,
		['deriveKey'],
	)
	return subtle().deriveKey(
		{ name: 'PBKDF2', salt: salt as unknown as ArrayBuffer, iterations, hash: 'SHA-256' },
		base,
		{ name: 'AES-GCM', length: 256 },
		false,
		['wrapKey', 'unwrapKey'],
	)
}

/** A new random data key, extractable so it can be wrapped (then discarded). */
export async function generateDataKey(): Promise<CryptoKey> {
	return subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

/**
 * Wrap a data key with the passphrase KEK.
 *
 * @param dataKey - An extractable data key
 * @param kek - The passphrase KEK
 * @param keyring - Keyring name (bound as AAD)
 * @param keyVersion - Key version (bound as AAD)
 * @param keyId - Key id (bound as AAD)
 */
export async function wrapDataKey(
	dataKey: CryptoKey,
	kek: CryptoKey,
	keyring: string,
	keyVersion: number,
	keyId: string,
): Promise<WrappedDataKey> {
	const iv = randomBytes(GCM_IV_BYTES)
	const wrapped = await subtle().wrapKey('raw', dataKey, kek, {
		name: 'AES-GCM',
		iv: iv as unknown as ArrayBuffer,
		additionalData: wrapAdditionalData(
			keyring,
			keyVersion,
			keyId,
			'passphrase',
		) as unknown as ArrayBuffer,
	})
	return { keyVersion, keyId, iv: toBase64(iv), wrappedKey: toBase64(new Uint8Array(wrapped)) }
}

/**
 * Unwrap a data key with the passphrase KEK. A wrong passphrase (or a tampered wrap,
 * or a wrap relabelled to another version) fails authentication.
 *
 * @param entry - The wrapped key
 * @param kek - The passphrase KEK
 * @param keyring - Keyring name
 * @param extractable - True only to re-wrap it right away; the kept copy is non-extractable
 * @throws {KeyUnwrapError} When the wrap does not authenticate under this KEK
 */
export async function unwrapDataKey(
	entry: WrappedDataKey,
	kek: CryptoKey,
	keyring: string,
	extractable = false,
): Promise<CryptoKey> {
	try {
		return await subtle().unwrapKey(
			'raw',
			fromBase64(entry.wrappedKey) as unknown as ArrayBuffer,
			kek,
			{
				name: 'AES-GCM',
				iv: fromBase64(entry.iv) as unknown as ArrayBuffer,
				additionalData: wrapAdditionalData(
					keyring,
					entry.keyVersion,
					entry.keyId,
					'passphrase',
				) as unknown as ArrayBuffer,
			},
			{ name: 'AES-GCM', length: 256 },
			extractable,
			['encrypt', 'decrypt'],
		)
	} catch (cause) {
		throw new KeyUnwrapError(
			`The passphrase does not open key version ${entry.keyVersion} of keyring "${keyring}". Check the passphrase.`,
			{
				code: 'WRONG_PASSPHRASE',
				keyVersion: entry.keyVersion,
				cause: cause instanceof Error ? cause.message : String(cause),
			},
		)
	}
}

/** A new recovery key pair: the public half goes in the record, the private half to the user. */
export async function generateRecoveryKeyPair(): Promise<{
	publicKey: { x: string; y: string }
	recoveryKey: string
}> {
	const pair = (await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
		'deriveKey',
	])) as CryptoKeyPair
	const jwk = await subtle().exportKey('jwk', pair.privateKey)
	if (typeof jwk.d !== 'string' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
		throw new SyncError('Failed to export the recovery key.', { code: 'RECOVERY_KEY_EXPORT' })
	}
	return { publicKey: { x: jwk.x, y: jwk.y }, recoveryKey: `${RECOVERY_KEY_PREFIX}${jwk.d}` }
}

/**
 * Wrap a data key for the recovery public key (ephemeral-static ECDH P-256, then
 * AES-GCM with the same AAD binding as the passphrase wrap). Needs only the public
 * key, so any unlocked device can keep recovery current across rotations.
 */
export async function wrapForRecovery(
	dataKey: CryptoKey,
	recoveryPublicKey: { x: string; y: string },
	keyring: string,
	keyVersion: number,
	keyId: string,
): Promise<RecoveryWrappedDataKey> {
	const recipient = await importPoint(recoveryPublicKey)
	const ephemeral = (await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
		'deriveKey',
	])) as CryptoKeyPair
	const wrappingKey = await subtle().deriveKey(
		{ name: 'ECDH', public: recipient },
		ephemeral.privateKey,
		{ name: 'AES-GCM', length: 256 },
		false,
		['wrapKey'],
	)
	const iv = randomBytes(GCM_IV_BYTES)
	const wrapped = await subtle().wrapKey('raw', dataKey, wrappingKey, {
		name: 'AES-GCM',
		iv: iv as unknown as ArrayBuffer,
		additionalData: wrapAdditionalData(
			keyring,
			keyVersion,
			keyId,
			'recovery',
		) as unknown as ArrayBuffer,
	})
	const ephemeralJwk = await subtle().exportKey('jwk', ephemeral.publicKey)
	return {
		keyVersion,
		keyId,
		ephemeralPublicKey: { x: String(ephemeralJwk.x), y: String(ephemeralJwk.y) },
		iv: toBase64(iv),
		wrappedKey: toBase64(new Uint8Array(wrapped)),
	}
}

/**
 * Unwrap a data key with the recovery key (extractable, for re-wrapping under a new
 * passphrase).
 *
 * @throws {KeyUnwrapError} When the recovery key is malformed or does not open the wrap
 */
export async function unwrapWithRecovery(
	entry: RecoveryWrappedDataKey,
	recoveryKey: string,
	recoveryPublicKey: { x: string; y: string },
	keyring: string,
): Promise<CryptoKey> {
	const trimmed = recoveryKey.trim()
	if (!trimmed.startsWith(RECOVERY_KEY_PREFIX)) {
		throw new KeyUnwrapError(`A recovery key starts with "${RECOVERY_KEY_PREFIX}".`, {
			code: 'WRONG_RECOVERY_KEY',
		})
	}
	try {
		const privateKey = await subtle().importKey(
			'jwk',
			{
				kty: 'EC',
				crv: 'P-256',
				x: recoveryPublicKey.x,
				y: recoveryPublicKey.y,
				d: trimmed.slice(RECOVERY_KEY_PREFIX.length),
				ext: false,
			},
			{ name: 'ECDH', namedCurve: 'P-256' },
			false,
			['deriveKey'],
		)
		const ephemeral = await importPoint(entry.ephemeralPublicKey)
		const unwrappingKey = await subtle().deriveKey(
			{ name: 'ECDH', public: ephemeral },
			privateKey,
			{ name: 'AES-GCM', length: 256 },
			false,
			['unwrapKey'],
		)
		return await subtle().unwrapKey(
			'raw',
			fromBase64(entry.wrappedKey) as unknown as ArrayBuffer,
			unwrappingKey,
			{
				name: 'AES-GCM',
				iv: fromBase64(entry.iv) as unknown as ArrayBuffer,
				additionalData: wrapAdditionalData(
					keyring,
					entry.keyVersion,
					entry.keyId,
					'recovery',
				) as unknown as ArrayBuffer,
			},
			{ name: 'AES-GCM', length: 256 },
			true,
			['encrypt', 'decrypt'],
		)
	} catch (cause) {
		throw new KeyUnwrapError(
			`The recovery key does not open key version ${entry.keyVersion} of keyring "${keyring}".`,
			{
				code: 'WRONG_RECOVERY_KEY',
				keyVersion: entry.keyVersion,
				cause: cause instanceof Error ? cause.message : String(cause),
			},
		)
	}
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

/** Bytes of standard base64. */
export function fromBase64(value: string): Uint8Array {
	const binary = atob(value)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
	return bytes
}
