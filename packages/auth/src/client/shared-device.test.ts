/**
 * A browser several people sign in to (shared computers): a device id belongs to ONE
 * account on the auth server (AUTH-5), so each account must sign in with a device id of
 * its own. Before this, every account on a browser presented the browser's one device id;
 * a beta.12 server accepted that (so two accounts' stores authored under one sync node),
 * and a later server refused every account but the device's first with
 * DEVICE_OWNERSHIP_CONFLICT. Now a sign-in offers every device id the browser holds
 * (plus an unused one) and the server picks the one registered to the account.
 */
import { describe, expect, it, vi } from 'vitest'
import { InMemoryDeviceKeyStore } from '../device/device-store'
import { createKoraAuthServer } from '../provider/built-in/quickstart-server'
import { decodeJwt } from '../tokens/jwt'
import { AuthClient, AuthError } from './auth-client'
import { createPersistentDeviceIdentity } from './device-session'
import type { AuthKeyValueStorage } from './storage'
import { createMemoryAuthTokenStorage } from './storage'

const SECRET = 's'.repeat(64)
const SERVER = 'https://auth.example.test'
const PASSWORD = 'password-123'

type AuthServer = ReturnType<typeof createKoraAuthServer>

/** Servers that behave like a release from before device candidates (they read `deviceId` alone). */
const serverIgnoresCandidates = new WeakSet<AuthServer>()

const OAUTH_PROVIDER = {
	providerId: 'test',
	clientId: 'client-id',
	clientSecret: 'client-secret',
	authorizationUrl: 'https://provider.example/authorize',
	tokenUrl: 'https://provider.example/token',
	userInfoUrl: 'https://provider.example/userinfo',
	scopes: ['openid', 'email', 'profile'],
	redirectUri: 'http://localhost/auth/oauth/test/callback',
}

/** An auth server with an OAuth provider whose signed-in profile the test switches. */
function oauthServer(): { server: AuthServer; as: (profile: Record<string, unknown>) => void } {
	let profile: Record<string, unknown> = {}
	const fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input)
		const body =
			url === OAUTH_PROVIDER.tokenUrl
				? { access_token: 'provider-access-token', token_type: 'Bearer' }
				: url === OAUTH_PROVIDER.userInfoUrl
					? profile
					: null
		return new Response(JSON.stringify(body), {
			status: body ? 200 : 404,
			headers: { 'Content-Type': 'application/json' },
		})
	}) as unknown as typeof globalThis.fetch
	const server = createKoraAuthServer({
		jwtSecret: SECRET,
		oauth: { providers: [OAUTH_PROVIDER], fetch },
	})
	return {
		server,
		as: (next) => {
			profile = next
		},
	}
}

function memoryStorage(): AuthKeyValueStorage & { values: Map<string, string> } {
	const values = new Map<string, string>()
	return {
		values,
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => {
			values.set(key, value)
		},
		removeItem: (key) => {
			values.delete(key)
		},
	}
}

/** Route the client's requests to an in-process auth server. */
function fetchVia(server: AuthServer, log: string[] = []): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input))
		const headers: Record<string, string> = {}
		new Headers(init?.headers).forEach((value, key) => {
			headers[key] = value
		})
		const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
		log.push(`${init?.method ?? 'GET'} ${url.pathname} ${body?.deviceId ?? ''}`)
		if (serverIgnoresCandidates.has(server) && body) body.deviceCandidates = undefined
		const res = await server.handleRequest({
			method: (init?.method ?? 'GET') as 'GET' | 'POST',
			path: url.pathname,
			body,
			headers,
		})
		return new Response(JSON.stringify(res.body), {
			status: res.status,
			headers: { 'Content-Type': 'application/json', ...(res.headers ?? {}) },
		})
	}) as typeof fetch
}

/** One browser profile: its device-id store and key store outlive every client on it. */
function browser(server: AuthServer, seed = 'dev') {
	const storage = memoryStorage()
	const keyStore = new InMemoryDeviceKeyStore()
	let counter = 0
	const deviceIdentity = createPersistentDeviceIdentity({
		storage,
		keyStore,
		generateDeviceId: () => `${seed}-${++counter}`,
	})
	const log: string[] = []
	const client = (): AuthClient =>
		new AuthClient({
			serverUrl: SERVER,
			storage: createMemoryAuthTokenStorage(),
			fetch: fetchVia(server, log),
			deviceIdentity,
		})
	return { storage, client, log }
}

async function deviceOf(client: AuthClient): Promise<string> {
	const token = await client.getAccessToken()
	if (!token) throw new Error('not signed in')
	const dev = decodeJwt(token)?.dev
	if (typeof dev !== 'string') throw new Error('no dev claim')
	return dev
}

