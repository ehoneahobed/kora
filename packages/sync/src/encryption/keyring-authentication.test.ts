/**
 * Key record authentication and forward-only adoption (final RC red team: RT-95, RT-96,
 * RT-97, RT-104). The fake key service applies the sync server's rules (structure,
 * compare-and-set, append-only successors) and can additionally misbehave: rewrite,
 * replay or lose records.
 */
import { fc, test as propTest } from '@fast-check/vitest'
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { MemoryKeyCache } from './key-cache'
import type { WrappedKeyRecord } from './key-record'
import { isKeyRecordSuccessor, validateKeyRecord } from './key-record'
import type { KeyServiceChannel, KeyServiceReply } from './keyring'
import { EncryptionKeyError, EncryptionKeyring } from './keyring'
import {
	KEK_SALT_BYTES,
	deriveKeyEncryptionKey,
	generateDataKey,
	generateMasterKey,
	generateRecoveryKeyPair,
	importMasterKey,
	newKeyId,
	randomBytes,
	sealRecord,
	toBase64,
	wrapDataKey,
	wrapMasterForRecovery,
	wrapMasterKey,
} from './keyring-crypto'

const ITERATIONS = 1000
const OWNER = 'u:alice'

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T
}

class KeyServer {
	record: WrappedKeyRecord | null = null
	/** Key ids of the "stored operations" (reported while no record exists). */
	knownKeyIds: string[] = []
	writes = 0

	fetch(): KeyServiceReply {
		return {
			status: 'ok',
			record: clone(this.record),
			...(this.record === null ? { knownKeyIds: [...this.knownKeyIds] } : {}),
		}
	}

	put(keyring: string, record: WrappedKeyRecord, expectedRevision: number): KeyServiceReply {
		const validation = validateKeyRecord(record, keyring)
		if (!validation.ok) throw new Error(`invalid record: ${validation.reason}`)
		if ((this.record?.revision ?? 0) !== expectedRevision) {
			return { status: 'conflict', record: clone(this.record) }
		}
		const successor = isKeyRecordSuccessor(this.record, record)
		if (!successor.ok) throw new Error(`not a successor: ${successor.reason}`)
		this.record = clone(record)
		this.writes++
		for (const key of record.keys) {
			if (!this.knownKeyIds.includes(key.keyId)) this.knownKeyIds.push(key.keyId)
		}
		return { status: 'ok', record: clone(record) }
	}

	channel(): KeyServiceChannel {
		return {
			fetch: async () => this.fetch(),
			put: async (keyring, record, expectedRevision) => this.put(keyring, record, expectedRevision),
		}
	}
}

function device(
	passphrase?: string | (() => Promise<string>),
	cache: MemoryKeyCache = new MemoryKeyCache(),
): EncryptionKeyring {
	return new EncryptionKeyring({
		...(passphrase !== undefined ? { passphrase } : {}),
		kdfIterations: ITERATIONS,
		cache,
	})
}

let sequence = 0
function op(body: string): Operation {
	sequence++
	return {
		id: `op-${sequence}`,
		nodeId: 'node-a',
		type: 'insert',
		collection: 'notes',
		recordId: `rec-${sequence}`,
		data: { body },
		previousData: null,
		timestamp: { wallTime: 1_700_000_000_000, logical: sequence, nodeId: 'node-a' },
		sequenceNumber: sequence,
		causalDeps: [],
		schemaVersion: 1,
		hashVersion: 2,
	}
}

async function seal(keyring: EncryptionKeyring, body: string): Promise<Operation> {
	const encryptor = keyring.getEncryptor()
	if (!encryptor) throw new Error(`locked: ${keyring.getStatus().code}`)
	return encryptor.encryptOperation(op(body))
}

async function read(keyring: EncryptionKeyring, sealed: Operation): Promise<string> {
	const encryptor = keyring.getEncryptor()
	if (!encryptor) throw new Error(`locked: ${keyring.getStatus().code}`)
	const plain = await encryptor.decryptOperation(sealed)
	return String((plain.data as { body: string }).body)
}

