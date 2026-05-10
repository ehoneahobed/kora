import { describe, expect, it } from 'vitest'
import {
	type AuthKeyValueStorage,
	createAuthTokenStorage,
	createMemoryAuthTokenStorage,
	createWebStorageAuthTokenStorage,
} from './storage'

function createMapStorage(): AuthKeyValueStorage & { values: Map<string, string> } {
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

describe('auth token storage adapters', () => {
	it('adapts async key-value stores', async () => {
		const values = new Map<string, string>()
		const storage = createAuthTokenStorage({
			prefix: 'mobile',
			store: {
				async getItem(key) {
					return values.get(key) ?? null
				},
				async setItem(key, value) {
					values.set(key, value)
				},
				async removeItem(key) {
					values.delete(key)
				},
			},
		})

		await storage.setTokens('access', 'refresh')

		expect(await storage.getAccessToken()).toBe('access')
		expect(await storage.getRefreshToken()).toBe('refresh')
		expect(values.get('mobile_access_token')).toBe('access')

		await storage.clear()

		expect(await storage.getAccessToken()).toBeNull()
		expect(await storage.getRefreshToken()).toBeNull()
	})

	it('creates memory storage', async () => {
		const storage = createMemoryAuthTokenStorage()

		await storage.setTokens('a', 'r')

		expect(await storage.getAccessToken()).toBe('a')
		expect(await storage.getRefreshToken()).toBe('r')

		await storage.clear()

		expect(await storage.getAccessToken()).toBeNull()
	})

	it('adapts Web Storage', async () => {
		const backing = createMapStorage()
		const webStorage = {
			getItem: backing.getItem,
			setItem: backing.setItem,
			removeItem: backing.removeItem,
		} as Storage

		const storage = createWebStorageAuthTokenStorage(webStorage, 'web')
		await storage.setTokens('access', 'refresh')

		expect(backing.values.get('web_access_token')).toBe('access')
		expect(await storage.getRefreshToken()).toBe('refresh')
	})
})
