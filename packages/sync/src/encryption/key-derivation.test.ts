import { describe, expect, test } from 'vitest'
import { KeyDerivationError, deriveKey, deriveVersionedKey, generateSalt } from './key-derivation'

describe('generateSalt', () => {
	test('returns a 32-byte Uint8Array', () => {
		const salt = generateSalt()
		expect(salt).toBeInstanceOf(Uint8Array)
		expect(salt.length).toBe(32)
	})

	test('generates unique salts on each call', () => {
		const salt1 = generateSalt()
		const salt2 = generateSalt()
		// Extremely unlikely to be equal, but we check the structure
		expect(salt1).not.toEqual(salt2)
	})
})

describe('deriveKey', () => {
	test('derives a CryptoKey from a passphrase', async () => {
		const { key, salt } = await deriveKey('test-passphrase')
		expect(key).toBeDefined()
		expect(key.type).toBe('secret')
		expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
		expect(key.usages).toContain('encrypt')
		expect(key.usages).toContain('decrypt')
		expect(salt).toBeInstanceOf(Uint8Array)
		expect(salt.length).toBe(32)
	})

	test('same passphrase and salt produce the same key', async () => {
		const salt = generateSalt()
		const { key: key1 } = await deriveKey('deterministic-test', salt)
		const { key: key2 } = await deriveKey('deterministic-test', salt)

		// Export both keys to compare raw bytes
		const raw1 = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', key1))
		const raw2 = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', key2))
		expect(raw1).toEqual(raw2)
	})

	test('different passphrases produce different keys', async () => {
		const salt = generateSalt()
		const { key: key1 } = await deriveKey('passphrase-one', salt)
		const { key: key2 } = await deriveKey('passphrase-two', salt)

		const raw1 = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', key1))
		const raw2 = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', key2))
		expect(raw1).not.toEqual(raw2)
	})

	test('different salts produce different keys', async () => {
		const salt1 = generateSalt()
		const salt2 = generateSalt()
		const { key: key1 } = await deriveKey('same-passphrase', salt1)
		const { key: key2 } = await deriveKey('same-passphrase', salt2)

		const raw1 = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', key1))
		const raw2 = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', key2))
		expect(raw1).not.toEqual(raw2)
	})

	test('throws KeyDerivationError for empty passphrase', async () => {
		await expect(deriveKey('')).rejects.toThrow(KeyDerivationError)
		await expect(deriveKey('')).rejects.toThrow('must not be empty')
	})

	test('generates a random salt when none is provided', async () => {
		const result1 = await deriveKey('some-passphrase')
		const result2 = await deriveKey('some-passphrase')
		// Salts should differ since none was provided
		expect(result1.salt).not.toEqual(result2.salt)
	})
})

describe('deriveVersionedKey', () => {
	test('creates a versioned key with the specified version', async () => {
		const vk = await deriveVersionedKey('my-passphrase', 1)
		expect(vk.version).toBe(1)
		expect(vk.key).toBeDefined()
		expect(vk.key.type).toBe('secret')
		expect(vk.salt).toBeInstanceOf(Uint8Array)
	})

	test('respects the provided salt', async () => {
		const salt = generateSalt()
		const vk1 = await deriveVersionedKey('test', 1, salt)
		const vk2 = await deriveVersionedKey('test', 1, salt)

		const raw1 = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', vk1.key))
		const raw2 = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', vk2.key))
		expect(raw1).toEqual(raw2)
	})

	test('throws for version 0', async () => {
		await expect(deriveVersionedKey('test', 0)).rejects.toThrow(KeyDerivationError)
		await expect(deriveVersionedKey('test', 0)).rejects.toThrow('positive integer')
	})

	test('throws for negative version', async () => {
		await expect(deriveVersionedKey('test', -1)).rejects.toThrow(KeyDerivationError)
	})

	test('throws for non-integer version', async () => {
		await expect(deriveVersionedKey('test', 1.5)).rejects.toThrow(KeyDerivationError)
	})

	test('supports high version numbers for key rotation', async () => {
		const vk = await deriveVersionedKey('rotated-key', 42)
		expect(vk.version).toBe(42)
		expect(vk.key.type).toBe('secret')
	})
})
