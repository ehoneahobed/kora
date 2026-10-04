/**
 * RT-104 repro (final RC red team, ENC-1): after the server loses a user's key record
 * (a restore from the server's own backup, which covers operations only, per the
 * encryption guide), the FIRST device to reconnect decides the user's keys. The guide
 * promises "the next device that still holds it uploads its copy again, so nothing is
 * lost while one device has synced". That holds only if an old device is first. A new
 * device (fresh install, the user types the passphrase) sees no record and creates a
 * brand-new keyring with a new data key. Every device that held the old record then
 * refuses the new one as KEY_RECORD_ROLLBACK and stops syncing for good (there is no
 * API to resolve it), and the new device can never decrypt the user's history.
 *
 * Asserts CORRECT behaviour: after the loss, an old device and a new device of the same
 * user end up on one keyring that opens the old data key.
 */
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { MemoryKeyCache } from '../../src/encryption/key-cache'
import type { WrappedKeyRecord } from '../../src/encryption/key-record'
import { isKeyRecordSuccessor } from '../../src/encryption/key-record'
import type { KeyServiceChannel, KeyServiceReply } from '../../src/encryption/keyring'
import { EncryptionKeyring } from '../../src/encryption/keyring'

const ITERATIONS = 1000

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T
}

class KeyServer {
	record: WrappedKeyRecord | null = null
	channel(): KeyServiceChannel {
		return {
			fetch: async () => ({ status: 'ok', record: clone(this.record) }),
			put: async (_keyring, record, expectedRevision): Promise<KeyServiceReply> => {
				if ((this.record?.revision ?? 0) !== expectedRevision) {
					return { status: 'conflict', record: clone(this.record) }
				}
				if (!isKeyRecordSuccessor(this.record, record).ok) {
					return { status: 'conflict', record: clone(this.record) }
				}
				this.record = clone(record)
				return { status: 'ok', record: clone(record) }
			},
		}
	}
}

function op(id: string): Operation {
	return {
		id,
		nodeId: 'node-a',
		type: 'insert',
		collection: 'notes',
		recordId: `rec-${id}`,
		data: { body: `secret ${id}` },
		previousData: null,
		timestamp: { wallTime: 1_700_000_000_000, logical: 0, nodeId: 'node-a' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		hashVersion: 2,
	}
}

describe('RT-104: a lost key record is re-created by whichever device connects first', () => {
	test('a new device reconnecting first does not fork the keyring', async () => {
		const server = new KeyServer()
		const passphrase = 'correct horse battery staple'
		const old = new EncryptionKeyring({ passphrase, kdfIterations: ITERATIONS, cache: new MemoryKeyCache() })
		expect(await old.synchronize(server.channel(), 'alice')).toBe('ready')
		const history = await (old.getEncryptor() as NonNullable<ReturnType<typeof old.getEncryptor>>)
			.encryptOperation(op('history'))

		// Disaster recovery: the server is restored from its backup (operations only).
		server.record = null

		// A new phone signs in first.
		const fresh = new EncryptionKeyring({ passphrase, kdfIterations: ITERATIONS, cache: new MemoryKeyCache() })
		await fresh.synchronize(server.channel(), 'alice')
		// Then the old laptop reconnects.
		const outcome = await old.synchronize(server.channel(), 'alice')

		expect(old.getStatus().code).toBeUndefined()
		expect(outcome).toBe('ready')
		// One keyring for the user: the new device reads the history.
		await fresh.synchronize(server.channel(), 'alice')
		const plain = await (fresh.getEncryptor() as NonNullable<ReturnType<typeof fresh.getEncryptor>>)
			.decryptOperation(history)
			.then(
				(o) => (o.data as { body: string }).body,
				(error: Error) => `failed: ${error.message}`,
			)
		expect(plain).toBe('secret history')
	})
})
