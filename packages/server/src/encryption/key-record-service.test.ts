import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EncryptionKeyPutMessage, WrappedKeyRecord } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import type { ServerStore } from '../store/server-store'
import { createSqliteServerStore } from '../store/sqlite-server-store'
import { ANONYMOUS_KEY_OWNER, EncryptionKeyService, userKeyOwner } from './key-record-service'

const B64_12 = 'AAAAAAAAAAAAAAAA'
const B64_32 = `${'A'.repeat(43)}=`
const B64_48 = 'A'.repeat(64)

function record(revision: number, versions = 1): WrappedKeyRecord {
	return {
		format: 1,
		keyring: 'default',
		revision,
		currentVersion: versions,
		kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000, salt: B64_32 },
		keys: Array.from({ length: versions }, (_, i) => ({
			keyVersion: i + 1,
			keyId: `k2-${String(i + 1).repeat(32)}`,
			iv: B64_12,
			wrappedKey: B64_48,
		})),
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

	test('refuses anonymous principals, bad keyrings and malformed records', async () => {
		const service = new EncryptionKeyService(await makeStore())
		expect((await service.handle(null, fetch)).response.status).toBe('forbidden')
		expect(
			(await service.handle(userKeyOwner('a'), { ...fetch, keyring: '../x' })).response.status,
		).toBe('invalid')
		const bad = { ...record(1), kdf: { name: 'none' } } as unknown as WrappedKeyRecord
		expect((await service.handle(userKeyOwner('a'), put(bad, 0))).response.status).toBe('invalid')
	})
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
