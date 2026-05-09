import { describe, expect, test } from 'vitest'
import {
	CryptoUnavailableError,
	EncryptionError,
	decryptData,
	encryptData,
	exportKey,
	generateEncryptionKey,
	importKey,
} from './database-encryption'

describe('database-encryption', () => {
	describe('generateEncryptionKey', () => {
		test('generates a valid AES-256-GCM CryptoKey', async () => {
			const key = await generateEncryptionKey()

			expect(key).toBeDefined()
			expect(key.type).toBe('secret')
			expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
		})

		test('generated key supports encrypt and decrypt usages', async () => {
			const key = await generateEncryptionKey()

			expect(key.usages).toContain('encrypt')
			expect(key.usages).toContain('decrypt')
		})

		test('generated key is extractable', async () => {
			const key = await generateEncryptionKey()

			expect(key.extractable).toBe(true)
		})

		test('generates unique keys on each call', async () => {
			const keyA = await generateEncryptionKey()
			const keyB = await generateEncryptionKey()

			const rawA = await exportKey(keyA)
			const rawB = await exportKey(keyB)

			// Two randomly generated keys should differ
			expect(rawA).not.toEqual(rawB)
		})
	})

	describe('encryptData / decryptData', () => {
		test('round-trip encrypt and decrypt produces the original data', async () => {
			const key = await generateEncryptionKey()
			const plaintext = new TextEncoder().encode('Hello, Kora!')

			const { ciphertext, iv } = await encryptData(key, plaintext)
			const decrypted = await decryptData(key, ciphertext, iv)

			expect(decrypted).toEqual(plaintext)
		})

		test('ciphertext differs from plaintext', async () => {
			const key = await generateEncryptionKey()
			const plaintext = new TextEncoder().encode('sensitive data')

			const { ciphertext } = await encryptData(key, plaintext)

			// Ciphertext should not equal plaintext (it is encrypted + has auth tag)
			expect(ciphertext).not.toEqual(plaintext)
		})

		test('encrypting same data twice produces different ciphertext (random IV)', async () => {
			const key = await generateEncryptionKey()
			const plaintext = new TextEncoder().encode('same data each time')

			const result1 = await encryptData(key, plaintext)
			const result2 = await encryptData(key, plaintext)

			// IVs should differ because they are randomly generated
			expect(result1.iv).not.toEqual(result2.iv)
			// Ciphertext should differ because the IVs differ
			expect(result1.ciphertext).not.toEqual(result2.ciphertext)
		})

		test('IV is 12 bytes (96 bits, recommended for AES-GCM)', async () => {
			const key = await generateEncryptionKey()
			const plaintext = new TextEncoder().encode('test')

			const { iv } = await encryptData(key, plaintext)

			expect(iv.length).toBe(12)
		})

		test('decryption fails with a wrong key', async () => {
			const keyA = await generateEncryptionKey()
			const keyB = await generateEncryptionKey()
			const plaintext = new TextEncoder().encode('secret message')

			const { ciphertext, iv } = await encryptData(keyA, plaintext)

			// Decrypting with a different key should throw
			await expect(decryptData(keyB, ciphertext, iv)).rejects.toThrow(EncryptionError)
		})

		test('decryption fails with tampered ciphertext', async () => {
			const key = await generateEncryptionKey()
			const plaintext = new TextEncoder().encode('important data')

			const { ciphertext, iv } = await encryptData(key, plaintext)

			// Tamper with the ciphertext by flipping a byte
			const tampered = new Uint8Array(ciphertext)
			tampered[0] = (tampered[0] as number) ^ 0xff

			// AES-GCM authentication should detect the tampering
			await expect(decryptData(key, tampered, iv)).rejects.toThrow(EncryptionError)
		})

		test('decryption fails with wrong IV', async () => {
			const key = await generateEncryptionKey()
			const plaintext = new TextEncoder().encode('test data')

			const { ciphertext } = await encryptData(key, plaintext)

			// Use a different IV for decryption
			const wrongIv = globalThis.crypto.getRandomValues(new Uint8Array(12))

			await expect(decryptData(key, ciphertext, wrongIv)).rejects.toThrow(EncryptionError)
		})

		test('handles empty data (zero-length plaintext)', async () => {
			const key = await generateEncryptionKey()
			const plaintext = new Uint8Array(0)

			const { ciphertext, iv } = await encryptData(key, plaintext)

			// AES-GCM produces ciphertext even for empty input (auth tag)
			expect(ciphertext.length).toBeGreaterThan(0)

			const decrypted = await decryptData(key, ciphertext, iv)
			expect(decrypted).toEqual(plaintext)
		})

		test('handles large data (256 KB)', async () => {
			const key = await generateEncryptionKey()
			// 256 KB of random data, filled in chunks to stay within
			// crypto.getRandomValues' 65,536-byte per-call limit.
			const plaintext = new Uint8Array(256 * 1024)
			const chunkSize = 65536
			for (let offset = 0; offset < plaintext.length; offset += chunkSize) {
				const end = Math.min(offset + chunkSize, plaintext.length)
				globalThis.crypto.getRandomValues(plaintext.subarray(offset, end))
			}

			const { ciphertext, iv } = await encryptData(key, plaintext)
			const decrypted = await decryptData(key, ciphertext, iv)

			expect(decrypted).toEqual(plaintext)
		})

		test('handles binary data with all byte values', async () => {
			const key = await generateEncryptionKey()
			// Create a buffer with all 256 possible byte values
			const plaintext = new Uint8Array(256)
			for (let i = 0; i < 256; i++) {
				plaintext[i] = i
			}

			const { ciphertext, iv } = await encryptData(key, plaintext)
			const decrypted = await decryptData(key, ciphertext, iv)

			expect(decrypted).toEqual(plaintext)
		})
	})

	describe('exportKey / importKey', () => {
		test('export produces 32-byte raw key', async () => {
			const key = await generateEncryptionKey()
			const raw = await exportKey(key)

			expect(raw).toBeInstanceOf(Uint8Array)
			expect(raw.length).toBe(32)
		})

		test('round-trip export and import produces a working key', async () => {
			const originalKey = await generateEncryptionKey()
			const plaintext = new TextEncoder().encode('round-trip key test')

			// Encrypt with the original key
			const { ciphertext, iv } = await encryptData(originalKey, plaintext)

			// Export and reimport
			const rawBytes = await exportKey(originalKey)
			const importedKey = await importKey(rawBytes)

			// Decrypt with the reimported key
			const decrypted = await decryptData(importedKey, ciphertext, iv)
			expect(decrypted).toEqual(plaintext)
		})

		test('exported key bytes match between export calls', async () => {
			const key = await generateEncryptionKey()

			const rawA = await exportKey(key)
			const rawB = await exportKey(key)

			expect(rawA).toEqual(rawB)
		})

		test('importKey rejects keys that are not 32 bytes', async () => {
			const tooShort = new Uint8Array(16)
			const tooLong = new Uint8Array(64)

			await expect(importKey(tooShort)).rejects.toThrow(EncryptionError)
			await expect(importKey(tooShort)).rejects.toThrow(/expected 32 bytes/)
			await expect(importKey(tooLong)).rejects.toThrow(EncryptionError)
			await expect(importKey(tooLong)).rejects.toThrow(/expected 32 bytes/)
		})

		test('importKey accepts valid 32-byte key and produces usable CryptoKey', async () => {
			// Create a known 32-byte key
			const rawKey = globalThis.crypto.getRandomValues(new Uint8Array(32))
			const key = await importKey(rawKey)

			expect(key.type).toBe('secret')
			expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
			expect(key.usages).toContain('encrypt')
			expect(key.usages).toContain('decrypt')
		})

		test('imported key can encrypt data that the original can decrypt', async () => {
			const originalKey = await generateEncryptionKey()
			const rawBytes = await exportKey(originalKey)
			const importedKey = await importKey(rawBytes)

			// Encrypt with imported, decrypt with original
			const plaintext = new TextEncoder().encode('cross-key test')
			const { ciphertext, iv } = await encryptData(importedKey, plaintext)
			const decrypted = await decryptData(originalKey, ciphertext, iv)

			expect(decrypted).toEqual(plaintext)
		})
	})
})
