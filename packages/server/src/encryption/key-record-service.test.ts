import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Operation } from '@korajs/core'
import type { EncryptionKeyPutMessage, WrappedKeyRecord } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import type { ServerStore } from '../store/server-store'
import { createSqliteServerStore } from '../store/sqlite-server-store'
import { ANONYMOUS_KEY_OWNER, EncryptionKeyService, userKeyOwner } from './key-record-service'

const B64_12 = 'AAAAAAAAAAAAAAAA'
const B64_32 = `${'A'.repeat(43)}=`
const B64_48 = 'A'.repeat(64)

const RING = `r-${'0'.repeat(32)}`

function record(revision: number, versions = 1, ringId = RING): WrappedKeyRecord {
	return {
		format: 2,
		keyring: 'default',
		ringId,
		revision,
		currentVersion: versions,
		kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000, salt: B64_32 },
		master: { iv: B64_12, wrappedKey: B64_48 },
		keys: Array.from({ length: versions }, (_, i) => ({
			keyVersion: i + 1,
			keyId: `k2-${String(i + 1).repeat(32)}`,
			iv: B64_12,
			wrappedKey: B64_48,
		})),
		mac: B64_32,
	}
}

let opSequence = 0
function sealedOp(nodeId: string, keyId: string): Operation {
	opSequence++
	return {
		id: `op-${opSequence}`,
		nodeId,
		type: 'insert',
		collection: 'notes',
		recordId: `rec-${opSequence}`,
		data: null,
		previousData: null,
		timestamp: { wallTime: 1_700_000_000_000 + opSequence, logical: 0, nodeId },
		sequenceNumber: opSequence,
		causalDeps: [],
		schemaVersion: 1,
		encrypted: {
			v: 2,
			alg: 'aes-256-gcm',
			keyId,
			keyVersion: 1,
			data: { iv: 'aXY=', ct: 'Y3Q=' },
			previousData: { iv: 'aXY=', ct: 'bnVsbA==' },
		},
	}
}

function put(rec: WrappedKeyRecord, expectedRevision: number): EncryptionKeyPutMessage {
	return {
		type: 'encryption-key-put',
		messageId: 'm',
		requestId: 'r',
		keyring: 'default',
		record: rec,
		expectedRevision,
	}
}

const fetch = {
	type: 'encryption-key-request' as const,
	messageId: 'm',
	requestId: 'r',
	keyring: 'default',
}

const cleanups: Array<() => void> = []
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup()
})

const stores: Array<[string, () => Promise<ServerStore>]> = [
	['memory', async () => new MemoryServerStore()],
	[
		'sqlite',
		async () => {
			const dir = mkdtempSync(join(tmpdir(), 'kora-keys-'))
			cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
			return createSqliteServerStore({ filename: join(dir, 'server.db') })
		},
	],
]

