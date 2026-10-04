/**
 * RT-107 repro (final verification round, ENC-1 key ring): "change the passphrase, then
 * rotate" does not contain a leaked passphrase against the sync server.
 *
 * The guide (`docs/guide/sync-encryption.md`, Passphrase change) says: "the old passphrase
 * (and the old master key it opened) can neither open nor authenticate any later record
 * ... After a suspected leak, change the passphrase and then rotate: only a rotation gives
 * new operations a key the leaked passphrase never reached."
 *
 * The attacker here is the sync server operator (or whoever compromised it) who also
 * learned the old passphrase. The server stores the old record, so the old passphrase
 * opens the OLD master key M1. Every device other than the one that changed the
 * passphrase still holds M1 (the server decides what they receive and simply never
 * forwards the new record). The attacker seals a successor revision under M1 that adds
 * a data key of its own as the current version; such a device authenticates it with the
 * held M1, adopts it, and seals every new operation under the attacker's key.
 *
 * The recovery anchor has the same hole: the anchor fingerprints the ring's FIRST data
 * key, which the old passphrase opens. A record under an attacker master wrapped to the
 * (public) recovery key, re-wrapping that first data key, passes `holdsAnchor`: a device
 * recovering after a lost passphrase adopts the attacker's ring.
 *
 * Asserts CORRECT behaviour: after the change-and-rotate the guide prescribes, no device
 * encrypts a new operation under a key the old passphrase holder knows. (If the design
 * accepts this as inherent, the guide must say instead that every device must be
 * re-unlocked with the new passphrase, or a new keyring started, and this file becomes an
 * observation.)
 */
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { MemoryKeyCache } from '../../src/encryption/key-cache'
import type { WrappedKeyRecord } from '../../src/encryption/key-record'
import type { KeyServiceChannel, KeyServiceReply } from '../../src/encryption/keyring'
import { EncryptionKeyring } from '../../src/encryption/keyring'
import {
	deriveKeyEncryptionKey,
	fromBase64,
	generateDataKey,
	generateMasterKey,
	importMasterKey,
	newKeyId,
	sealRecord,
	unwrapDataKey,
	unwrapMasterKey,
	wrapDataKey,
	wrapMasterForRecovery,
} from '../../src/encryption/keyring-crypto'
import { SyncEncryptor } from '../../src/encryption/sync-encryptor'

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

/** The attacker opens the OLD record with the leaked passphrase. */
async function openOld(record: WrappedKeyRecord, passphrase: string) {
	const kek = await deriveKeyEncryptionKey(
		passphrase,
		fromBase64(record.kdf.salt),
		record.kdf.iterations,
	)
	const raw = await unwrapMasterKey(record.master, kek, record.keyring, record.ringId)
	return importMasterKey(raw)
}

async function tryDecrypt(sealed: Operation, key: CryptoKey, keyId: string, version: number) {
	const enc = SyncEncryptor.fromKeys([{ version, key, keyId }])
	return enc.decryptOperation(sealed).then(
		(opened) => opened.data,
		() => null,
	)
}

