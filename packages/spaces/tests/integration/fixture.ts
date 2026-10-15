import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, member, owner, t } from '@korajs/core'
import {
	type KoraSyncServer,
	MemoryServerStore,
	type ProductionHttpRouteResponse,
	type ServerStore,
	createKoraServer,
	createPostgresServerStore,
	createSqliteServerStore,
} from '@korajs/server'
import postgres from 'postgres'
import { type Sharing, spacesCollections } from '../../src/index'
import type { InvitationDelivery, SpacesEvent, SpacesRoutesOptions } from '../../src/server'
import { spacesRoutes } from '../../src/server'

export const sharing = spacesCollections({
	roles: ['viewer', 'editor', 'admin', 'owner'],
	ownerRole: 'owner',
	manageRole: 'admin',
	groups: { forms: { owner: 'ownerId' } },
})

/** The app schema around a sharing configuration: one shared collection, `forms`. */
export function schemaFor(config: Sharing) {
	return defineSchema({
		version: 1,
		access: config.access,
		collections: {
			...config.collections,
			forms: {
				fields: { title: t.string(), ownerId: t.string().stamp('userId') },
				access: {
					read: member('id'),
					create: owner('ownerId'),
					update: member('id', config.roles[1] ?? config.ownerRole),
					delete: member('id', config.ownerRole),
				},
			},
		},
	})
}

export const schema = schemaFor(sharing)

/** Postgres for the cross-instance runs (`KORA_PG_TEST_URL`); skipped without it. */
export const PG_URL = process.env.KORA_PG_TEST_URL

/** A signed-in test user: id, email, verified. */
export interface TestUser {
	id: string
	email: string
	emailVerified: boolean
}

export const USERS: Record<string, TestUser> = {
	ann: { id: 'ann', email: 'ann@example.com', emailVerified: true },
	bob: { id: 'bob', email: 'bob@example.com', emailVerified: true },
	cat: { id: 'cat', email: 'cat@example.com', emailVerified: true },
	dan: { id: 'dan', email: 'dan@example.com', emailVerified: true },
	eve: { id: 'eve', email: 'eve@example.com', emailVerified: false },
}

export type StoreKind = 'memory' | 'sqlite' | 'postgres'

/** The store kinds to run on: memory and SQLite always, Postgres with `KORA_PG_TEST_URL`. */
export const STORE_KINDS: StoreKind[] = PG_URL
	? ['memory', 'sqlite', 'postgres']
	: ['memory', 'sqlite']

interface Instance {
	server: KoraSyncServer
	store: ServerStore
	route: ReturnType<typeof spacesRoutes>
}

export interface Harness {
	/** The first instance (the one setup writes go through). */
	server: KoraSyncServer
	store: ServerStore
	/** Number of server instances sharing the database. */
	instances: number
	sent: InvitationDelivery[]
	events: SpacesEvent[]
	/** POST to a spaces route as `user` (or anonymously), on instance `instance`. */
	call(
		user: string | null,
		path: string,
		body: unknown,
		instance?: number,
	): Promise<ProductionHttpRouteResponse>
	/** The token of the last invitation sent to `email`. */
	tokenFor(email: string): string
	/** Create a form owned by `ownerId` (a server write, as a synced device's insert would be). */
	createForm(id: string, ownerId: string): Promise<void>
	roleOf(userId: string, formId: string): Promise<string | null>
	/** Invite and accept in one go. */
	join(inviter: string, user: string, formId: string, role: string): Promise<void>
	close(): Promise<void>
}

/**
 * A server (or several instances sharing one database: two SQLite connections on one
 * file, or Postgres instances on one database) serving the spaces routes.
 */
