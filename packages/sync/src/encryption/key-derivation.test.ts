import { describe, expect, test } from 'vitest'
import {
	DEFAULT_PBKDF2_ITERATIONS,
	KeyDerivationError,
	deriveKey,
	deriveVersionedKey,
	generateSalt,
} from './key-derivation'

// Behaviour tests use a low iteration count: 600,000 PBKDF2 rounds take seconds on a
// loaded CI machine and made these tests time out (a timing dependency, CLAUDE.md
// anti-pattern 9). The production default is pinned by its own test below.
const TEST_ITERATIONS = 1_000

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
		const { key, salt } = await deriveKey('test-passphrase', undefined, TEST_ITERATIONS)
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
		const { key: key1 } = await deriveKey('deterministic-test', salt, TEST_ITERATIONS)
		const { key: key2 } = await deriveKey('deterministic-test', salt, TEST_ITERATIONS)

		// Export both keys to compare raw bytes
		const raw1 = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', key1))
		const raw2 = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', key2))
		expect(raw1).toEqual(raw2)
	})

	test('different passphrases produce different keys', async () => {
		const salt = generateSalt()
		const { key: key1 } = await deriveKey('passphrase-one', salt, TEST_ITERATIONS)
		const { key: key2 } = await deriveKey('passphrase-two', salt, TEST_ITERATIONS)

		const raw1 = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', key1))
		const raw2 = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', key2))
		expect(raw1).not.toEqual(raw2)
	})

	test('different salts produce different keys', async () => {
		const salt1 = generateSalt()
		const salt2 = generateSalt()
		const { key: key1 } = await deriveKey('same-passphrase', salt1, TEST_ITERATIONS)
		const { key: key2 } = await deriveKey('same-passphrase', salt2, TEST_ITERATIONS)

		const raw1 = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', key1))
		const raw2 = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', key2))
		expect(raw1).not.toEqual(raw2)
	})

	test('throws KeyDerivationError for empty passphrase', async () => {
		await expect(deriveKey('', undefined, TEST_ITERATIONS)).rejects.toThrow(KeyDerivationError)
		await expect(deriveKey('', undefined, TEST_ITERATIONS)).rejects.toThrow('must not be empty')
	})

	test('generates a random salt when none is provided', async () => {
		const result1 = await deriveKey('some-passphrase', undefined, TEST_ITERATIONS)
		const result2 = await deriveKey('some-passphrase', undefined, TEST_ITERATIONS)
		// Salts should differ since none was provided
		expect(result1.salt).not.toEqual(result2.salt)
	})
})

describe('deriveVersionedKey', () => {
	test('creates a versioned key with the specified version', async () => {
		const vk = await deriveVersionedKey('my-passphrase', 1, undefined, TEST_ITERATIONS)
		expect(vk.version).toBe(1)
		expect(vk.key).toBeDefined()
		expect(vk.key.type).toBe('secret')
		expect(vk.salt).toBeInstanceOf(Uint8Array)
	})

	test('respects the provided salt', async () => {
		const salt = generateSalt()
		const vk1 = await deriveVersionedKey('test', 1, salt, TEST_ITERATIONS)
		const vk2 = await deriveVersionedKey('test', 1, salt, TEST_ITERATIONS)

		const raw1 = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', vk1.key))
		const raw2 = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', vk2.key))
		expect(raw1).toEqual(raw2)
	})

	test('throws for version 0', async () => {
		await expect(deriveVersionedKey('test', 0, undefined, TEST_ITERATIONS)).rejects.toThrow(
			KeyDerivationError,
		)
		await expect(deriveVersionedKey('test', 0, undefined, TEST_ITERATIONS)).rejects.toThrow(
			'positive integer',
		)
	})

	test('throws for negative version', async () => {
		await expect(deriveVersionedKey('test', -1, undefined, TEST_ITERATIONS)).rejects.toThrow(
			KeyDerivationError,
		)
	})

	test('throws for non-integer version', async () => {
		await expect(deriveVersionedKey('test', 1.5, undefined, TEST_ITERATIONS)).rejects.toThrow(
			KeyDerivationError,
		)
	})

	test('supports high version numbers for key rotation', async () => {
		const vk = await deriveVersionedKey('rotated-key', 42, undefined, TEST_ITERATIONS)
		expect(vk.version).toBe(42)
		expect(vk.key.type).toBe('secret')
	})
})

describe('production iteration count', () => {
	test('defaults to the OWASP minimum of 600,000 iterations', () => {
		expect(DEFAULT_PBKDF2_ITERATIONS).toBe(600_000)
	})

	test('a key derived with the default count differs from one with a lower count', async () => {
		const salt = generateSalt()
		const { key: strong } = await deriveKey('pinned', salt)
		const { key: weak } = await deriveKey('pinned', salt, TEST_ITERATIONS)
		const rawStrong = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', strong))
		const rawWeak = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', weak))
		expect(rawStrong).not.toEqual(rawWeak)
	}, 60_000)
})
