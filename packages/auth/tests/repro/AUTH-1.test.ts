/**
 * AUTH-1 repro: the documented quickstart sync wiring (`createKoraAuthServer().auth`
 * -> KoraSyncServer) returns no server-side scopes, so the sync server uses the
 * client-supplied handshake `syncScope` verbatim. A second authenticated user can
 * handshake with the victim's scope and read and write the victim's rows.
 * Asserts CORRECT behavior, so it FAILS today.
 */
import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import { KoraAuthProvider, KoraSyncServer, MemoryServerStore, MixedAuthProvider } from '@korajs/server'
import type { AuthProvider } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { createKoraAuthServer } from '../../src/provider/built-in/quickstart-server'

const SECRET = 'x'.repeat(64)

const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), userId: t.string() }, scope: ['userId'] },
		notes: { fields: { body: t.string(), userId: t.string() }, scope: ['userId'] },
	},
})

let opCounter = 0
function insert(nodeId: string, collection: string, data: Record<string, unknown>, seq: number): Operation {
	opCounter++
	return {
		id: `op-${nodeId}-${opCounter}`,
		nodeId,
		type: 'insert',
		collection,
		recordId: `rec-${nodeId}-${opCounter}`,
		data,
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: 0, nodeId },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
	}
}

async function signUp(auth: ReturnType<typeof createKoraAuthServer>, email: string) {
	const res = await auth.handleRequest({
		method: 'POST',
		path: '/auth/signup',
		body: { email, password: 'password-123' },
		ip: '1.1.1.1',
	})
	const data = (res.body as { data: { user: { id: string }; tokens: { accessToken: string } } }).data
	return { userId: data.user.id, token: data.tokens.accessToken }
}

async function bootServer(auth: AuthProvider) {
	const store = new MemoryServerStore('server-1')
	await store.setSchema(schema)
	const server = new KoraSyncServer({ store, auth })
	return { store, server }
}

function connect(server: KoraSyncServer) {
	const { client, server: transport } = createServerTransportPair()
	const messages: SyncMessage[] = []
	client.onMessage((m) => messages.push(m))
	server.handleConnection(transport)
	return { client, messages }
}

async function handshake(
	c: ReturnType<typeof connect>,
	nodeId: string,
	token: string,
	syncScope?: Record<string, Record<string, unknown>>,
) {
	c.client.send({
		type: 'handshake',
		messageId: `hs-${nodeId}`,
		nodeId,
		versionVector: {},
		schemaVersion: 1,
		authToken: token,
		...(syncScope ? { syncScope } : {}),
	} as SyncMessage)
	await vi.waitFor(() =>
		expect(c.messages.some((m) => m.type === 'handshake-response')).toBe(true),
	)
}

function received(c: ReturnType<typeof connect>): Operation[] {
	return c.messages.flatMap((m) => (m.type === 'operation-batch' ? m.operations : []))
}

async function upload(c: ReturnType<typeof connect>, ops: Operation[]) {
	c.client.send({
		type: 'operation-batch',
		messageId: `b-${ops[0]?.id}`,
		operations: ops,
		isFinal: true,
		batchIndex: 0,
	} as SyncMessage)
	await new Promise((r) => setTimeout(r, 100))
}

