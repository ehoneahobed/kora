/**
 * RT-110 repro (Codex review of PR #4, server-backup.ts restoreBackupKeyRecords): a
 * backup's end-to-end key records were restored insert-only (compare-and-set against
 * "no record"). A store that already held an OLDER revision of the same keyring kept
 * it, in merge mode and in replace mode alike (the key table is never cleared). The
 * restored history names data keys that only the backup's newer revision holds, so a
 * fresh device fetched the stale record and could not decrypt it.
 *
 * Scenario, end to end with real keyrings and the server's key service: a device
 * rotates its key ring (revision 1 -> 2, a second data key), the server is backed up, the
 * backup is restored into a server that holds revision 1 (a standby restored from an
 * older backup), and a brand-new device with the passphrase decrypts every operation.
 *
 * Asserts the CORRECT behaviour on the memory, SQLite and Postgres stores
 * (KORA_PG_TEST_URL).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Operation } from '@korajs/core'
import type { KeyServiceChannel, KeyServiceReply, WrappedKeyRecord } from '@korajs/sync'
import { EncryptionKeyring, MemoryKeyCache } from '@korajs/sync'
import { afterAll, describe, expect, test } from 'vitest'
import { EncryptionKeyService, userKeyOwner } from '../../src/encryption/key-record-service'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createPostgresServerStore } from '../../src/store/postgres-server-store'
import type { ServerStore } from '../../src/store/server-store'
import { createSqliteServerStore } from '../../src/store/sqlite-server-store'

const PASSPHRASE = 'correct horse battery staple'
const ITERATIONS = 1000
const OWNER = userKeyOwner('alice')

const dir = mkdtempSync(join(tmpdir(), 'rt-110-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A device's key-service channel to one server's key service. */
function channelTo(store: ServerStore): KeyServiceChannel {
	const service = new EncryptionKeyService(store)
	const toReply = (response: {
		status: string
		record: WrappedKeyRecord | null
		knownKeyIds?: string[]
	}): KeyServiceReply =>
		({
			status: response.status,
			record: response.record,
			...(response.knownKeyIds ? { knownKeyIds: response.knownKeyIds } : {}),
		}) as KeyServiceReply
	return {
		fetch: async (keyring) =>
			toReply(
				(
					await service.handle(OWNER, {
						type: 'encryption-key-request',
						messageId: 'm',
						requestId: 'r',
						keyring,
					})
				).response,
			),
		put: async (keyring, record, expectedRevision) =>
			toReply(
				(
					await service.handle(OWNER, {
						type: 'encryption-key-put',
						messageId: 'm',
						requestId: 'r',
						keyring,
						record,
						expectedRevision,
					})
				).response,
			),
	}
}

function device(): EncryptionKeyring {
	return new EncryptionKeyring({
		passphrase: PASSPHRASE,
		kdfIterations: ITERATIONS,
		cache: new MemoryKeyCache(),
	})
}

let sequence = 0
function plainOp(body: string): Operation {
	sequence++
	return {
		id: `rt110-op-${sequence}`,
		nodeId: 'alice-laptop',
		type: 'insert',
		collection: 'notes',
		recordId: `note-${sequence}`,
		data: { body },
		previousData: null,
		timestamp: { wallTime: 1_700_000_000_000 + sequence, logical: 0, nodeId: 'alice-laptop' },
		sequenceNumber: sequence,
		causalDeps: [],
		schemaVersion: 1,
		hashVersion: 2,
	}
}

async function seal(keyring: EncryptionKeyring, body: string): Promise<Operation> {
	const encryptor = keyring.getEncryptor()
	if (encryptor === null) throw new Error('device is locked')
	return encryptor.encryptOperation(plainOp(body))
}

/** Every operation body the fresh device can read from `store`, or the failure. */
async function readAll(store: ServerStore, keyring: EncryptionKeyring): Promise<string[]> {
	const encryptor = keyring.getEncryptor()
	if (encryptor === null) return ['device is locked']
	const backup = await store.exportBackup()
	const { parseServerBackup } = await import('../../src/store/server-backup')
	const { operations } = parseServerBackup(backup)
	const bodies: string[] = []
	for (const op of operations) {
		bodies.push(
			await encryptor.decryptOperation(op).then(
				(opened) => (opened.data as { body: string }).body,
				(error: Error) => `undecryptable: ${error.message}`,
			),
		)
	}
	return bodies.sort()
}

async function storedRevision(store: ServerStore): Promise<number | undefined> {
	const rows = (await store.listEncryptionKeyRecords?.(OWNER)) ?? []
	return rows.find((row) => row.keyring === 'default')?.revision
}

type StoreFactory = (name: string) => Promise<ServerStore>

async function scenario(makeStore: StoreFactory, merge: boolean): Promise<void> {
	// The production server: a device creates the ring and writes history under key 1.
	const production = await makeStore(`production-${merge ? 'merge' : 'replace'}`)
	const laptop = device()
	expect(await laptop.synchronize(channelTo(production), 'alice')).toBe('ready')
	await production.applyRemoteOperation(await seal(laptop, 'before rotation'))
	const oldBackup = await production.exportBackup()

	// A standby restored from that older backup holds revision 1.
	const standby = await makeStore(`standby-${merge ? 'merge' : 'replace'}`)
	await standby.importBackup(oldBackup)
	expect(await storedRevision(standby)).toBe(1)

	// The device rotates: the ring advances and new history uses key 2.
	await laptop.rotate(channelTo(production))
	expect(await storedRevision(production)).toBeGreaterThan(1)
	await production.applyRemoteOperation(await seal(laptop, 'after rotation'))

	// Disaster recovery onto the standby from the newer backup.
	const backup = await production.exportBackup()
	await standby.importBackup(backup, merge)
	expect(await storedRevision(standby)).toBe(await storedRevision(production))

	// A brand-new phone signs in against the restored server and reads all history.
	const phone = device()
	expect(await phone.synchronize(channelTo(standby), 'alice')).toBe('ready')
	expect(await readAll(standby, phone)).toEqual(['after rotation', 'before rotation'])

	await production.close()
	await standby.close()
}

const pgUrl = process.env.KORA_PG_TEST_URL
const factories: Array<[string, StoreFactory | null]> = [
	['memory', async () => new MemoryServerStore()],
	['SQLite', async (name) => createSqliteServerStore({ filename: join(dir, `${name}.db`) })],
	[
		'Postgres',
		pgUrl
			? async (name) => {
					const { default: postgres } = await import('postgres')
					const admin = postgres(pgUrl, { max: 1, onnotice: () => {} })
					const database = `kora_rt110_${name.replace('-', '_')}`
					await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`)
					await admin.unsafe(`CREATE DATABASE ${database}`)
					await admin.end()
					return createPostgresServerStore({
						connectionString: pgUrl.replace(/\/[^/]*$/, `/${database}`),
					})
				}
			: null,
	],
]

describe('RT-110: restoring a backup into a store holding an older key record', () => {
	for (const [name, factory] of factories) {
		test.skipIf(factory === null)(`${name}: merge-mode restore advances the ring`, async () => {
			await scenario(factory as StoreFactory, true)
		})
		test.skipIf(factory === null)(
			`${name}: replace-mode restore takes the backup's record`,
			async () => {
				await scenario(factory as StoreFactory, false)
			},
		)
	}
})
