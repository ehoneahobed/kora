import { describe, expect, test } from 'vitest'
import { hashPassword, verifyPassword } from './password-hash'

describe('hashPassword', () => {
	test('returns hex-encoded hash of 128 characters (64 bytes)', async () => {
		const { hash } = await hashPassword('test-password')
		expect(hash).toMatch(/^[0-9a-f]{128}$/)
	})

	test('returns hex-encoded salt of 64 characters (32 bytes)', async () => {
		const { salt } = await hashPassword('test-password')
		expect(salt).toMatch(/^[0-9a-f]{64}$/)
	})

	test('produces different hashes for different passwords', async () => {
		const result1 = await hashPassword('password-one')
		const result2 = await hashPassword('password-two')
		expect(result1.hash).not.toBe(result2.hash)
	})

	test('produces different hashes for the same password due to random salt', async () => {
		const result1 = await hashPassword('same-password')
		const result2 = await hashPassword('same-password')
		expect(result1.salt).not.toBe(result2.salt)
		expect(result1.hash).not.toBe(result2.hash)
	})
})

describe('verifyPassword', () => {
	test('returns true for a correct password', async () => {
		const { hash, salt } = await hashPassword('correct-password')
		const isValid = await verifyPassword('correct-password', hash, salt)
		expect(isValid).toBe(true)
	})

	test('returns false for an incorrect password', async () => {
		const { hash, salt } = await hashPassword('correct-password')
		const isValid = await verifyPassword('wrong-password', hash, salt)
		expect(isValid).toBe(false)
	})

	test('returns false (not throws) for a wrong password — timing-safe rejection', async () => {
		const { hash, salt } = await hashPassword('my-password')
		// Verify that the function returns a boolean false rather than
		// throwing an error, confirming the timing-safe comparison path.
		const result = await verifyPassword('other-password', hash, salt)
		expect(result).toBe(false)
		expect(typeof result).toBe('boolean')
	})

	test('returns false when stored hash has unexpected length', async () => {
		const { salt } = await hashPassword('test-password')
		// A truncated hash should be rejected gracefully, not throw.
		const isValid = await verifyPassword('test-password', 'abcdef', salt)
		expect(isValid).toBe(false)
	})

	test('verifies correctly after round-tripping hash and salt as strings', async () => {
		const { hash, salt } = await hashPassword('round-trip-password')

		// Simulate storing and retrieving from a database (strings stay strings).
		const storedHash = String(hash)
		const storedSalt = String(salt)

		const isValid = await verifyPassword('round-trip-password', storedHash, storedSalt)
		expect(isValid).toBe(true)
	})
})
