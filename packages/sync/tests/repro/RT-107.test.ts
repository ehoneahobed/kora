/**
 * RT-107 repro (final verification round, ENC-1 key ring): "change the passphrase, then
 * rotate" did not contain a leaked passphrase against the sync server.
 *
 * The attacker is the sync server operator (or whoever compromised it) who also learned
 * the OLD passphrase. The server keeps the old record, so the old passphrase opens the
 * old master key M1 and every data key of that time.
 *
 * (1) Every device other than the one that changed the passphrase still holds M1, and
 *     the server decides what it forwards: it seals a successor under M1 that adds a data
 *     key of its own. A device that only holds M1 has no secret the attacker lacks, so it
 *     cannot tell such a record from a genuine one: this is inherent to a shared-secret
 *     ring (observation below, documented in the guide and the `changePassphrase` JSDoc).
 *     The fix: a passphrase change lists the old master key in the record's
 *     `retiredMasters` (authenticated under the new master), and a device that accepted
 *     such a record refuses every record authenticated only by a retired master, however
 *     it was opened (held master key, a stale configured passphrase, the old passphrase
 *     typed again), across restarts. The guide's procedure therefore re-unlocks every
 *     device with the new passphrase.
 *
 * (2) The `kora-rk2-` recovery anchor fingerprinted the ring's FIRST data key, which the
 *     old passphrase opens. The fix (`kora-rk3-`): `enableRecovery()` creates a new data
 *     key version under the current master in the same write and anchors the recovery
 *     key to it (HMAC keyed by that key over keyring, ring id, key id and the recovery
 *     public key). No older passphrase ever opened it, so a ring built with the old
 *     passphrase never matches. `kora-rk2-` keys are refused. A recovery key made BEFORE
 *     the leak stays steerable (inherent: everything it can check was known to the old
 *     passphrase holder), so the guide says to call `enableRecovery()` again after a leak.
 */
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { MemoryKeyCache } from '../../src/encryption/key-cache'
import type { WrappedDataKey, WrappedKeyRecord } from '../../src/encryption/key-record'
import { isKeyRecordSuccessor, validateKeyRecord } from '../../src/encryption/key-record'
import type { KeyServiceChannel, KeyServiceReply } from '../../src/encryption/keyring'
import { EncryptionKeyring } from '../../src/encryption/keyring'
import type { MasterKeys } from '../../src/encryption/keyring-crypto'
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