describe('RT-107: a leaked passphrase is not contained by change + rotate', () => {
	test('a device still holding the old master adopts a server-forged key under it', async () => {
		const server = new KeyServer()
		const deviceA = new EncryptionKeyring({
			passphrase: 'leaked passphrase',
			kdfIterations: ITERATIONS,
			cache: new MemoryKeyCache(),
		})
		const deviceB = new EncryptionKeyring({
			passphrase: 'leaked passphrase',
			kdfIterations: ITERATIONS,
			cache: new MemoryKeyCache(),
		})
		expect(await deviceA.synchronize(server.channel(), 'alice')).toBe('ready')
		expect(await deviceB.synchronize(server.channel(), 'alice')).toBe('ready')
		const oldRecord = clone(server.record as WrappedKeyRecord)

		// The user learns of the leak and does what the guide says, on device A.
		await deviceA.changePassphrase('new passphrase', server.channel())
		await deviceA.rotate(server.channel())
		const honest = server.record as WrappedKeyRecord

		// The server never forwards that record to B. It forges one under the OLD master.
		const m1 = await openOld(oldRecord, 'leaked passphrase')
		const attackerKey = await generateDataKey()
		const attackerKeyId = newKeyId()
		const version = honest.currentVersion
		const forged = await sealRecord(
			{
				...oldRecord,
				revision: honest.revision,
				currentVersion: version,
				keys: [
					...oldRecord.keys,
					...(await Promise.all(
						Array.from({ length: version - oldRecord.currentVersion - 1 }, async (_, i) =>
							wrapDataKey(
								await generateDataKey(),
								m1.wrapKey,
								oldRecord.keyring,
								oldRecord.currentVersion + 1 + i,
								newKeyId(),
							),
						),
					)),
					await wrapDataKey(attackerKey, m1.wrapKey, oldRecord.keyring, version, attackerKeyId),
				],
			},
			m1.macKey,
		)
		await deviceB.adoptPushed(forged)

		const encryptor = deviceB.getEncryptor()
		const sealed = encryptor ? await encryptor.encryptOperation(op('o1')) : null
		const stolen = sealed ? await tryDecrypt(sealed, attackerKey, attackerKeyId, version) : null
		// Correct: B never seals a new operation under a key the attacker made.
		expect(stolen).toBeNull()
	})

	test('recovery accepts an attacker ring that re-wraps the first data key (anchor)', async () => {
		const server = new KeyServer()
		const deviceA = new EncryptionKeyring({
			passphrase: 'leaked passphrase',
			kdfIterations: ITERATIONS,
			cache: new MemoryKeyCache(),
		})
		await deviceA.synchronize(server.channel(), 'alice')
		const recoveryKey = await deviceA.enableRecovery(server.channel())
		const oldRecord = clone(server.record as WrappedKeyRecord)
		await deviceA.changePassphrase('new passphrase', server.channel())
		await deviceA.rotate(server.channel())

		// Attacker: old passphrase -> M1 -> first data key (the anchor's key).
		const m1 = await openOld(oldRecord, 'leaked passphrase')
		const first = oldRecord.keys[0] as WrappedKeyRecord['keys'][number]
		const firstKey = await unwrapDataKey(first, m1.wrapKey, oldRecord.keyring, true)
		// A fresh ring of the attacker's own, wrapped to the user's (public) recovery key.
		const rawAttacker = generateMasterKey()
		const attackerMaster = await importMasterKey(rawAttacker.slice())
		const attackerKey = await generateDataKey()
		const attackerKeyId = newKeyId()
		const recovery = oldRecord.recovery as NonNullable<WrappedKeyRecord['recovery']>
		const forged = await sealRecord(
			{
				...oldRecord,
				revision: (server.record as WrappedKeyRecord).revision + 1,
				currentVersion: 2,
				keys: [
					await wrapDataKey(firstKey, attackerMaster.wrapKey, oldRecord.keyring, 1, first.keyId),
					await wrapDataKey(
						attackerKey,
						attackerMaster.wrapKey,
						oldRecord.keyring,
						2,
						attackerKeyId,
					),
				],
				recovery: await wrapMasterForRecovery(
					rawAttacker,
					recovery.publicKey,
					oldRecord.keyring,
					oldRecord.ringId,
				),
			},
			attackerMaster.macKey,
		)
		server.record = forged

		// The user lost the passphrase and recovers on a new device.
		const deviceC = new EncryptionKeyring({
			kdfIterations: ITERATIONS,
			cache: new MemoryKeyCache(),
		})
		await deviceC.load('alice')
		await deviceC.recover(recoveryKey, 'third passphrase', server.channel()).catch(() => undefined)

		const encryptor = deviceC.getEncryptor()
		const sealed = encryptor ? await encryptor.encryptOperation(op('o2')) : null
		const stolen = sealed ? await tryDecrypt(sealed, attackerKey, attackerKeyId, 2) : null
		expect(stolen).toBeNull()
	})
})
