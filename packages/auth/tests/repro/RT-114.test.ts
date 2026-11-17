/**
 * RT-114 repro (audit 2026-11-16): RBAC sync scopes do not work end to end.
 *
 * `RbacEngine.resolveScopes` and `OrgScopeResolver.resolve` mark a read-only grant by adding
 * `__readonly: true` to the scope filter. The sync server treats every key of a scope as a
 * field filter, so a viewer only matches records whose `__readonly` field is `true`: it
 * syncs nothing, and its writes are refused only by accident. `'*:read'` is also checked
 * literally, so a role granted `todos:read` (no wildcard) gets no scope at all.
 *
 * Asserts the CORRECT behaviour (fails before the fix), through the documented wiring
 * (`createKoraAuthServer({ resolveScopes })` -> `KoraSyncServer`): a viewer downloads the
 * organisation's records and cannot upload; a member can upload; a role granted only
 * `todos:read` downloads todos (not projects) and cannot upload; a role granted
 * `todos:write` uploads todos but not projects.
 */
import { createHash } from 'node:crypto'
import type { Operation } from '@korajs/core'
import { HybridLogicalClock, defineSchema, t } from '@korajs/core'
import { canonicalize } from '@korajs/core/internal'
import { KoraSyncServer, MemoryServerStore } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { InMemoryOrgStore } from '../../src/org/org-store'
import { createKoraAuthServer } from '../../src/provider/built-in/quickstart-server'
import { RbacEngine, defineRoles } from '../../src/rbac/rbac-engine'

const SECRET = 'r'.repeat(64)

const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), orgId: t.string() }, scope: ['orgId'] },
		projects: { fields: { name: t.string(), orgId: t.string() }, scope: ['orgId'] },
	},
})

/** A version-1 content id: the server verifies every uploaded id. */
function withContentId(o: Operation): Operation {
	const input: Record<string, unknown> = {
		type: o.type,
		collection: o.collection,
		recordId: o.recordId,
		data: o.data,
		timestamp: HybridLogicalClock.serialize(o.timestamp),
		nodeId: o.nodeId,
	}
	return { ...o, id: createHash('sha256').update(canonicalize(input)).digest('hex') }
}

let counter = 0
function insert(nodeId: string, collection: string, data: Record<string, unknown>, seq: number) {
	counter++
	return withContentId({
		id: `op-${counter}`,
		nodeId,
		type: 'insert',
		collection,
		recordId: `rec-${nodeId}-${counter}`,
		data,
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: counter, nodeId },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
	})
}

type Auth = ReturnType<typeof createKoraAuthServer>

async function signUp(auth: Auth, email: string): Promise<{ userId: string; token: string }> {
	const res = await auth.handleRequest({
		method: 'POST',
		path: '/auth/signup',
		body: { email, password: 'password-123' },
		ip: '1.1.1.1',
	})
	const data = (res.body as { data: { user: { id: string }; tokens: { accessToken: string } } })
		.data
	return { userId: data.user.id, token: data.tokens.accessToken }
}

interface Client {
	messages: SyncMessage[]
	send(message: SyncMessage): void
}

function connect(server: KoraSyncServer): Client {
	const { client, server: transport } = createServerTransportPair()
	const messages: SyncMessage[] = []
	client.onMessage((m) => messages.push(m))
	server.handleConnection(transport)
	return { messages, send: (m) => client.send(m) }
}

async function handshake(c: Client, nodeId: string, token: string): Promise<void> {
	c.send({
		type: 'handshake',
		protocolVersion: 2,
		messageId: `hs-${nodeId}`,
		nodeId,
		versionVector: {},
		schemaVersion: 1,
		authToken: token,
	} as SyncMessage)
	await vi.waitFor(() =>
		expect(c.messages.some((m) => m.type === 'handshake-response' || m.type === 'error')).toBe(
			true,
		),
	)
	expect(c.messages.find((m) => m.type === 'error')).toBeUndefined()
}

