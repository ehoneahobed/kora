import { describe, expect, test } from 'vitest'
import { decryptSecret, encryptSecret, hashSecret, verifySecret } from './secret-crypto'

describe('encryptSecret / decryptSecret', () => {
	test('round-trips plaintext with the correct key', async () => {
		const encrypted = await encryptSecret('sk_live_abc123', 'key-material')
		expect(encrypted).not.toContain('sk_live_abc123')
		expect(await decryptSecret(encrypted, 'key-material')).toBe('sk_live_abc123')
	})

	test('produces different ciphertext each time (random salt + IV)', async () => {
		const a = await encryptSecret('same', 'key')
		const b = await encryptSecret('same', 'key')
		expect(a).not.toBe(b)
		expect(await decryptSecret(a, 'key')).toBe('same')
		expect(await decryptSecret(b, 'key')).toBe('same')
	})

	test('decryption fails with the wrong key', async () => {
		const encrypted = await encryptSecret('token', 'right-key')
		await expect(decryptSecret(encrypted, 'wrong-key')).rejects.toBeTruthy()
	})

	test('rejects a malformed encrypted value', async () => {
		await expect(decryptSecret('not-a-valid-format', 'key')).rejects.toThrow(/format/)
	})

	test('handles unicode plaintext', async () => {
		const secret = 'pÄsswörd🔐'
		const encrypted = await encryptSecret(secret, 'key')
		expect(await decryptSecret(encrypted, 'key')).toBe(secret)
	})
})

describe('hashSecret / verifySecret', () => {
	test('verifies a correct password', async () => {
		const stored = await hashSecret('hunter2')
		expect(await verifySecret('hunter2', stored)).toBe(true)
	})

	test('rejects an incorrect password', async () => {
		const stored = await hashSecret('hunter2')
		expect(await verifySecret('hunter3', stored)).toBe(false)
	})

	test('is one-way: the stored hash does not contain the plaintext', async () => {
		const stored = await hashSecret('plaintext-password')
		expect(stored).not.toContain('plaintext-password')
	})

	test('salts: the same password hashes to different values', async () => {
		const a = await hashSecret('same')
		const b = await hashSecret('same')
		expect(a).not.toBe(b)
		expect(await verifySecret('same', a)).toBe(true)
		expect(await verifySecret('same', b)).toBe(true)
	})

	test('returns false for a malformed stored value rather than throwing', async () => {
		expect(await verifySecret('x', 'garbage')).toBe(false)
		expect(await verifySecret('x', 'v1.nothex.nothex')).toBe(false)
	})
})
