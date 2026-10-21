import { KoraError } from '@korajs/core'
import { exportPublicKeyJwk, generateDeviceKeyPair } from '../device/device-identity'
import { type DeviceKeyStore, createDeviceKeyStore } from '../device/device-store'
import type { AuthKeyValueStorage } from './storage'

const DEFAULT_DEVICE_ID_KEY = 'kora_auth_device_id'

/** Suffix of the storage key holding which account signs in with which device id. */
const ACCOUNTS_KEY_SUFFIX = ':accounts'

export interface AuthDeviceIdentity {
	/** Stable local device ID used in token `dev` claims. */
	deviceId: string
	/** Public proof-of-possession key serialized as a JSON Web Key string. */
	devicePublicKey: string
}

/**
 * The account a device identity is wanted for. A device id is registered to ONE account
 * on the auth server (a token's `dev` names a device owned by its `sub`), so on a browser
 * several people sign in to, each account needs a device id of its own.
 */
export interface AuthDeviceAccount {
	/** The account's user id, when known (after a sign-in). */
	userId?: string
	/** The address the account signs in with, when known (password sign-in and sign-up). */
	email?: string
}

export interface AuthDeviceIdentityProvider {
	/**
	 * The device identity to sign `account` in with: the one this account used on this
	 * device before, else the device's first identity unless another account already
	 * uses it, else a fresh one. Without `account`, the device's first identity.
	 */
	getDeviceIdentity(account?: AuthDeviceAccount): Promise<AuthDeviceIdentity>
	/**
	 * The auth server refused `conflictingDeviceId` for `account`: another account owns it
	 * (`DEVICE_OWNERSHIP_CONFLICT`, a browser shared between accounts). Returns a fresh
	 * identity for this account; the next sign-in of `account` is offered it again.
	 * Optional: without it, the conflict is reported to the caller.
	 */
	replaceDeviceIdentity?(
		account: AuthDeviceAccount,
		conflictingDeviceId: string,
	): Promise<AuthDeviceIdentity>
	/**
	 * `account` signed in with `deviceId`: the account keeps that identity on this device.
	 * Optional.
	 */
	rememberDeviceAccount?(deviceId: string, account: AuthDeviceAccount): Promise<void>
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
 * A device ID belongs to one account on the auth server. The first account to sign in
 * on this device keeps the device's first ID (`kora_auth_device_id`, unchanged from
 * earlier releases), and every other account that signs in here gets an ID of its own,
 * remembered per account (`kora_auth_device_id:accounts`: user ids, and SHA-256 hashes of
 * sign-in addresses, never the addresses themselves). Each account therefore syncs under
 * its own node on a shared browser, and none is refused for another's device.
 */
