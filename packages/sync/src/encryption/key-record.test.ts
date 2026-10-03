import { describe, expect, test } from 'vitest'
import { isEncryptionKeyMessage } from './key-messages'
import type { WrappedKeyRecord } from './key-record'
import { isKeyRecordSuccessor, isValidKeyringName, validateKeyRecord } from './key-record'

const B64_12 = 'AAAAAAAAAAAAAAAA'
const B64_32 = `${'A'.repeat(43)}=`
const B64_48 = 'A'.repeat(64)

function record(overrides: Partial<WrappedKeyRecord> = {}): WrappedKeyRecord {
	return {
		format: 1,
		keyring: 'default',
		revision: 1,
		currentVersion: 1,
		kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000, salt: B64_32 },
		keys: [{ keyVersion: 1, keyId: `k2-${'a'.repeat(32)}`, iv: B64_12, wrappedKey: B64_48 }],
		...overrides,
	}
}

describe('validateKeyRecord', () => {
	test('accepts a well-formed record', () => {
		expect(validateKeyRecord(record(), 'default')).toEqual({ ok: true })
	})

	test.each([
		['another keyring', { keyring: 'other' }],
		['a non-PBKDF2 kdf', { kdf: { name: 'scrypt', hash: 'SHA-256', iterations: 1, salt: B64_32 } }],
		['a short salt', { kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 1, salt: B64_12 } }],
		['no keys', { keys: [] }],
		['currentVersion below the highest key', { currentVersion: 2 }],
		['a revision of 0', { revision: 0 }],
	])('refuses %s', (_label, overrides) => {
		expect(validateKeyRecord(record(overrides as Partial<WrappedKeyRecord>), 'default').ok).toBe(
			false,
		)
	})

	test('refuses duplicate versions and malformed key ids', () => {
		const key = record().keys[0]
		if (!key) throw new Error('fixture')
		expect(validateKeyRecord(record({ keys: [key, key] }), 'default').ok).toBe(false)
		expect(validateKeyRecord(record({ keys: [{ ...key, keyId: 'k1-123' }] }), 'default').ok).toBe(
			false,
		)
	})
})

describe('isKeyRecordSuccessor', () => {
	test('a first record has revision 1', () => {
		expect(isKeyRecordSuccessor(null, record()).ok).toBe(true)
		expect(isKeyRecordSuccessor(null, record({ revision: 2 })).ok).toBe(false)
	})

	test('a successor advances the revision by one and keeps every version', () => {
		const first = record()
		const key = first.keys[0]
		if (!key) throw new Error('fixture')
		const rotated = record({
			revision: 2,
			currentVersion: 2,
			keys: [key, { ...key, keyVersion: 2, keyId: `k2-${'b'.repeat(32)}` }],
		})
		expect(isKeyRecordSuccessor(first, rotated).ok).toBe(true)
		// Dropping or relabelling a version would make history unreadable.
		expect(
			isKeyRecordSuccessor(
				rotated,
				record({ revision: 3, keys: [{ ...key, keyId: `k2-${'c'.repeat(32)}` }] }),
			).ok,
		).toBe(false)
		expect(isKeyRecordSuccessor(first, record({ revision: 3 })).ok).toBe(false)
	})
})

test('keyring names and key messages', () => {
	expect(isValidKeyringName('default')).toBe(true)
	expect(isValidKeyringName('')).toBe(false)
	expect(isValidKeyringName('a/b')).toBe(false)
	expect(
		isEncryptionKeyMessage({
			type: 'encryption-key-request',
			messageId: 'm',
			requestId: 'r',
			keyring: 'default',
		}),
	).toBe(true)
	expect(
		isEncryptionKeyMessage({
			type: 'encryption-key-response',
			messageId: 'm',
			keyring: 'default',
			status: 'bogus',
			record: null,
		}),
	).toBe(false)
})
