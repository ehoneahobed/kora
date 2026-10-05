import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { MemoryKeyCache } from './key-cache'
import type { WrappedKeyRecord } from './key-record'
import { isKeyRecordSuccessor, validateKeyRecord } from './key-record'
import type { KeyServiceChannel, KeyServiceReply } from './keyring'
import { EncryptionKeyError, EncryptionKeyring } from './keyring'

/** Low PBKDF2 cost keeps the real crypto path while the suite stays fast. */
const ITERATIONS = 1000

/**
 * The server side of the key service, in memory, with the same rules the sync server
 * enforces: compare-and-set on the revision and append-only key versions.
 */
class FakeKeyServer {
	readonly records = new Map<string, WrappedKeyRecord>()
	fetches = 0
	puts = 0

	channel(owner: string): KeyServiceChannel {
		return {
			fetch: async (keyring) => {
				this.fetches++
				return { status: 'ok', record: this.clone(this.records.get(`${owner}/${keyring}`)) }
			},
			put: async (keyring, record, expectedRevision): Promise<KeyServiceReply> => {
				this.puts++
				const key = `${owner}/${keyring}`
				const current = this.records.get(key) ?? null
				expect(validateKeyRecord(record, keyring)).toEqual({ ok: true })
				if ((current?.revision ?? 0) !== expectedRevision) {
					return { status: 'conflict', record: this.clone(current ?? undefined) }
				}
				expect(isKeyRecordSuccessor(current, record)).toEqual({ ok: true })
				this.records.set(key, this.clone(record) as WrappedKeyRecord)
				return { status: 'ok', record: this.clone(record) }
			},
		}
	}

	private clone(record: WrappedKeyRecord | undefined): WrappedKeyRecord | null {
		return record ? (JSON.parse(JSON.stringify(record)) as WrappedKeyRecord) : null
	}
}

