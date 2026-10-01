/**
 * AUTH-11 end to end: the built-in auth server, a KoraSyncServer, the auth client,
 * its sync binding and a real SyncEngine. When the server ends a live session the
 * client refreshes its token and re-handshakes; a revoked device cannot.
 */
import type { VersionVector } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import { KoraSyncServer, MemoryServerStore } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncMessage, SyncStore, SyncTransport } from '@korajs/sync'
import { SyncEngine } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { AuthClient } from '../../src/client/auth-client'
import { createKoraAuthSync } from '../../src/client/auth-sync'
import { createMemoryAuthTokenStorage } from '../../src/client/storage'
import { createKoraAuthServer } from '../../src/provider/built-in/quickstart-server'

const SERVER = 'https://auth.example.test'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), userId: t.string() }, scope: ['userId'] } },
})

/** A client transport that opens a fresh in-memory connection to the server on every connect. */
class LoopbackTransport implements SyncTransport {
	private current: ReturnType<typeof createServerTransportPair>['client'] | null = null
	private messageHandler: ((message: SyncMessage) => void) | null = null
	private closeHandler: ((reason: string) => void) | null = null
	private errorHandler: ((error: Error) => void) | null = null
	readonly handshakeTokens: Array<string | undefined> = []
	readonly errors: SyncMessage[] = []

	constructor(private readonly server: KoraSyncServer) {}

	async connect(): Promise<void> {
		const pair = createServerTransportPair()
		pair.client.onMessage((message) => {
			if (message.type === 'error') this.errors.push(message)
			this.messageHandler?.(message)
		})
		pair.client.onClose((reason) => this.closeHandler?.(reason))
		pair.client.onError((error) => this.errorHandler?.(error))
		this.server.handleConnection(pair.server)
		this.current = pair.client
	}
	async disconnect(): Promise<void> {
		await this.current?.disconnect()
	}
	send(message: SyncMessage): void {
		if (message.type === 'handshake') this.handshakeTokens.push(message.authToken)
		this.current?.send(message)
	}
	onMessage(handler: (message: SyncMessage) => void): void {
		this.messageHandler = handler
	}
	onClose(handler: (reason: string) => void): void {
		this.closeHandler = handler
	}
	onError(handler: (error: Error) => void): void {
		this.errorHandler = handler
	}
	isConnected(): boolean {
		return this.current?.isConnected() ?? false
	}
}

function syncStore(nodeId: string): SyncStore {
	const versionVector: VersionVector = new Map()
	return {
		getVersionVector: () => versionVector,
		getNodeId: () => nodeId,
		applyRemoteOperation: vi.fn(async () => 'applied' as const),
		getOperationRange: vi.fn(async () => []),
	}
}

async function setup() {
	const auth = createKoraAuthServer({ jwtSecret: 's'.repeat(64) })
	const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input))
		const headers: Record<string, string> = {}
		new Headers(init?.headers).forEach((value, key) => {
			headers[key] = value
		})
		const response = await auth.handleRequest({
			method: init?.method ?? 'GET',
			path: url.pathname,
			headers,
			body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
		})
		return new Response(JSON.stringify(response.body), {
			status: response.status,
			headers: { 'Content-Type': 'application/json' },
		})
	}) as typeof fetch

	const signup = (
		await auth.handleRequest({
			method: 'POST',
			path: '/auth/signup',
			body: { email: 'u@example.com', password: 'password-123', deviceId: 'laptop' },
		})
	).body as { data: { tokens: { accessToken: string; refreshToken: string } } }
	const phone = (
		await auth.handleRequest({
			method: 'POST',
			path: '/auth/signin',
			body: { email: 'u@example.com', password: 'password-123', deviceId: 'phone' },
		})
	).body as { data: { tokens: { accessToken: string } } }

	const storage = createMemoryAuthTokenStorage()
	await storage.setTokens(signup.data.tokens.accessToken, signup.data.tokens.refreshToken)
	const authClient = new AuthClient({ serverUrl: SERVER, storage, fetch: fetchFn })
	await authClient.initialize()
	const binding = createKoraAuthSync({ authClient, schema })

	const store = new MemoryServerStore('server-1')
	await store.setSchema(schema)
	const syncServer = new KoraSyncServer({
		store,
		auth: auth.auth,
		relayRetransmitIntervalMs: 0,
		deliveryPollIntervalMs: 0,
	})
	const transport = new LoopbackTransport(syncServer)
	const engine = new SyncEngine({
		transport,
		store: syncStore('laptop-node'),
		config: {
			url: 'ws://sync.example.test',
			auth: binding.auth,
			...(binding.resolveSyncState ? { authState: binding.resolveSyncState } : {}),
		},
	})
	return {
		auth,
		authClient,
		syncServer,
		transport,
		engine,
		phoneToken: phone.data.tokens.accessToken,
	}
}

