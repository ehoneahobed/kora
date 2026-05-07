import { describe, expect, it } from 'vitest'
import type { Operation } from '@korajs/core'
import { generateEncryptionKey } from './database-encryption'
import {
	OperationEncryptor,
	OperationEncryptionError,
	isEncryptedField,
} from './operation-encryptor'

// ============================================================================
// Test fixtures
// ============================================================================

function makeInsertOp(overrides: Partial<Operation> = {}): Operation {
	return {
		id: 'op-insert-001',
		nodeId: 'node-aaa',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-001',
		data: { title: 'Buy milk', completed: false, priority: 'medium' },
		previousData: null,
		timestamp: { wallTime: 1700000000000, logical: 0, nodeId: 'node-aaa' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

function makeUpdateOp(overrides: Partial<Operation> = {}): Operation {
	return {
		id: 'op-update-001',
		nodeId: 'node-aaa',
		type: 'update',
		collection: 'todos',
		recordId: 'rec-001',
		data: { completed: true },
		previousData: { completed: false },
		timestamp: { wallTime: 1700000001000, logical: 0, nodeId: 'node-aaa' },
		sequenceNumber: 2,
		causalDeps: ['op-insert-001'],
		schemaVersion: 1,
		...overrides,
	}
}

function makeDeleteOp(overrides: Partial<Operation> = {}): Operation {
	return {
		id: 'op-delete-001',
		nodeId: 'node-aaa',
		type: 'delete',
		collection: 'todos',
		recordId: 'rec-001',
		data: null,
		previousData: null,
		timestamp: { wallTime: 1700000002000, logical: 0, nodeId: 'node-aaa' },
		sequenceNumber: 3,
		causalDeps: ['op-update-001'],
		schemaVersion: 1,
		...overrides,
	}
}

// ============================================================================
// Tests
// ============================================================================

describe('OperationEncryptor', () => {
	// ---- Round-trip encryption/decryption ----

	describe('round-trip encrypt/decrypt', () => {
		it('round-trips an insert operation', async () => {
			const key = await generateEncryptionKey()
			const encryptor = new OperationEncryptor({ key })
			const original = makeInsertOp()

			const encrypted = await encryptor.encryptOperation(original)
			const decrypted = await encryptor.decryptOperation(encrypted)

			expect(decrypted.data).toEqual(original.data)
			expect(decrypted.previousData).toBeNull()
		})

		it('round-trips an update operation with both data and previousData', async () => {
			const key = await generateEncryptionKey()
			const encryptor = new OperationEncryptor({ key })
			const original = makeUpdateOp()

			const encrypted = await encryptor.encryptOperation(original)
			const decrypted = await encryptor.decryptOperation(encrypted)

			expect(decrypted.data).toEqual(original.data)
			expect(decrypted.previousData).toEqual(original.previousData)
		})

		it('round-trips a delete operation (null data fields)', async () => {
			const key = await generateEncryptionKey()
			const encryptor = new OperationEncryptor({ key })
			const original = makeDeleteOp()

			const encrypted = await encryptor.encryptOperation(original)
			const decrypted = await encryptor.decryptOperation(encrypted)

			expect(decrypted.data).toBeNull()
			expect(decrypted.previousData).toBeNull()
		})

		it('round-trips data with special characters and unicode', async () => {
			const key = await generateEncryptionKey()
			const encryptor = new OperationEncryptor({ key })
			const original = makeInsertOp({
				data: {
					title: 'Café résumé — "quotes" & <tags>',
					emoji: '🎵🪕',
					japanese: 'コーラ楽器',
					nested: { inner: true },
					array: [1, 'two', null],
				},
			})

			const encrypted = await encryptor.encryptOperation(original)
			const decrypted = await encryptor.decryptOperation(encrypted)

			expect(decrypted.data).toEqual(original.data)
		})

		it('round-trips data with large payloads', async () => {
			const key = await generateEncryptionKey()
			const encryptor = new OperationEncryptor({ key })
			const largeContent = 'x'.repeat(100_000)
			const original = makeInsertOp({
				data: { content: largeContent, index: 42 },
			})

			const encrypted = await encryptor.encryptOperation(original)
			const decrypted = await encryptor.decryptOperation(encrypted)

			expect(decrypted.data).toEqual(original.data)
		})
	})

	// ---- Metadata preservation ----

	describe('metadata preservation', () => {
		it('preserves all metadata fields after encryption', async () => {
			const key = await generateEncryptionKey()
			const encryptor = new OperationEncryptor({ key })
			const original = makeUpdateOp()

			const encrypted = await encryptor.encryptOperation(original)

			// All metadata must be preserved in cleartext
			expect(encrypted.id).toBe(original.id)
			expect(encrypted.nodeId).toBe(original.nodeId)
			expect(encrypted.type).toBe(original.type)
			expect(encrypted.collection).toBe(original.collection)
			expect(encrypted.recordId).toBe(original.recordId)
			expect(encrypted.timestamp).toEqual(original.timestamp)
			expect(encrypted.sequenceNumber).toBe(original.sequenceNumber)
			expect(encrypted.causalDeps).toEqual(original.causalDeps)
			expect(encrypted.schemaVersion).toBe(original.schemaVersion)
		})

		it('does not mutate the original operation', async () => {
			const key = await generateEncryptionKey()
			const encryptor = new OperationEncryptor({ key })
			const original = makeInsertOp()
			const originalCopy = JSON.parse(JSON.stringify(original)) as Operation

			await encryptor.encryptOperation(original)

			expect(original).toEqual(originalCopy)
		})
	})

	// ---- Encrypted field structure ----

	describe('encrypted field structure', () => {
		it('replaces data with an encrypted envelope', async () => {
			const key = await generateEncryptionKey()
			const encryptor = new OperationEncryptor({ key })

			const encrypted = await encryptor.encryptOperation(makeInsertOp())

			expect(encrypted.data).not.toBeNull()
			const envelope = encrypted.data as Record<string, unknown>
			expect(envelope['__kora_encrypted']).toBe(true)
			expect(typeof envelope['ciphertext']).toBe('string')
			expect(typeof envelope['iv']).toBe('string')
			expect(envelope['algorithm']).toBe('AES-256-GCM')
			expect(envelope['version']).toBe(1)
		})

		it('produces base64url-encoded strings (no +, /, or = padding)', async () => {
			const key = await generateEncryptionKey()
			const encryptor = new OperationEncryptor({ key })

			const encrypted = await encryptor.encryptOperation(makeInsertOp())
			const envelope = encrypted.data as Record<string, unknown>

			expect(envelope['ciphertext']).not.toMatch(/[+/=]/)
			expect(envelope['iv']).not.toMatch(/[+/=]/)
		})

		it('ciphertext does not contain plaintext values', async () => {
			const key = await generateEncryptionKey()
			const encryptor = new OperationEncryptor({ key })

			const encrypted = await encryptor.encryptOperation(makeInsertOp())
			const ciphertext = (encrypted.data as Record<string, string>)['ciphertext']

			expect(ciphertext).not.toContain('Buy milk')
			expect(ciphertext).not.toContain('completed')
			expect(ciphertext).not.toContain('priority')
		})

		it('uses different IV for each encryption (no IV reuse)', async () => {
			const key = await generateEncryptionKey()
			const encryptor = new OperationEncryptor({ key })
			const op = makeInsertOp()

			const enc1 = await encryptor.encryptOperation(op)
			const enc2 = await encryptor.encryptOperation(op)

			const iv1 = (enc1.data as Record<string, string>)['iv']
			const iv2 = (enc2.data as Record<string, string>)['iv']
			expect(iv1).not.toBe(iv2)
		})

		it('produces different ciphertext for each encryption', async () => {
			const key = await generateEncryptionKey()
			const encryptor = new OperationEncryptor({ key })
			const op = makeInsertOp()

			const enc1 = await encryptor.encryptOperation(op)
			const enc2 = await encryptor.encryptOperation(op)

			const ct1 = (enc1.data as Record<string, string>)['ciphertext']
			const ct2 = (enc2.data as Record<string, string>)['ciphertext']
			expect(ct1).not.toBe(ct2)
		})
	})

	// ---- isEncrypted detection ----

	describe('isEncrypted', () => {
		it('returns false for a plaintext operation', async () => {
			const key = await generateEncryptionKey()
			const encryptor = new OperationEncryptor({ key })

			expect(encryptor.isEncrypted(makeInsertOp())).toBe(false)
		})

		it('returns true for an encrypted operation', async () => {
			const key = await generateEncryptionKey()
			const encryptor = new OperationEncryptor({ key })

			const encrypted = await encryptor.encryptOperation(makeInsertOp())
			expect(encryptor.isEncrypted(encrypted)).toBe(true)
		})

		it('returns true when only previousData is encrypted', async () => {
			const key = await generateEncryptionKey()
			const encryptor = new OperationEncryptor({ key })

			const encrypted = await encryptor.encryptOperation(makeUpdateOp())
			// Manually set data to plaintext but keep previousData encrypted
			const mixed: Operation = {
				...encrypted,
				data: { completed: true },
			}
			expect(encryptor.isEncrypted(mixed)).toBe(true)
		})

		it('returns false for a delete operation (both fields null)', async () => {
			const key = await generateEncryptionKey()
			const encryptor = new OperationEncryptor({ key })

			expect(encryptor.isEncrypted(makeDeleteOp())).toBe(false)
		})
	})

	// ---- Key mismatch ----

	describe('wrong key', () => {
		it('throws OperationEncryptionError when decrypting with the wrong key', async () => {
			const keyA = await generateEncryptionKey()
			const keyB = await generateEncryptionKey()
			const encryptorA = new OperationEncryptor({ key: keyA })
			const encryptorB = new OperationEncryptor({ key: keyB })

			const encrypted = await encryptorA.encryptOperation(makeInsertOp())

			await expect(encryptorB.decryptOperation(encrypted)).rejects.toThrow(
				OperationEncryptionError,
			)
		})

		it('error message mentions wrong key or tampered data', async () => {
			const keyA = await generateEncryptionKey()
			const keyB = await generateEncryptionKey()
			const encryptorA = new OperationEncryptor({ key: keyA })
			const encryptorB = new OperationEncryptor({ key: keyB })

			const encrypted = await encryptorA.encryptOperation(makeInsertOp())

			await expect(encryptorB.decryptOperation(encrypted)).rejects.toThrow(
				/wrong encryption key|tampered data/i,
			)
		})
	})

	// ---- Tampered ciphertext ----

	describe('tampered ciphertext', () => {
		it('throws when ciphertext is tampered', async () => {
			const key = await generateEncryptionKey()
			const encryptor = new OperationEncryptor({ key })

			const encrypted = await encryptor.encryptOperation(makeInsertOp())
			const envelope = encrypted.data as Record<string, string>

			// Flip a character in the ciphertext
			const tamperedCt = envelope['ciphertext']
			const flipped = (tamperedCt.charAt(0) === 'A' ? 'B' : 'A') + tamperedCt.slice(1)
			const tamperedOp: Operation = {
				...encrypted,
				data: { ...envelope, ciphertext: flipped },
			}

			await expect(encryptor.decryptOperation(tamperedOp)).rejects.toThrow(
				OperationEncryptionError,
			)
		})

		it('throws when IV is tampered', async () => {
			const key = await generateEncryptionKey()
			const encryptor = new OperationEncryptor({ key })

			const encrypted = await encryptor.encryptOperation(makeInsertOp())
			const envelope = encrypted.data as Record<string, string>

			const tamperedIv = envelope['iv']
			const flipped = (tamperedIv.charAt(0) === 'A' ? 'B' : 'A') + tamperedIv.slice(1)
			const tamperedOp: Operation = {
				...encrypted,
				data: { ...envelope, iv: flipped },
			}

			await expect(encryptor.decryptOperation(tamperedOp)).rejects.toThrow(
				OperationEncryptionError,
			)
		})
	})

	// ---- Backward compatibility ----

	describe('backward compatibility', () => {
		it('passes through plaintext data in decryptOperation', async () => {
			const key = await generateEncryptionKey()
			const encryptor = new OperationEncryptor({ key })
			const plaintext = makeInsertOp()

			// Decrypting a non-encrypted operation should return it unchanged
			const decrypted = await encryptor.decryptOperation(plaintext)

			expect(decrypted.data).toEqual(plaintext.data)
			expect(decrypted.previousData).toEqual(plaintext.previousData)
		})

		it('handles mixed encrypted/plaintext operations in a batch', async () => {
			const key = await generateEncryptionKey()
			const encryptor = new OperationEncryptor({ key })

			const op1 = makeInsertOp({ id: 'op-1' })
			const op2Encrypted = await encryptor.encryptOperation(
				makeInsertOp({ id: 'op-2', data: { title: 'Secret' } }),
			)
			const op3 = makeDeleteOp({ id: 'op-3' })

			const results = await encryptor.decryptBatch([op1, op2Encrypted, op3])

			expect(results[0].data).toEqual(op1.data) // plaintext passthrough
			expect(results[1].data).toEqual({ title: 'Secret' }) // decrypted
			expect(results[2].data).toBeNull() // null passthrough
		})
	})

	// ---- Batch operations ----

	describe('batch operations', () => {
		it('encrypts a batch of operations', async () => {
			const key = await generateEncryptionKey()
			const encryptor = new OperationEncryptor({ key })

			const ops = [
				makeInsertOp({ id: 'batch-1' }),
				makeUpdateOp({ id: 'batch-2' }),
				makeDeleteOp({ id: 'batch-3' }),
			]

			const encrypted = await encryptor.encryptBatch(ops)

			expect(encrypted).toHaveLength(3)
			expect(encryptor.isEncrypted(encrypted[0])).toBe(true)
			expect(encryptor.isEncrypted(encrypted[1])).toBe(true)
			expect(encryptor.isEncrypted(encrypted[2])).toBe(false) // delete: both null
		})

		it('decrypts a batch of operations', async () => {
			const key = await generateEncryptionKey()
			const encryptor = new OperationEncryptor({ key })

			const originals = [
				makeInsertOp({ id: 'batch-1' }),
				makeUpdateOp({ id: 'batch-2' }),
				makeDeleteOp({ id: 'batch-3' }),
			]

			const encrypted = await encryptor.encryptBatch(originals)
			const decrypted = await encryptor.decryptBatch(encrypted)

			expect(decrypted[0].data).toEqual(originals[0].data)
			expect(decrypted[1].data).toEqual(originals[1].data)
			expect(decrypted[1].previousData).toEqual(originals[1].previousData)
			expect(decrypted[2].data).toBeNull()
		})

		it('handles empty batch', async () => {
			const key = await generateEncryptionKey()
			const encryptor = new OperationEncryptor({ key })

			const encrypted = await encryptor.encryptBatch([])
			expect(encrypted).toEqual([])

			const decrypted = await encryptor.decryptBatch([])
			expect(decrypted).toEqual([])
		})
	})

	// ---- Deterministic behavior ----

	describe('deterministic decryption', () => {
		it('two encryptors with the same key produce interchangeable results', async () => {
			const key = await generateEncryptionKey()
			const encryptorA = new OperationEncryptor({ key })
			const encryptorB = new OperationEncryptor({ key })
			const original = makeUpdateOp()

			// Encrypt with A, decrypt with B
			const encrypted = await encryptorA.encryptOperation(original)
			const decrypted = await encryptorB.decryptOperation(encrypted)

			expect(decrypted.data).toEqual(original.data)
			expect(decrypted.previousData).toEqual(original.previousData)
		})
	})
})

// ============================================================================
// isEncryptedField (standalone utility)
// ============================================================================

describe('isEncryptedField', () => {
	it('returns false for null', () => {
		expect(isEncryptedField(null)).toBe(false)
	})

	it('returns false for a plain record', () => {
		expect(isEncryptedField({ title: 'Hello', count: 42 })).toBe(false)
	})

	it('returns true for a valid encrypted envelope', () => {
		expect(
			isEncryptedField({
				__kora_encrypted: true,
				ciphertext: 'abc123',
				iv: 'def456',
				algorithm: 'AES-256-GCM',
				version: 1,
			}),
		).toBe(true)
	})

	it('returns false when marker is missing', () => {
		expect(
			isEncryptedField({
				ciphertext: 'abc123',
				iv: 'def456',
				algorithm: 'AES-256-GCM',
				version: 1,
			}),
		).toBe(false)
	})

	it('returns false when algorithm is wrong', () => {
		expect(
			isEncryptedField({
				__kora_encrypted: true,
				ciphertext: 'abc123',
				iv: 'def456',
				algorithm: 'ChaCha20-Poly1305',
				version: 1,
			}),
		).toBe(false)
	})

	it('returns false when ciphertext is missing', () => {
		expect(
			isEncryptedField({
				__kora_encrypted: true,
				iv: 'def456',
				algorithm: 'AES-256-GCM',
				version: 1,
			}),
		).toBe(false)
	})
})
