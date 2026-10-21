/**
 * A browser several people sign in to (shared computers): a device id belongs to ONE
 * account on the auth server (AUTH-5), so each account must sign in with a device id of
 * its own. Before this, every account on a browser presented the browser's one device id;
 * a beta.12 server accepted that (so two accounts' stores authored under one sync node),
 * and a later server refused every account but the device's first with
 * DEVICE_OWNERSHIP_CONFLICT.
 */
import { describe, expect, it } from 'vitest'
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
	it('gives each account its own device id, stable across sign-ins in any order', async () => {
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
		// Kofi's sign-up never presented Ama's id: the browser knew it was hers.
		expect(shared.log.filter((line) => line.startsWith('POST /auth/signup'))).toEqual([
			`POST /auth/signup ${amaDevice}`,
			`POST /auth/signup ${kofiDevice}`,
		])

		for (const [email, expected] of [
			['kofi@example.org', kofiDevice],
			['ama@example.org', amaDevice],
			['kofi@example.org', kofiDevice],
			['KOFI@Example.org', kofiDevice],
		] as const) {
			const client = shared.client()
			await client.signIn({ email, password: PASSWORD })
			expect(await deviceOf(client)).toBe(expected)
			await client.signOut()
		}
		// The map never holds an address in the clear.
		const map = shared.storage.values.get('kora_auth_device_id:accounts') ?? ''
		expect(map).not.toContain('example.org')
	})

	it('moves an account off a device id another account registered (a beta.12 shared browser)', async () => {
		for (const order of ['kofi-first', 'ama-first'] as const) {
			const server = createKoraAuthServer({ jwtSecret: SECRET })
			const shared = browser(server, `legacy-${order}`)
			// beta.12: both accounts signed in with the browser's one device id. The server
			// registered it to Ama, the first; this browser recorded no accounts.
			const legacy = shared.client()
			await legacy.signUp({ email: 'ama@example.org', password: PASSWORD })
			const sharedDevice = await deviceOf(legacy)
			await legacy.signOut()
			await server.handleRequest({
				method: 'POST',
				path: '/auth/signup',
				body: { email: 'kofi@example.org', password: PASSWORD },
			})
			shared.storage.values.delete('kora_auth_device_id:accounts')
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
			// Kofi was refused once (when the browser did not know the id was Ama's), then never again.
			expect(await signIn('kofi@example.org')).toBe(devices.get('kofi@example.org'))
			const refusedForKofi = shared.log.filter(
				(line) => line === `POST /auth/signin ${sharedDevice}`,
			).length
			expect(refusedForKofi).toBe(order === 'kofi-first' ? 2 : 1)
		}
	})

	it('signs up a new account on a browser whose device id another account owns', async () => {
		const server = createKoraAuthServer({ jwtSecret: SECRET })
		const shared = browser(server)
		const ama = shared.client()
		await ama.signUp({ email: 'ama@example.org', password: PASSWORD })
		const amaDevice = await deviceOf(ama)
		await ama.signOut()
		// The browser forgot which account uses its device id (a beta.12 browser).
		shared.storage.values.delete('kora_auth_device_id:accounts')
		shared.log.length = 0

		const esi = shared.client()
		await esi.signUp({ email: 'esi@example.org', password: PASSWORD })
		expect(await deviceOf(esi)).not.toBe(amaDevice)
		// The refused attempt created no account: the second attempt was a sign-up too.
		expect(shared.log.filter((line) => line.startsWith('POST /auth/signup')).length).toBe(2)
		expect(shared.log.some((line) => line.startsWith('POST /auth/signin'))).toBe(false)
	})

	it('signs in to the account an older server created before refusing the device', async () => {
		const server = createKoraAuthServer({ jwtSecret: SECRET })
		const shared = browser(server)
		const ama = shared.client()
		await ama.signUp({ email: 'ama@example.org', password: PASSWORD })
		const amaDevice = await deviceOf(ama)
		await ama.signOut()
		shared.storage.values.delete('kora_auth_device_id:accounts')

		// An auth server without the sign-up device pre-check: it creates the account, then
		// refuses the device id.
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
		expect(await deviceOf(client)).toBe('esi-own-device')
	})

	it('reports the conflict when the identity provider cannot replace the device id', async () => {
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