describe('AUTH-11 end to end', () => {
	test('a terminated session refreshes its token and re-handshakes', async () => {
		const { authClient, syncServer, transport, engine } = await setup()
		await engine.start()
		await vi.waitFor(() => expect(engine.getState()).toBe('streaming'))
		const userId = (await authClient.getStoredIdentity())?.userId ?? ''

		// The server ends the session (as at credential expiry), without revoking anything.
		expect(syncServer.terminateSessions({ userId, deviceId: 'laptop', code: 'AUTH_EXPIRED' })).toBe(
			1,
		)
		await vi.waitFor(() => expect(engine.getState()).toBe('disconnected'))
		expect(transport.errors.at(-1)).toMatchObject({ code: 'AUTH_EXPIRED', retriable: true })

		await engine.start()
		await vi.waitFor(() => expect(engine.getState()).toBe('streaming'))
		// The second handshake carried a freshly refreshed token, not the cached one.
		expect(transport.handshakeTokens).toHaveLength(2)
		expect(transport.handshakeTokens[1]).not.toBe(transport.handshakeTokens[0])
		expect(authClient.state).toBe('authenticated')
		await engine.stop()
	})

	test('revokeAllForUser (password reset/change, admin revoke) ends every live session', async () => {
		const { auth, authClient, transport, engine } = await setup()
		await engine.start()
		await vi.waitFor(() => expect(engine.getState()).toBe('streaming'))
		const userId = (await authClient.getStoredIdentity())?.userId ?? ''

		// PasswordResetManager({ onPasswordChanged: auth.revokeAllForUser }) and
		// new AdminApi({ revokeAllForUser: auth.revokeAllForUser }) both land here.
		await auth.revokeAllForUser(userId)
		await vi.waitFor(() => expect(engine.getState()).toBe('disconnected'))
		expect(transport.errors.at(-1)).toMatchObject({ code: 'AUTH_REVOKED', retriable: true })
	})

	test('bindSyncServer terminates sessions on a server built with a wrapping provider', async () => {
		const { auth } = await setup()
		const terminated: Array<{ userId?: string; deviceId?: string }> = []
		const unbind = auth.bindSyncServer({ terminateSessions: (filter) => terminated.push(filter) })
		await auth.revokeAllForUser('u-1')
		unbind()
		await auth.revokeAllForUser('u-1')
		expect(terminated).toEqual([{ userId: 'u-1' }])
	})

	test('revoking the device ends its session and it cannot reconnect', async () => {
		const { auth, authClient, transport, engine, phoneToken } = await setup()
		await engine.start()
		await vi.waitFor(() => expect(engine.getState()).toBe('streaming'))

		const revoked = await auth.handleRequest({
			method: 'DELETE',
			path: '/auth/device/laptop',
			headers: { authorization: `Bearer ${phoneToken}` },
		})
		expect(revoked.status).toBe(200)
		await vi.waitFor(() => expect(engine.getState()).toBe('disconnected'))
		expect(transport.errors.at(-1)).toMatchObject({ code: 'AUTH_REVOKED', retriable: true })

		// The reconnect forces a refresh; the server rejects it definitively, so the
		// client is signed out and sync suspends instead of handshaking again.
		await engine.start().catch(() => undefined)
		await vi.waitFor(() => expect(authClient.state).toBe('unauthenticated'))
		await engine.start().catch(() => undefined)
		expect(transport.handshakeTokens).toHaveLength(1)
		expect(engine.getStatus().status).toBe('auth-required')
	})
})