export function createPersistentDeviceIdentity(
	options: PersistentDeviceIdentityOptions,
): AuthDeviceIdentityProvider {
	const storage = options.storage
	const keyStore = options.keyStore ?? createDefaultPersistentKeyStore()
	const deviceIdKey = options.deviceIdKey ?? DEFAULT_DEVICE_ID_KEY
	const accountsKey = `${deviceIdKey}${ACCOUNTS_KEY_SUFFIX}`
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

	const primaryDeviceId = async (): Promise<string> => {
		let deviceId = await storage.getItem(deviceIdKey)
		if (!deviceId) {
			deviceId = generateDeviceId()
			await storage.setItem(deviceIdKey, deviceId)
		}
		return deviceId
	}

	const loadAccounts = async (): Promise<Record<string, string>> => {
		const raw = await storage.getItem(accountsKey)
		if (!raw) return {}
		try {
			const parsed: unknown = JSON.parse(raw)
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
			const out: Record<string, string> = {}
			for (const [key, value] of Object.entries(parsed)) {
				if (typeof value === 'string' && value.length > 0) out[key] = value
			}
			return out
		} catch {
			// An unreadable map only costs a conflict round trip: the server still refuses a
			// device id another account owns, and the account gets a fresh one then.
			return {}
		}
	}

	const saveAccounts = async (accounts: Record<string, string>): Promise<void> => {
		await storage.setItem(accountsKey, JSON.stringify(accounts))
	}

	return {
		async getDeviceIdentity(account?: AuthDeviceAccount): Promise<AuthDeviceIdentity> {
			const primary = await primaryDeviceId()
			if (!account) return identityOf(primary)
			const keys = await accountKeys(account)
			const accounts = await loadAccounts()
			const known = lookupAccount(accounts, keys)
			if (known) return identityOf(known)
			// The device's first id, unless another account signs in with it here.
			const taken = Object.entries(accounts).some(
				([key, value]) => value === primary && !key.startsWith(PENDING_PREFIX),
			)
			if (!taken || keys.length === 0) return identityOf(primary)
			const fresh = generateDeviceId()
			for (const key of keys) accounts[`${PENDING_PREFIX}${key}`] = fresh
			await saveAccounts(accounts)
			return identityOf(fresh)
		},

		async replaceDeviceIdentity(
			account: AuthDeviceAccount,
			conflictingDeviceId: string,
		): Promise<AuthDeviceIdentity> {
			const keys = await accountKeys(account)
			const accounts = await loadAccounts()
			// A remembered id the server says is another account's is forgotten for this one.
			for (const [key, value] of Object.entries(accounts)) {
				if (value !== conflictingDeviceId) continue
				const bare = key.startsWith(PENDING_PREFIX) ? key.slice(PENDING_PREFIX.length) : key
				if (keys.includes(bare) || (keys.length === 0 && bare === UNKNOWN_ACCOUNT_KEY)) {
					delete accounts[key]
				}
			}
			const fresh = generateDeviceId()
			for (const key of keys.length > 0 ? keys : [UNKNOWN_ACCOUNT_KEY]) {
				accounts[`${PENDING_PREFIX}${key}`] = fresh
			}
			await saveAccounts(accounts)
			return identityOf(fresh)
		},

		async rememberDeviceAccount(deviceId: string, account: AuthDeviceAccount): Promise<void> {
			const keys = await accountKeys(account)
			if (keys.length === 0) return
			const accounts = await loadAccounts()
			for (const key of keys) {
				accounts[key] = deviceId
				delete accounts[`${PENDING_PREFIX}${key}`]
			}
			delete accounts[`${PENDING_PREFIX}${UNKNOWN_ACCOUNT_KEY}`]
			await saveAccounts(accounts)
		},
	}
}

/** Prefix of a fresh id offered to an account that has not signed in with it yet. */
const PENDING_PREFIX = 'p:'

/** The account of a sign-in that names none (OAuth), after a conflict. */
const UNKNOWN_ACCOUNT_KEY = '?'

/** The account's keys in the map, most precise first: its user id, then its address. */
async function accountKeys(account: AuthDeviceAccount): Promise<string[]> {
	const keys: string[] = []
	if (typeof account.userId === 'string' && account.userId.length > 0) {
		keys.push(`u:${account.userId}`)
	}
	if (typeof account.email === 'string' && account.email.trim().length > 0) {
		const hashed = await sha256Hex(account.email.trim().toLowerCase())
		if (hashed) keys.push(`e:${hashed}`)
	}
	return keys
}

function lookupAccount(accounts: Record<string, string>, keys: string[]): string | null {
	for (const key of keys) {
		const value = accounts[key]
		if (value) return value
	}
	for (const key of keys) {
		const value = accounts[`${PENDING_PREFIX}${key}`]
		if (value) return value
	}
	if (keys.length === 0) return accounts[`${PENDING_PREFIX}${UNKNOWN_ACCOUNT_KEY}`] ?? null
	return null
}

async function sha256Hex(value: string): Promise<string | null> {
	const subtle = globalThis.crypto?.subtle
	if (!subtle) return null
	const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value))
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
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
