import { describe, expect, it } from 'vitest'
import { InMemoryDeviceKeyStore } from '../device/device-store'
import { AuthDeviceIdentityError, createPersistentDeviceIdentity } from './device-session'
import type { AuthKeyValueStorage } from './storage'

function createStorage(): AuthKeyValueStorage & { values: Map<string, string> } {
	const values = new Map<string, string>()
	return {
		values,
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => {
			values.set(key, value)
		},
		removeItem: (key) => {
			values.delete(key)
		},
	}
}

describe('createPersistentDeviceIdentity', () => {
	it('creates and reuses a stable device identity', async () => {
		const storage = createStorage()
		const keyStore = new InMemoryDeviceKeyStore()
		const identityProvider = createPersistentDeviceIdentity({
			storage,
			keyStore,
			generateDeviceId: () => 'device-1',
		})

		const first = await identityProvider.getDeviceIdentity()
		const second = await identityProvider.getDeviceIdentity()

		expect(first.deviceId).toBe('device-1')
		expect(second.deviceId).toBe('device-1')
		expect(first.devicePublicKey).toBe(second.devicePublicKey)
		expect(JSON.parse(first.devicePublicKey)).toMatchObject({
			kty: 'EC',
			crv: 'P-256',
		})
		expect(await keyStore.hasKeyPair('device-1')).toBe(true)
	})

	it('requires an explicit key store when the runtime has no persistent default', async () => {
		const storage = createStorage()

		expect(() =>
			createPersistentDeviceIdentity({
				storage,
				generateDeviceId: () => 'device-1',
			}),
		).toThrow(AuthDeviceIdentityError)
	})
})