describe('RT-95: every field of the record is authenticated', () => {
	test('a server-made recovery block (valid structure, no MAC) is refused, never used', async () => {
		const server = new KeyServer()
		const a = device('p')
		await a.synchronize(server.channel(), 'alice')
		const record = server.record as WrappedKeyRecord
		const attacker = await generateRecoveryKeyPair()
		// The server cannot open the master key: it wraps bytes of its own.
		const forged: WrappedKeyRecord = {
			...clone(record),
			revision: record.revision + 1,
			recovery: await wrapMasterForRecovery(
				generateMasterKey(),
				attacker.publicKey,
				record.keyring,
				record.ringId,
			),
		}
		expect(await a.adoptPushed(forged)).toBe('locked')
		expect(a.getStatus().code).toBe('KEY_RECORD_INVALID')
		// The device keeps its keys and its authenticated record.
		expect(await read(a, await seal(a, 'still works'))).toBe('still works')
		server.record = forged
		const fresh = device('p')
		expect(await fresh.synchronize(server.channel(), 'alice')).toBe('locked')
		expect(fresh.getStatus().code).toBe('KEY_RECORD_INVALID')
	})

	test.each([
		['revision', (r: WrappedKeyRecord) => ({ ...r, revision: r.revision + 5 })],
		['kdf iterations', (r: WrappedKeyRecord) => ({ ...r, kdf: { ...r.kdf, iterations: 5000 } })],
		[
			'master wrap',
			(r: WrappedKeyRecord) => ({ ...r, master: { ...r.master, iv: 'AAAAAAAAAAAAAAAA' } }),
		],
		[
			'a dropped recovery block',
			(r: WrappedKeyRecord) => {
				const { recovery: _dropped, ...rest } = r
				return { ...rest, revision: r.revision + 1 }
			},
		],
		[
			'a relabelled version',
			(r: WrappedKeyRecord) => ({
				...r,
				revision: r.revision + 1,
				keys: r.keys.map((key) => ({ ...key, keyVersion: key.keyVersion + 1 })),
				currentVersion: r.currentVersion + 1,
			}),
		],
	])(
		'a record with a changed %s is refused by a device holding the ring',
		async (_label, mutate) => {
			const server = new KeyServer()
			const a = device('p')
			await a.synchronize(server.channel(), 'alice')
			await a.enableRecovery(server.channel())
			const b = device('p')
			await b.synchronize(server.channel(), 'alice')
			const tampered = mutate(clone(server.record as WrappedKeyRecord)) as WrappedKeyRecord
			expect(await b.adoptPushed(tampered)).toBe('locked')
			expect(b.getStatus().code).toMatch(/KEY_RECORD_INVALID|KEY_RECORD_ROLLBACK/)
			expect(b.getEncryptor()).not.toBeNull()
		},
	)

	test('rotation never wraps a data key to a recovery key: only the master key is', async () => {
		const server = new KeyServer()
		const a = device('p')
		await a.synchronize(server.channel(), 'alice')
		const recoveryKey = await a.enableRecovery(server.channel())
		const recovery = clone((server.record as WrappedKeyRecord).recovery)
		await a.rotate(server.channel())
		await a.rotate(server.channel())
		expect((server.record as WrappedKeyRecord).recovery).toEqual(recovery)
		const v3 = await seal(a, 'v3')
		// The recovery key still opens every version (through the master key).
		const lost = device()
		await lost.load('alice')
		await lost.recover(recoveryKey, 'new', server.channel())
		expect(await read(lost, v3)).toBe('v3')
	})

	test('recovery refuses a record the recovered master key does not authenticate', async () => {
		const server = new KeyServer()
		const a = device('p')
		await a.synchronize(server.channel(), 'alice')
		const recoveryKey = await a.enableRecovery(server.channel())
		const record = server.record as WrappedKeyRecord
		// The server appends a data key of its own choosing (it cannot MAC it).
		const injected = clone(record)
		const own = injected.keys[0]
		if (!own) throw new Error('fixture')
		// (enableRecovery added version 2, the recovery anchor key.)
		injected.keys.push({ ...own, keyVersion: 3, keyId: `k2-${'f'.repeat(32)}` })
		injected.currentVersion = 3
		server.record = injected
		const lost = device()
		await lost.load('alice')
		await expect(lost.recover(recoveryKey, 'new', server.channel())).rejects.toMatchObject({
			context: expect.objectContaining({ code: 'KEY_RECORD_INVALID' }),
		})
	})

	test('recovery refuses a substituted ring wrapped to the (public) recovery key', async () => {
		const server = new KeyServer()
		const a = device('forgotten')
		await a.synchronize(server.channel(), 'alice')
		const recoveryKey = await a.enableRecovery(server.channel())
		const genuine = server.record as WrappedKeyRecord
		const recoveryPublicKey = genuine.recovery?.publicKey
		if (!recoveryPublicKey) throw new Error('fixture')
		// The server builds a whole ring of its own (master and data key it knows), same ring
		// id and a higher revision, and wraps its master key to the user's recovery PUBLIC key.
		const raw = generateMasterKey()
		const master = await importMasterKey(raw)
		const salt = randomBytes(KEK_SALT_BYTES)
		const kek = await deriveKeyEncryptionKey('server', salt, ITERATIONS)
		const dataKey = await generateDataKey()
		const keyId = newKeyId()
		const substituted = await sealRecord(
			{
				format: 2,
				keyring: genuine.keyring,
				ringId: genuine.ringId,
				revision: genuine.revision + 1,
				currentVersion: 1,
				kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: toBase64(salt) },
				master: await wrapMasterKey(raw, kek, genuine.keyring, genuine.ringId),
				keys: [await wrapDataKey(dataKey, master.wrapKey, genuine.keyring, 1, keyId)],
				recovery: await wrapMasterForRecovery(
					raw,
					recoveryPublicKey,
					genuine.keyring,
					genuine.ringId,
				),
			},
			master.macKey,
		)
		server.record = substituted
		const lost = device()
		await lost.load('alice')
		await expect(lost.recover(recoveryKey, 'new', server.channel())).rejects.toMatchObject({
			context: expect.objectContaining({ code: 'KEY_RECORD_INVALID' }),
		})
		// Nothing was written and no key of the server's ring is used.
		expect(server.record).toEqual(substituted)
		expect(lost.getEncryptor()).toBeNull()
	})

	test('a recovery key stays anchored across rotation, passphrase change and recovery', async () => {
		const server = new KeyServer()
		const a = device('one')
		await a.synchronize(server.channel(), 'alice')
		const recoveryKey = await a.enableRecovery(server.channel())
		await a.rotate(server.channel())
		await a.changePassphrase('two', server.channel())
		const first = device()
		await first.load('alice')
		await first.recover(recoveryKey, 'three', server.channel())
		const second = device()
		await second.load('alice')
		await second.recover(recoveryKey, 'four', server.channel())
		// v2: the recovery anchor key enableRecovery() created; v3: the rotation.
		expect(second.getStatus().availableVersions).toEqual([1, 2, 3])
	})

	test('recovery keeps the master key: devices holding the ring keep managing it', async () => {
		const server = new KeyServer()
		const a = device('forgotten')
		await a.synchronize(server.channel(), 'alice')
		const recoveryKey = await a.enableRecovery(server.channel())
		const b = device()
		await b.load('alice')
		await b.recover(recoveryKey, 'new passphrase', server.channel())
		expect(await a.adoptPushed(clone(server.record as WrappedKeyRecord))).toBe('ready')
		expect(a.getStatus().code).toBeUndefined()
		await a.rotate(server.channel())
		expect(await b.adoptPushed(clone(server.record as WrappedKeyRecord))).toBe('ready')
		expect(b.getStatus().availableVersions).toEqual([1, 2, 3])
	})
})

