/**
 * `@korajs/spaces` end to end: real devices syncing with a server that serves the
 * spaces routes. Accepting an invitation resolves once the member's own device holds the
 * membership, the space's records follow, and a removal takes them away again.
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
import { spacesCollections } from '@korajs/spaces'
import { type SpacesAppLike, SpacesOfflineError, createSpaces } from '@korajs/spaces/client'
import { type InvitationDelivery, spacesRoutes } from '@korajs/spaces/server'
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

const sharing = spacesCollections({
	roles: ['viewer', 'editor', 'admin', 'owner'],
	ownerRole: 'owner',
	manageRole: 'admin',
	groups: { forms: { owner: 'ownerId' } },
})

const schema = defineSchema({
	version: 1,
	access: sharing.access,
	collections: {
		...sharing.collections,
		forms: {
			fields: { title: t.string(), ownerId: t.string().stamp('userId') },
			access: {
				read: member('id'),
				create: owner('ownerId'),
				update: member('id', 'editor'),
				delete: member('id', 'owner'),
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

const EMAILS: Record<string, string> = { ann: 'ann@example.com', bob: 'bob@example.com' }

let net: Net | null = null
afterEach(async () => {
	await net?.close()
	net = null
})

async function setup() {
	net = new Net(schema)
	await net.open()
	const server = net.server
	const sent: InvitationDelivery[] = []
	const route = spacesRoutes({
		sharing,
		identify: (request) => {
			const header = request.headers?.authorization
			const user = typeof header === 'string' ? header.replace(/^Bearer /, '') : ''
			return EMAILS[user] ? { userId: user, email: EMAILS[user], emailVerified: true } : null
		},
		acceptUrl: (token) => `https://app.test/invite#${token}`,
		deliverInvitation: (delivery) => {
			sent.push(delivery)
		},
	})
	/** The client of `user`, talking to the route in process. */
	const clientOf = (device: Device, user: string) => {
		const app: SpacesAppLike = {
			collections: new Proxy({} as SpacesAppLike['collections'], {
				get: (_, name) => device.store.collection(String(name)),
			}),
		}
		const routeFetch: typeof fetch = async (input, init) => {
			const url = new URL(String(input), 'http://app.test')
			const response = await route.handle({
				method: init?.method ?? 'GET',
				path: url.pathname,
				body: JSON.parse(String(init?.body ?? 'null')),
				headers: { authorization: `Bearer ${user}` },
				kora: server.getKoraContext(),
				access: server.access,
			})
			return new Response(JSON.stringify(response.body), {
				status: response.status,
				headers: { 'content-type': 'application/json' },
			})
		}
		return createSpaces(app, { fetch: routeFetch })
	}
	const ann = await net.device('ann', 'ann')
	await ann.connect()
	const form = (await ann.store.collection('forms').insert({ title: 'Survey' })) as { id: string }
	await settle()
	const bob = await net.device('bob', 'bob')
	await bob.connect()
	const tokenOf = (email: string): string => {
		const delivery = [...sent].reverse().find((d) => d.email === email)
		if (!delivery) throw new Error(`nothing sent to ${email}`)
		return delivery.url.slice(delivery.url.indexOf('#') + 1)
	}
	return {
		net,
		ann,
		bob,
		form: form.id,
		annSpaces: clientOf(ann, 'ann'),
		bobSpaces: clientOf(bob, 'bob'),
		tokenOf,
	}
}

describe('sharing between devices', () => {
	test('accepting resolves once the member’s device has the membership, and the space follows', async () => {
		const { ann, bob, form, annSpaces, bobSpaces, tokenOf } = await setup()
		expect(await bob.ids('forms')).toEqual([])

		await annSpaces.invite(['forms', form], { email: 'bob@example.com', role: 'editor' })
		await settle()
		// The manager's device holds the pending invitation (with the address), the invitee's does not.
		expect(await ann.ids('space_invitations')).toHaveLength(1)
		expect(await bob.ids('space_invitations')).toEqual([])
		// Secrets never reach a device.
		expect(await ann.ids('space_invitation_secrets')).toEqual([])

		const accepted = await bobSpaces.accept(tokenOf('bob@example.com'), { timeoutMs: 5000 })
		expect(accepted).toMatchObject({
			space: ['forms', form],
			role: 'editor',
			userId: 'bob',
			pending: false,
		})
		const mine = await bob.store.collection('space_members').where({ userId: 'bob' }).exec()
		expect(mine).toHaveLength(1)
		await settle()
		expect(await bob.ids('forms')).toEqual([form])
		expect(await ann.ids('space_members')).toHaveLength(1)
		expect(await ann.ids('space_invitations')).toEqual([])

		// The editor can edit the form now.
		await bob.store.collection('forms').update(form, { title: 'Survey (edited)' })
		await settle()
		const [onAnn] = (await ann.store.collection('forms').where({ id: form }).exec()) as Array<{
			title: string
		}>
		expect(onAnn?.title).toBe('Survey (edited)')

		// Removed: the space leaves bob's device.
		await annSpaces.remove(['forms', form], 'bob')
		await settle()
		expect(await bob.ids('forms')).toEqual([])
		expect(await bob.ids('space_members')).toEqual([])
	})

	test('accept reports pending when the membership has not reached the device yet', async () => {
		const { bob, form, annSpaces, bobSpaces, tokenOf } = await setup()
		await annSpaces.invite(['forms', form], { email: 'bob@example.com', role: 'viewer' })
		await bob.disconnect()
		const accepted = await bobSpaces.accept(tokenOf('bob@example.com'), { timeoutMs: 150 })
		expect(accepted.pending).toBe(true)
		await bob.connect()
		expect(await bob.ids('forms')).toEqual([form])
	})

	test('a network failure is SpacesOfflineError, and nothing is queued', async () => {
		const offline = createSpaces(
			{ collections: {} },
			{
				fetch: async () => {
					throw new TypeError('Failed to fetch')
				},
			},
		)
		await expect(
			offline.invite(['forms', 'f1'], { email: 'a@example.com', role: 'viewer' }),
		).rejects.toBeInstanceOf(SpacesOfflineError)
	})
})
