/**
 * RT-95 repro (final RC red team, ENC-1): the recovery public key in the server-stored key
 * record is not authenticated. A device adopts any structurally valid record that keeps its
 * key versions, and `rotate()` then wraps the NEW data key to `record.recovery.publicKey`.
 * A malicious (or compromised) sync server swaps in its own recovery public key, either on
 * a push, on a fetch, or in the `conflict` reply of the rotation's own compare-and-set, and
 * unwraps the next data key with its private half. It then reads every operation sealed
 * under that version. The guide says the server "never sees ... a data key, and it cannot
 * unwrap anything".
 *
 * Since record format 2 the recovery key opens the ring's master key (which wraps every
 * data key), so the attack is: the server puts a recovery block for ITS key into the
 * record and waits for a device to wrap the real master key (or a data key) to it. The
 * steal below follows that chain: recovery block -> master key -> current data key.
 *
 * Asserts CORRECT behaviour: a recovery key the passphrase holder never set up is refused
 * (the device locks with an error, or never wraps a key to it), so the server never
 * obtains a data key.
 */
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { MemoryKeyCache } from '../../src/encryption/key-cache'
import type { WrappedKeyRecord } from '../../src/encryption/key-record'
import type { KeyServiceChannel, KeyServiceReply } from '../../src/encryption/keyring'
import { EncryptionKeyring } from '../../src/encryption/keyring'
import {
	generateMasterKey,
	generateRecoveryKeyPair,
	importMasterKey,
	unwrapDataKey,
	unwrapMasterWithRecovery,
	wrapMasterForRecovery,
} from '../../src/encryption/keyring-crypto'
import { SyncEncryptor } from '../../src/encryption/sync-encryptor'

const ITERATIONS = 1000

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T
}

/** An honest key store plus a hook that lets the "server" rewrite what it serves. */
class MaliciousKeyServer {
	record: WrappedKeyRecord | null = null
	/** When set, the next put is answered `conflict` with this record (and it is stored). */
	forceConflictWith: WrappedKeyRecord | null = null

