/**
 * ENC-1 integration: end-to-end encryption with shared, server-stored, passphrase-
 * wrapped key material, through createApp, the real SyncEngine and a real
 * KoraSyncServer (one in-memory session per connect). Devices of one user share a
 * server without auth (its one shared keyring); per-user isolation of key records is
 * exercised with token auth at the protocol level.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
	KoraSyncServer,
	MemoryServerStore,
	TokenAuthProvider,
} from '../../../packages/server/src/index'
import { createServerTransportPair } from '../../../packages/server/src/internal'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { body: t.string() } } },
})

let server: KoraSyncServer
let serverStore: MemoryServerStore

class MemoryTransport implements SyncTransport {
	private inner: ReturnType<typeof createServerTransportPair>['client'] | null = null
	private onMsg: (m: SyncMessage) => void = () => {}
	private onCls: (r: string) => void = () => {}
	private onErr: (e: Error) => void = () => {}
	async connect(): Promise<void> {
		const pair = createServerTransportPair()
		this.inner = pair.client
		pair.client.onMessage((m) => this.onMsg(m))
		pair.client.onClose((r) => this.onCls(r))
		pair.client.onError((e) => this.onErr(e))
		server.handleConnection(pair.server)
	}
	async disconnect(): Promise<void> {
		await this.inner?.disconnect()
	}
	send(message: SyncMessage): void {
		if (!this.inner) throw new Error('not connected')
		this.inner.send(message)
	}
	onMessage(h: (m: SyncMessage) => void): void {
		this.onMsg = h
	}
	onClose(h: (r: string) => void): void {
		this.onCls = h
	}
	onError(h: (e: Error) => void): void {
		this.onErr = h
	}
	isConnected(): boolean {
		return this.inner?.isConnected() ?? false
	}
}

vi.mock('../../src/create-sync-transport', () => ({
	createSyncTransport: () => new MemoryTransport(),
}))

const { createApp } = await import('../../src/create-app')

type Notes = {
	insert: (d: Record<string, unknown>) => Promise<{ id: string }>
	findById: (id: string) => Promise<Record<string, unknown> | null>
}
type App = ReturnType<typeof createApp>

let dir: string
const apps: App[] = []

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'kora-keyring-'))
	serverStore = new MemoryServerStore()
	server = new KoraSyncServer({ store: serverStore })
})

afterEach(async () => {
	for (const app of apps.splice(0)) await app.close()
	await server.stop()
	rmSync(dir, { recursive: true, force: true })
	vi.restoreAllMocks()
})

function device(name: string, encryption: { key?: string; keyring?: string } = {}): App {
	const app = createApp({
		schema,
		store: { adapter: 'better-sqlite3', name: join(dir, `${name}.db`) },
		sync: {
			url: 'ws://memory',
			encryption: { enabled: true, kdfIterations: 1000, ...encryption },
		},
	})
	apps.push(app)
	return app
}

const notes = (app: App): Notes => (app as unknown as { notes: Notes }).notes

async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (await check()) return
		await new Promise((r) => setTimeout(r, 20))
	}
	throw new Error(`timed out waiting for ${what}`)
}

async function connected(app: App): Promise<void> {
	await app.ready
	await app.sync?.connect()
	await until(() => app.getSyncEngine()?.getState() === 'streaming', 'streaming')
}

const stored = (recordId: string) =>
	serverStore.getAllOperations().filter((op) => op.recordId === recordId)

describe('ENC-1: shared key material through createApp', () => {
	test('a second device of the same user decrypts everything; the server sees only ciphertext', async () => {
		const a1 = device('a1', { key: 'alice passphrase' })
		const a2 = device('a2', { key: 'alice passphrase' })
		await connected(a1)
		const row = await notes(a1).insert({ body: 'top secret' })
		await until(() => stored(row.id).length > 0, 'upload')
		expect(JSON.stringify(stored(row.id))).not.toContain('top secret')
		expect(stored(row.id)[0]?.encrypted?.keyId).toBe(a1.encryption?.getStatus().keyId)

		await connected(a2)
		await until(async () => (await notes(a2).findById(row.id)) !== null, 'decrypt on a2')
		expect((await notes(a2).findById(row.id))?.body).toBe('top secret')
		expect(a2.encryption?.getStatus()).toMatchObject({ state: 'unlocked', keyVersion: 1 })
		// The server holds the wrapped record, never the passphrase.
		const json = await serverStore.getEncryptionKeyRecord('*', 'default')
		expect(json).not.toBeNull()
		expect(json).not.toContain('alice passphrase')
	}, 20000)

	test('a different keyring (another scope) cannot read the first one', async () => {
		const a = device('a', { key: 'same words' })
		const other = device('other', { key: 'same words', keyring: 'other' })
		await connected(a)
		const row = await notes(a).insert({ body: 'for the default keyring only' })
		await until(() => stored(row.id).length > 0, 'upload')

		const failures: string[] = []
		other.events.on('sync:apply-failed', (event) => failures.push(event.operationId))
		await other.ready
		await other.sync?.connect()
		await until(() => failures.length > 0, 'quarantined')
		expect(await notes(other).findById(row.id)).toBeNull()
		expect(other.encryption?.getStatus().keyId).not.toBe(a.encryption?.getStatus().keyId)
	}, 20000)

	test('locked: nothing leaves the device until unlock; then it syncs encrypted', async () => {
		const a1 = device('a1', { key: 'pw' })
		await connected(a1)
		const locked = device('a2') // no passphrase configured
		await locked.ready
		const suspended: string[] = []
		locked.on('sync:suspended', (event) => suspended.push(event.reason))
		const row = await notes(locked).insert({ body: 'written while locked' })
		await locked.sync?.connect()
		expect(locked.encryption?.getStatus().state).toBe('locked')
		expect(suspended).toContain('encryption-locked')
		expect(stored(row.id)).toHaveLength(0)
		// useSyncStatus & co: a locked keyring is a suspension the user can act on (enter
		// the passphrase), not a plain "offline".
		expect(locked.getSyncEngine()?.getStatus()).toMatchObject({
			status: 'encryption-locked',
			phase: 'suspended',
			reason: 'encryption-locked',
		})
		await expect(locked.sync?.waitForSettled({ timeoutMs: 1000 })).resolves.toMatchObject({
			outcome: 'suspended',
			reason: 'encryption-locked',
		})

		await expect(locked.encryption?.unlock('wrong')).resolves.toMatchObject({
			code: 'AWAITING_SERVER',
		})
		await until(() => locked.encryption?.getStatus().code === 'WRONG_PASSPHRASE', 'wrong pw')
		expect(stored(row.id)).toHaveLength(0)

		await locked.encryption?.unlock('pw')
		await until(() => stored(row.id).length > 0, 'upload after unlock')
		expect(stored(row.id)[0]?.encrypted).toBeDefined()
		await until(async () => (await notes(a1).findById(row.id)) !== null, 'a1 receives')
	}, 20000)

	test('offline after unlock: local writes queue and sync encrypted on reconnect', async () => {
		const a1 = device('a1', { key: 'pw' })
		const a2 = device('a2', { key: 'pw' })
		await connected(a1)
		await connected(a2)
		await a1.sync?.disconnect()
		const row = await notes(a1).insert({ body: 'offline note' })
		expect(a1.encryption?.getStatus().state).toBe('unlocked')
		expect(stored(row.id)).toHaveLength(0)
		await a1.sync?.connect()
		await until(async () => (await notes(a2).findById(row.id)) !== null, 'a2 receives')
		expect((await notes(a2).findById(row.id))?.body).toBe('offline note')
	}, 20000)

	test('rotation mid-stream: the other device adopts the new key before its operations', async () => {
		const a1 = device('a1', { key: 'pw' })
		const a2 = device('a2', { key: 'pw' })
		await connected(a1)
		await connected(a2)
		const before = await notes(a1).insert({ body: 'v1 note' })
		await until(async () => (await notes(a2).findById(before.id)) !== null, 'v1 on a2')

		await a1.encryption?.rotateKey()
		const after = await notes(a1).insert({ body: 'v2 note' })
		await until(() => stored(after.id).length > 0, 'v2 upload')
		expect(stored(after.id)[0]?.encrypted?.keyVersion).toBe(2)
		await until(async () => (await notes(a2).findById(after.id)) !== null, 'v2 on a2')
		expect(a2.encryption?.getStatus()).toMatchObject({ keyVersion: 2, availableVersions: [1, 2] })

		// A new device opens both versions.
		const a3 = device('a3', { key: 'pw' })
		await connected(a3)
		await until(async () => (await notes(a3).findById(before.id)) !== null, 'v1 on a3')
		expect((await notes(a3).findById(after.id))?.body).toBe('v2 note')
	}, 20000)

	test('passphrase change: no re-encryption; the old passphrase no longer opens the keyring', async () => {
		const a1 = device('a1', { key: 'old pw' })
		await connected(a1)
		const row = await notes(a1).insert({ body: 'kept readable' })
		await until(() => stored(row.id).length > 0, 'upload')
		const ciphertext = JSON.stringify(stored(row.id)[0]?.encrypted)
		await a1.encryption?.changePassphrase('new pw', { currentPassphrase: 'old pw' })
		expect(JSON.stringify(stored(row.id)[0]?.encrypted)).toBe(ciphertext)

		const stale = device('a2', { key: 'old pw' })
		await stale.ready
		await stale.sync?.connect()
		await until(() => stale.encryption?.getStatus().code === 'WRONG_PASSPHRASE', 'refused')
		await stale.encryption?.unlock('new pw')
		await until(async () => (await notes(stale).findById(row.id)) !== null, 'readable')
	}, 20000)
})

describe('ENC-1: key records are per authenticated user', () => {
	const B64_12 = 'AAAAAAAAAAAAAAAA'
	const record = (salt: string) => ({
		format: 1 as const,
		keyring: 'default',
		revision: 1,
		currentVersion: 1,
		kdf: { name: 'PBKDF2' as const, hash: 'SHA-256' as const, iterations: 1000, salt },
		keys: [
			{ keyVersion: 1, keyId: `k2-${'a'.repeat(32)}`, iv: B64_12, wrappedKey: 'A'.repeat(64) },
		],
	})

	async function session(token: string) {
		const pair = createServerTransportPair()
		const inbox: SyncMessage[] = []
		pair.client.onMessage((m) => inbox.push(m))
		server.handleConnection(pair.server)
		pair.client.send({
			type: 'handshake',
			messageId: `h-${token}`,
			nodeId: `node-${token}`,
			versionVector: {},
			schemaVersion: 1,
			authToken: token,
			protocolVersion: 2,
			sequenceReservation: true,
		})
		await until(() => inbox.some((m) => m.type === 'handshake-response'), 'handshake')
		let n = 0
		const ask = async (message: Record<string, unknown>) => {
			const requestId = `r-${token}-${n++}`
			pair.client.send({
				...message,
				messageId: requestId,
				requestId,
				keyring: 'default',
			} as SyncMessage)
			await until(
				() => inbox.some((m) => m.type === 'encryption-key-response' && m.requestId === requestId),
				'key response',
			)
			return inbox.find(
				(m) => m.type === 'encryption-key-response' && m.requestId === requestId,
			) as Extract<SyncMessage, { type: 'encryption-key-response' }>
		}
		return { inbox, ask }
	}

	test('a session reads and writes only its own user record; others get theirs', async () => {
		await server.stop()
		serverStore = new MemoryServerStore()
		server = new KoraSyncServer({
			store: serverStore,
			auth: new TokenAuthProvider({ validate: async (token) => ({ userId: token }) }),
		})
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const alice = await session('alice')
		const aliceSalt = `${'A'.repeat(43)}=`
		expect(
			(
				await alice.ask({
					type: 'encryption-key-put',
					record: record(aliceSalt),
					expectedRevision: 0,
				})
			).status,
		).toBe('ok')

		const bob = await session('bob')
		// Bob cannot name Alice: his request is answered with his own (absent) record.
		expect((await bob.ask({ type: 'encryption-key-request' })).record).toBeNull()
		const bobSalt = `${'B'.repeat(43)}=`
		expect(
			(await bob.ask({ type: 'encryption-key-put', record: record(bobSalt), expectedRevision: 0 }))
				.status,
		).toBe('ok')
		expect((await alice.ask({ type: 'encryption-key-request' })).record?.kdf.salt).toBe(aliceSalt)
		expect((await bob.ask({ type: 'encryption-key-request' })).record?.kdf.salt).toBe(bobSalt)

		// A second session of Alice gets the record pushed when the first one rotates.
		const alice2 = await session('alice')
		const rotated = {
			...record(aliceSalt),
			revision: 2,
			currentVersion: 2,
			keys: [
				...record(aliceSalt).keys,
				{ keyVersion: 2, keyId: `k2-${'b'.repeat(32)}`, iv: B64_12, wrappedKey: 'A'.repeat(64) },
			],
		}
		expect(
			(await alice.ask({ type: 'encryption-key-put', record: rotated, expectedRevision: 1 }))
				.status,
		).toBe('ok')
		await until(
			() =>
				alice2.inbox.some((m) => m.type === 'encryption-key-response' && m.requestId === undefined),
			'push to sibling',
		)
		expect(
			bob.inbox.some((m) => m.type === 'encryption-key-response' && m.requestId === undefined),
		).toBe(false)
	})
})
