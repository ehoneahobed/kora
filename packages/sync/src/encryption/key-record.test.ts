import { describe, expect, test } from 'vitest'
import { isEncryptionKeyMessage } from './key-messages'
import type { WrappedKeyRecord } from './key-record'
import {
	canonicalJson,
	isKeyRecordSuccessor,
	isValidKeyringName,
	keyRecordMacInput,
	validateKeyRecord,
} from './key-record'

const B64_12 = 'AAAAAAAAAAAAAAAA'
const B64_32 = `${'A'.repeat(43)}=`
const B64_48 = 'A'.repeat(64)

const RING = `r-${'0'.repeat(32)}`

function record(overrides: Partial<WrappedKeyRecord> = {}): WrappedKeyRecord {
	return {
		format: 2,
		keyring: 'default',
		ringId: RING,
		revision: 1,
		currentVersion: 1,
		kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000, salt: B64_32 },
		master: { iv: B64_12, wrappedKey: B64_48 },
		keys: [{ keyVersion: 1, keyId: `k2-${'a'.repeat(32)}`, iv: B64_12, wrappedKey: B64_48 }],
		mac: B64_32,
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
		['format 1', { format: 1 }],
		['a malformed ring id', { ringId: 'r-xyz' }],
		['no master wrap', { master: undefined }],
		['no mac', { mac: undefined }],
		['an unknown field', { extra: 1 }],
		[
			'more PBKDF2 iterations than an unlock can finish',
			{ kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 2 ** 40, salt: B64_32 } },
		],
		[
			'a format-1 recovery block',
			{ recovery: { alg: 'ECDH-P256+AES-GCM', publicKey: { x: 'a', y: 'b' }, keys: [] } },
		],
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
	test('a first record (or a re-upload after the server lost it) may carry any revision', () => {
		expect(isKeyRecordSuccessor(null, record()).ok).toBe(true)
		expect(isKeyRecordSuccessor(null, record({ revision: 7 })).ok).toBe(true)
	})

	test('a successor raises the revision, keeps the ring and every version', () => {
		const first = record()
		const key = first.keys[0]
		if (!key) throw new Error('fixture')
		const rotated = record({
			revision: 2,
			currentVersion: 2,
			keys: [key, { ...key, keyVersion: 2, keyId: `k2-${'b'.repeat(32)}` }],
		})
		expect(isKeyRecordSuccessor(first, rotated).ok).toBe(true)
		// A merge or a healed rollback may jump revisions.
		expect(isKeyRecordSuccessor(first, record({ ...rotated, revision: 9 })).ok).toBe(true)
		// Dropping or relabelling a version would make history unreadable.
		expect(
			isKeyRecordSuccessor(
				rotated,
				record({ revision: 3, keys: [{ ...key, keyId: `k2-${'c'.repeat(32)}` }] }),
			).ok,
		).toBe(false)
		expect(isKeyRecordSuccessor(rotated, record({ ...rotated, revision: 2 })).ok).toBe(false)
		expect(isKeyRecordSuccessor(rotated, record({ ...rotated, revision: 1 })).ok).toBe(false)
		expect(
			isKeyRecordSuccessor(first, record({ ...rotated, ringId: `r-${'1'.repeat(32)}` })).ok,
		).toBe(false)
	})
})

describe('canonical MAC input', () => {
	test('is independent of key order and covers every field but the mac', () => {
		const a = record()
		const reordered = Object.fromEntries(Object.entries(a).reverse()) as unknown as WrappedKeyRecord
		expect(keyRecordMacInput(reordered)).toEqual(keyRecordMacInput(a))
		expect(keyRecordMacInput(record({ mac: `${'B'.repeat(43)}=` }))).toEqual(keyRecordMacInput(a))
		expect(keyRecordMacInput(record({ revision: 2 }))).not.toEqual(keyRecordMacInput(a))
		expect(canonicalJson({ b: 1, a: [2, { d: null, c: 'x' }] })).toBe(
			'{"a":[2,{"c":"x","d":null}],"b":1}',
		)
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
