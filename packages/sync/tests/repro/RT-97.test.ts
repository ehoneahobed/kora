/**
 * RT-97 repro (final RC red team, ENC-1): a rotation that races a passphrase change on
 * another device wraps the new data key under the OLD passphrase into a record that
 * carries the NEW salt. `rotate()` (and `enableRecovery()`) read the KEK once, before the
 * compare-and-set loop. When the first put loses to the other device's passphrase change,
 * the device adopts the new record (which drops its KEK because the salt changed) and then
 * retries with the stale KEK captured before the loop. The server accepts the structurally
 * valid record. Nobody holding the current passphrase can open the new version: every
 * other device and every new device fails WRONG_PASSPHRASE on it, and operations sealed
 * under it are readable only on the rotating device, until its cache is lost (then never).
 *
 * Asserts CORRECT behaviour: after the race, a device unlocking with the current
 * passphrase opens every key version and decrypts what the rotating device sealed.
 */
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { MemoryKeyCache } from '../../src/encryption/key-cache'
import type { WrappedKeyRecord } from '../../src/encryption/key-record'
import { isKeyRecordSuccessor, validateKeyRecord } from '../../src/encryption/key-record'
import type { KeyServiceChannel, KeyServiceReply } from '../../src/encryption/keyring'
import { EncryptionKeyring } from '../../src/encryption/keyring'

const ITERATIONS = 1000

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T
}

/** The sync server's rules: compare-and-set on revision, append-only versions. */
class KeyServer {
	record: WrappedKeyRecord | null = null
	channel(): KeyServiceChannel {
		return {
			fetch: async () => ({ status: 'ok', record: clone(this.record) }),
			put: async (keyring, record, expectedRevision): Promise<KeyServiceReply> => {
				if (!validateKeyRecord(record, keyring).ok) throw new Error('invalid')
				if ((this.record?.revision ?? 0) !== expectedRevision) {
					return { status: 'conflict', record: clone(this.record) }
				}
				if (!isKeyRecordSuccessor(this.record, record).ok) throw new Error('not successor')
				this.record = clone(record)
				return { status: 'ok', record: clone(record) }
			},
		}
	}
}

function op(id: string): Operation {
	return {
		id,
		nodeId: 'node-b',
		type: 'insert',
		collection: 'notes',
		recordId: `rec-${id}`,
		data: { body: `secret ${id}` },
		previousData: null,
		timestamp: { wallTime: 1_700_000_000_000, logical: 0, nodeId: 'node-b' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		hashVersion: 2,
	}
}

function device(passphrase: string): EncryptionKeyring {
	return new EncryptionKeyring({ passphrase, kdfIterations: ITERATIONS, cache: new MemoryKeyCache() })
}

describe('RT-97: rotation racing a passphrase change wraps under the stale KEK', () => {
	test('a device with the current passphrase opens the rotated version', async () => {
		const server = new KeyServer()
		const a = device('first passphrase')
		const b = device('first passphrase')
		expect(await a.synchronize(server.channel(), 'alice')).toBe('ready')
		expect(await b.synchronize(server.channel(), 'alice')).toBe('ready')

		// A changes the passphrase; B has not heard of it yet and rotates.
		await a.changePassphrase('second passphrase', server.channel())
		await b.rotate(server.channel()).catch(() => undefined)
		const bEncryptor = b.getEncryptor()
		expect(bEncryptor).not.toBeNull()
		const sealed = await (bEncryptor as NonNullable<typeof bEncryptor>).encryptOperation(
			op('rotated'),
		)

		// A fresh device of the same user, with the CURRENT passphrase.
		const c = device('second passphrase')
		const outcome = await c.synchronize(server.channel(), 'alice')
		expect(c.getStatus().code).toBeUndefined()
		expect(outcome).toBe('ready')
		const plain = await (c.getEncryptor() as NonNullable<ReturnType<typeof c.getEncryptor>>)
			.decryptOperation(sealed)
		expect((plain.data as { body: string }).body).toBe('secret rotated')
	})
})
