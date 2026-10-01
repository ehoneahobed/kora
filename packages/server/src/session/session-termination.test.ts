import { type SchemaDefinition, defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MixedAuthProvider } from '../auth/mixed-auth-provider'
import { NoAuthProvider } from '../auth/no-auth'
import { KoraSyncServer } from '../server/kora-sync-server'
import { MemoryServerStore } from '../store/memory-server-store'
import { createServerTransportPair } from '../transport/memory-server-transport'
import type { AuthContext, AuthProvider, SessionRevocation } from '../types'

const scopedSchema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), userId: t.string() }, scope: ['userId'] },
	},
})

const unscopedSchema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string() } } },
})

type Listener = (event: SessionRevocation) => void | Promise<void>

/** Auth provider with a controllable revocation feed and per-token contexts. */
class FakeAuth implements AuthProvider {
	readonly listeners = new Set<Listener>()
	constructor(private readonly contexts: Record<string, AuthContext>) {}
	async authenticate(token: string): Promise<AuthContext | null> {
		return this.contexts[token] ?? null
	}
	onRevoke(listener: Listener): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
	emit(event: SessionRevocation): void {
		for (const listener of this.listeners) void listener(event)
	}
}

function ctx(userId: string, deviceId: string, extra: Partial<AuthContext> = {}): AuthContext {
	return {
		userId,
		scopes: { todos: { userId } },
		metadata: { deviceId },
		...extra,
	}
}

async function setup(auth: AuthProvider, schema: SchemaDefinition = scopedSchema) {
	const store = new MemoryServerStore('server-1')
	await store.setSchema(schema)
	const server = new KoraSyncServer({
		store,
		auth,
		relayRetransmitIntervalMs: 0,
		deliveryPollIntervalMs: 0,
	})
	const connect = (token: string, nodeId: string, syncScope?: Record<string, unknown>) => {
		const { client, server: transport } = createServerTransportPair()
		const messages: SyncMessage[] = []
		const closed: string[] = []
		client.onMessage((m) => messages.push(m))
		client.onClose((reason) => closed.push(reason))
		server.handleConnection(transport)
		client.send({
			type: 'handshake',
			messageId: `hs-${nodeId}`,
			nodeId,
			versionVector: {},
			schemaVersion: 1,
			authToken: token,
			...(syncScope ? { syncScope } : {}),
		} as SyncMessage)
		return { client, messages, closed }
	}
	return { store, server, connect }
}

function errorsOf(messages: SyncMessage[]) {
	return messages.flatMap((m) => (m.type === 'error' ? [m] : []))
}