/** Applies the sync server's write rules; the test plays the malicious server around it. */
class KeyServer {
	record: WrappedKeyRecord | null = null
	channel(): KeyServiceChannel {
		return {
			fetch: async () => ({ status: 'ok', record: clone(this.record) }),
			put: async (keyring, record, expectedRevision): Promise<KeyServiceReply> => {
				if (!validateKeyRecord(record, keyring).ok) throw new Error('invalid record')
				if ((this.record?.revision ?? 0) !== expectedRevision) {
					return { status: 'conflict', record: clone(this.record) }
				}
				if (!isKeyRecordSuccessor(this.record, record).ok) throw new Error('not a successor')
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

function device(passphrase?: string, cache = new MemoryKeyCache()): EncryptionKeyring {
	return new EncryptionKeyring({
		...(passphrase !== undefined ? { passphrase } : {}),
		kdfIterations: ITERATIONS,
		cache,
	})
}

/** The attacker opens the OLD record with the leaked passphrase. */
async function openOld(record: WrappedKeyRecord, passphrase: string): Promise<MasterKeys> {
	const kek = await deriveKeyEncryptionKey(
		passphrase,
		fromBase64(record.kdf.salt),
		record.kdf.iterations,
	)
	const raw = await unwrapMasterKey(record.master, kek, record.keyring, record.ringId)
	return importMasterKey(raw)
}

/** What the attacker reads of an operation sealed under its key, or null. */
async function stolenWith(
	keyring: EncryptionKeyring,
	key: CryptoKey,
	keyId: string,
	version: number,
): Promise<unknown> {
	const encryptor = keyring.getEncryptor()
	if (encryptor === null) return null
	const sealed = await encryptor.encryptOperation(op(`o-${keyId}`))
	return SyncEncryptor.fromKeys([{ version, key, keyId }])
		.decryptOperation(sealed)
		.then(
			(opened) => opened.data,
			() => null,
		)
}

/**
 * The attacker's successor under the OLD master: every key it knows plus one of its own
 * as the current version, above the honest revision.
 */
async function forgeUnderOldMaster(
	oldRecord: WrappedKeyRecord,
	m1: MasterKeys,
	revision: number,
): Promise<{ forged: WrappedKeyRecord; key: CryptoKey; keyId: string; version: number }> {
	const key = await generateDataKey()
	const keyId = newKeyId()
	const version = oldRecord.currentVersion + 1
	const forged = await sealRecord(
		{
			...oldRecord,
			revision,
			currentVersion: version,
			keys: [
				...oldRecord.keys,
				await wrapDataKey(key, m1.wrapKey, oldRecord.keyring, version, keyId),
			],
		},
		m1.macKey,
	)
	return { forged, key, keyId, version }
}

describe('RT-107 (1): a leaked passphrase and a passphrase change', () => {
	test('observation (inherent): a device that only ever held the old master cannot tell a forged record', async () => {
		const server = new KeyServer()
		const deviceA = device('leaked passphrase')
		const deviceB = device('leaked passphrase')
		await deviceA.synchronize(server.channel(), 'alice')
		await deviceB.synchronize(server.channel(), 'alice')
		const oldRecord = clone(server.record as WrappedKeyRecord)
		await deviceA.changePassphrase('new passphrase', server.channel())
		await deviceA.rotate(server.channel())
		const honest = server.record as WrappedKeyRecord

		// B is never given the new record and is never re-unlocked: it holds no secret the
		// attacker lacks. The guide and the changePassphrase JSDoc say exactly this.
		const m1 = await openOld(oldRecord, 'leaked passphrase')
		const attack = await forgeUnderOldMaster(oldRecord, m1, honest.revision)
		await deviceB.adoptPushed(attack.forged)
		expect(await stolenWith(deviceB, attack.key, attack.keyId, attack.version)).not.toBeNull()
	})

	test('after change + rotate + re-unlock, a record forged under the old master is refused on every path', async () => {
		const server = new KeyServer()
		const cache = new MemoryKeyCache()
		const deviceA = device('leaked passphrase')
		// B keeps the OLD passphrase configured (an app that did not update its `key`).
		const deviceB = device('leaked passphrase', cache)
		await deviceA.synchronize(server.channel(), 'alice')
		await deviceB.synchronize(server.channel(), 'alice')
		const oldRecord = clone(server.record as WrappedKeyRecord)

		// The guide's procedure: change, rotate, then re-unlock every other device.
		await deviceA.changePassphrase('new passphrase', server.channel())
		await deviceA.rotate(server.channel())
		await deviceB.lock()
		await deviceB.unlock('new passphrase', server.channel())
		const honest = clone(server.record as WrappedKeyRecord)
		expect(honest.retiredMasters).toHaveLength(1)
		const honestKeyId = deviceB.getStatus().keyId

		const m1 = await openOld(oldRecord, 'leaked passphrase')
		const attack = await forgeUnderOldMaster(oldRecord, m1, honest.revision + 1)

		// Pushed: the stale configured passphrase opens it, and it is refused.
		expect(await deviceB.adoptPushed(clone(attack.forged))).toBe('locked')
		expect(deviceB.getStatus().code).toBe('KEY_RECORD_INVALID')
		expect(await stolenWith(deviceB, attack.key, attack.keyId, attack.version)).toBeNull()

		// Served on fetch at the next handshake: refused, the honest keys stay in use.
		server.record = clone(attack.forged)
		expect(await deviceB.synchronize(server.channel(), 'alice')).toBe('locked')
		expect(deviceB.getStatus().code).toBe('KEY_RECORD_INVALID')

		// The user types the old passphrase by habit: refused as well.
		await expect(deviceB.unlock('leaked passphrase', server.channel())).rejects.toMatchObject({
			context: expect.objectContaining({ code: 'KEY_RECORD_INVALID' }),
		})
		expect(await stolenWith(deviceB, attack.key, attack.keyId, attack.version)).toBeNull()

		// After a restart (persistent cache) the retired master is still refused.
		const restarted = device('leaked passphrase', cache)
		await restarted.load('alice')
		expect(restarted.getStatus().keyId).toBe(honestKeyId)
		expect(await restarted.synchronize(server.channel(), 'alice')).toBe('locked')
		expect(await stolenWith(restarted, attack.key, attack.keyId, attack.version)).toBeNull()

		// And the honest record is adopted again once the server serves it.
		server.record = honest
		expect(await restarted.synchronize(server.channel(), 'alice')).toBe('ready')
		expect(restarted.getStatus().keyId).toBe(honestKeyId)
	})

	test('the server cannot drop a retired master from the record', () => {
		const record = { retiredMasters: ['m-00000000000000000000000000000001'] }
		const base = { ringId: 'r-1', revision: 2, keys: [] } as unknown as WrappedKeyRecord
		const dropped = { ...base, revision: 3 } as WrappedKeyRecord
		expect(isKeyRecordSuccessor({ ...base, ...record }, dropped).ok).toBe(false)
		expect(isKeyRecordSuccessor({ ...base, ...record }, { ...dropped, ...record }).ok).toBe(true)
	})
})

describe('RT-107 (2): the recovery anchor', () => {
	async function attackerRing(
		oldRecord: WrappedKeyRecord,
		m1: MasterKeys,
		recoveryPublicKey: { x: string; y: string },
		revision: number,
	): Promise<{ forged: WrappedKeyRecord; key: CryptoKey; keyId: string; version: number }> {
		// Every data key the old passphrase opens, re-wrapped under a master of the
		// attacker's, plus one of its own, wrapped to the user's recovery PUBLIC key.
		const raw = generateMasterKey()
		const master = await importMasterKey(raw.slice())
		const keys: WrappedDataKey[] = []
		for (const entry of oldRecord.keys) {
			const dataKey = await unwrapDataKey(entry, m1.wrapKey, oldRecord.keyring, true)
			keys.push(
				await wrapDataKey(
					dataKey,
					master.wrapKey,
					oldRecord.keyring,
					entry.keyVersion,
					entry.keyId,
				),
			)
		}
		const key = await generateDataKey()
		const keyId = newKeyId()
		const version = oldRecord.currentVersion + 1
		keys.push(await wrapDataKey(key, master.wrapKey, oldRecord.keyring, version, keyId))
		const forged = await sealRecord(
			{
				...oldRecord,
				revision,
				currentVersion: version,
				keys,
				recovery: await wrapMasterForRecovery(
					raw,
					recoveryPublicKey,
					oldRecord.keyring,
					oldRecord.ringId,
				),
			},
			master.macKey,
		)
		return { forged, key, keyId, version }
	}

	test('after change + rotate + enableRecovery, recovery refuses a ring built with the old passphrase', async () => {
		const server = new KeyServer()
		const deviceA = device('leaked passphrase')
		await deviceA.synchronize(server.channel(), 'alice')
		await deviceA.enableRecovery(server.channel())
		const oldRecord = clone(server.record as WrappedKeyRecord)

		await deviceA.changePassphrase('new passphrase', server.channel())
		await deviceA.rotate(server.channel())
		const recoveryKey = await deviceA.enableRecovery(server.channel())
		expect(recoveryKey).toMatch(/^kora-rk3-/)
		const honest = clone(server.record as WrappedKeyRecord)
		const publicKey = (honest.recovery as NonNullable<WrappedKeyRecord['recovery']>).publicKey

		const m1 = await openOld(oldRecord, 'leaked passphrase')
		const attack = await attackerRing(oldRecord, m1, publicKey, honest.revision + 1)
		server.record = attack.forged

		const deviceC = device()
		await deviceC.load('alice')
		await expect(
			deviceC.recover(recoveryKey, 'third passphrase', server.channel()),
		).rejects.toMatchObject({ context: expect.objectContaining({ code: 'KEY_RECORD_INVALID' }) })
		expect(deviceC.getEncryptor()).toBeNull()
		expect(await stolenWith(deviceC, attack.key, attack.keyId, attack.version)).toBeNull()

		// The genuine ring recovers with the same key.
		server.record = honest
		await deviceC.recover(recoveryKey, 'third passphrase', server.channel())
		expect(deviceC.getStatus().state).toBe('unlocked')
	})

	test('release-candidate kora-rk2- recovery keys are refused with a clear error', async () => {
		const server = new KeyServer()
		const deviceA = device('pass')
		await deviceA.synchronize(server.channel(), 'alice')
		await deviceA.enableRecovery(server.channel())
		const fresh = device()
		await fresh.load('alice')
		await expect(
			fresh.recover(
				'kora-rk2-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA',
				'new',
				server.channel(),
			),
		).rejects.toMatchObject({
			context: expect.objectContaining({
				code: 'WRONG_RECOVERY_KEY',
				reason: 'RECOVERY_KEY_RETIRED',
			}),
		})
	})

	test('observation (inherent): a recovery key made before the leak can be steered by the old passphrase holder', async () => {
		const server = new KeyServer()
		const deviceA = device('leaked passphrase')
		await deviceA.synchronize(server.channel(), 'alice')
		const preLeakKey = await deviceA.enableRecovery(server.channel())
		const oldRecord = clone(server.record as WrappedKeyRecord)
		await deviceA.changePassphrase('new passphrase', server.channel())
		await deviceA.rotate(server.channel())
		const honest = server.record as WrappedKeyRecord
		const publicKey = (oldRecord.recovery as NonNullable<WrappedKeyRecord['recovery']>).publicKey

		// Its anchor key was opened by the old passphrase: the guide says to call
		// enableRecovery() again after a leak and destroy the old recovery key.
		const m1 = await openOld(oldRecord, 'leaked passphrase')
		const attack = await attackerRing(oldRecord, m1, publicKey, honest.revision + 1)
		server.record = attack.forged
		const deviceC = device()
		await deviceC.load('alice')
		await deviceC.recover(preLeakKey, 'third passphrase', server.channel())
		expect(await stolenWith(deviceC, attack.key, attack.keyId, attack.version)).not.toBeNull()
	})
})
