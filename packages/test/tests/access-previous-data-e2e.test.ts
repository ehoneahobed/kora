/**
 * Issue #78 item 1, end to end: a real device that is a member of the group a record is
 * moved INTO never receives the old group's content (in an operation's `previousData` or
 * anywhere in its local operation log), and still ends with exactly the record the server
 * holds, including after further edits of fields whose fold reads the writer's base
 * (an array and a counter).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, member, owner, t } from '@korajs/core'
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
import { afterEach, describe, expect, test, vi } from 'vitest'

const schema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'edit', 'manage'],
		groups: { documents: { owner: 'ownerId', role: 'manage' } },
	},
	collections: {
		members: { fields: { userId: t.string(), group: t.string(), role: t.string() } },
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
			fields: {
				documentId: t.string(),
				body: t.string(),
				tags: t.array(t.string()).default([]),
				votes: t.number().merge('counter').default(0),
			},
			access: {
				read: member('documentId', 'view', { group: 'documents' }),
				create: member('documentId', 'view', { group: 'documents' }),
				update: member('documentId', 'view', { group: 'documents' }),
				delete: member('documentId', 'view', { group: 'documents' }),
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
		})
	}

	async open(): Promise<void> {
		await this.serverStore.setSchema(this.schema)
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
		// The app knows its signed-in user (authClient), which stamps ownerId on insert.
		await this.store.bindPrincipal(this.user)
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

interface CommentRow {
	id: string
	documentId: string
	body: string
	tags: string[]
	votes: number
}

describe("a record moved into the member's group", () => {
	test('arrives without the old content and converges through later edits', async () => {
		net = new Net(schema)
		await net.open()
		const ann = await net.device('ann', 'ann')
		await ann.connect()
		const docs = ann.store.collection('documents')
		const d1 = (await docs.insert({ title: 'one' })) as { id: string }
		const d2 = (await docs.insert({ title: 'two' })) as { id: string }
		await settle()
		await net.server.access.grant({ userId: 'bob', group: ['documents', d1.id], role: 'view' })
		const bob = await net.device('bob', 'bob')
		await bob.connect()
		const context = net.server.getKoraContext()
		// The record is born in d2 (bob cannot read it), then moves into d1.
		const inserted = await context.apply({
			collection: 'comments',
			type: 'insert',
			data: { documentId: d2.id, body: 'D2-SECRET', tags: ['d2-tag'], votes: 7 },
		})
		expect(inserted.ok).toBe(true)
		const id = (inserted as { operation?: { recordId: string } }).operation?.recordId ?? ''
		expect(id).not.toBe('')
		await settle()
		expect(await bob.ids('comments')).toEqual([])
		await context.apply({
			collection: 'comments',
			type: 'update',
			recordId: id,
			data: { documentId: d1.id, body: 'moved', tags: ['d1-tag'], votes: 9 },
		})
		await settle()
		// Later edits of the base-reading fields, from the server and from ann's device.
		await context.apply({
			collection: 'comments',
			type: 'update',
			recordId: id,
			data: { tags: ['d1-tag', 'more'], votes: 12 },
		})
		await settle()
		await ann.store.collection('comments').update(id, { votes: 20, body: 'edited by ann' })
		await settle()

		const server = (
			await net.serverStore.queryCollection('comments', { where: { id } })
		)[0] as unknown as CommentRow
		const local = (await bob.store.collection('comments').findById(id)) as CommentRow | null
		expect(local).not.toBeNull()
		expect(local?.documentId).toBe(d1.id)
		expect(local?.body).toBe(server.body)
		expect(local?.votes).toBe(server.votes)
		expect([...(local?.tags ?? [])].sort()).toEqual([...(server.tags ?? [])].sort())

		// Nothing of the old group is in the device's operation log or rows.
		const logged = await bob.adapter.query<Record<string, unknown>>(
			'SELECT * FROM "_kora_ops_comments"',
		)
		expect(JSON.stringify(logged)).not.toContain('D2-SECRET')
		expect(JSON.stringify(logged)).not.toContain('"votes":7')
		expect(JSON.stringify(logged)).not.toContain('d2-tag')
	})
})
