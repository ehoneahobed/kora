import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateEncryptionKey } from '../encryption/database-encryption'
import { deriveEncryptionKey, generateSalt } from '../encryption/key-derivation'
import type { AuthTokens } from '../types'
import { EncryptedTokenStore } from './encrypted-token-store'

const SAMPLE_TOKENS: AuthTokens = {
	accessToken: 'eyJhbGciOiJIUzI1NiJ9.access.signature',
	refreshToken: 'eyJhbGciOiJIUzI1NiJ9.refresh.signature',
}

const SAMPLE_TOKENS_WITH_CREDENTIAL: AuthTokens = {
	accessToken: 'eyJhbGciOiJIUzI1NiJ9.access.signature',
	refreshToken: 'eyJhbGciOiJIUzI1NiJ9.refresh.signature',
	deviceCredential: 'eyJhbGciOiJIUzI1NiJ9.device.signature',
}

/**
 * Creates a mock localStorage-like object for testing.
 * Backed by a plain Map so tests are isolated from the actual DOM.
 */
function createMockStorage(): Storage & { _store: Map<string, string> } {
	const store = new Map<string, string>()
	return {
		_store: store,
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

describe('EncryptedTokenStore', () => {
	let mockStorage: ReturnType<typeof createMockStorage>

	beforeEach(() => {
		mockStorage = createMockStorage()
		vi.stubGlobal('localStorage', mockStorage)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	describe('round-trip encrypt/decrypt', () => {
		it('saves and loads tokens with a generated key', async () => {
			const key = await generateEncryptionKey()
			const store = new EncryptedTokenStore({ key })

			await store.saveTokens(SAMPLE_TOKENS)
			const loaded = await store.loadTokens()

			expect(loaded).toEqual(SAMPLE_TOKENS)
		})

		it('saves and loads tokens including device credential', async () => {
			const key = await generateEncryptionKey()
			const store = new EncryptedTokenStore({ key })

			await store.saveTokens(SAMPLE_TOKENS_WITH_CREDENTIAL)
			const loaded = await store.loadTokens()

			expect(loaded).toEqual(SAMPLE_TOKENS_WITH_CREDENTIAL)
		})

		it('getAccessToken returns the decrypted access token', async () => {
			const key = await generateEncryptionKey()
			const store = new EncryptedTokenStore({ key })

			await store.saveTokens(SAMPLE_TOKENS)
			const accessToken = await store.getAccessToken()

			expect(accessToken).toBe(SAMPLE_TOKENS.accessToken)
		})

		it('getRefreshToken returns the decrypted refresh token', async () => {
			const key = await generateEncryptionKey()
			const store = new EncryptedTokenStore({ key })

			await store.saveTokens(SAMPLE_TOKENS)
			const refreshToken = await store.getRefreshToken()

			expect(refreshToken).toBe(SAMPLE_TOKENS.refreshToken)
		})

		it('getAccessToken returns null when no tokens are stored', async () => {
			const key = await generateEncryptionKey()
			const store = new EncryptedTokenStore({ key })

			expect(await store.getAccessToken()).toBeNull()
		})

		it('getRefreshToken returns null when no tokens are stored', async () => {
			const key = await generateEncryptionKey()
			const store = new EncryptedTokenStore({ key })

			expect(await store.getRefreshToken()).toBeNull()
		})

		it('overwrites previously saved tokens', async () => {
			const key = await generateEncryptionKey()
			const store = new EncryptedTokenStore({ key })

			await store.saveTokens(SAMPLE_TOKENS)

			const newTokens: AuthTokens = {
				accessToken: 'new.access.token',
				refreshToken: 'new.refresh.token',
			}
			await store.saveTokens(newTokens)

			const loaded = await store.loadTokens()
			expect(loaded).toEqual(newTokens)
		})

		it('returns null when no tokens have been saved', async () => {
			const key = await generateEncryptionKey()
			const store = new EncryptedTokenStore({ key })

			expect(await store.loadTokens()).toBeNull()
		})
	})

	describe('stored format', () => {
		it('stores data as JSON with iv and data fields', async () => {
			const key = await generateEncryptionKey()
			const store = new EncryptedTokenStore({ key })

			await store.saveTokens(SAMPLE_TOKENS)

			const raw = mockStorage.getItem('kora_auth_encrypted')
			expect(raw).not.toBeNull()

			const parsed = JSON.parse(raw as string) as Record<string, unknown>
			expect(typeof parsed['iv']).toBe('string')
			expect(typeof parsed['data']).toBe('string')

			// Verify these are base64url-encoded (no +, /, or = padding)
			const ivStr = parsed['iv'] as string
			const dataStr = parsed['data'] as string
			expect(ivStr).not.toMatch(/[+/=]/)
			expect(dataStr).not.toMatch(/[+/=]/)
		})

		it('stored ciphertext does not contain plaintext token values', async () => {
			const key = await generateEncryptionKey()
			const store = new EncryptedTokenStore({ key })

			await store.saveTokens(SAMPLE_TOKENS)

			const raw = mockStorage.getItem('kora_auth_encrypted') as string
			// The raw storage value should not contain the plaintext tokens
			expect(raw).not.toContain(SAMPLE_TOKENS.accessToken)
			expect(raw).not.toContain(SAMPLE_TOKENS.refreshToken)
		})

		it('uses custom storage key when provided', async () => {
			const key = await generateEncryptionKey()
			const store = new EncryptedTokenStore({
				key,
				storageKey: 'my_custom_encrypted_key',
			})

			await store.saveTokens(SAMPLE_TOKENS)

			expect(mockStorage.getItem('my_custom_encrypted_key')).not.toBeNull()
			expect(mockStorage.getItem('kora_auth_encrypted')).toBeNull()
		})
	})

	describe('different keys produce different ciphertext', () => {
		it('encrypting same tokens with different keys produces different stored values', async () => {
			const keyA = await generateEncryptionKey()
			const keyB = await generateEncryptionKey()

			const storeA = new EncryptedTokenStore({ key: keyA, storageKey: 'store_a' })
			const storeB = new EncryptedTokenStore({ key: keyB, storageKey: 'store_b' })

			await storeA.saveTokens(SAMPLE_TOKENS)
			await storeB.saveTokens(SAMPLE_TOKENS)

			const rawA = mockStorage.getItem('store_a') as string
			const rawB = mockStorage.getItem('store_b') as string

			// Different keys must produce different ciphertext
			const parsedA = JSON.parse(rawA) as Record<string, string>
			const parsedB = JSON.parse(rawB) as Record<string, string>
			expect(parsedA['data']).not.toBe(parsedB['data'])
		})

		it('encrypting same tokens twice with same key produces different ciphertext (random IV)', async () => {
			const key = await generateEncryptionKey()

			const storeA = new EncryptedTokenStore({ key, storageKey: 'store_first' })
			const storeB = new EncryptedTokenStore({ key, storageKey: 'store_second' })

			await storeA.saveTokens(SAMPLE_TOKENS)
			await storeB.saveTokens(SAMPLE_TOKENS)

			const rawA = mockStorage.getItem('store_first') as string
			const rawB = mockStorage.getItem('store_second') as string

			const parsedA = JSON.parse(rawA) as Record<string, string>
			const parsedB = JSON.parse(rawB) as Record<string, string>

			// IVs should differ because they are randomly generated
			expect(parsedA['iv']).not.toBe(parsedB['iv'])
			// Ciphertext should differ because the IVs differ
			expect(parsedA['data']).not.toBe(parsedB['data'])
		})
	})

	describe('wrong key fails to decrypt', () => {
		it('returns null when decrypting with a different key', async () => {
			const keyA = await generateEncryptionKey()
			const keyB = await generateEncryptionKey()

			const storeA = new EncryptedTokenStore({ key: keyA })
			await storeA.saveTokens(SAMPLE_TOKENS)

			// Try to load with a different key
			const storeB = new EncryptedTokenStore({ key: keyB })
			const loaded = await storeB.loadTokens()

			// Should return null, not throw
			expect(loaded).toBeNull()
		})

		it('getAccessToken returns null with wrong key', async () => {
			const keyA = await generateEncryptionKey()
			const keyB = await generateEncryptionKey()

			const storeA = new EncryptedTokenStore({ key: keyA })
			await storeA.saveTokens(SAMPLE_TOKENS)

			const storeB = new EncryptedTokenStore({ key: keyB })
			expect(await storeB.getAccessToken()).toBeNull()
		})

		it('getRefreshToken returns null with wrong key', async () => {
			const keyA = await generateEncryptionKey()
			const keyB = await generateEncryptionKey()

			const storeA = new EncryptedTokenStore({ key: keyA })
			await storeA.saveTokens(SAMPLE_TOKENS)

			const storeB = new EncryptedTokenStore({ key: keyB })
			expect(await storeB.getRefreshToken()).toBeNull()
		})
	})

	describe('tampered ciphertext returns null', () => {
		it('returns null when ciphertext data is tampered', async () => {
			const key = await generateEncryptionKey()
			const store = new EncryptedTokenStore({ key })

			await store.saveTokens(SAMPLE_TOKENS)

			// Tamper with the stored ciphertext
			const raw = mockStorage.getItem('kora_auth_encrypted') as string
			const parsed = JSON.parse(raw) as Record<string, string>

			// Flip characters in the ciphertext data to simulate tampering
			const tamperedData = parsed['data'] as string
			const flipped = tamperedData.charAt(0) === 'A'
				? 'B' + tamperedData.slice(1)
				: 'A' + tamperedData.slice(1)
			parsed['data'] = flipped

			mockStorage.setItem('kora_auth_encrypted', JSON.stringify(parsed))

			const loaded = await store.loadTokens()
			expect(loaded).toBeNull()
		})

		it('returns null when IV is tampered', async () => {
			const key = await generateEncryptionKey()
			const store = new EncryptedTokenStore({ key })

			await store.saveTokens(SAMPLE_TOKENS)

			// Tamper with the IV
			const raw = mockStorage.getItem('kora_auth_encrypted') as string
			const parsed = JSON.parse(raw) as Record<string, string>

			const tamperedIv = parsed['iv'] as string
			const flipped = tamperedIv.charAt(0) === 'A'
				? 'B' + tamperedIv.slice(1)
				: 'A' + tamperedIv.slice(1)
			parsed['iv'] = flipped

			mockStorage.setItem('kora_auth_encrypted', JSON.stringify(parsed))

			const loaded = await store.loadTokens()
			expect(loaded).toBeNull()
		})

		it('returns null when stored JSON is corrupted', async () => {
			const key = await generateEncryptionKey()
			const store = new EncryptedTokenStore({ key })

			mockStorage.setItem('kora_auth_encrypted', 'not-valid-json{{{')

			const loaded = await store.loadTokens()
			expect(loaded).toBeNull()
		})

		it('returns null when stored JSON is missing required fields', async () => {
			const key = await generateEncryptionKey()
			const store = new EncryptedTokenStore({ key })

			// Missing "data" field
			mockStorage.setItem('kora_auth_encrypted', JSON.stringify({ iv: 'abc' }))

			const loaded = await store.loadTokens()
			expect(loaded).toBeNull()
		})

		it('returns null when stored JSON is an array', async () => {
			const key = await generateEncryptionKey()
			const store = new EncryptedTokenStore({ key })

			mockStorage.setItem('kora_auth_encrypted', JSON.stringify([1, 2, 3]))

			const loaded = await store.loadTokens()
			expect(loaded).toBeNull()
		})
	})

	describe('clearTokens', () => {
		it('removes encrypted data from storage', async () => {
			const key = await generateEncryptionKey()
			const store = new EncryptedTokenStore({ key })

			await store.saveTokens(SAMPLE_TOKENS)
			expect(mockStorage.getItem('kora_auth_encrypted')).not.toBeNull()

			store.clearTokens()

			expect(mockStorage.getItem('kora_auth_encrypted')).toBeNull()
		})

		it('loadTokens returns null after clearTokens', async () => {
			const key = await generateEncryptionKey()
			const store = new EncryptedTokenStore({ key })

			await store.saveTokens(SAMPLE_TOKENS)
			store.clearTokens()

			expect(await store.loadTokens()).toBeNull()
		})

		it('clearTokens is safe to call when no tokens are stored', async () => {
			const key = await generateEncryptionKey()
			const store = new EncryptedTokenStore({ key })

			// Should not throw
			store.clearTokens()
			expect(await store.loadTokens()).toBeNull()
		})
	})

	describe('works with passphrase-derived keys', () => {
		it('round-trips tokens with a passphrase-derived key', async () => {
			const salt = generateSalt()
			const { key } = await deriveEncryptionKey('my-secure-passphrase', salt)
			const store = new EncryptedTokenStore({ key })

			await store.saveTokens(SAMPLE_TOKENS)
			const loaded = await store.loadTokens()

			expect(loaded).toEqual(SAMPLE_TOKENS)
		})

		it('same passphrase and salt can decrypt previously saved tokens', async () => {
			const salt = generateSalt()
			const { key: saveKey } = await deriveEncryptionKey('user-passphrase', salt)

			const saveStore = new EncryptedTokenStore({ key: saveKey })
			await saveStore.saveTokens(SAMPLE_TOKENS_WITH_CREDENTIAL)

			// Re-derive the same key (simulating app restart)
			const { key: loadKey } = await deriveEncryptionKey('user-passphrase', salt)
			const loadStore = new EncryptedTokenStore({ key: loadKey })
			const loaded = await loadStore.loadTokens()

			expect(loaded).toEqual(SAMPLE_TOKENS_WITH_CREDENTIAL)
		})

		it('wrong passphrase returns null', async () => {
			const salt = generateSalt()
			const { key: correctKey } = await deriveEncryptionKey('correct-passphrase', salt)

			const store = new EncryptedTokenStore({ key: correctKey })
			await store.saveTokens(SAMPLE_TOKENS)

			// Try with wrong passphrase
			const { key: wrongKey } = await deriveEncryptionKey('wrong-passphrase', salt)
			const wrongStore = new EncryptedTokenStore({ key: wrongKey })

			expect(await wrongStore.loadTokens()).toBeNull()
		})

		it('different salt with same passphrase returns null', async () => {
			const saltA = generateSalt()
			const saltB = generateSalt()
			const { key: keyA } = await deriveEncryptionKey('same-passphrase', saltA)

			const store = new EncryptedTokenStore({ key: keyA })
			await store.saveTokens(SAMPLE_TOKENS)

			// Try with different salt
			const { key: keyB } = await deriveEncryptionKey('same-passphrase', saltB)
			const wrongStore = new EncryptedTokenStore({ key: keyB })

			expect(await wrongStore.loadTokens()).toBeNull()
		})
	})

	describe('with localStorage unavailable (memory fallback)', () => {
		beforeEach(() => {
			vi.stubGlobal('localStorage', undefined)
		})

		it('saves and loads tokens in memory', async () => {
			const key = await generateEncryptionKey()
			const store = new EncryptedTokenStore({ key })

			await store.saveTokens(SAMPLE_TOKENS)
			const loaded = await store.loadTokens()

			expect(loaded).toEqual(SAMPLE_TOKENS)
		})

		it('clears tokens from memory', async () => {
			const key = await generateEncryptionKey()
			const store = new EncryptedTokenStore({ key })

			await store.saveTokens(SAMPLE_TOKENS)
			store.clearTokens()

			expect(await store.loadTokens()).toBeNull()
		})
	})

	describe('only persists expected token fields', () => {
		it('does not persist extra fields beyond accessToken, refreshToken, deviceCredential', async () => {
			const key = await generateEncryptionKey()
			const store = new EncryptedTokenStore({ key })

			// Pass tokens with an extra field
			const tokensWithExtra = {
				...SAMPLE_TOKENS,
				unexpectedField: 'should-not-persist',
			} as AuthTokens

			await store.saveTokens(tokensWithExtra)
			const loaded = await store.loadTokens()

			expect(loaded).toEqual(SAMPLE_TOKENS)
			expect(loaded).not.toHaveProperty('unexpectedField')
		})
	})
})
