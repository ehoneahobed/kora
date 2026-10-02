import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MixedAuthProvider } from '../auth/mixed-auth-provider'
import { KoraSyncServer } from '../server/kora-sync-server'
import { MemoryServerStore } from '../store/memory-server-store'
import { createServerTransportPair } from '../transport/memory-server-transport'
import type { AuthContext, AuthProvider } from '../types'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string() } } },
})

async function setup(auth: AuthProvider, extra: Record<string, unknown> = {}) {
	const store = new MemoryServerStore('server')
	await store.setSchema(schema)
	const server = new KoraSyncServer({
		store,
		auth,
		relayRetransmitIntervalMs: 0,
		deliveryPollIntervalMs: 0,
		...extra,
	})
	const connect = async (token: string, nodeId: string, nodeToken?: string) => {
		const { client, server: transport } = createServerTransportPair()
		const messages: SyncMessage[] = []
		client.onMessage((m) => messages.push(m))
		server.handleConnection(transport)
		client.send({
			type: 'handshake',
			messageId: `hs-${nodeId}`,
			nodeId,
			versionVector: {},
			schemaVersion: 1,
			authToken: token,
			...(nodeToken ? { nodeToken } : {}),
		} as SyncMessage)
		await vi.waitFor(() =>
			expect(messages.some((m) => m.type === 'handshake-response' || m.type === 'error')).toBe(
				true,
			),
		)
		return { client, messages }
	}
	return { server, store, connect }
}

const accepted = (messages: SyncMessage[]) =>
	messages.some((m) => m.type === 'handshake-response' && m.accepted)
const errorCodes = (messages: SyncMessage[]) =>
	messages.flatMap((m) => (m.type === 'error' ? [m.code] : []))
const tokenOf = (messages: SyncMessage[]) =>
	(messages.find((m) => m.type === 'handshake-response') as { nodeToken?: string } | undefined)
		?.nodeToken

afterEach(() => {
	vi.useRealTimers()
})

describe('anonymous node tokens (RT-12)', () => {
	const primary: AuthProvider = { authenticate: async () => null }
	const mixed = () => new MixedAuthProvider({ primary, anonymousScopes: { notes: {} } })

	test('a token is issued once, at the first claim, and only to anonymous principals', async () => {
		const { connect } = await setup(mixed())
		const first = await connect('', 'kiosk')
		const token = tokenOf(first.messages)
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
		const again = await connect('', 'kiosk', token)
		expect(accepted(again.messages)).toBe(true)
		expect(tokenOf(again.messages)).toBeUndefined()

		const signedIn = await setup({
			authenticate: async () => ({ userId: 'u1', scopes: { notes: {} } }),
		})
		const user = await signedIn.connect('t', 'laptop')
		expect(accepted(user.messages)).toBe(true)
		expect(tokenOf(user.messages)).toBeUndefined()
	})

	test('a wrong or missing token cannot take a claimed anonymous node', async () => {
		const { connect } = await setup(mixed())
		await connect('', 'kiosk')
		expect(errorCodes((await connect('', 'kiosk', 'guessed')).messages)).toContain(
			'NODE_ID_CLAIMED',
		)
		expect(errorCodes((await connect('', 'kiosk')).messages)).toContain('NODE_ID_CLAIMED')
	})

	test('the claims table stores only a hash of the token', async () => {
		const { connect, store } = await setup(mixed())
		const first = await connect('', 'kiosk')
		const token = tokenOf(first.messages) as string
		const owners = (store as unknown as { nodeOwners: Map<string, string> }).nodeOwners
		const owner = owners.get('kiosk') ?? ''
		expect(owner.startsWith('kora:anon-node:')).toBe(true)
		expect(owner).not.toContain(token)
	})

	test('a user id in the reserved kora: namespace is refused', async () => {
		const { connect } = await setup({
			authenticate: async () => ({ userId: 'kora:anon-node:abc', scopes: { notes: {} } }),
		})
		const result = await connect('t', 'n')
		expect(accepted(result.messages)).toBe(false)
		expect(errorCodes(result.messages)).toContain('AUTH_FAILED')
	})
})