describe('RT-96: devices only move forward', () => {
	test('the pin survives a restart (persistent cache): an older revision is refused', async () => {
		const server = new KeyServer()
		const cache = new MemoryKeyCache()
		const a = device('old', cache)
		await a.synchronize(server.channel(), 'alice')
		const old = clone(server.record as WrappedKeyRecord)
		await a.changePassphrase('new', server.channel())

		const restarted = device(undefined, cache)
		await restarted.load('alice')
		expect(await restarted.adoptPushed(old)).toBe('locked')
		expect(restarted.getStatus().code).toBe('KEY_RECORD_ROLLBACK')
		// The old passphrase gets nowhere on this device.
		await expect(restarted.unlock('old', null)).rejects.toThrow(EncryptionKeyError)
		// Connected: the newer record goes back to the server.
		server.record = old
		expect(await restarted.synchronize(server.channel(), 'alice')).toBe('ready')
		expect((server.record as WrappedKeyRecord).revision).toBe(old.revision + 1)
	})

	test('a lock() keeps the pin: unlock() with the old passphrase never adopts the old revision', async () => {
		const server = new KeyServer()
		const a = device('old')
		await a.synchronize(server.channel(), 'alice')
		const old = clone(server.record as WrappedKeyRecord)
		await a.changePassphrase('new', server.channel())
		await a.lock()
		server.record = old
		await expect(a.unlock('old', server.channel())).rejects.toThrow(EncryptionKeyError)
		expect(a.getEncryptor()).toBeNull()
		await a.unlock('new', server.channel())
		expect(a.getStatus().state).toBe('unlocked')
		expect((server.record as WrappedKeyRecord).revision).toBe(2)
	})

	test('a passphrase change elsewhere: held keys keep working, management needs the passphrase', async () => {
		const server = new KeyServer()
		const a = device('one')
		const b = device('one')
		await a.synchronize(server.channel(), 'alice')
		await b.synchronize(server.channel(), 'alice')
		await a.changePassphrase('two', server.channel())
		expect(await b.adoptPushed(clone(server.record as WrappedKeyRecord))).toBe('ready')
		expect(b.getStatus()).toMatchObject({ state: 'unlocked', code: 'PASSPHRASE_REQUIRED' })
		expect(await read(a, await seal(b, 'from b'))).toBe('from b')
		await expect(b.enableRecovery(server.channel())).rejects.toMatchObject({
			context: expect.objectContaining({ code: 'PASSPHRASE_REQUIRED' }),
		})
		await b.unlock('two', server.channel())
		expect(b.getStatus().code).toBeUndefined()
		await b.rotate(server.channel())
		expect(await a.adoptPushed(clone(server.record as WrappedKeyRecord))).toBe('ready')
		expect(a.getStatus().availableVersions).toEqual([1, 2])
	})
})