	channel(): KeyServiceChannel {
		return {
			fetch: async () => ({ status: 'ok', record: clone(this.record) }),
			put: async (_keyring, record, expectedRevision): Promise<KeyServiceReply> => {
				if (this.forceConflictWith) {
					this.record = clone(this.forceConflictWith)
					this.forceConflictWith = null
					return { status: 'conflict', record: clone(this.record) }
				}
				if ((this.record?.revision ?? 0) !== expectedRevision) {
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

type Attacker = Awaited<ReturnType<typeof generateRecoveryKeyPair>>

/**
 * The server's recovery block: it cannot open the real master key, so it wraps bytes of
 * its own to its own public key, hoping a device re-wraps the real one to that key.
 */
async function forgedRecovery(
	record: WrappedKeyRecord,
	attacker: Attacker,
): Promise<NonNullable<WrappedKeyRecord['recovery']>> {
	return wrapMasterForRecovery(
		generateMasterKey(),
		attacker.publicKey,
		record.keyring,
		record.ringId,
	)
}

/** What the server can read with its own recovery private key, or null. */
async function serverSteals(
	record: WrappedKeyRecord,
	attacker: Attacker,
	sealed: Operation,
): Promise<string | null> {
	const recovery = record.recovery
	const current = record.keys.find((k) => k.keyVersion === record.currentVersion)
	if (!recovery || !current) return null
	if (recovery.publicKey.x !== attacker.publicKey.x) return null
	try {
		const raw = await unwrapMasterWithRecovery(
			recovery,
			attacker.recoveryKey,
			record.keyring,
			record.ringId,
		)
		const master = await importMasterKey(raw)
		const dataKey = await unwrapDataKey(current, master.wrapKey, record.keyring)
		const stolen = SyncEncryptor.fromKeys([
			{ version: current.keyVersion, keyId: current.keyId, key: dataKey },
		])
		const plain = await stolen.decryptOperation(sealed)
		return String((plain.data as { body: string }).body)
	} catch {
		return null
	}
}

describe('RT-95: unauthenticated recovery public key lets the server obtain data keys', () => {
	test('a recovery key injected through a push is never used to wrap a key', async () => {
		const server = new MaliciousKeyServer()
		const device = new EncryptionKeyring({
			passphrase: 'correct horse',
			kdfIterations: ITERATIONS,
			cache: new MemoryKeyCache(),
		})
		expect(await device.synchronize(server.channel(), 'alice')).toBe('ready')

		// The server pushes a record with a recovery block for ITS public key, but keeps
		// storing the honest record so the device's next write succeeds.
		const attacker = await generateRecoveryKeyPair()
		const current = server.record as WrappedKeyRecord
		const forged: WrappedKeyRecord = {
			...clone(current),
			revision: current.revision + 1,
			recovery: await forgedRecovery(current, attacker),
		}
		await device.adoptPushed(clone(forged))

		// Routine key management on the honest device.
		await device.rotate(server.channel()).catch(() => undefined)
		await device.changePassphrase('battery staple', server.channel()).catch(() => undefined)
		const encryptor = device.getEncryptor()
		const sealed = encryptor ? await encryptor.encryptOperation(op('after-rotation')) : null

		const stolen =
			sealed && server.record ? await serverSteals(server.record, attacker, sealed) : null
		expect(stolen).toBeNull()
	})

	test('a recovery key served on fetch to a device that opens the record is refused', async () => {
		const server = new MaliciousKeyServer()
		const first = new EncryptionKeyring({
			passphrase: 'correct horse',
			kdfIterations: ITERATIONS,
			cache: new MemoryKeyCache(),
		})
		expect(await first.synchronize(server.channel(), 'alice')).toBe('ready')
		const attacker = await generateRecoveryKeyPair()
		const current = server.record as WrappedKeyRecord
		server.record = {
			...clone(current),
			revision: current.revision + 1,
			recovery: await forgedRecovery(current, attacker),
		}
		// A new device with the passphrase opens the forged record, then manages keys.
		const second = new EncryptionKeyring({
			passphrase: 'correct horse',
			kdfIterations: ITERATIONS,
			cache: new MemoryKeyCache(),
		})
		await second.synchronize(server.channel(), 'alice')
		await second.rotate(server.channel()).catch(() => undefined)
		await second.changePassphrase('battery staple', server.channel()).catch(() => undefined)
		const encryptor = second.getEncryptor() ?? first.getEncryptor()
		const sealed = encryptor ? await encryptor.encryptOperation(op('after-fetch')) : null

		const stolen =
			sealed && server.record ? await serverSteals(server.record, attacker, sealed) : null
		expect(stolen).toBeNull()
	})

	test('a recovery key swapped in through the rotation conflict reply is never used', async () => {
		const server = new MaliciousKeyServer()
		const device = new EncryptionKeyring({
			passphrase: 'correct horse',
			kdfIterations: ITERATIONS,
			cache: new MemoryKeyCache(),
		})
		expect(await device.synchronize(server.channel(), 'alice')).toBe('ready')
		// The user set up a genuine recovery key.
		await device.enableRecovery(server.channel())

		const attacker = await generateRecoveryKeyPair()
		const current = server.record as WrappedKeyRecord
		// Same versions, recovery public key replaced.
		server.forceConflictWith = {
			...clone(current),
			revision: current.revision + 1,
			recovery: await forgedRecovery(current, attacker),
		}
		await device.rotate(server.channel()).catch(() => undefined)
		// The server restores the honest record so the next writes go through.
		server.record = clone(current)
		await device.rotate(server.channel()).catch(() => undefined)
		await device.changePassphrase('battery staple', server.channel()).catch(() => undefined)
		const encryptor = device.getEncryptor()
		const sealed = encryptor ? await encryptor.encryptOperation(op('after-conflict')) : null

		const stolen =
			sealed && server.record ? await serverSteals(server.record, attacker, sealed) : null
		expect(stolen).toBeNull()
	})
})