/** Upload one operation and wait for the server's verdict on it. */
async function upload(c: Client, op: Operation): Promise<'accepted' | 'rejected'> {
	const messageId = `b-${op.id}`
	c.send({
		type: 'operation-batch',
		messageId,
		operations: [op],
		isFinal: true,
		batchIndex: 0,
	} as SyncMessage)
	await vi.waitFor(() =>
		expect(
			c.messages.some(
				(m) =>
					(m.type === 'operation-rejected' && m.operationId === op.id) ||
					(m.type === 'acknowledgment' && m.acknowledgedMessageId === messageId),
			),
		).toBe(true),
	)
	return c.messages.some((m) => m.type === 'operation-rejected' && m.operationId === op.id)
		? 'rejected'
		: 'accepted'
}

function receivedTitles(c: Client): string[] {
	return c.messages
		.flatMap((m) => (m.type === 'operation-batch' ? m.operations : []))
		.map((o) => String(o.data?.title ?? o.data?.name))
}

async function setup(rbac: (orgs: InMemoryOrgStore) => RbacEngine) {
	const orgs = new InMemoryOrgStore()
	const engine = rbac(orgs)
	let orgId = ''
	const auth = createKoraAuthServer({
		jwtSecret: SECRET,
		resolveScopes: async ({ userId }) =>
			(await engine.resolveScopes(userId, orgId, ['todos', 'projects'])) ?? {},
	})
	const owner = await signUp(auth, 'owner@example.com')
	orgId = (await orgs.createOrg(owner.userId, { name: 'Acme', slug: 'acme' })).id
	const store = new MemoryServerStore('server-1')
	await store.setSchema(schema)
	const server = new KoraSyncServer({ store, auth: auth.auth })

	// The owner (role owner, '*:*') seeds one todo and one project.
	const o = connect(server)
	await handshake(o, 'owner-dev', owner.token)
	expect(await upload(o, insert('owner-dev', 'todos', { title: 'todo-1', orgId }, 1))).toBe(
		'accepted',
	)
	expect(await upload(o, insert('owner-dev', 'projects', { name: 'project-1', orgId }, 2))).toBe(
		'accepted',
	)

	async function member(
		email: string,
		role: 'viewer' | 'member',
	): Promise<Client & { id: string }> {
		const user = await signUp(auth, email)
		await orgs.addMember(orgId, user.userId, role, owner.userId)
		const c = connect(server)
		const id = `${role}-${user.userId.slice(0, 6)}`
		await handshake(c, id, user.token)
		return { ...c, id }
	}
	return { orgId, member, store }
}

describe('RT-114: RBAC sync scopes work through a real server session', () => {
	test('built-in roles: a viewer downloads the org and cannot upload; a member uploads', async () => {
		const { orgId, member } = await setup((orgs) => new RbacEngine(orgs))

		const viewer = await member('viewer@example.com', 'viewer')
		await vi.waitFor(() => expect(receivedTitles(viewer).sort()).toEqual(['project-1', 'todo-1']))
		expect(await upload(viewer, insert(viewer.id, 'todos', { title: 'v', orgId }, 1))).toBe(
			'rejected',
		)

		const writer = await member('member@example.com', 'member')
		expect(await upload(writer, insert(writer.id, 'todos', { title: 'm', orgId }, 1))).toBe(
			'accepted',
		)
	})

	test('collection permissions: todos:read downloads todos only; todos:write uploads todos only', async () => {
		const roles = defineRoles()
			.role('viewer', ['todos:read'])
			.role('member', ['todos:write'], { inherits: ['viewer'] })
			.role('admin', ['org:manage-members'], { inherits: ['member'] })
			.role('owner', ['*:*'])
			.role('billing', ['org:billing'])
			.build()
		const { orgId, member } = await setup((orgs) => new RbacEngine(orgs, { roles }))

		const reader = await member('reader@example.com', 'viewer')
		await vi.waitFor(() => expect(receivedTitles(reader)).toEqual(['todo-1']))
		expect(await upload(reader, insert(reader.id, 'todos', { title: 'r', orgId }, 1))).toBe(
			'rejected',
		)

		const editor = await member('editor@example.com', 'member')
		expect(await upload(editor, insert(editor.id, 'todos', { title: 'e', orgId }, 1))).toBe(
			'accepted',
		)
		expect(await upload(editor, insert(editor.id, 'projects', { name: 'p', orgId }, 2))).toBe(
			'rejected',
		)
	})
})