describe('session re-validation (RT-18)', () => {
	function revocableAuth() {
		const revoked = new Set<string>()
		const auth: AuthProvider = {
			authenticate: async (token): Promise<AuthContext | null> => {
				if (token === 'broken') throw new Error('auth database unavailable')
				if (revoked.has(token)) return null
				return {
					userId: token.split('-')[0] ?? '',
					scopes: { notes: {} },
					metadata: { deviceId: 'd1' },
				}
			},
		}
		return { auth, revoked }
	}

	test('revalidateSessions ends exactly the sessions whose credential is now refused', async () => {
		const { auth, revoked } = revocableAuth()
		const { server, connect } = await setup(auth, { sessionRevalidationIntervalMs: 0 })
		const alice = await connect('alice-1', 'n1')
		const bob = await connect('bob-1', 'n2')
		revoked.add('alice-1')
		expect(await server.revalidateSessions()).toBe(1)
		expect(errorCodes(alice.messages)).toEqual(['AUTH_REVOKED'])
		expect(errorCodes(bob.messages)).toEqual([])
		expect(server.getConnectionCount()).toBe(1)
		await server.stop()
	})

	test('a provider error ends nothing', async () => {
		const { auth } = revocableAuth()
		const { server, connect } = await setup(auth, { sessionRevalidationIntervalMs: 0 })
		const flaky = vi.spyOn(auth, 'authenticate')
		await connect('alice-1', 'n1')
		flaky.mockRejectedValueOnce(new Error('auth database unavailable'))
		expect(await server.revalidateSessions()).toBe(0)
		expect(server.getConnectionCount()).toBe(1)
		await server.stop()
	})

	test('the periodic timer re-validates live sessions every interval', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
		const { auth, revoked } = revocableAuth()
		const { server, connect } = await setup(auth, { sessionRevalidationIntervalMs: 30_000 })
		const passes = vi.spyOn(server, 'revalidateSessions')
		const alice = await connect('alice-1', 'n1')
		revoked.add('alice-1')
		expect(passes).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(30_000)
		expect(passes).toHaveBeenCalledTimes(1)
		await vi.waitFor(() => expect(errorCodes(alice.messages)).toContain('AUTH_REVOKED'))
		await server.stop()
	})

	test('the delivery poll tick re-validates once the interval has elapsed', async () => {
		const { auth, revoked } = revocableAuth()
		const { server, connect } = await setup(auth, { sessionRevalidationIntervalMs: 30_000 })
		const alice = await connect('alice-1', 'n1')
		revoked.add('alice-1')
		// The first poll after start runs a pass (nothing ran yet).
		await server.pollDeliveryLog()
		await vi.waitFor(() => expect(errorCodes(alice.messages)).toContain('AUTH_REVOKED'))
		await server.stop()
	})
})

describe('directional uplink grants are resolved (RT-16)', () => {
	const scoped = defineSchema({
		version: 1,
		collections: {
			notes: { fields: { title: t.string(), userId: t.string() }, scope: ['userId'] },
		},
	})

	async function handshake(context: AuthContext): Promise<SyncMessage[]> {
		const store = new MemoryServerStore('server')
		await store.setSchema(scoped)
		const server = new KoraSyncServer({
			store,
			auth: { authenticate: async () => context },
			relayRetransmitIntervalMs: 0,
			deliveryPollIntervalMs: 0,
		})
		const { client, server: transport } = createServerTransportPair()
		const messages: SyncMessage[] = []
		client.onMessage((m) => messages.push(m))
		server.handleConnection(transport)
		client.send({
			type: 'handshake',
			messageId: 'hs',
			nodeId: 'n1',
			versionVector: {},
			schemaVersion: 1,
			authToken: 't',
		} as SyncMessage)
		await vi.waitFor(() =>
			expect(messages.some((m) => m.type === 'handshake-response' || m.type === 'error')).toBe(
				true,
			),
		)
		return messages
	}

	test('an unresolved uplink binding denies writes to the collection but keeps the session', async () => {
		const messages = await handshake({
			userId: 'u1',
			downlinkScopes: { $claims: { userId: 'u1' } },
			uplinkScopes: { $claims: { orgId: 'o1' } },
		})
		const response = messages.find((m) => m.type === 'handshake-response') as
			| { accepted: boolean; acceptedUplinkScopes?: unknown; acceptedDownlinkScopes?: unknown }
			| undefined
		expect(response?.accepted).toBe(true)
		expect(response?.acceptedDownlinkScopes).toEqual({ notes: { userId: 'u1' } })
		expect(response?.acceptedUplinkScopes).toEqual({})
	})

	test('an undefined value in an explicit uplink grant is refused (fails closed)', async () => {
		const messages = await handshake({
			userId: 'u1',
			downlinkScopes: { notes: { userId: 'u1' } },
			uplinkScopes: { notes: { userId: undefined } },
		})
		expect(errorCodes(messages)).toContain('INVALID_SCOPE_PREDICATE')
	})
})
