/**
 * Access rules, end to end (beta.15 access step 5): what a real device holds follows
 * membership changes made while it was away, judged on the device's own records.
 *
 * - A group revoked and granted again: records deleted in between are gone.
 * - A record moved to a group the user is not in while they were revoked: gone.
 * - A role changed in place (no revoke): a downgrade removes what the old role read,
 *   an upgrade brings what the new role reads.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { anyone, defineSchema, member, memberOfKey, owner, t } from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { MergeEngine } from '@korajs/merge'
import { KoraSyncServer, MemoryServerStore, TokenAuthProvider } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { SyncEngine } from '@korajs/sync'
import type { SyncTransport } from '@korajs/sync'
import {
	ApplyPipeline,
	MergeAwareSyncStore,
	StoreQueueStorage,
	StoreSyncStatePersistence,
} from 'korajs/testing'
import { afterEach, describe, expect, test } from 'vitest'

const schema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'edit', 'manage'],
		groups: { documents: { owner: 'ownerId', role: 'manage' } },
	},
	collections: {
		members: {
			fields: { userId: t.string(), group: t.string(), role: t.string() },
			access: { read: memberOfKey('group', 'manage') },
		},
		documents: {
			fields: { title: t.string(), ownerId: t.string().stamp('userId') },
			access: {
				read: member('id'),
				create: owner('ownerId'),
				update: member('id', 'edit'),
				delete: member('id', 'manage'),
			},
		},
		comments: {
			fields: { documentId: t.string(), body: t.string() },
			access: {
				read: member('documentId', 'view', { group: 'documents' }),
				create: member('documentId', 'view', { group: 'documents' }),
				update: member('documentId', 'view', { group: 'documents' }),
				delete: member('documentId', 'view', { group: 'documents' }),
			},
		},
		drafts: {
			fields: { documentId: t.string(), body: t.string() },
			access: {
				read: member('documentId', 'edit', { group: 'documents' }),
				create: member('documentId', 'edit', { group: 'documents' }),
				// Broader than read: an accepted write does not mean the writer may read.
				update: anyone({ writes: true }),
			},
		},
	},
})

const settle = async (n = 15): Promise<void> => {
	for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 20))
}

class Net {
	readonly tmp = mkdtempSync(join(tmpdir(), 'access-e2e-'))
	readonly serverStore = new MemoryServerStore()
	readonly server: KoraSyncServer
	readonly devices: Device[] = []

	constructor(readonly schema: SchemaDefinition) {
		this.server = new KoraSyncServer({
			store: this.serverStore,
			schemaVersion: schema.version,
			supportedSchemaVersions: { min: schema.version, max: schema.version },
			auth: new TokenAuthProvider({
				validate: async (token) => ({ userId: token }),
			}),
			experimentalAccessRules: true,
		})
	}

	async open(): Promise<void> {
		await this.serverStore.setSchema(this.schema, { accessRulesEnforced: true })
	}

	async device(name: string, user: string): Promise<Device> {
		const device = new Device(this, name, user)
		await device.open()
		this.devices.push(device)
		return device
	}

	async close(): Promise<void> {
		for (const device of this.devices) await device.close().catch(() => {})
		await this.server.stop().catch(() => {})
		rmSync(this.tmp, { recursive: true, force: true })
	}
}

class Device {
	readonly emitter = new SimpleEventEmitter()
	readonly store: Store
	readonly adapter: BetterSqlite3Adapter
	readonly merge = new MergeEngine()
	private engine: SyncEngine | null = null
	private unsub: (() => void) | null = null

	constructor(
		private readonly net: Net,
		name: string,
		private readonly user: string,
	) {
		this.adapter = new BetterSqlite3Adapter(join(net.tmp, `${name}.db`))
		this.store = new Store({ schema: net.schema, adapter: this.adapter, emitter: this.emitter })
	}

	async open(): Promise<void> {
		await this.store.open()
		this.store.setLocalMutationHandler(
			new ApplyPipeline({ store: this.store, mergeEngine: this.merge, emitter: this.emitter }),
		)
	}

	async connect(): Promise<void> {
		const pair = createServerTransportPair()
		const client = pair.client as unknown as SyncTransport
		const engine = new SyncEngine({
			transport: client,
			store: new MergeAwareSyncStore(this.store, this.merge, this.emitter),
			queueStorage: new StoreQueueStorage(this.adapter),
			syncState: new StoreSyncStatePersistence(this.store),
			config: {
				url: 'ws://test',
				schemaVersion: this.net.schema.version,
				auth: async () => ({ token: this.user }),
			},
			emitter: this.emitter,
		})
		this.engine = engine
		this.unsub = this.emitter.on('operation:created', (e: { operation: Operation }) => {
			if (this.engine === engine && client.isConnected())
				engine.pushOperation(e.operation).catch(() => {})
		})
		this.net.server.handleConnection(pair.server)
		await engine.start()
		await settle()
	}

	async disconnect(): Promise<void> {
		this.unsub?.()
		this.unsub = null
		await this.engine?.stop().catch(() => {})
		this.engine = null
		await settle(3)
	}

	async ids(collection: string): Promise<string[]> {
		const rows = (await this.store.collection(collection).where({}).exec()) as Array<{
			id: string
		}>
		return rows.map((row) => row.id).sort()
	}

	async close(): Promise<void> {
		await this.disconnect()
		await this.store.close()
	}
}

let net: Net | null = null
afterEach(async () => {
	await net?.close()
	net = null
})

async function setup() {
	net = new Net(schema)
	await net.open()
	const ann = await net.device('ann', 'ann')
	await ann.connect()
	const docs = ann.store.collection('documents')
	const d1 = (await docs.insert({ title: 'one', ownerId: 'ann' })) as { id: string }
	const d2 = (await docs.insert({ title: 'two', ownerId: 'ann' })) as { id: string }
	const comments = ann.store.collection('comments')
	const c1 = (await comments.insert({ documentId: d1.id, body: 'a' })) as { id: string }
	const c2 = (await comments.insert({ documentId: d1.id, body: 'b' })) as { id: string }
	const s1 = (await ann.store
		.collection('drafts')
		.insert({ documentId: d1.id, body: 'secret' })) as { id: string }
	await settle()
	return { net, ann, d1: d1.id, d2: d2.id, c1: c1.id, c2: c2.id, s1: s1.id }
}

describe('a device follows membership changes made while it was away', () => {
	test('revoked and granted again: a record deleted in between is gone', async () => {
		const { net, ann, d1, c1, c2 } = await setup()
		await net.server.access.grant({ userId: 'bob', group: ['documents', d1], role: 'view' })
		const bob = await net.device('bob', 'bob')
		await bob.connect()
		expect(await bob.ids('comments')).toEqual([c1, c2].sort())
		// The device keeps the key of the rules it was re-scoped under.
		expect(await bob.store.loadAccessRulesKey()).toMatch(/^[0-9a-f]{32}$/)
		await bob.disconnect()

		await net.server.access.revoke({ userId: 'bob', group: ['documents', d1] })
		await ann.store.collection('comments').delete(c2)
		await settle()
		await net.server.access.grant({ userId: 'bob', group: ['documents', d1], role: 'view' })

		await bob.connect()
		expect(await bob.ids('comments')).toEqual([c1])
		expect(await bob.ids('documents')).toEqual([d1])
	})

	test('a record moved to another group while revoked is gone', async () => {
		const { net, d1, d2, c1, c2 } = await setup()
		await net.server.access.grant({ userId: 'bob', group: ['documents', d1], role: 'view' })
		const bob = await net.device('bob', 'bob')
		await bob.connect()
		await bob.disconnect()

		await net.server.access.revoke({ userId: 'bob', group: ['documents', d1] })
		// Access fields move only on the server.
		await net.server.getKoraContext().apply({
			collection: 'comments',
			type: 'update',
			recordId: c1,
			data: { documentId: d2 },
		})
		await settle()

		await bob.connect()
		expect(await bob.ids('comments')).toEqual([])
		expect(await bob.ids('documents')).toEqual([])

		// Granted again: what is in d1 now, not what was.
		await net.server.access.grant({ userId: 'bob', group: ['documents', d1], role: 'view' })
		await settle()
		expect(await bob.ids('comments')).toEqual([c2])
	})

	test('a record kept for an unsent edit is removed once the edit is refused', async () => {
		const { net, d1, c1, c2 } = await setup()
		await net.server.access.grant({ userId: 'bob', group: ['documents', d1], role: 'view' })
		const bob = await net.device('bob', 'bob')
		await bob.connect()
		await bob.disconnect()

		await bob.store.collection('comments').update(c1, { body: 'edited offline' })
		await net.server.access.revoke({ userId: 'bob', group: ['documents', d1] })

		await bob.connect()
		await settle()
		expect(await bob.ids('comments')).toEqual([])
		expect(await bob.ids('documents')).toEqual([])
		expect(c2).toBeTruthy()
	})

	test('a role downgraded in place removes what only the old role could read', async () => {
		const { net, d1, s1 } = await setup()
		await net.server.access.grant({ userId: 'bob', group: ['documents', d1], role: 'edit' })
		const bob = await net.device('bob', 'bob')
		await bob.connect()
		expect(await bob.ids('drafts')).toEqual([s1])
		await bob.disconnect()

		await net.server.access.grant({ userId: 'bob', group: ['documents', d1], role: 'view' })
		await bob.connect()
		expect(await bob.ids('drafts')).toEqual([])
		expect(await bob.ids('documents')).toEqual([d1])
	})

	test('an unsent edit accepted under a broader write rule does not keep the record', async () => {
		const { net, d1, s1 } = await setup()
		await net.server.access.grant({ userId: 'bob', group: ['documents', d1], role: 'edit' })
		const bob = await net.device('bob', 'bob')
		await bob.connect()
		expect(await bob.ids('drafts')).toEqual([s1])
		await bob.disconnect()

		await bob.store.collection('drafts').update(s1, { body: 'edited offline' })
		await net.server.access.grant({ userId: 'bob', group: ['documents', d1], role: 'view' })

		await bob.connect()
		await settle()
		expect(await bob.ids('drafts')).toEqual([])
		const ann = net.devices[0]
		expect(
			((await ann?.store.collection('drafts').findById(s1)) as { body?: string } | null)?.body,
		).toBe('edited offline')
	})

	test('a role upgraded in place brings what the new role reads', async () => {
		const { net, d1, s1 } = await setup()
		await net.server.access.grant({ userId: 'bob', group: ['documents', d1], role: 'view' })
		const bob = await net.device('bob', 'bob')
		await bob.connect()
		expect(await bob.ids('drafts')).toEqual([])
		await bob.disconnect()

		await net.server.access.grant({ userId: 'bob', group: ['documents', d1], role: 'edit' })
		await bob.connect()
		expect(await bob.ids('drafts')).toEqual([s1])
	})

	test('a connected device follows a revoke, then a regrant, without reconnecting', async () => {
		const { net, ann, d1, c1, c2 } = await setup()
		await net.server.access.grant({ userId: 'bob', group: ['documents', d1], role: 'view' })
		const bob = await net.device('bob', 'bob')
		await bob.connect()
		await net.server.access.revoke({ userId: 'bob', group: ['documents', d1] })
		await settle()
		expect(await bob.ids('comments')).toEqual([])
		await ann.store.collection('comments').delete(c2)
		await net.server.access.grant({ userId: 'bob', group: ['documents', d1], role: 'view' })
		await settle()
		expect(await bob.ids('comments')).toEqual([c1])
	})
})
