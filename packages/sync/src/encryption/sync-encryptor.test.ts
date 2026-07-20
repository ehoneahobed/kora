import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import type { SerializedOperation } from '../protocol/messages'
import { JsonMessageSerializer, ProtobufMessageSerializer } from '../protocol/serializer'
import { deriveVersionedKey as deriveVersionedKeyWithCost, generateSalt } from './key-derivation'
import {
	DecryptionError,
	EncryptionError,
	SyncEncryptor,
	isEncryptedPayload,
} from './sync-encryptor'
import type { SyncEncryptionConfig, VersionedKey } from './types'

// --- Test helpers ---

/**
 * Low PBKDF2 iteration count for tests. Production derives at 600,000
 * iterations (see DEFAULT_PBKDF2_ITERATIONS); those real derivations are
 * CPU-bound on the libuv crypto threadpool and, when many test files run in
 * parallel under `turbo test --concurrency=N`, several per-test derivations
 * queued behind each other pushed heavy tests past the 5s default timeout
 * (flaky in CI, green in isolation). 1,000 iterations exercises the exact same
 * real WebCrypto PBKDF2/AES-GCM code path in ~1ms, removing the contention
 * without touching the production default. Every derivation in this file must
 * use the SAME count so encrypt/decrypt key pairs match.
 */
const TEST_KDF_ITERATIONS = 1_000

/** deriveVersionedKey pinned to the fast test iteration count. */
function deriveVersionedKey(
	passphrase: string,
	version: number,
	salt?: Uint8Array,
): Promise<VersionedKey> {
	return deriveVersionedKeyWithCost(passphrase, version, salt, TEST_KDF_ITERATIONS)
}