describe('a browser shared between accounts', () => {
	it('gives each account its own device id, stable across sign-ins in any order, in one request each', async () => {
		const server = createKoraAuthServer({ jwtSecret: SECRET })
		const shared = browser(server)

		const ama = shared.client()
		await ama.signUp({ email: 'ama@example.org', password: PASSWORD })
		const amaDevice = await deviceOf(ama)
		await ama.signOut()

		const kofi = shared.client()
		await kofi.signUp({ email: 'kofi@example.org', password: PASSWORD })
		const kofiDevice = await deviceOf(kofi)
		await kofi.signOut()
		expect(kofiDevice).not.toBe(amaDevice)
		// The account that came first keeps the browser's first device id.
		expect(shared.storage.values.get('kora_auth_device_id')).toBe(amaDevice)

		for (const [email, expected] of [
			['kofi@example.org', kofiDevice],
			['ama@example.org', amaDevice],
			['kofi@example.org', kofiDevice],
			['KOFI@Example.org', kofiDevice],
			['ama@example.org', amaDevice],
		] as const) {
			const client = shared.client()
			await client.signIn({ email, password: PASSWORD })
			expect(await deviceOf(client)).toBe(expected)
			await client.signOut()
		}
		// Never refused, never retried: one request per sign-up and sign-in.
		expect(shared.log.filter((line) => /^POST \/auth\/sign(in|up) /.test(line)).length).toBe(7)
		// Nothing about the accounts is stored on the browser: device ids only.
		for (const value of shared.storage.values.values()) {
			expect(value).not.toMatch(/example\.org|ama|kofi/i)
		}
	})

	it('keeps the registered owner on the shared device id of a beta.12 browser, in either order', async () => {
		for (const order of ['kofi-first', 'ama-first'] as const) {
			const server = createKoraAuthServer({ jwtSecret: SECRET })
			const shared = browser(server, `legacy-${order}`)
			// beta.12: both accounts signed in with the browser's one device id. The server
			// registered it to Ama, the first.
			const legacy = shared.client()
			await legacy.signUp({ email: 'ama@example.org', password: PASSWORD })
			const sharedDevice = await deviceOf(legacy)
			await legacy.signOut()
			await server.handleRequest({
				method: 'POST',
				path: '/auth/signup',
				body: { email: 'kofi@example.org', password: PASSWORD },
			})
			shared.log.length = 0

			const signIn = async (email: string): Promise<string> => {
				const client = shared.client()
				await client.signIn({ email, password: PASSWORD })
				const device = await deviceOf(client)
				await client.signOut()
				return device
			}
			const first = order === 'kofi-first' ? 'kofi@example.org' : 'ama@example.org'
			const second = order === 'kofi-first' ? 'ama@example.org' : 'kofi@example.org'
			const devices = new Map<string, string>()
			devices.set(first, await signIn(first))
			devices.set(second, await signIn(second))

			// The device's registered owner keeps it; the other account moves to its own.
			expect(devices.get('ama@example.org')).toBe(sharedDevice)
			expect(devices.get('kofi@example.org')).not.toBe(sharedDevice)
			expect(await signIn('kofi@example.org')).toBe(devices.get('kofi@example.org'))
			expect(await signIn('ama@example.org')).toBe(sharedDevice)
			// No sign-in was refused.
			expect(shared.log.filter((line) => line.startsWith('POST /auth/signin ')).length).toBe(4)
		}
	})

	it('gives each OAuth account its own stable device id on a shared browser', async () => {
		const { server, as } = oauthServer()
		const shared = browser(server, 'oauth')
		const signIn = async (who: string): Promise<string> => {
			as({ id: `provider-${who}`, email: `${who}@example.org`, email_verified: true, name: who })
			const start = await server.handleRequest({ method: 'GET', path: '/auth/oauth/test' })
			if (!('data' in start.body)) throw new Error('OAuth start failed')
			const data = start.body.data as { state: string; binding: string }
			const client = shared.client()
			await client.completeOAuthSignIn('test', {
				code: `code-${who}`,
				state: data.state,
				binding: data.binding,
			})
			const device = await deviceOf(client)
			await client.signOut()
			return device
		}
		const ama = await signIn('ama')
		const kofi = await signIn('kofi')
		expect(kofi).not.toBe(ama)
		// Alternating sign-ins: each account gets its own device id again, never refused (the
		// authorization code is single-use: a refusal would fail the sign-in).
		for (let round = 0; round < 3; round++) {
			expect(await signIn('kofi')).toBe(kofi)
			expect(await signIn('ama')).toBe(ama)
		}
		// Two device ids held (plus one unused): no new id per sign-in.
		expect(JSON.parse(shared.storage.values.get('kora_auth_device_id:others') ?? '[]')).toEqual([
			kofi,
		])
	})

	it('bounds the device ids a browser holds', async () => {
		const server = createKoraAuthServer({ jwtSecret: SECRET })
		const shared = browser(server, 'many')
		const devices: string[] = []
		for (let i = 0; i < 12; i++) {
			await server.handleRequest({
				method: 'POST',
				path: '/auth/signup',
				body: { email: `user${i}@example.org`, password: PASSWORD },
				ip: `10.0.0.${i}`,
			})
			const client = shared.client()
			await client.signIn({ email: `user${i}@example.org`, password: PASSWORD })
			devices.push(await deviceOf(client))
			await client.signOut()
		}
		expect(new Set(devices).size).toBe(12)
		const others: string[] = JSON.parse(
			shared.storage.values.get('kora_auth_device_id:others') ?? '[]',
		)
		// The first id, seven others (the most recent accounts), and one spare.
		expect(others).toEqual(devices.slice(5))
		const client = shared.client()
		await client.signIn({ email: 'user11@example.org', password: PASSWORD })
		expect(await deviceOf(client)).toBe(devices[11])
	})

	it('falls back to one candidate per request with a server from before device candidates', async () => {
		const server = createKoraAuthServer({ jwtSecret: SECRET })
		serverIgnoresCandidates.add(server)
		const shared = browser(server, 'older')
		const ama = shared.client()
		await ama.signUp({ email: 'ama@example.org', password: PASSWORD })
		const amaDevice = await deviceOf(ama)
		await ama.signOut()

		const esi = shared.client()
		await esi.signUp({ email: 'esi@example.org', password: PASSWORD })
		const esiDevice = await deviceOf(esi)
		await esi.signOut()
		expect(esiDevice).not.toBe(amaDevice)
		// The refused attempt created no account: the second attempt was a sign-up too.
		expect(shared.log.some((line) => line.startsWith('POST /auth/signin'))).toBe(false)

		const again = shared.client()
		await again.signIn({ email: 'esi@example.org', password: PASSWORD })
		expect(await deviceOf(again)).toBe(esiDevice)
	})

	it('signs in to the account an older server created before refusing the device', async () => {
		const server = createKoraAuthServer({ jwtSecret: SECRET })
		const shared = browser(server)
		const ama = shared.client()
		await ama.signUp({ email: 'ama@example.org', password: PASSWORD })
		const amaDevice = await deviceOf(ama)
		await ama.signOut()

		// An auth server without the sign-up device pre-check or candidates: it creates the
		// account, then refuses the device id.
		const inner = fetchVia(server, shared.log)
		const olderServer = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input))
			const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
			if (url.pathname === '/auth/signup' && body.deviceId === amaDevice) {
				await server.handleRequest({
					method: 'POST',
					path: '/auth/signup',
					body: { email: body.email, password: body.password },
				})
				return new Response(
					JSON.stringify({
						error: 'registered to another account',
						code: 'DEVICE_OWNERSHIP_CONFLICT',
					}),
					{ status: 409, headers: { 'Content-Type': 'application/json' } },
				)
			}
			return inner(input, init)
		}) as typeof fetch
		const client = new AuthClient({
			serverUrl: SERVER,
			storage: createMemoryAuthTokenStorage(),
			fetch: olderServer,
			deviceIdentity: createPersistentDeviceIdentity({
				storage: shared.storage,
				keyStore: new InMemoryDeviceKeyStore(),
				generateDeviceId: () => 'esi-own-device',
			}),
		})
		await client.signUp({ email: 'esi@example.org', password: PASSWORD })
		expect(client.state).toBe('authenticated')
		expect(await deviceOf(client)).not.toBe(amaDevice)
	})

	it('reports the conflict when the identity provider offers one device id', async () => {
		const server = createKoraAuthServer({ jwtSecret: SECRET })
		const shared = browser(server)
		const ama = shared.client()
		await ama.signUp({ email: 'ama@example.org', password: PASSWORD })
		const amaDevice = await deviceOf(ama)
		await ama.signOut()
		await server.handleRequest({
			method: 'POST',
			path: '/auth/signup',
			body: { email: 'kofi@example.org', password: PASSWORD },
		})
		const fixed = new AuthClient({
			serverUrl: SERVER,
			storage: createMemoryAuthTokenStorage(),
			fetch: fetchVia(server),
			deviceIdentity: {
				getDeviceIdentity: async () => ({ deviceId: amaDevice, devicePublicKey: '' }),
			},
		})
		const error = await fixed
			.signIn({ email: 'kofi@example.org', password: PASSWORD })
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(AuthError)
		expect((error as AuthError).context).toMatchObject({ serverCode: 'DEVICE_OWNERSHIP_CONFLICT' })
		// An explicitly chosen device id is never replaced either.
		const explicit = shared.client()
		await expect(
			explicit.signIn({ email: 'kofi@example.org', password: PASSWORD, deviceId: amaDevice }),
		).rejects.toBeInstanceOf(AuthError)
	})
})
