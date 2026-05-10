import { KoraError } from '@korajs/core'
import { exportPublicKeyJwk, generateDeviceKeyPair } from '../device/device-identity'
import { type DeviceKeyStore, createDeviceKeyStore } from '../device/device-store'
import type { AuthKeyValueStorage } from './storage'

const DEFAULT_DEVICE_ID_KEY = 'kora_auth_device_id'

export interface AuthDeviceIdentity {
	/** Stable local device ID used in token `dev` claims. */
	deviceId: string
	/** Public proof-of-possession key serialized as a JSON Web Key string. */
	devicePublicKey: string
}

export interface AuthDeviceIdentityProvider {
	getDeviceIdentity(): Promise<AuthDeviceIdentity>
}

export interface PersistentDeviceIdentityOptions {
	/** Store for the stable device ID. Use a platform credential store in production. */
	storage: AuthKeyValueStorage
	/** Store for the non-extractable device key pair. Defaults to IndexedDB when available. */
	keyStore?: DeviceKeyStore
	/** Storage key for the device ID. Defaults to `kora_auth_device_id`. */
	deviceIdKey?: string
	/** Optional device ID generator for tests or custom device registries. */
	generateDeviceId?: () => string
}

export class AuthDeviceIdentityError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'AUTH_DEVICE_IDENTITY_ERROR', context)
		this.name = 'AuthDeviceIdentityError'
	}
}

/**
 * Creates a persistent device identity provider for `AuthClient`.
 *
 * The provider keeps a stable device ID in the supplied key-value store and a
 * non-extractable ECDSA P-256 key pair in the supplied `DeviceKeyStore`. The
 * public key is returned during sign-up/sign-in so the server can bind tokens
 * to a real offline device instead of a transient browser session.
 */
export function createPersistentDeviceIdentity(
	options: PersistentDeviceIdentityOptions,
): AuthDeviceIdentityProvider {
	const storage = options.storage
	const keyStore = options.keyStore ?? createDefaultPersistentKeyStore()
	const deviceIdKey = options.deviceIdKey ?? DEFAULT_DEVICE_ID_KEY
	const generateDeviceId = options.generateDeviceId ?? defaultDeviceId

	return {
		async getDeviceIdentity(): Promise<AuthDeviceIdentity> {
			let deviceId = await storage.getItem(deviceIdKey)
			if (!deviceId) {
				deviceId = generateDeviceId()
				await storage.setItem(deviceIdKey, deviceId)
			}

			let keyPair = await keyStore.loadKeyPair(deviceId)
			if (!keyPair) {
				keyPair = await generateDeviceKeyPair()
				await keyStore.saveKeyPair(deviceId, keyPair)
			}

			const publicKey = await exportPublicKeyJwk(keyPair)
			return {
				deviceId,
				devicePublicKey: JSON.stringify(publicKey),
			}
		},
	}
}

function createDefaultPersistentKeyStore(): DeviceKeyStore {
	if (typeof globalThis.indexedDB !== 'undefined') {
		return createDeviceKeyStore()
	}

	throw new AuthDeviceIdentityError(
		'No persistent device key store is available in this runtime. Pass `keyStore` to createPersistentDeviceIdentity().',
	)
}

function defaultDeviceId(): string {
	if (typeof globalThis.crypto?.randomUUID === 'function') {
		return globalThis.crypto.randomUUID()
	}

	const bytes = new Uint8Array(16)
	if (typeof globalThis.crypto?.getRandomValues === 'function') {
		globalThis.crypto.getRandomValues(bytes)
	} else {
		for (let i = 0; i < bytes.length; i++) {
			bytes[i] = Math.floor(Math.random() * 256)
		}
	}

	bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40
	bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