function makeOperation(overrides?: Partial<Operation>): Operation {
	return {
		id: 'op-test-1',
		nodeId: 'node-1',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-1',
		data: { title: 'Test Todo', completed: false, priority: 'high' },
		previousData: null,
		timestamp: { wallTime: 1700000000000, logical: 0, nodeId: 'node-1' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

function makeUpdateOperation(): Operation {
	return makeOperation({
		id: 'op-test-2',
		type: 'update',
		data: { completed: true },
		previousData: { completed: false },
	})
}

function makeDeleteOperation(): Operation {
	return makeOperation({
		id: 'op-test-3',
		type: 'delete',
		data: null,
		previousData: null,
	})
}

async function createEncryptor(passphrase = 'test-passphrase'): Promise<SyncEncryptor> {
	return SyncEncryptor.create({ enabled: true, key: passphrase }, undefined, TEST_KDF_ITERATIONS)
}

async function createEncryptorWithSalt(
	passphrase: string,
	salt: Uint8Array,
): Promise<SyncEncryptor> {
	return SyncEncryptor.create({ enabled: true, key: passphrase }, salt, TEST_KDF_ITERATIONS)
}

// --- Tests ---

describe('SyncEncryptor.create', () => {
	test('creates an encryptor from a passphrase string', async () => {
		const encryptor = await createEncryptor()
		expect(encryptor).toBeInstanceOf(SyncEncryptor)
		expect(encryptor.getCurrentKeyVersion()).toBe(1)
	})

	test('creates an encryptor from an async key provider', async () => {
		const config: SyncEncryptionConfig = {
			enabled: true,
			key: async () => 'async-passphrase',
		}
		const encryptor = await SyncEncryptor.create(config, undefined, TEST_KDF_ITERATIONS)
		expect(encryptor).toBeInstanceOf(SyncEncryptor)
	})

	test('throws EncryptionError when encryption is disabled', async () => {
		await expect(SyncEncryptor.create({ enabled: false, key: 'test' })).rejects.toThrow(
			EncryptionError,
		)
	})

	test('throws EncryptionError for empty passphrase', async () => {
		await expect(SyncEncryptor.create({ enabled: true, key: '' })).rejects.toThrow(EncryptionError)
		await expect(SyncEncryptor.create({ enabled: true, key: '' })).rejects.toThrow(
			'must not be empty',
		)
	})

	test('throws EncryptionError for async provider returning empty string', async () => {
		await expect(SyncEncryptor.create({ enabled: true, key: async () => '' })).rejects.toThrow(
			EncryptionError,
		)
	})

	test('deterministic key with same salt', async () => {
		const salt = generateSalt()
		const enc1 = await createEncryptorWithSalt('same-pass', salt)
		const enc2 = await createEncryptorWithSalt('same-pass', salt)

		const op = makeOperation()
		const encrypted = await enc1.encryptOperation(op)
		const decrypted = await enc2.decryptOperation(encrypted)
		expect(decrypted.data).toEqual(op.data)
	})
})

describe('SyncEncryptor.fromKeys', () => {
	test('creates an encryptor from pre-derived keys', async () => {
		const vk = await deriveVersionedKey('passphrase', 1)
		const encryptor = SyncEncryptor.fromKeys([vk])
		expect(encryptor.getCurrentKeyVersion()).toBe(1)
	})

	test('uses the highest version as current', async () => {
		const salt = generateSalt()
		const vk1 = await deriveVersionedKey('pass1', 1, salt)
		const vk2 = await deriveVersionedKey('pass2', 5, salt)
		const encryptor = SyncEncryptor.fromKeys([vk1, vk2])
		expect(encryptor.getCurrentKeyVersion()).toBe(5)
	})

	test('throws for empty keys array', () => {
		expect(() => SyncEncryptor.fromKeys([])).toThrow(EncryptionError)
	})
})

describe('encrypt/decrypt roundtrip', () => {
	test('insert operation with data', async () => {
		const encryptor = await createEncryptor()
		const op = makeOperation()
		const encrypted = await encryptor.encryptOperation(op)

		// data should be encrypted (not the original values)
		expect(encrypted.data).not.toEqual(op.data)
		expect(SyncEncryptor.isEncryptedPayload(encrypted.data)).toBe(true)

		// Metadata should be unchanged
		expect(encrypted.id).toBe(op.id)
		expect(encrypted.nodeId).toBe(op.nodeId)
		expect(encrypted.type).toBe(op.type)
		expect(encrypted.collection).toBe(op.collection)
		expect(encrypted.recordId).toBe(op.recordId)
		expect(encrypted.timestamp).toEqual(op.timestamp)
		expect(encrypted.sequenceNumber).toBe(op.sequenceNumber)
		expect(encrypted.causalDeps).toEqual(op.causalDeps)
		expect(encrypted.schemaVersion).toBe(op.schemaVersion)
		expect(encrypted.previousData).toBeNull()

		// Decrypt should restore original
		const decrypted = await encryptor.decryptOperation(encrypted)
		expect(decrypted.data).toEqual(op.data)
		expect(decrypted.previousData).toBeNull()
	})

	test('update operation with data and previousData', async () => {
		const encryptor = await createEncryptor()
		const op = makeUpdateOperation()
		const encrypted = await encryptor.encryptOperation(op)

		// Both data and previousData should be encrypted
		expect(SyncEncryptor.isEncryptedPayload(encrypted.data)).toBe(true)
		expect(SyncEncryptor.isEncryptedPayload(encrypted.previousData)).toBe(true)

		const decrypted = await encryptor.decryptOperation(encrypted)
		expect(decrypted.data).toEqual(op.data)
		expect(decrypted.previousData).toEqual(op.previousData)
	})

	test('delete operation with null data and previousData', async () => {
		const encryptor = await createEncryptor()
		const op = makeDeleteOperation()
		const encrypted = await encryptor.encryptOperation(op)

		// null fields stay null
		expect(encrypted.data).toBeNull()
		expect(encrypted.previousData).toBeNull()

		const decrypted = await encryptor.decryptOperation(encrypted)
		expect(decrypted.data).toBeNull()
		expect(decrypted.previousData).toBeNull()
	})

	test('does not mutate the original operation', async () => {
		const encryptor = await createEncryptor()
		const op = makeOperation()
		const originalData = { ...op.data }

		await encryptor.encryptOperation(op)
		expect(op.data).toEqual(originalData)
	})

	test('each encryption produces unique ciphertext (unique IVs)', async () => {
		const encryptor = await createEncryptor()
		const op = makeOperation()

		const enc1 = await encryptor.encryptOperation(op)
		const enc2 = await encryptor.encryptOperation(op)

		// The encrypted payloads should have different IVs and thus different ciphertext
		const payload1 = enc1.data as Record<string, unknown>
		const payload2 = enc2.data as Record<string, unknown>
		expect(payload1.iv).not.toBe(payload2.iv)
		expect(payload1.ct).not.toBe(payload2.ct)

		// But both should decrypt to the same value
		const dec1 = await encryptor.decryptOperation(enc1)
		const dec2 = await encryptor.decryptOperation(enc2)
		expect(dec1.data).toEqual(dec2.data)
	})
})

describe('encrypted payload structure', () => {
	test('contains expected fields', async () => {
		const encryptor = await createEncryptor()
		const op = makeOperation()
		const encrypted = await encryptor.encryptOperation(op)

		const payload = encrypted.data as Record<string, unknown>
		expect(payload.__kora_e2e_encrypted).toBe(true)
		expect(typeof payload.v).toBe('number')
		expect(typeof payload.iv).toBe('string')
		expect(typeof payload.ct).toBe('string')
		expect(payload.alg).toBe('aes-256-gcm')
	})

	test('key version matches current version', async () => {
		const encryptor = await createEncryptor()
		const op = makeOperation()
		const encrypted = await encryptor.encryptOperation(op)

		const payload = encrypted.data as Record<string, unknown>
		expect(payload.v).toBe(1)
	})
})

describe('isEncryptedPayload', () => {
	test('returns true for encrypted payload', async () => {
		const encryptor = await createEncryptor()
		const op = makeOperation()
		const encrypted = await encryptor.encryptOperation(op)
		expect(isEncryptedPayload(encrypted.data)).toBe(true)
	})

	test('returns false for null', () => {
		expect(isEncryptedPayload(null)).toBe(false)
	})

	test('returns false for plain data', () => {
		expect(isEncryptedPayload({ title: 'test' })).toBe(false)
	})

	test('returns false for incomplete encrypted payload', () => {
		expect(isEncryptedPayload({ __kora_e2e_encrypted: true })).toBe(false)
		expect(isEncryptedPayload({ __kora_e2e_encrypted: true, v: 1 })).toBe(false)
	})
})

describe('key mismatch', () => {
	test('throws DecryptionError when decrypting with wrong key', async () => {
		const encryptor1 = await createEncryptor('passphrase-one')
		const encryptor2 = await createEncryptor('passphrase-two')

		const op = makeOperation()
		const encrypted = await encryptor1.encryptOperation(op)

		await expect(encryptor2.decryptOperation(encrypted)).rejects.toThrow(DecryptionError)
		await expect(encryptor2.decryptOperation(encrypted)).rejects.toThrow('wrong encryption key')
	})
})

describe('key rotation', () => {
	test('addKey increases the current version', async () => {
		const encryptor = await createEncryptor('initial')
		expect(encryptor.getCurrentKeyVersion()).toBe(1)

		const vk2 = await deriveVersionedKey('rotated', 2)
		encryptor.addKey(vk2)
		expect(encryptor.getCurrentKeyVersion()).toBe(2)
	})

	test('addKey throws for duplicate version', async () => {
		const encryptor = await createEncryptor('initial')
		const vk = await deriveVersionedKey('dup', 1)
		expect(() => encryptor.addKey(vk)).toThrow(EncryptionError)
		expect(() => encryptor.addKey(vk)).toThrow('already exists')
	})

	test('operations encrypted with old key can be decrypted after rotation', async () => {
		const salt = generateSalt()
		const vk1 = await deriveVersionedKey('pass-v1', 1, salt)
		const encryptorV1 = SyncEncryptor.fromKeys([vk1])

		const op = makeOperation()
		const encryptedWithV1 = await encryptorV1.encryptOperation(op)

		// Simulate rotation: new encryptor has both keys
		const vk2 = await deriveVersionedKey('pass-v2', 2)
		const encryptorV1V2 = SyncEncryptor.fromKeys([vk1, vk2])

		// Can decrypt old operations with key v1
		const decrypted = await encryptorV1V2.decryptOperation(encryptedWithV1)
		expect(decrypted.data).toEqual(op.data)
	})

	test('new operations use the latest key version', async () => {
		const vk1 = await deriveVersionedKey('pass-v1', 1)
		const vk2 = await deriveVersionedKey('pass-v2', 2)
		const encryptor = SyncEncryptor.fromKeys([vk1, vk2])

		const op = makeOperation()
		const encrypted = await encryptor.encryptOperation(op)

		const payload = encrypted.data as Record<string, unknown>
		expect(payload.v).toBe(2)
	})

	test('decryption fails when key version is not available', async () => {
		const vk1 = await deriveVersionedKey('pass-v1', 1)
		const vk3 = await deriveVersionedKey('pass-v3', 3)

		const encryptorV3 = SyncEncryptor.fromKeys([vk3])
		const op = makeOperation()
		const encrypted = await encryptorV3.encryptOperation(op)

		// Encryptor only has v1, but operation was encrypted with v3
		const encryptorV1 = SyncEncryptor.fromKeys([vk1])
		await expect(encryptorV1.decryptOperation(encrypted)).rejects.toThrow(DecryptionError)
		await expect(encryptorV1.decryptOperation(encrypted)).rejects.toThrow('version 3')
	})
})

describe('batch operations', () => {
	test('encryptBatch encrypts all operations', async () => {
		const encryptor = await createEncryptor()
		const ops = [makeOperation(), makeUpdateOperation(), makeDeleteOperation()]
		const encrypted = await encryptor.encryptBatch(ops)

		expect(encrypted).toHaveLength(3)
		expect(SyncEncryptor.isEncryptedPayload(encrypted[0]?.data ?? null)).toBe(true)
		expect(SyncEncryptor.isEncryptedPayload(encrypted[1]?.data ?? null)).toBe(true)
		expect(encrypted[2]?.data).toBeNull() // delete has null data
	})

	test('decryptBatch decrypts all operations', async () => {
		const encryptor = await createEncryptor()
		const ops = [makeOperation(), makeUpdateOperation()]
		const encrypted = await encryptor.encryptBatch(ops)
		const decrypted = await encryptor.decryptBatch(encrypted)

		expect(decrypted[0]?.data).toEqual(ops[0]?.data)
		expect(decrypted[1]?.data).toEqual(ops[1]?.data)
		expect(decrypted[1]?.previousData).toEqual(ops[1]?.previousData)
	})
})

describe('serialized operation support', () => {
	test('encrypt/decrypt roundtrip for SerializedOperation', async () => {
		const encryptor = await createEncryptor()
		const serialized: SerializedOperation = {
			id: 'op-ser-1',
			nodeId: 'node-1',
			type: 'insert',
			collection: 'todos',
			recordId: 'rec-1',
			data: { title: 'Serialized Op', done: false },
			previousData: null,
			timestamp: { wallTime: 1700000000000, logical: 0, nodeId: 'node-1' },
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		}

		const encrypted = await encryptor.encryptSerializedOperation(serialized)
		expect(SyncEncryptor.isEncryptedPayload(encrypted.data)).toBe(true)
		expect(encrypted.previousData).toBeNull()

		const decrypted = await encryptor.decryptSerializedOperation(encrypted)
		expect(decrypted.data).toEqual(serialized.data)
	})
})

describe('JSON serializer compatibility', () => {
	test('encrypted operations survive JSON serialize/deserialize', async () => {
		const encryptor = await createEncryptor()
		const serializer = new JsonMessageSerializer()
		const op = makeOperation()

		// Encrypt then serialize
		const encrypted = await encryptor.encryptOperation(op)
		const serialized = serializer.encodeOperation(encrypted)
		const json = JSON.stringify(serialized)

		// Deserialize then decrypt
		const parsed = JSON.parse(json) as SerializedOperation
		const decoded = serializer.decodeOperation(parsed)
		const decrypted = await encryptor.decryptOperation(decoded)

		expect(decrypted.data).toEqual(op.data)
	})
})

describe('protobuf serializer compatibility', () => {
	test('encrypted operations survive protobuf serialize/deserialize', async () => {
		const encryptor = await createEncryptor()
		const serializer = new ProtobufMessageSerializer()
		const op = makeUpdateOperation()

		// Encrypt then serialize
		const encrypted = await encryptor.encryptOperation(op)
		const serialized = serializer.encodeOperation(encrypted)

		// Serialize through protobuf message envelope
		const json = JSON.stringify(serialized)
		const parsed = JSON.parse(json) as SerializedOperation
		const decoded = serializer.decodeOperation(parsed)
		const decrypted = await encryptor.decryptOperation(decoded)

		expect(decrypted.data).toEqual(op.data)
		expect(decrypted.previousData).toEqual(op.previousData)
	})
})

describe('backward compatibility', () => {
	test('decrypting unencrypted operation passes through unchanged', async () => {
		const encryptor = await createEncryptor()
		const op = makeOperation()

		// Decrypt an operation that was never encrypted
		const decrypted = await encryptor.decryptOperation(op)
		expect(decrypted.data).toEqual(op.data)
	})

	test('mixed encrypted/unencrypted batch', async () => {
		const encryptor = await createEncryptor()
		const plainOp = makeOperation({ id: 'plain-1' })
		const encOp = await encryptor.encryptOperation(
			makeOperation({ id: 'enc-1', data: { secret: 'value' } }),
		)

		// Decrypt batch with mixed operations
		const decrypted = await encryptor.decryptBatch([plainOp, encOp])
		expect(decrypted[0]?.data).toEqual(plainOp.data)
		expect(decrypted[1]?.data).toEqual({ secret: 'value' })
	})
})

describe('server relay simulation', () => {
	test('server stores and relays encrypted ops without decrypting', async () => {
		const salt = generateSalt()
		const clientAEncryptor = await createEncryptorWithSalt('shared-secret', salt)
		const clientBEncryptor = await createEncryptorWithSalt('shared-secret', salt)

		const op = makeOperation({
			data: { title: 'Private Note', content: 'Very sensitive' },
		})

		// Client A encrypts
		const encrypted = await clientAEncryptor.encryptOperation(op)

		// "Server" stores the encrypted operation as-is (simulated by JSON roundtrip)
		const serverStored = JSON.parse(JSON.stringify(encrypted)) as Operation

		// Verify server cannot read the data
		expect(serverStored.data).not.toEqual(op.data)
		expect(SyncEncryptor.isEncryptedPayload(serverStored.data)).toBe(true)

		// "Server" relays to Client B
		const decrypted = await clientBEncryptor.decryptOperation(serverStored)
		expect(decrypted.data).toEqual(op.data)
	})

	test('end-to-end: two clients converge through encrypted sync', async () => {
		const salt = generateSalt()
		const encA = await createEncryptorWithSalt('team-key', salt)
		const encB = await createEncryptorWithSalt('team-key', salt)

		// Client A creates operations
		const opA1 = makeOperation({
			id: 'a1',
			nodeId: 'client-a',
			data: { title: 'Task 1' },
		})
		const opA2 = makeOperation({
			id: 'a2',
			nodeId: 'client-a',
			type: 'update',
			data: { completed: true },
			previousData: { completed: false },
			sequenceNumber: 2,
		})

		// Client B creates an operation
		const opB1 = makeOperation({
			id: 'b1',
			nodeId: 'client-b',
			data: { title: 'Task 2' },
		})

		// Encrypt all
		const encA1 = await encA.encryptOperation(opA1)
		const encA2 = await encA.encryptOperation(opA2)
		const encB1 = await encB.encryptOperation(opB1)

		// "Server" collects all encrypted operations
		const serverOps = [encA1, encA2, encB1].map((op) => JSON.parse(JSON.stringify(op)) as Operation)

		// Client A receives B's operation
		const decA = await encA.decryptOperation(serverOps[2] as Operation)
		expect(decA.data).toEqual({ title: 'Task 2' })

		// Client B receives A's operations
		const decB1 = await encB.decryptOperation(serverOps[0] as Operation)
		const decB2 = await encB.decryptOperation(serverOps[1] as Operation)
		expect(decB1.data).toEqual({ title: 'Task 1' })
		expect(decB2.data).toEqual({ completed: true })
		expect(decB2.previousData).toEqual({ completed: false })
	})
})

describe('edge cases', () => {
	test('handles data with special characters', async () => {
		const encryptor = await createEncryptor()
		const op = makeOperation({
			data: {
				title: 'Contains "quotes" and \\backslashes',
				unicode: '\u00e9\u00e0\u00fc\u00f6\u00e4\u2603\u2764\ufe0f',
				newlines: 'line1\nline2\ttab',
				empty: '',
				nested: { deep: { value: 42 } },
			},
		})

		const encrypted = await encryptor.encryptOperation(op)
		const decrypted = await encryptor.decryptOperation(encrypted)
		expect(decrypted.data).toEqual(op.data)
	})

	test('handles data with large values', async () => {
		const encryptor = await createEncryptor()
		const largeString = 'x'.repeat(100_000)
		const op = makeOperation({ data: { content: largeString } })

		const encrypted = await encryptor.encryptOperation(op)
		const decrypted = await encryptor.decryptOperation(encrypted)
		expect((decrypted.data as Record<string, unknown>).content).toBe(largeString)
	})

	test('handles data with numeric values', async () => {
		const encryptor = await createEncryptor()
		const op = makeOperation({
			data: {
				int: 42,
				float: Math.PI,
				negative: -100,
				zero: 0,
				max: Number.MAX_SAFE_INTEGER,
			},
		})

		const encrypted = await encryptor.encryptOperation(op)
		const decrypted = await encryptor.decryptOperation(encrypted)
		expect(decrypted.data).toEqual(op.data)
	})

	test('handles data with boolean values', async () => {
		const encryptor = await createEncryptor()
		const op = makeOperation({
			data: { trueVal: true, falseVal: false },
		})

		const encrypted = await encryptor.encryptOperation(op)
		const decrypted = await encryptor.decryptOperation(encrypted)
		expect(decrypted.data).toEqual(op.data)
	})

	test('handles data with null field values', async () => {
		const encryptor = await createEncryptor()
		const op = makeOperation({
			data: { title: 'test', optional: null },
		})

		const encrypted = await encryptor.encryptOperation(op)
		const decrypted = await encryptor.decryptOperation(encrypted)
		expect(decrypted.data).toEqual(op.data)
	})

	test('handles data with array values', async () => {
		const encryptor = await createEncryptor()
		const op = makeOperation({
			data: { tags: ['urgent', 'important'], scores: [1, 2, 3] },
		})

		const encrypted = await encryptor.encryptOperation(op)
		const decrypted = await encryptor.decryptOperation(encrypted)
		expect(decrypted.data).toEqual(op.data)
	})
})
