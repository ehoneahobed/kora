import type { DeviceKeyStore } from '../device/device-store'
import { AuthClient, type AuthClientConfig, type AuthTokenStorage } from './auth-client'
import type { AuthDeviceIdentityProvider } from './device-session'
import { createPersistentDeviceIdentity } from './device-session'
import {
	type AuthKeyValueStorage,
	createAuthTokenStorage,
	createWebStorageAuthTokenStorage,
} from './storage'

export interface CreateKoraAuthOptions
	extends Omit<AuthClientConfig, 'storage' | 'deviceIdentity'> {
	/**
	 * Complete token storage adapter. Use this for fully custom runtimes.
	 * If omitted, `credentialStore` is adapted automatically.
	 */
	storage?: AuthTokenStorage
	/**
	 * Runtime credential store used for tokens and stable device ID.
	 * Examples: Tauri secure storage, Expo SecureStore, iOS Keychain, Android Keystore.
	 */
	credentialStore?: AuthKeyValueStorage
	/**
	 * Explicit device identity provider. Set to `false` to disable automatic
	 * device binding during sign-up/sign-in.
	 */
	deviceIdentity?: AuthDeviceIdentityProvider | false
	/**
	 * Device key store for runtimes without IndexedDB, such as React Native.
	 */
	deviceKeyStore?: DeviceKeyStore
}

/**
 * Create a production-shaped Kora auth client with minimal setup.
 *
 * Defaults:
 * - browser/Tauri WebView: localStorage for tokens, IndexedDB for device keys
 * - desktop/mobile: pass `credentialStore` and optionally `deviceKeyStore`
 * - automatic device identity is enabled when a persistent device ID store exists
 */
export function createKoraAuth(options: CreateKoraAuthOptions): AuthClient {
	const storage =
		options.storage ??
		(options.credentialStore
			? createAuthTokenStorage({
					store: options.credentialStore,
					prefix: options.storageKey,
				})
			: tryCreateDefaultTokenStorage(options.storageKey))

	const deviceIdentity =
		options.deviceIdentity === false
			? undefined
			: (options.deviceIdentity ??
				tryCreateDefaultDeviceIdentity(options.credentialStore, options.deviceKeyStore))

	return new AuthClient({
		serverUrl: options.serverUrl,
		storageKey: options.storageKey,
		storage,
		fetch: options.fetch,
		deviceIdentity,
	})
}

function tryCreateDefaultTokenStorage(
	storageKey: string | undefined,
): AuthTokenStorage | undefined {
	const storage = tryGetBrowserStorage()
	return storage ? createWebStorageAuthTokenStorage(storage, storageKey) : undefined
}

function tryCreateDefaultDeviceIdentity(
	credentialStore: AuthKeyValueStorage | undefined,
	deviceKeyStore: DeviceKeyStore | undefined,
): AuthDeviceIdentityProvider | undefined {
	const storage = credentialStore ?? tryGetBrowserStorage()
	if (!storage) {
		return undefined
	}

	try {
		return createPersistentDeviceIdentity({
			storage,
			keyStore: deviceKeyStore,
		})
	} catch {
		return undefined
	}
}

function tryGetBrowserStorage(): Storage | null {
	try {
		if (typeof globalThis.localStorage === 'undefined') {
			return null
		}
		const key = '__kora_auth_quickstart_test__'
		globalThis.localStorage.setItem(key, '1')
		globalThis.localStorage.removeItem(key)
		return globalThis.localStorage
	} catch {
		return null
	}
}