function device(
	passphrase?: string,
	options: { cache?: MemoryKeyCache; kdfIterations?: number } = {},
): EncryptionKeyring {
	return new EncryptionKeyring({
		...(passphrase !== undefined ? { passphrase } : {}),
		kdfIterations: options.kdfIterations ?? ITERATIONS,
		cache: options.cache ?? new MemoryKeyCache(),
	})
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

async function seal(keyring: EncryptionKeyring, operation: Operation): Promise<Operation> {
	const encryptor = keyring.getEncryptor()
	if (!encryptor) throw new Error('locked')
	return encryptor.encryptOperation(operation)
}

async function open(keyring: EncryptionKeyring, operation: Operation): Promise<Operation> {
	const encryptor = keyring.getEncryptor()
	if (!encryptor) throw new Error('locked')
	return encryptor.decryptOperation(operation)
}

describe('EncryptionKeyring: shared key material (ENC-1)', () => {
	test('the first device creates the record; a second device with the passphrase opens the same keys', async () => {
		const server = new FakeKeyServer()
		const a = device('correct horse')
		const b = device('correct horse')
		expect(await a.synchronize(server.channel('u:alice'), 'alice')).toBe('ready')
		expect(await b.synchronize(server.channel('u:alice'), 'alice')).toBe('ready')
		expect(server.records.size).toBe(1)
		expect(a.getStatus()).toMatchObject({ state: 'unlocked', keyVersion: 1 })
		expect(b.getStatus().keyId).toBe(a.getStatus().keyId)

		const sealed = await seal(a, op('1'))
		expect(JSON.stringify(sealed)).not.toContain('secret')
		expect(sealed.encrypted?.keyId).toBe(a.getStatus().keyId)
		expect((await open(b, sealed)).data).toEqual({ body: 'secret 1' })
	})

	test('the server stores no passphrase and no usable key', async () => {
		const server = new FakeKeyServer()
		const a = device('a very secret passphrase')
		await a.synchronize(server.channel('u:alice'), 'alice')
		const stored = JSON.stringify([...server.records.values()])
		expect(stored).not.toContain('a very secret passphrase')
		const record = [...server.records.values()][0] as WrappedKeyRecord
		expect(Object.keys(record).sort()).toEqual(
			[
				'currentVersion',
				'format',
				'kdf',
				'keyring',
				'keys',
				'mac',
				'master',
				'revision',
				'ringId',
			].sort(),
		)
		expect(Object.keys(record.keys[0] ?? {}).sort()).toEqual(
			['iv', 'keyId', 'keyVersion', 'wrappedKey'].sort(),
		)
		expect(record.kdf).toMatchObject({ name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS })
	})

	test('the data keys a device keeps are non-extractable', async () => {
		const server = new FakeKeyServer()
		const cache = new MemoryKeyCache()
		const a = device('p', { cache })
		await a.synchronize(server.channel('u:alice'), 'alice')
		const cached = await cache.load('alice\u0000default')
		expect(cached?.keys).toHaveLength(1)
		expect(cached?.keys[0]?.key.extractable).toBe(false)
		expect(cached?.kek?.extractable).toBe(false)
		await expect(
			globalThis.crypto.subtle.exportKey('raw', cached?.keys[0]?.key as CryptoKey),
		).rejects.toThrow()
	})

	test('two devices racing to create the first key converge on one (compare-and-set)', async () => {
		const server = new FakeKeyServer()
		const a = device('p')
		const b = device('p')
		const [ra, rb] = await Promise.all([
			a.synchronize(server.channel('u:alice'), 'alice'),
			b.synchronize(server.channel('u:alice'), 'alice'),
		])
		expect([ra, rb]).toEqual(['ready', 'ready'])
		expect(a.getStatus().keyId).toBe(b.getStatus().keyId)
		expect((await open(b, await seal(a, op('race')))).data).toEqual({ body: 'secret race' })
	})

	test('different users have different keyrings', async () => {
		const server = new FakeKeyServer()
		const alice = device('p')
		const bob = device('p')
		await alice.synchronize(server.channel('u:alice'), 'alice')
		await bob.synchronize(server.channel('u:bob'), 'bob')
		expect(alice.getStatus().keyId).not.toBe(bob.getStatus().keyId)
		await expect(open(bob, await seal(alice, op('x')))).rejects.toThrow(
			/KEY_ID_MISMATCH|key material/,
		)
	})
})

describe('EncryptionKeyring: lock state and passphrases', () => {
	test('without a passphrase the keyring is locked and cannot connect', async () => {
		const server = new FakeKeyServer()
		const k = device()
		await k.load('alice')
		expect(k.canConnect()).toBe(false)
		expect(k.getStatus()).toMatchObject({ state: 'locked', code: 'NO_PASSPHRASE' })
		expect(await k.synchronize(server.channel('u:alice'), 'alice')).toBe('locked')
		expect(server.records.size).toBe(0)
		expect(k.getEncryptor()).toBeNull()
	})

	test('a wrong passphrase is refused and leaves the device locked', async () => {
		const server = new FakeKeyServer()
		await device('right').synchronize(server.channel('u:alice'), 'alice')
		const k = device('wrong')
		expect(await k.synchronize(server.channel('u:alice'), 'alice')).toBe('locked')
		expect(k.getStatus()).toMatchObject({ state: 'error', code: 'WRONG_PASSPHRASE' })
		expect(k.getEncryptor()).toBeNull()

		const status = await k.unlock('right', server.channel('u:alice'))
		expect(status.state).toBe('unlocked')
	})

	test('unlock() rejects a wrong passphrase and backs off after three failures', async () => {
		const server = new FakeKeyServer()
		await device('right').synchronize(server.channel('u:alice'), 'alice')
		const k = device()
		await k.load('alice')
		for (let i = 0; i < 4; i++) {
			await expect(k.unlock(`wrong-${i}`, server.channel('u:alice'))).rejects.toThrow(
				EncryptionKeyError,
			)
		}
		await expect(k.unlock('right', server.channel('u:alice'))).rejects.toMatchObject({
			context: expect.objectContaining({ code: 'UNLOCK_THROTTLED' }),
		})
	})

	test('a cached record unlocks offline; a device that unlocked once restarts unlocked', async () => {
		const server = new FakeKeyServer()
		const cache = new MemoryKeyCache()
		const first = device('p', { cache })
		await first.synchronize(server.channel('u:alice'), 'alice')
		const sealed = await seal(first, op('offline'))

		// Restart: keys come from the cache, no server needed.
		const restarted = device(undefined, { cache })
		await restarted.load('alice')
		expect(restarted.getStatus().state).toBe('unlocked')
		expect((await open(restarted, sealed)).data).toEqual({ body: 'secret offline' })

		// Lock keeps only the wrapped record: unlock works offline (no channel) from it.
		await restarted.lock()
		expect(restarted.getStatus()).toMatchObject({ state: 'locked', code: 'LOCKED_BY_APP' })
		expect(restarted.canConnect()).toBe(false)
		await expect(restarted.unlock('nope', null)).rejects.toThrow(EncryptionKeyError)
		const status = await restarted.unlock('p', null)
		expect(status.state).toBe('unlocked')
		expect(server.fetches).toBe(1)
	})

	test('unlock() with no record known waits for the server (AWAITING_SERVER)', async () => {
		const server = new FakeKeyServer()
		await device('p').synchronize(server.channel('u:alice'), 'alice')
		const k = device()
		await k.load('alice')
		expect((await k.unlock('p', null)).code).toBe('AWAITING_SERVER')
		expect(k.canConnect()).toBe(true)
		expect(await k.synchronize(server.channel('u:alice'), 'alice')).toBe('ready')
	})

	test('a principal change drops the previous user keys', async () => {
		const server = new FakeKeyServer()
		const cache = new MemoryKeyCache()
		const k = device('p', { cache })
		await k.synchronize(server.channel('u:alice'), 'alice')
		const aliceKey = k.getStatus().keyId
		await k.load('bob')
		expect(k.getEncryptor()).toBeNull()
		await k.synchronize(server.channel('u:bob'), 'bob')
		expect(k.getStatus().keyId).not.toBe(aliceKey)
	})
})

describe('EncryptionKeyring: rotation, passphrase change, recovery', () => {
	test('rotation adds a version: new ops use it, history still decrypts everywhere', async () => {
		const server = new FakeKeyServer()
		const a = device('p')
		const b = device('p')
		await a.synchronize(server.channel('u:alice'), 'alice')
		await b.synchronize(server.channel('u:alice'), 'alice')
		const old = await seal(a, op('v1'))

		await a.rotate(server.channel('u:alice'))
		expect(a.getStatus()).toMatchObject({ keyVersion: 2, availableVersions: [1, 2] })
		const fresh = await seal(a, op('v2'))
		expect(fresh.encrypted?.keyVersion).toBe(2)

		// b adopts the pushed record (it holds the KEK, so no passphrase prompt).
		const record = server.records.get('u:alice/default') as WrappedKeyRecord
		expect(await b.adoptPushed(record)).toBe('ready')
		expect((await open(b, fresh)).data).toEqual({ body: 'secret v2' })
		expect((await open(b, old)).data).toEqual({ body: 'secret v1' })
		// A newcomer opens both versions.
		const c = device('p')
		await c.synchronize(server.channel('u:alice'), 'alice')
		expect((await open(c, old)).data).toEqual({ body: 'secret v1' })
	})

	test('a passphrase change re-wraps without re-encrypting; old passphrase stops working', async () => {
		const server = new FakeKeyServer()
		const a = device('old')
		const b = device('old')
		await a.synchronize(server.channel('u:alice'), 'alice')
		await b.synchronize(server.channel('u:alice'), 'alice')
		const sealed = await seal(a, op('before'))

		await expect(
			a.changePassphrase('new', server.channel('u:alice'), 'not-the-old-one'),
		).rejects.toThrow(EncryptionKeyError)
		await a.changePassphrase('new', server.channel('u:alice'), 'old')
		const record = server.records.get('u:alice/default') as WrappedKeyRecord
		expect(record.keys[0]?.keyId).toBe(a.getStatus().keyId)

		// b keeps its data keys (no prompt) but its KEK is stale: rotation asks for it.
		expect(await b.adoptPushed(record)).toBe('ready')
		expect((await open(b, sealed)).data).toEqual({ body: 'secret before' })
		await expect(b.rotate(server.channel('u:alice'))).rejects.toMatchObject({
			context: expect.objectContaining({ code: 'PASSPHRASE_REQUIRED' }),
		})

		const withOld = device('old')
		expect(await withOld.synchronize(server.channel('u:alice'), 'alice')).toBe('locked')
		const withNew = device('new')
		expect(await withNew.synchronize(server.channel('u:alice'), 'alice')).toBe('ready')
		expect((await open(withNew, sealed)).data).toEqual({ body: 'secret before' })
	})

	test('a recovery key recovers every version after a lost passphrase', async () => {
		const server = new FakeKeyServer()
		const a = device('forgotten')
		await a.synchronize(server.channel('u:alice'), 'alice')
		const v1 = await seal(a, op('v1'))
		const recoveryKey = await a.enableRecovery(server.channel('u:alice'))
		expect(recoveryKey).toMatch(/^kora-rk3-[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{22}$/)
		await a.rotate(server.channel('u:alice')) // recovery wraps follow rotation
		const v2 = await seal(a, op('v2'))

		const fresh = device()
		await fresh.load('alice')
		await expect(
			fresh.recover(
				'kora-rk3-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA',
				'n',
				server.channel('u:alice'),
			),
		).rejects.toThrow()
		await fresh.recover(recoveryKey, 'brand new', server.channel('u:alice'))
		expect((await open(fresh, v1)).data).toEqual({ body: 'secret v1' })
		expect((await open(fresh, v2)).data).toEqual({ body: 'secret v2' })
		const later = device('brand new')
		expect(await later.synchronize(server.channel('u:alice'), 'alice')).toBe('ready')
	})

	test('without a recovery key, a lost passphrase is final', async () => {
		const server = new FakeKeyServer()
		await device('lost').synchronize(server.channel('u:alice'), 'alice')
		const k = device()
		await k.load('alice')
		await expect(k.recover('kora-rk3-x', 'n', server.channel('u:alice'))).rejects.toMatchObject({
			context: expect.objectContaining({ code: 'NO_RECOVERY_KEY' }),
		})
	})
})

describe('EncryptionKeyring: a hostile or broken server', () => {
	test('a rolled-back record is refused, the keys stay, and the newer record is re-uploaded', async () => {
		const server = new FakeKeyServer()
		const a = device('p')
		await a.synchronize(server.channel('u:alice'), 'alice')
		const before = server.records.get('u:alice/default') as WrappedKeyRecord
		await a.rotate(server.channel('u:alice'))
		const pinned = server.records.get('u:alice/default') as WrappedKeyRecord
		const codes: Array<string | undefined> = []
		a.onStatusChange((status) => codes.push(status.code))

		// Pushed (no connection to write to): refused and reported, keys kept.
		expect(await a.adoptPushed(before)).toBe('locked')
		expect(a.getStatus()).toMatchObject({ state: 'error', code: 'KEY_RECORD_ROLLBACK' })
		expect(a.isRetryableLock()).toBe(true)
		expect(a.getEncryptor()?.getCurrentKeyVersion()).toBe(2)

		// The next session re-uploads the pinned revision over the old one.
		server.records.set('u:alice/default', before)
		expect(await a.synchronize(server.channel('u:alice'), 'alice')).toBe('ready')
		expect(server.records.get('u:alice/default')).toEqual(pinned)
		expect(a.getStatus()).toMatchObject({ state: 'unlocked', keyVersion: 2 })
		expect(codes).toContain('KEY_RECORD_ROLLBACK')
	})

	test('a record with weaker KDF parameters than the app minimum is refused', async () => {
		const server = new FakeKeyServer()
		await device('p', { kdfIterations: 1000 }).synchronize(server.channel('u:alice'), 'alice')
		const strict = device('p', { kdfIterations: 2000 })
		expect(await strict.synchronize(server.channel('u:alice'), 'alice')).toBe('locked')
		expect(strict.getStatus().code).toBe('KEY_RECORD_INVALID')
	})

	test('a wrap relabelled to another version fails authentication (AAD binds version and key id)', async () => {
		const server = new FakeKeyServer()
		const a = device('p')
		await a.synchronize(server.channel('u:alice'), 'alice')
		await a.rotate(server.channel('u:alice'))
		const record = server.records.get('u:alice/default') as WrappedKeyRecord
		const [k1, k2] = record.keys
		if (!k1 || !k2) throw new Error('expected two versions')
		// Swap the wraps of v1 and v2, keeping their labels.
		server.records.set('u:alice/default', {
			...record,
			keys: [
				{ ...k1, iv: k2.iv, wrappedKey: k2.wrappedKey },
				{ ...k2, iv: k1.iv, wrappedKey: k1.wrappedKey },
			],
		})
		const b = device('p')
		expect(await b.synchronize(server.channel('u:alice'), 'alice')).toBe('locked')
		// The record MAC fails before any wrap is used.
		expect(b.getStatus().code).toBe('KEY_RECORD_INVALID')
		expect(b.getEncryptor()).toBeNull()
	})

	test('a server that lost the record gets the device copy back (no new key is forked)', async () => {
		const server = new FakeKeyServer()
		const a = device('p')
		await a.synchronize(server.channel('u:alice'), 'alice')
		const keyId = a.getStatus().keyId
		server.records.clear()
		expect(await a.synchronize(server.channel('u:alice'), 'alice')).toBe('ready')
		expect(a.getStatus().keyId).toBe(keyId)
		expect((server.records.get('u:alice/default') as WrappedKeyRecord).keys[0]?.keyId).toBe(keyId)
	})
})