describe('RT-104: a lost key record', () => {
	test('a new device waits (KEY_RECORD_MISSING) until a device holding the ring re-uploads it', async () => {
		const server = new KeyServer()
		const old = device('p')
		await old.synchronize(server.channel(), 'alice')
		const history = await seal(old, 'history')
		server.record = null

		const fresh = device('p')
		expect(await fresh.synchronize(server.channel(), 'alice')).toBe('locked')
		expect(fresh.getStatus()).toMatchObject({ state: 'locked', code: 'KEY_RECORD_MISSING' })
		expect(fresh.isRetryableLock()).toBe(true)
		expect(fresh.canConnect()).toBe(true)
		expect(server.record).toBeNull()

		expect(await old.synchronize(server.channel(), 'alice')).toBe('ready')
		expect(await fresh.synchronize(server.channel(), 'alice')).toBe('ready')
		expect(await read(fresh, history)).toBe('history')
	})

	test('an unlock() on a new device waits too, and keeps the passphrase for later', async () => {
		const server = new KeyServer()
		const old = device('p')
		await old.synchronize(server.channel(), 'alice')
		server.record = null
		const fresh = device()
		await fresh.load('alice')
		await expect(fresh.unlock('p', server.channel())).rejects.toMatchObject({
			context: expect.objectContaining({ code: 'KEY_RECORD_MISSING' }),
		})
		expect(fresh.canConnect()).toBe(true)
		await old.synchronize(server.channel(), 'alice')
		expect(await fresh.synchronize(server.channel(), 'alice')).toBe('ready')
	})

	test('a re-uploaded record keeps its revision, so every pin accepts it', async () => {
		const server = new KeyServer()
		const a = device('p')
		const b = device('p')
		await a.synchronize(server.channel(), 'alice')
		await a.rotate(server.channel())
		await a.rotate(server.channel())
		await b.synchronize(server.channel(), 'alice')
		server.record = null
		await a.synchronize(server.channel(), 'alice')
		expect((server.record as WrappedKeyRecord | null)?.revision).toBe(3)
		expect(await b.synchronize(server.channel(), 'alice')).toBe('ready')
		expect(b.getStatus().code).toBeUndefined()
	})

	test('startNewKeyring() is the explicit way out; an old device later merges both rings', async () => {
		const server = new KeyServer()
		const old = device('p')
		await old.synchronize(server.channel(), 'alice')
		const history = await seal(old, 'history')
		server.record = null

		const fresh = device('p')
		expect(await fresh.synchronize(server.channel(), 'alice')).toBe('locked')
		await fresh.startNewKeyring(server.channel())
		const recent = await seal(fresh, 'recent')
		await expect(read(fresh, history)).rejects.toThrow()

		// The old device returns: it opens the new ring with the passphrase and merges.
		expect(await old.synchronize(server.channel(), 'alice')).toBe('ready')
		expect(await read(old, recent)).toBe('recent')
		expect(await read(old, history)).toBe('history')
		expect(await fresh.synchronize(server.channel(), 'alice')).toBe('ready')
		expect(await read(fresh, history)).toBe('history')
		// New operations of both use the same current key.
		expect(old.getStatus().keyId).toBe(fresh.getStatus().keyId)
	})

	test('a device without the passphrase reports the fork, and merges after unlock()', async () => {
		const server = new KeyServer()
		const cache = new MemoryKeyCache()
		const old = device('p', cache)
		await old.synchronize(server.channel(), 'alice')
		const history = await seal(old, 'history')
		const restarted = device(undefined, cache)
		await restarted.load('alice')
		server.record = null
		const fresh = device('p')
		await fresh.synchronize(server.channel(), 'alice')
		await fresh.startNewKeyring(server.channel())

		expect(await restarted.synchronize(server.channel(), 'alice')).toBe('locked')
		expect(restarted.getStatus().code).toBe('KEY_RING_FORK')
		expect(restarted.isRetryableLock()).toBe(false)
		await restarted.unlock('p', server.channel())
		expect(await fresh.synchronize(server.channel(), 'alice')).toBe('ready')
		expect(await read(fresh, history)).toBe('history')
	})

	test('startNewKeyring() while disconnected runs at the next handshake', async () => {
		const server = new KeyServer()
		await device('p').synchronize(server.channel(), 'alice')
		server.record = null
		const fresh = device('p')
		expect(await fresh.synchronize(server.channel(), 'alice')).toBe('locked')
		expect((await fresh.startNewKeyring(null)).code).toBe('AWAITING_SERVER')
		expect(await fresh.synchronize(server.channel(), 'alice')).toBe('ready')
		expect(server.record).not.toBeNull()
	})

	test('startNewKeyring() refuses while a record exists', async () => {
		const server = new KeyServer()
		await device('p').synchronize(server.channel(), 'alice')
		const other = device('p')
		await other.load('alice')
		await expect(other.startNewKeyring(server.channel())).rejects.toMatchObject({
			context: expect.objectContaining({ code: 'KEY_RECORD_EXISTS' }),
		})
	})
})

