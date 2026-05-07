import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthTokens } from '../types'
import { TokenStore } from './token-store'

const SAMPLE_TOKENS: AuthTokens = {
	accessToken: 'access.token.here',
	refreshToken: 'refresh.token.here',
}

const SAMPLE_TOKENS_WITH_CREDENTIAL: AuthTokens = {
	accessToken: 'access.token.here',
	refreshToken: 'refresh.token.here',
	deviceCredential: 'device.credential.here',
}

/**
 * Creates a mock localStorage-like object for testing.
 * Backed by a plain Map so tests are isolated from the actual DOM.
 */
function createMockStorage(): Storage {
	const store = new Map<string, string>()
	return {
		get length() {
			return store.size
		},
		clear() {
			store.clear()
		},
		getItem(key: string) {
			return store.get(key) ?? null
		},
		key(_index: number) {
			return null
		},
		removeItem(key: string) {
			store.delete(key)
		},
		setItem(key: string, value: string) {
			store.set(key, value)
		},
	}
}

describe('TokenStore', () => {
	describe('with localStorage available', () => {
		let mockStorage: Storage

		beforeEach(() => {
			mockStorage = createMockStorage()
			// Install a mock localStorage on globalThis
			vi.stubGlobal('localStorage', mockStorage)
		})

		afterEach(() => {
			vi.unstubAllGlobals()
		})

		it('saves and loads tokens', () => {
			const store = new TokenStore()
			store.saveTokens(SAMPLE_TOKENS)

			const loaded = store.loadTokens()
			expect(loaded).toEqual(SAMPLE_TOKENS)
		})

		it('saves and loads tokens including device credential', () => {
			const store = new TokenStore()
			store.saveTokens(SAMPLE_TOKENS_WITH_CREDENTIAL)

			const loaded = store.loadTokens()
			expect(loaded).toEqual(SAMPLE_TOKENS_WITH_CREDENTIAL)
		})

		it('clears tokens', () => {
			const store = new TokenStore()
			store.saveTokens(SAMPLE_TOKENS)

			store.clearTokens()

			expect(store.loadTokens()).toBeNull()
		})

		it('returns null when no tokens are saved', () => {
			const store = new TokenStore()
			expect(store.loadTokens()).toBeNull()
		})

		it('getAccessToken returns the access token', () => {
			const store = new TokenStore()
			store.saveTokens(SAMPLE_TOKENS)

			expect(store.getAccessToken()).toBe('access.token.here')
		})

		it('getRefreshToken returns the refresh token', () => {
			const store = new TokenStore()
			store.saveTokens(SAMPLE_TOKENS)

			expect(store.getRefreshToken()).toBe('refresh.token.here')
		})

		it('getAccessToken returns null when no tokens are saved', () => {
			const store = new TokenStore()
			expect(store.getAccessToken()).toBeNull()
		})

		it('getRefreshToken returns null when no tokens are saved', () => {
			const store = new TokenStore()
			expect(store.getRefreshToken()).toBeNull()
		})

		it('overwrites previously saved tokens', () => {
			const store = new TokenStore()
			store.saveTokens(SAMPLE_TOKENS)

			const newTokens: AuthTokens = {
				accessToken: 'new.access.token',
				refreshToken: 'new.refresh.token',
			}
			store.saveTokens(newTokens)

			expect(store.loadTokens()).toEqual(newTokens)
		})

		it('uses a custom storage key when provided', () => {
			const store = new TokenStore('my_custom_key')
			store.saveTokens(SAMPLE_TOKENS)

			// Verify it was stored under the custom key
			const raw = mockStorage.getItem('my_custom_key')
			expect(raw).not.toBeNull()

			// Default key should be empty
			const defaultRaw = mockStorage.getItem('kora_auth_tokens')
			expect(defaultRaw).toBeNull()
		})

		it('handles corrupted data in storage gracefully', () => {
			mockStorage.setItem('kora_auth_tokens', 'not-valid-json{{{')

			const store = new TokenStore()
			expect(store.loadTokens()).toBeNull()
		})

		it('returns null for stored data missing required fields', () => {
			mockStorage.setItem(
				'kora_auth_tokens',
				JSON.stringify({ accessToken: 'only-access' }),
			)

			const store = new TokenStore()
			expect(store.loadTokens()).toBeNull()
		})
	})

	describe('with localStorage unavailable (memory fallback)', () => {
		beforeEach(() => {
			// Remove localStorage from globalThis to simulate Node.js / SSR
			vi.stubGlobal('localStorage', undefined)
		})

		afterEach(() => {
			vi.unstubAllGlobals()
		})

		it('saves and loads tokens in memory', () => {
			const store = new TokenStore()
			store.saveTokens(SAMPLE_TOKENS)

			const loaded = store.loadTokens()
			expect(loaded).toEqual(SAMPLE_TOKENS)
		})

		it('clears tokens from memory', () => {
			const store = new TokenStore()
			store.saveTokens(SAMPLE_TOKENS)

			store.clearTokens()

			expect(store.loadTokens()).toBeNull()
		})

		it('returns null when no tokens are saved', () => {
			const store = new TokenStore()
			expect(store.loadTokens()).toBeNull()
		})

		it('getAccessToken works with memory storage', () => {
			const store = new TokenStore()
			store.saveTokens(SAMPLE_TOKENS)

			expect(store.getAccessToken()).toBe('access.token.here')
		})

		it('getRefreshToken works with memory storage', () => {
			const store = new TokenStore()
			store.saveTokens(SAMPLE_TOKENS)

			expect(store.getRefreshToken()).toBe('refresh.token.here')
		})
	})

	describe('with localStorage that throws on access', () => {
		beforeEach(() => {
			// Simulate a localStorage that exists but throws (e.g., private browsing)
			const throwing = {
				getItem() {
					throw new DOMException('Access denied')
				},
				setItem() {
					throw new DOMException('Access denied')
				},
				removeItem() {
					throw new DOMException('Access denied')
				},
			}
			vi.stubGlobal('localStorage', throwing)
		})

		afterEach(() => {
			vi.unstubAllGlobals()
		})

		it('falls back to memory storage when localStorage throws', () => {
			const store = new TokenStore()
			store.saveTokens(SAMPLE_TOKENS)

			// Should still work via in-memory fallback
			expect(store.loadTokens()).toEqual(SAMPLE_TOKENS)
		})
	})
})