export async function createHarness(
	kind: StoreKind,
	overrides: Partial<SpacesRoutesOptions> = {},
	options: { instances?: number; sharing?: Sharing } = {},
): Promise<Harness> {
	const count = kind === 'memory' ? 1 : (options.instances ?? 1)
	const cleanups: Array<() => Promise<void>> = []
	const stores: ServerStore[] = []
	if (kind === 'memory') {
		stores.push(new MemoryServerStore())
	} else if (kind === 'sqlite') {
		const dir = mkdtempSync(join(tmpdir(), 'kora-spaces-'))
		cleanups.push(async () => rmSync(dir, { recursive: true, force: true }))
		for (let i = 0; i < count; i++)
			stores.push(createSqliteServerStore({ filename: join(dir, 'server.db') }))
	} else {
		const database = `kora_spaces_${randomBytes(6).toString('hex')}`
		const admin = postgres(PG_URL as string, { max: 1, onnotice: () => {} })
		await admin.unsafe(`CREATE DATABASE ${database}`)
		const url = new URL(PG_URL as string)
		url.pathname = `/${database}`
		cleanups.push(async () => {
			await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
			await admin.end()
		})
		for (let i = 0; i < count; i++) {
			stores.push(
				await createPostgresServerStore({ connectionString: url.toString(), instanceId: `i${i}` }),
			)
		}
	}
	const sent: InvitationDelivery[] = []
	const events: SpacesEvent[] = []
	const instances: Instance[] = []
	for (const store of stores) {
		await store.setSchema(options.sharing ? schemaFor(options.sharing) : schema, {})
		const server = createKoraServer({
			store,
			accessSweepIntervalMs: 0,
		})
		const route = spacesRoutes({
			sharing: options.sharing ?? sharing,
			identify: (request) => {
				const header = request.headers?.authorization
				const name = typeof header === 'string' ? header.replace(/^Bearer /, '') : ''
				const user = USERS[name]
				return user
					? { userId: user.id, email: user.email, emailVerified: user.emailVerified }
					: null
			},
			findUserByEmail: (email) =>
				Object.values(USERS).find((user) => user.email === email)?.id ?? null,
			acceptUrl: (token) => `https://app.test/invite#${token}`,
			deliverInvitation: (delivery) => {
				sent.push(delivery)
			},
			onEvent: (event) => {
				events.push(event)
			},
			limits: { requestsPerUserPerMinute: false, perRecipientPerDay: false },
			...overrides,
		})
		instances.push({ server, store, route })
	}
	const first = instances[0] as Instance
	const kora = first.server.getKoraContext()
	const harness: Harness = {
		server: first.server,
		store: first.store,
		instances: instances.length,
		sent,
		events,
		call: (user, path, body, index = 0) => {
			const instance = instances[index % instances.length] as Instance
			return instance.route.handle({
				method: 'POST',
				path: `/api/spaces${path}`,
				body,
				headers: user ? { authorization: `Bearer ${user}` } : {},
				kora: instance.server.getKoraContext(),
				access: instance.server.access,
			})
		},
		tokenFor(email) {
			const delivery = [...sent].reverse().find((d) => d.email === email)
			if (!delivery) throw new Error(`no invitation sent to ${email}`)
			return delivery.url.slice(delivery.url.indexOf('#') + 1)
		},
		async createForm(id, ownerId) {
			const result = await kora.apply({
				collection: 'forms',
				type: 'insert',
				recordId: id,
				data: { title: id, ownerId },
			})
			if (!result.ok) throw new Error(`createForm: ${result.code} ${result.message}`)
		},
		async roleOf(userId, formId) {
			return (await first.server.access.roleOf(userId, ['forms', formId]))?.role ?? null
		},
		async join(inviter, user, formId, role) {
			const email = USERS[user]?.email ?? ''
			const invited = await harness.call(inviter, '/invitations/create', {
				space: ['forms', formId],
				email,
				role,
			})
			if (invited.status !== 200) throw new Error(`invite: ${JSON.stringify(invited.body)}`)
			const accepted = await harness.call(user, '/invitations/accept', {
				token: harness.tokenFor(email),
			})
			if (accepted.status !== 200) throw new Error(`accept: ${JSON.stringify(accepted.body)}`)
		},
		async close() {
			for (const instance of instances) {
				await instance.server.stop?.()
				await instance.store.close?.()
			}
			for (const cleanup of cleanups) await cleanup()
		},
	}
	return harness
}

/** The error code of a failed response, or null. */
export function codeOf(response: ProductionHttpRouteResponse): string | null {
	const body = response.body as { error?: { code?: string } } | undefined
	return body?.error?.code ?? null
}