async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('KoraSyncServer.terminateSessions (AUTH-11)', () => {
	test('ends only the matching device with a retriable AUTH_REVOKED', async () => {
		const auth = new FakeAuth({
			laptop: ctx('u1', 'laptop'),
			phone: ctx('u1', 'phone'),
			other: ctx('u2', 'laptop'),
		})
		const { server, connect } = await setup(auth)
		const laptop = connect('laptop', 'n-laptop')
		const phone = connect('phone', 'n-phone')
		const other = connect('other', 'n-other')
		await vi.waitFor(() => expect(server.getConnectionCount()).toBe(3))
		await vi.waitFor(() =>
			expect(other.messages.some((m) => m.type === 'handshake-response')).toBe(true),
		)

		expect(server.terminateSessions({ userId: 'u1', deviceId: 'laptop' })).toBe(1)

		expect(errorsOf(laptop.messages)).toEqual([
			expect.objectContaining({ code: 'AUTH_REVOKED', retriable: true }),
		])
		expect(laptop.client.isConnected()).toBe(false)
		expect(phone.client.isConnected()).toBe(true)
		expect(other.client.isConnected()).toBe(true)
		expect(server.getConnectionCount()).toBe(2)
	})

	test('a user filter ends every device of that user only', async () => {
		const auth = new FakeAuth({
			laptop: ctx('u1', 'laptop'),
			phone: ctx('u1', 'phone'),
			other: ctx('u2', 'tablet'),
		})
		const { server, connect } = await setup(auth)
		const sessions = [connect('laptop', 'n-1'), connect('phone', 'n-2'), connect('other', 'n-3')]
		for (const s of sessions) {
			await vi.waitFor(() =>
				expect(s.messages.some((m) => m.type === 'handshake-response')).toBe(true),
			)
		}
		expect(server.terminateSessions({ userId: 'u1', code: 'AUTH_EXPIRED' })).toBe(2)
		expect(errorsOf(sessions[0]?.messages ?? [])[0]).toMatchObject({
			code: 'AUTH_EXPIRED',
			retriable: true,
		})
		expect(sessions[2]?.client.isConnected()).toBe(true)
	})

	test('refuses an empty filter instead of ending every session', async () => {
		const { server } = await setup(new FakeAuth({}))
		expect(() => server.terminateSessions({})).toThrow(/userId or a deviceId/)
	})

	test('never matches an unauthenticated session keyed by node id', async () => {
		const { server, connect } = await setup(new NoAuthProvider())
		const anon = connect('', 'u1')
		await vi.waitFor(() =>
			expect(anon.messages.some((m) => m.type === 'handshake-response')).toBe(true),
		)
		expect(server.terminateSessions({ userId: 'u1' })).toBe(0)
		expect(anon.client.isConnected()).toBe(true)
	})

	test("follows the auth provider's revocation feed and stops following on stop()", async () => {
		const auth = new FakeAuth({ laptop: ctx('u1', 'laptop') })
		const { server, connect } = await setup(auth)
		expect(auth.listeners.size).toBe(1)
		const laptop = connect('laptop', 'n-laptop')
		await vi.waitFor(() =>
			expect(laptop.messages.some((m) => m.type === 'handshake-response')).toBe(true),
		)
		auth.emit({ userId: 'u1', deviceId: 'laptop' })
		expect(laptop.client.isConnected()).toBe(false)
		await server.stop()
		expect(auth.listeners.size).toBe(0)
	})

	test('MixedAuthProvider forwards the primary revocation feed', async () => {
		const primary = new FakeAuth({ laptop: ctx('u1', 'laptop') })
		const mixed = new MixedAuthProvider({ primary, anonymousScopes: {} })
		const { connect } = await setup(mixed)
		expect(primary.listeners.size).toBe(1)
		const laptop = connect('laptop', 'n-laptop')
		await vi.waitFor(() =>
			expect(laptop.messages.some((m) => m.type === 'handshake-response')).toBe(true),
		)
		primary.emit({ userId: 'u1' })
		expect(laptop.client.isConnected()).toBe(false)
	})

	test('a revocation that lands during the handshake refuses that session', async () => {
		let release: (value: AuthContext) => void = () => {}
		const gate = new Promise<AuthContext>((resolve) => {
			release = resolve
		})
		const auth: AuthProvider = { authenticate: () => gate }
		const { server, connect } = await setup(auth)
		const laptop = connect('laptop', 'n-laptop')
		await vi.waitFor(() => expect(server.getConnectionCount()).toBe(1))
		await settle()
		expect(server.terminateSessions({ userId: 'u1', deviceId: 'laptop' })).toBe(0)
		release(ctx('u1', 'laptop'))
		await vi.waitFor(() =>
			expect(errorsOf(laptop.messages)).toEqual([
				expect.objectContaining({ code: 'AUTH_REVOKED', retriable: true }),
			]),
		)
		expect(laptop.messages.some((m) => m.type === 'handshake-response')).toBe(false)
	})
})