type Action =
	| { device: 0 | 1; kind: 'rotate' }
	| { device: 0 | 1; kind: 'changePassphrase'; to: string }
	| { device: 0 | 1; kind: 'enableRecovery' }
	| { device: 0 | 1; kind: 'refresh' }

const action: fc.Arbitrary<Action> = fc.oneof(
	fc.record({
		device: fc.constantFrom(0 as const, 1 as const),
		kind: fc.constant('rotate' as const),
	}),
	fc.record({
		device: fc.constantFrom(0 as const, 1 as const),
		kind: fc.constant('changePassphrase' as const),
		to: fc.constantFrom('pass-x', 'pass-y', 'pass-z'),
	}),
	fc.record({
		device: fc.constantFrom(0 as const, 1 as const),
		kind: fc.constant('enableRecovery' as const),
	}),
	fc.record({
		device: fc.constantFrom(0 as const, 1 as const),
		kind: fc.constant('refresh' as const),
	}),
)

describe('RT-97: concurrent rotation, passphrase change and recovery set-up on two devices', () => {
	// A fixed seed keeps the explored interleavings identical on every run (no flaky
	// counterexamples), and the timeout is a hang guard only: 40 runs of real WebCrypto
	// work take a few seconds on an idle machine and much longer on a loaded CI runner.
	propTest.prop([fc.scheduler(), fc.array(action, { minLength: 1, maxLength: 6 })], {
		numRuns: 40,
		seed: 970_097,
	})(
		'every device with the current passphrase can read every data-key version',
		async (s, actions) => {
			const server = new KeyServer()
			// The user knows the passphrase each device last set (and the initial one).
			const known: string[] = ['pass-0', 'pass-0']
			const devices = [0, 1].map((index) => device(async () => known[index] as string)) as [
				EncryptionKeyring,
				EncryptionKeyring,
			]
			for (const d of devices) {
				expect(await d.synchronize(server.channel(), 'alice')).toBe('ready')
			}
			// Interleave the key service: each device's calls run when the scheduler says.
			const channels = devices.map(
				(): KeyServiceChannel => ({
					fetch: s.scheduleFunction(async (_keyring: string) => server.fetch()),
					put: s.scheduleFunction(
						async (keyring: string, record: WrappedKeyRecord, expected: number) =>
							server.put(keyring, record, expected),
					),
				}),
			)
			const sealed: Operation[] = []
			const run = async (a: Action): Promise<void> => {
				const d = devices[a.device]
				const channel = channels[a.device] as KeyServiceChannel
				try {
					if (a.kind === 'rotate') await d.rotate(channel)
					else if (a.kind === 'enableRecovery') await d.enableRecovery(channel)
					else if (a.kind === 'refresh') await d.synchronize(channel, 'alice')
					else {
						await d.changePassphrase(a.to, channel)
						known[a.device] = a.to
						known[1 - a.device] = a.to
					}
				} catch (error) {
					// A lost race or a stale passphrase is a refusal, never corruption.
					if (!(error instanceof EncryptionKeyError)) throw error
				}
				if (d.getEncryptor()) sealed.push(await seal(d, `after ${a.kind}`))
			}
			await s.waitFor(Promise.all(actions.map((a) => run(a))))

			const final = server.record as WrappedKeyRecord
			// Exactly the last committed passphrase opens the record, and it opens every
			// version: a fresh device holds every key id any device sealed with.
			const current = known[0] as string
			const reader = device(current)
			expect(await reader.synchronize(server.channel(), 'alice')).toBe('ready')
			expect(reader.getStatus().availableVersions).toHaveLength(final.keys.length)
			for (const operation of sealed) {
				expect(await read(reader, operation)).toMatch(/^after /)
			}
			// Both devices can catch up with the current passphrase and hold every version.
			for (const d of devices) {
				await d.unlock(current, server.channel())
				expect(d.getStatus().availableVersions).toHaveLength(final.keys.length)
			}
		},
		60_000,
	)
})
