/**
 * ENC-3 repro: E2E ciphertext is not bound to its operation (no AES-GCM additional
 * authenticated data over op id / collection / recordId / field), and decryptField
 * passes plaintext through. A server (the party E2E is meant to exclude) can therefore
 * (1) inject plaintext operations that a client with encryption enabled applies, and
 * (2) transplant a valid ciphertext from one operation/field onto another.
 * Asserts CORRECT behavior: both are rejected.
 */
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { SyncEncryptor } from '../../src/encryption/sync-encryptor'

function op(id: string, recordId: string, data: Record<string, unknown>): Operation {
	return {
		id,
		nodeId: 'n1',
		type: 'insert',
		collection: 'accounts',
		recordId,
		data,
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'n1' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
	}
}

describe('ENC-3: ciphertext not bound to operation; plaintext accepted', () => {
	test('plaintext op is rejected when encryption is enabled', async () => {
		const enc = await SyncEncryptor.create({ enabled: true, key: 'k' }, new Uint8Array(32), 1000)
		const forged = op('forged', 'acct-1', { role: 'admin' })
		await expect(enc.decryptOperation(forged)).rejects.toThrow()
	})

	test('ciphertext moved to a different operation fails authentication', async () => {
		const enc = await SyncEncryptor.create({ enabled: true, key: 'k' }, new Uint8Array(32), 1000)
		const original = await enc.encryptOperation(op('op-a', 'acct-a', { balance: 1_000_000 }))
		const transplanted: Operation = { ...op('op-b', 'acct-b', {}), data: original.data }
		await expect(enc.decryptOperation(transplanted)).rejects.toThrow()
	})
})