describe('AUTH-1: sync scope is client-controlled under the documented auth wiring', () => {
	test('createKoraAuthServer().auth: Mallory cannot read or write Alice rows by sending Alice scope', async () => {
		const auth = createKoraAuthServer({ jwtSecret: SECRET })
		const alice = await signUp(auth, 'alice@example.com')
		const mallory = await signUp(auth, 'mallory@example.com')
		const { store, server } = await bootServer(auth.auth)

		// Alice syncs normally with her own (client-derived) scope and writes a todo.
		const a = connect(server)
		await handshake(a, 'alice-dev', alice.token, { todos: { userId: alice.userId } })
		await upload(a, [insert('alice-dev', 'todos', { title: 'alice secret', userId: alice.userId }, 1)])
		expect(await store.getOperationCount()).toBe(1)

		// Mallory (valid token, her own account) hand-crafts a handshake with Alice's scope.
		const m = connect(server)
		await handshake(m, 'mallory-dev', mallory.token, { todos: { userId: alice.userId } })
		await new Promise((r) => setTimeout(r, 100))
		const hsResp = m.messages.find((x) => x.type === 'handshake-response') as
			| { acceptedScope?: unknown }
			| undefined

		// READ: correct behavior is that the server pins Mallory to her own userId.
		expect.soft(hsResp?.acceptedScope).not.toEqual({ todos: { userId: alice.userId } })
		expect.soft(received(m).map((o) => o.data?.title)).not.toContain('alice secret')

		// WRITE: Mallory inserts a row into Alice's partition.
		await upload(m, [insert('mallory-dev', 'todos', { title: 'planted', userId: alice.userId }, 1)])
		expect.soft(await store.getOperationCount()).toBe(1)
		expect(received(a).map((o) => o.data?.title)).not.toContain('planted')
	})

	test('createKoraAuthServer().auth: omitting syncScope must not grant every tenant', async () => {
		const auth = createKoraAuthServer({ jwtSecret: SECRET })
		const alice = await signUp(auth, 'alice@example.com')
		const mallory = await signUp(auth, 'mallory@example.com')
		const { server } = await bootServer(auth.auth)
		const a = connect(server)
		await handshake(a, 'alice-dev', alice.token, { todos: { userId: alice.userId } })
		await upload(a, [insert('alice-dev', 'todos', { title: 'alice secret', userId: alice.userId }, 1)])

		const m = connect(server)
		await handshake(m, 'mallory-dev', mallory.token) // no scope at all
		await new Promise((r) => setTimeout(r, 100))
		expect(received(m).map((o) => o.data?.title)).not.toContain('alice secret')
	})

	test('MixedAuthProvider (documented): anonymous handshake cannot add collections beyond anonymousScopes', async () => {
		const authSrv = createKoraAuthServer({ jwtSecret: SECRET })
		const alice = await signUp(authSrv, 'alice@example.com')
		const mixed = new MixedAuthProvider({
			primary: authSrv.routes.toSyncAuthProvider(),
			anonymousScopes: { notes: { userId: 'public' } },
		})
		const { server } = await bootServer(mixed)
		const a = connect(server)
		await handshake(a, 'alice-dev', alice.token, { todos: { userId: alice.userId } })
		await upload(a, [insert('alice-dev', 'todos', { title: 'alice secret', userId: alice.userId }, 1)])

		const anon = connect(server)
		await handshake(anon, 'anon-dev', '', { todos: {} })
		await new Promise((r) => setTimeout(r, 100))
		expect(received(anon).map((o) => o.data?.title)).not.toContain('alice secret')
	})

	test('KoraAuthProvider with resolveScopes: handshake cannot add a collection the server never granted', async () => {
		const authSrv = createKoraAuthServer({ jwtSecret: SECRET })
		const alice = await signUp(authSrv, 'alice@example.com')
		const mallory = await signUp(authSrv, 'mallory@example.com')
		const provider = new KoraAuthProvider({
			tokenValidator: authSrv.tokenManager,
			userLookup: authSrv.userStore,
			resolveScopes: async (userId) => ({ todos: { userId } }), // notes deliberately NOT granted
		})
		const { server } = await bootServer(provider)
		const a = connect(server)
		await handshake(a, 'alice-dev', alice.token)
		const m = connect(server)
		await handshake(m, 'mallory-dev', mallory.token, { notes: {} })
		await new Promise((r) => setTimeout(r, 100))
		const hsResp = m.messages.find((x) => x.type === 'handshake-response') as
			| { acceptedScope?: Record<string, unknown> }
			| undefined
		expect(Object.keys(hsResp?.acceptedScope ?? {})).not.toContain('notes')
	})
})
