import { KoraError } from '@korajs/core/lite'
import { exportPublicKeyJwk, generateDeviceKeyPair } from '../device/device-identity'
import { type DeviceKeyStore, createDeviceKeyStore } from '../device/device-store'
import type { AuthKeyValueStorage } from './storage'

const DEFAULT_DEVICE_ID_KEY = 'kora_auth_device_id'

/** Suffix of the storage key holding the device ids other accounts signed in with here. */
const OTHERS_KEY_SUFFIX = ':others'

/** Suffix of the storage key holding the device id no account has signed in with yet. */
const SPARE_KEY_SUFFIX = ':spare'

/**
 * Most device ids one device keeps (its first, the others, not counting the spare): one
 * per account that signed in here. Past it the longest-held other id is let go (that
 * account then signs in with a new id, and its database syncs under a new node).
 */
export const MAX_HELD_DEVICE_IDS = 8

export interface AuthDeviceIdentity {
	/** Stable local device ID used in token `dev` claims. */
	deviceId: string
	/** Public proof-of-possession key serialized as a JSON Web Key string. */
	devicePublicKey: string
}

export interface AuthDeviceIdentityProvider {
	/** The device's first identity. */
	getDeviceIdentity(): Promise<AuthDeviceIdentity>
	/**
	 * Every identity a sign-in may use, in order: the device's first, the ones other
	 * accounts signed in with on this device, then one no account has used (a spare).
	 * A device id is registered to ONE account on the auth server, so on a browser several
	 * people sign in to, the server picks the candidate registered to the signing-in
	 * account, else one registered to nobody. Optional: without it a sign-in offers
	 * {@link getDeviceIdentity} alone.
	 */
	getDeviceCandidates?(): Promise<AuthDeviceIdentity[]>
	/**
	 * The auth server issued a session for `deviceId` (one of the candidates): the device
	 * keeps holding it. Optional.
	 */
	rememberDevice?(deviceId: string): Promise<void>
	/**
	 * The server refused every candidate: each is registered to some account (a sign-up
	 * that registered the unused id and never finished here, or an id copied to another
	 * device). The unused id joins the held ones (an account may own it) and a new unused
	 * id replaces it. Optional.
	 */
	refreshSpare?(): Promise<void>
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
 * non-extractable ECDSA P-256 key pair per device ID in the supplied `DeviceKeyStore`.
 * The public key is returned during sign-up/sign-in so the server can bind tokens
 * to a real offline device instead of a transient browser session.
 *
 * A device ID belongs to one account on the auth server. The device keeps its first ID
 * (`kora_auth_device_id`, unchanged from earlier releases), the IDs other accounts
 * signed in with on it (`kora_auth_device_id:others`, at most
 * {@link MAX_HELD_DEVICE_IDS} in all) and one unused ID (`kora_auth_device_id:spare`).
 * A sign-in offers all of them and the server picks the one registered to the account
 * (else an unregistered one), so each account syncs under its own node on a shared
 * browser, keeps it from one sign-in to the next, and none is refused for another's
 * device. Nothing about the accounts themselves is stored.
 */
export function createPersistentDeviceIdentity(
	options: PersistentDeviceIdentityOptions,
): AuthDeviceIdentityProvider {
	const storage = options.storage
	const keyStore = options.keyStore ?? createDefaultPersistentKeyStore()
	const deviceIdKey = options.deviceIdKey ?? DEFAULT_DEVICE_ID_KEY
	const othersKey = `${deviceIdKey}${OTHERS_KEY_SUFFIX}`
	const spareKey = `${deviceIdKey}${SPARE_KEY_SUFFIX}`
	const generateDeviceId = options.generateDeviceId ?? defaultDeviceId

	const identityOf = async (deviceId: string): Promise<AuthDeviceIdentity> => {
		let keyPair = await keyStore.loadKeyPair(deviceId)
		if (!keyPair) {
			keyPair = await generateDeviceKeyPair()
			await keyStore.saveKeyPair(deviceId, keyPair)
		}
		const publicKey = await exportPublicKeyJwk(keyPair)
		return { deviceId, devicePublicKey: JSON.stringify(publicKey) }
	}

	const storedId = async (key: string): Promise<string> => {
		let deviceId = await storage.getItem(key)
		if (!deviceId) {
			deviceId = generateDeviceId()
			await storage.setItem(key, deviceId)
		}
		return deviceId
	}

	const loadOthers = async (): Promise<string[]> => {
		const raw = await storage.getItem(othersKey)
		if (!raw) return []
		try {
			const parsed: unknown = JSON.parse(raw)
			if (!Array.isArray(parsed)) return []
			return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
		} catch (error) {
			// An unreadable list only costs the accounts that used those ids a new device id
			// (and node) at their next sign-in; nothing is refused.
			console.warn(
				`[kora] unreadable ${othersKey}; other accounts on this device get new device ids: ${error instanceof Error ? error.message : String(error)}`,
			)
			return []
		}
	}

	return {
		async getDeviceIdentity(): Promise<AuthDeviceIdentity> {
			return identityOf(await storedId(deviceIdKey))
		},

		async getDeviceCandidates(): Promise<AuthDeviceIdentity[]> {
			const primary = await storedId(deviceIdKey)
			const others = (await loadOthers()).filter((id) => id !== primary)
			const spare = await storedId(spareKey)
			const ids = [primary, ...others, spare].filter((id, index, all) => all.indexOf(id) === index)
			return Promise.all(ids.map(identityOf))
		},

		async rememberDevice(deviceId: string): Promise<void> {
			const primary = await storage.getItem(deviceIdKey)
			if (deviceId === primary) return
			const others = await loadOthers()
			if (others.includes(deviceId)) return
			// Only the spare becomes held: an id the server chose itself is not this device's.
			if ((await storage.getItem(spareKey)) !== deviceId) return
			others.push(deviceId)
			while (others.length > MAX_HELD_DEVICE_IDS - 1) others.shift()
			await storage.setItem(othersKey, JSON.stringify(others))
			await storage.removeItem(spareKey)
		},

		async refreshSpare(): Promise<void> {
			const spare = await storage.getItem(spareKey)
			if (spare) {
				const others = (await loadOthers()).filter((id) => id !== spare)
				others.push(spare)
				while (others.length > MAX_HELD_DEVICE_IDS - 1) others.shift()
				await storage.setItem(othersKey, JSON.stringify(others))
			}
			await storage.setItem(spareKey, generateDeviceId())
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
