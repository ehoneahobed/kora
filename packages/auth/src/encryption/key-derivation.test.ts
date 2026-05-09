import { describe, expect, test } from 'vitest'
import { decryptData, encryptData, exportKey } from './database-encryption'
import { KeyDerivationError, deriveEncryptionKey, generateSalt } from './key-derivation'

describe('key-derivation', () => {
	describe('generateSalt', () => {
		test('generates a 32-byte salt', () => {
			const salt = generateSalt()

			expect(salt).toBeInstanceOf(Uint8Array)
			expect(salt.length).toBe(32)
		})

		test('generates unique salts on each call', () => {
			const saltA = generateSalt()
			const saltB = generateSalt()

			// Two random salts should differ
			expect(saltA).not.toEqual(saltB)
		})

		test('generates non-zero salt', () => {
			const salt = generateSalt()

			// A 32-byte random buffer should not be all zeros
			// (probability is astronomically low: 2^-256)
			const allZeros = salt.every((byte) => byte === 0)
			expect(allZeros).toBe(false)
		})
	})

	describe('deriveEncryptionKey', () => {
		test('derives a valid AES-256-GCM CryptoKey', async () => {
			const { key } = await deriveEncryptionKey('test-passphrase')

			expect(key).toBeDefined()
			expect(key.type).toBe('secret')
			expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
			expect(key.usages).toContain('encrypt')
			expect(key.usages).toContain('decrypt')
		})

		test('returns the salt used for derivation', async () => {
			const { salt } = await deriveEncryptionKey('test-passphrase')

			expect(salt).toBeInstanceOf(Uint8Array)
			expect(salt.length).toBe(32)
		})

		test('same passphrase and salt produce the same key', async () => {
			const salt = generateSalt()

			const { key: keyA } = await deriveEncryptionKey('my-passphrase', salt)
			const { key: keyB } = await deriveEncryptionKey('my-passphrase', salt)

			const rawA = await exportKey(keyA)
			const rawB = await exportKey(keyB)

			expect(rawA).toEqual(rawB)
		})

		test('different passphrase produces a different key', async () => {
			const salt = generateSalt()

			const { key: keyA } = await deriveEncryptionKey('passphrase-one', salt)
			const { key: keyB } = await deriveEncryptionKey('passphrase-two', salt)

			const rawA = await exportKey(keyA)
			const rawB = await exportKey(keyB)

			expect(rawA).not.toEqual(rawB)
		})

		test('different salt produces a different key', async () => {
			const saltA = generateSalt()
			const saltB = generateSalt()

			const { key: keyA } = await deriveEncryptionKey('same-passphrase', saltA)
			const { key: keyB } = await deriveEncryptionKey('same-passphrase', saltB)

			const rawA = await exportKey(keyA)
			const rawB = await exportKey(keyB)

			expect(rawA).not.toEqual(rawB)
		})

		test('generates a random salt when none is provided', async () => {
			const resultA = await deriveEncryptionKey('passphrase')
			const resultB = await deriveEncryptionKey('passphrase')

			// Salts should differ because they are randomly generated
			expect(resultA.salt).not.toEqual(resultB.salt)
		})

		test('uses the provided salt when given', async () => {
			const providedSalt = globalThis.crypto.getRandomValues(new Uint8Array(32))
			const { salt: returnedSalt } = await deriveEncryptionKey('passphrase', providedSalt)

			expect(returnedSalt).toEqual(providedSalt)
		})

		test('derived key can encrypt and decrypt data', async () => {
			const { key, salt } = await deriveEncryptionKey('user-passphrase')
			const plaintext = new TextEncoder().encode('sensitive local data')

			// Encrypt with the derived key
			const { ciphertext, iv } = await encryptData(key, plaintext)

			// Re-derive the same key from the same passphrase and salt
			const { key: sameKey } = await deriveEncryptionKey('user-passphrase', salt)

			// Decrypt with the re-derived key
			const decrypted = await decryptData(sameKey, ciphertext, iv)
			expect(decrypted).toEqual(plaintext)
		})

		test('throws KeyDerivationError for empty passphrase', async () => {
			await expect(deriveEncryptionKey('')).rejects.toThrow(KeyDerivationError)
			await expect(deriveEncryptionKey('')).rejects.toThrow(/must not be empty/)
		})

		test('handles unicode passphrases', async () => {
			const salt = generateSalt()

			const { key } = await deriveEncryptionKey(
				'\u00e9\u00e0\u00fc-\u4f60\u597d-\ud83d\udd11',
				salt,
			)

			expect(key).toBeDefined()
			expect(key.type).toBe('secret')

			// Verify determinism with unicode
			const { key: sameKey } = await deriveEncryptionKey(
				'\u00e9\u00e0\u00fc-\u4f60\u597d-\ud83d\udd11',
				salt,
			)
			const rawA = await exportKey(key)
			const rawB = await exportKey(sameKey)
			expect(rawA).toEqual(rawB)
		})

		test('handles very long passphrases', async () => {
			const longPassphrase = 'a'.repeat(10_000)
			const { key } = await deriveEncryptionKey(longPassphrase)

			expect(key).toBeDefined()
			expect(key.type).toBe('secret')
		})
	})
})
