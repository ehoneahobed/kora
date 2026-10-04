import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { MemoryKeyCache } from './key-cache'
import type { WrappedKeyRecord } from './key-record'
import type { KeyServiceChannel, KeyServiceReply } from './keyring'
import { EncryptionKeyring } from './keyring'
import type { MasterKeys } from './keyring-crypto'
import {
	deriveKeyEncryptionKey,
	fromBase64,
	generateDataKey,
	importMasterKey,
	newKeyId,
	sealRecord,
	unwrapMasterKey,
	wrapDataKey,
} from './keyring-crypto'
import { SyncEncryptor } from './sync-encryptor'

/**
 * RT-107 hardening: a device that held the old master key when the server served a newer
 * revision it could not authenticate (a passphrase change made elsewhere) never again
 * adopts, without an explicit unlock, a record authenticated only by that old key.
 */

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
				this.record = clone(record)
				return { status: 'ok', record: clone(record) }
			},
		}
	}
}

function device(passphrase: string, cache = new MemoryKeyCache()): EncryptionKeyring {
	return new EncryptionKeyring({ passphrase, kdfIterations: ITERATIONS, cache })
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

async function openWith(record: WrappedKeyRecord, passphrase: string): Promise<MasterKeys> {
	const kek = await deriveKeyEncryptionKey(
		passphrase,
		fromBase64(record.kdf.salt),
		record.kdf.iterations,
	)
	return importMasterKey(await unwrapMasterKey(record.master, kek, record.keyring, record.ringId))
}

/** A successor under `record`'s master that makes a key of the attacker's current. */
async function forge(
	record: WrappedKeyRecord,
	master: MasterKeys,
	revision: number,
): Promise<{ forged: WrappedKeyRecord; key: CryptoKey; keyId: string; version: number }> {
	const key = await generateDataKey()
	const keyId = newKeyId()
	const version = record.currentVersion + 1
	const forged = await sealRecord(
		{
			...record,
			revision,
			currentVersion: version,
			keys: [
				...record.keys,
				await wrapDataKey(key, master.wrapKey, record.keyring, version, keyId),
			],
		},
		master.macKey,
	)
	return { forged, key, keyId, version }
}

async function readableBy(
	keyring: EncryptionKeyring,
	key: CryptoKey,
	keyId: string,
	version: number,
): Promise<boolean> {
	const encryptor = keyring.getEncryptor()
	if (encryptor === null) return false
	const sealed = await encryptor.encryptOperation(op(`o-${keyId}`))
	return SyncEncryptor.fromKeys([{ version, key, keyId }])
		.decryptOperation(sealed)
		.then(
			() => true,
			() => false,
		)
}

describe('EncryptionKeyring: a master key superseded by an unreadable newer revision', () => {
	test('a device that saw a passphrase change refuses a record forged under its old master, across restarts', async () => {
		const server = new KeyServer()
		const cache = new MemoryKeyCache()
		const a = device('old')
		const b = device('old', cache)
		await a.synchronize(server.channel(), 'alice')
		await b.synchronize(server.channel(), 'alice')
		const oldRecord = clone(server.record as WrappedKeyRecord)

		await a.changePassphrase('new', server.channel())
		// B learns of the change but cannot read it: it keeps its keys.
		expect(await b.adoptPushed(clone(server.record as WrappedKeyRecord))).toBe('ready')
		expect(b.getStatus().code).toBe('PASSPHRASE_REQUIRED')

		// The server (knowing the OLD passphrase) forges a successor under the old master.
		const m1 = await openWith(oldRecord, 'old')
		const attack = await forge(oldRecord, m1, (server.record as WrappedKeyRecord).revision + 1)
		expect(await b.adoptPushed(clone(attack.forged))).toBe('locked')
		expect(b.getStatus().code).toBe('KEY_RECORD_INVALID')
		expect(await readableBy(b, attack.key, attack.keyId, attack.version)).toBe(false)

		// After a restart, served on fetch: still refused.
		const restarted = device('old', cache)
		await restarted.load('alice')
		server.record = clone(attack.forged)
		expect(await restarted.synchronize(server.channel(), 'alice')).toBe('locked')
		expect(restarted.getStatus().code).toBe('KEY_RECORD_INVALID')
		expect(await readableBy(restarted, attack.key, attack.keyId, attack.version)).toBe(false)
	})

	test('a junk newer revision only delays: an explicit unlock with the passphrase clears the mark', async () => {
		const server = new KeyServer()
		const a = device('p')
		const b = device('p')
		await a.synchronize(server.channel(), 'alice')
		await b.synchronize(server.channel(), 'alice')
		const current = server.record as WrappedKeyRecord

		// A newer revision whose master wrap the passphrase does not open (another ring's):
		// it authenticates under nothing this device has.
		const other = new KeyServer()
		await device('other').synchronize(other.channel(), 'alice')
		const foreign = other.record as WrappedKeyRecord
		const junk = { ...clone(current), revision: current.revision + 1, master: foreign.master }
		expect(await b.adoptPushed(junk)).toBe('ready')
		expect(b.getStatus().code).toBe('PASSPHRASE_REQUIRED')

		// A genuine rotation under the unchanged master is not adopted automatically...
		await a.rotate(server.channel())
		expect(await b.adoptPushed(clone(server.record as WrappedKeyRecord))).toBe('locked')
		expect(b.getStatus().code).toBe('KEY_RECORD_INVALID')

		// ...until the user unlocks with the passphrase; then it flows again.
		await b.unlock('p', server.channel())
		expect(b.getStatus().state).toBe('unlocked')
		expect(b.getStatus().keyId).toBe(a.getStatus().keyId)
		await a.rotate(server.channel())
		expect(await b.adoptPushed(clone(server.record as WrappedKeyRecord))).toBe('ready')
		expect(b.getStatus().keyId).toBe(a.getStatus().keyId)
	})

	test('a device that never saw the change is unaffected by the mark (rotations flow)', async () => {
		const server = new KeyServer()
		const a = device('p')
		const b = device('p')
		await a.synchronize(server.channel(), 'alice')
		await b.synchronize(server.channel(), 'alice')
		await a.rotate(server.channel())
		expect(await b.adoptPushed(clone(server.record as WrappedKeyRecord))).toBe('ready')
		expect(b.getStatus().keyId).toBe(a.getStatus().keyId)
		expect(b.getStatus().code).toBeUndefined()
	})
})