describe('session expiry timer (AUTH-11)', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	test('closes with retriable AUTH_EXPIRED exactly when the credential expires', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
		vi.setSystemTime(1_000_000)
		const auth = new FakeAuth({ laptop: ctx('u1', 'laptop', { expiresAt: 1_000_000 + 60_000 }) })
		const { server, connect } = await setup(auth)
		const laptop = connect('laptop', 'n-laptop')
		await settle()
		expect(laptop.messages.some((m) => m.type === 'handshake-response')).toBe(true)

		await vi.advanceTimersByTimeAsync(59_999)
		expect(laptop.client.isConnected()).toBe(true)
		await vi.advanceTimersByTimeAsync(1)
		expect(errorsOf(laptop.messages)).toEqual([
			expect.objectContaining({ code: 'AUTH_EXPIRED', retriable: true }),
		])
		expect(laptop.client.isConnected()).toBe(false)
		expect(server.getConnectionCount()).toBe(0)
	})

	test('re-arms past the setTimeout limit for long-lived credentials', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
		vi.setSystemTime(0)
		const lifetime = 2_147_483_647 + 1_000
		const auth = new FakeAuth({ laptop: ctx('u1', 'laptop', { expiresAt: lifetime }) })
		const { connect } = await setup(auth)
		const laptop = connect('laptop', 'n-laptop')
		await settle()
		await vi.advanceTimersByTimeAsync(2_147_483_647)
		expect(laptop.client.isConnected()).toBe(true)
		await vi.advanceTimersByTimeAsync(1_000)
		expect(laptop.client.isConnected()).toBe(false)
	})

	test('clears the timer when the session closes first', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
		vi.setSystemTime(1_000_000)
		const auth = new FakeAuth({ laptop: ctx('u1', 'laptop', { expiresAt: 1_000_000 + 5_000 }) })
		const { connect } = await setup(auth)
		const laptop = connect('laptop', 'n-laptop')
		await settle()
		expect(vi.getTimerCount()).toBe(1)
		await laptop.client.disconnect()
		await settle()
		expect(vi.getTimerCount()).toBe(0)
	})

	test('refuses a handshake whose credential already expired', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
		vi.setSystemTime(1_000_000)
		const auth = new FakeAuth({ laptop: ctx('u1', 'laptop', { expiresAt: 999_000 }) })
		const { connect } = await setup(auth)
		const laptop = connect('laptop', 'n-laptop')
		await settle()
		expect(errorsOf(laptop.messages)).toEqual([
			expect.objectContaining({ code: 'AUTH_EXPIRED', retriable: true }),
		])
		expect(laptop.messages.some((m) => m.type === 'handshake-response')).toBe(false)
	})
})

describe('authenticated provider without a grant (AUTH-1)', () => {
	test('a custom provider returning no scopes is denied, not given the handshake scope', async () => {
		const auth: AuthProvider = { authenticate: async () => ({ userId: 'u1' }) }
		const { connect } = await setup(auth)
		const client = connect('any', 'n-1', { todos: { userId: 'someone-else' } })
		await vi.waitFor(() => expect(errorsOf(client.messages).length).toBe(1))
		expect(errorsOf(client.messages)[0]).toMatchObject({
			code: 'SCOPE_REQUIRED',
			retriable: false,
		})
		expect(client.messages.some((m) => m.type === 'handshake-response')).toBe(false)
		expect(client.client.isConnected()).toBe(false)
	})

	test('an unresolved binding in a claims grant is SCOPE_REQUIRED too', async () => {
		const auth: AuthProvider = {
			authenticate: async () => ({ userId: 'u1', scopes: { $claims: { orgId: 'o1' } } }),
		}
		const { connect } = await setup(auth)
		const client = connect('any', 'n-1', { todos: { userId: 'u1' } })
		await vi.waitFor(() => expect(errorsOf(client.messages).length).toBe(1))
		expect(errorsOf(client.messages)[0]).toMatchObject({ code: 'SCOPE_REQUIRED' })
	})

	test('a provider without scopes still works for a schema with no scoped collections', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const auth: AuthProvider = { authenticate: async () => ({ userId: 'u1' }) }
		const { connect } = await setup(auth, unscopedSchema)
		const client = connect('any', 'n-1')
		await vi.waitFor(() =>
			expect(client.messages.some((m) => m.type === 'handshake-response')).toBe(true),
		)
		expect(errorsOf(client.messages)).toEqual([])
		// The multi-tenant guardrail still fires: every user shares these collections.
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('resolved to no sync scopes'))
		warn.mockRestore()
	})

	test('NoAuthProvider keeps the handshake scope as a client-side filter', async () => {
		const { connect } = await setup(new NoAuthProvider())
		const client = connect('', 'n-1', { todos: { userId: 'u1' } })
		await vi.waitFor(() =>
			expect(client.messages.some((m) => m.type === 'handshake-response')).toBe(true),
		)
		const response = client.messages.find((m) => m.type === 'handshake-response')
		expect(response).toMatchObject({ acceptedScope: { todos: { userId: 'u1' } } })
	})
})