describe.each(stores)('EncryptionKeyService on the %s store (ENC-1)', (_name, makeStore) => {
	test('stores and serves a record per owner; owners never see each other', async () => {
		const service = new EncryptionKeyService(await makeStore())
		expect(service.isSupported()).toBe(true)
		const alice = userKeyOwner('alice')
		expect((await service.handle(alice, fetch)).response).toMatchObject({
			status: 'ok',
			record: null,
		})
		const created = await service.handle(alice, put(record(1), 0))
		expect(created.response.status).toBe('ok')
		expect(created.written?.revision).toBe(1)
		expect((await service.handle(alice, fetch)).response.record?.revision).toBe(1)
		expect((await service.handle(userKeyOwner('bob'), fetch)).response.record).toBeNull()
		expect((await service.handle(ANONYMOUS_KEY_OWNER, fetch)).response.record).toBeNull()
	})

	test('compare-and-set: a stale write loses with the current record', async () => {
		const service = new EncryptionKeyService(await makeStore())
		const owner = userKeyOwner('alice')
		await service.handle(owner, put(record(1), 0))
		const second = await service.handle(owner, put(record(1), 0))
		expect(second.response).toMatchObject({ status: 'conflict', record: { revision: 1 } })
		expect(second.written).toBeNull()
		expect((await service.handle(owner, put(record(2, 2), 1))).response.status).toBe('ok')
	})

	test('history is append-only: a write that drops a version is refused', async () => {
		const service = new EncryptionKeyService(await makeStore())
		const owner = userKeyOwner('alice')
		await service.handle(owner, put(record(1, 2), 0))
		const dropped = await service.handle(owner, put(record(2, 1), 1))
		expect(dropped.response.status).toBe('invalid')
		expect(dropped.response.message).toMatch(/key version 2 must be kept/)
	})

	test('revisions only grow and the ring id never changes; a first write keeps its revision', async () => {
		const service = new EncryptionKeyService(await makeStore())
		const owner = userKeyOwner('alice')
		// A device re-uploading a lost record keeps the revision every device pinned.
		expect((await service.handle(owner, put(record(5), 0))).response.status).toBe('ok')
		expect((await service.handle(owner, put(record(5), 5))).response.status).toBe('invalid')
		const otherRing = record(6, 1, `r-${'1'.repeat(32)}`)
		expect((await service.handle(owner, put(otherRing, 5))).response.message).toMatch(/ringId/)
		// A merge or a healed rollback may jump revisions.
		expect((await service.handle(owner, put(record(9, 2), 5))).response.status).toBe('ok')
		// Format 1 records are not accepted.
		const legacy = { ...record(10, 2), format: 1 } as unknown as WrappedKeyRecord
		expect((await service.handle(owner, put(legacy, 9))).response.status).toBe('invalid')
	})

	test('with no record, a fetch reports the key ids of the owner encrypted history (RT-104)', async () => {
		const store = await makeStore()
		const service = new EncryptionKeyService(store)
		const alice = userKeyOwner('alice')
		expect((await service.handle(alice, fetch)).response.knownKeyIds).toEqual([])
		expect(await store.claimNode?.('alice-phone', 'alice')).toBe(true)
		expect(await store.claimNode?.('bob-phone', 'bob')).toBe(true)
		await store.applyRemoteOperation(sealedOp('alice-phone', `k2-${'a'.repeat(32)}`))
		await store.applyRemoteOperation(sealedOp('alice-phone', `k2-${'a'.repeat(32)}`))
		await store.applyRemoteOperation(sealedOp('bob-phone', `k2-${'b'.repeat(32)}`))
		expect((await service.handle(alice, fetch)).response.knownKeyIds).toEqual([
			`k2-${'a'.repeat(32)}`,
		])
		expect((await service.handle(userKeyOwner('bob'), fetch)).response.knownKeyIds).toEqual([
			`k2-${'b'.repeat(32)}`,
		])
		expect(
			[...((await service.handle(ANONYMOUS_KEY_OWNER, fetch)).response.knownKeyIds ?? [])].sort(),
		).toEqual([`k2-${'a'.repeat(32)}`, `k2-${'b'.repeat(32)}`])
		// Once a record exists nothing is reported.
		await service.handle(alice, put(record(1), 0))
		expect((await service.handle(alice, fetch)).response.knownKeyIds).toBeUndefined()
	})

	test('history of the owner other keyrings is not reported as a lost record', async () => {
		const store = await makeStore()
		const service = new EncryptionKeyService(store)
		const alice = userKeyOwner('alice')
		expect(await store.claimNode?.('alice-phone', 'alice')).toBe(true)
		const otherRecord = { ...record(1), keyring: 'other' }
		const other = { ...put(otherRecord, 0), keyring: 'other' }
		expect((await service.handle(alice, other)).response.status).toBe('ok')
		const otherKey = otherRecord.keys[0]?.keyId as string
		await store.applyRemoteOperation(sealedOp('alice-phone', otherKey))
		// Only the other keyring's history: the first device of "default" may create it.
		expect((await service.handle(alice, fetch)).response.knownKeyIds).toEqual([])
		// History under a key no record names: "default" was lost.
		await store.applyRemoteOperation(sealedOp('alice-phone', `k2-${'a'.repeat(32)}`))
		expect((await service.handle(alice, fetch)).response.knownKeyIds).toEqual([
			`k2-${'a'.repeat(32)}`,
		])
	})

	test('refuses anonymous principals, bad keyrings and malformed records', async () => {
		const service = new EncryptionKeyService(await makeStore())
		expect((await service.handle(null, fetch)).response.status).toBe('forbidden')
		expect(
			(await service.handle(userKeyOwner('a'), { ...fetch, keyring: '../x' })).response.status,
		).toBe('invalid')
		const bad = { ...record(1), kdf: { name: 'none' } } as unknown as WrappedKeyRecord
		expect((await service.handle(userKeyOwner('a'), put(bad, 0))).response.status).toBe('invalid')
	})

	test('the server backup carries key records; a restore fills only missing ones (RT-104)', async () => {
		const source = await makeStore()
		const sourceService = new EncryptionKeyService(source)
		const alice = userKeyOwner('alice')
		const bob = userKeyOwner('bob')
		await sourceService.handle(alice, put(record(3, 2), 0))
		await sourceService.handle(bob, put(record(1), 0))
		const backup = await source.exportBackup()

		// Disaster recovery onto an empty server: every record comes back unchanged.
		const target = await makeStore()
		const targetService = new EncryptionKeyService(target)
		await target.importBackup(backup)
		expect((await targetService.handle(alice, fetch)).response.record).toEqual(record(3, 2))
		expect((await targetService.handle(bob, fetch)).response.record).toEqual(record(1))

		// A record the server holds is never replaced by the backup's (older) copy.
		await targetService.handle(alice, put(record(4, 3), 3))
		await target.importBackup(backup, true)
		await target.importBackup(backup)
		expect((await targetService.handle(alice, fetch)).response.record?.revision).toBe(4)
	})
})

test('a backup with a malformed key record is refused whole (RT-104)', async () => {
	const store = new MemoryServerStore()
	await new EncryptionKeyService(store).handle(userKeyOwner('alice'), put(record(1), 0))
	const backup = await store.exportBackup()
	// Byte-level, same length, so the section framing stays intact: the format becomes 9.
	const needle = new TextEncoder().encode('\\"format\\":2')
	const tampered = new Uint8Array(backup)
	const at = tampered.findIndex((_, i) => needle.every((byte, j) => tampered[i + j] === byte))
	expect(at).toBeGreaterThanOrEqual(0)
	tampered[at + needle.length - 1] = '9'.charCodeAt(0)
	const target = new MemoryServerStore()
	await expect(target.importBackup(tampered)).rejects.toMatchObject({
		code: 'BACKUP_INVALID_KEY_RECORD',
	})
	expect(await target.getEncryptionKeyRecord('u:alice', 'default')).toBeNull()
})

test('a store without key-record support answers unsupported (never memory-only keys)', async () => {
	const store = new MemoryServerStore() as ServerStore
	const bare = Object.create(store) as ServerStore
	Object.defineProperty(bare, 'getEncryptionKeyRecord', { value: undefined })
	Object.defineProperty(bare, 'putEncryptionKeyRecord', { value: undefined })
	const service = new EncryptionKeyService(bare)
	expect(service.isSupported()).toBe(false)
	expect((await service.handle(userKeyOwner('a'), fetch)).response.status).toBe('unsupported')
})
