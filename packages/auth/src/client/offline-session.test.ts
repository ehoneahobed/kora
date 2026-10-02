import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthClient, type AuthClientSession } from './auth-client'
import { createKoraAuthSync } from './auth-sync'
import { createMemoryAuthTokenStorage } from './storage'

const SERVER = 'https://auth.example.test'

function b64url(value: unknown): string {
	return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function token(type: 'access' | 'refresh', expiresInSeconds: number, iatOffsetSeconds = 0): string {
	const now = Math.floor(Date.now() / 1000) + iatOffsetSeconds
	return `${b64url({ alg: 'HS256' })}.${b64url({
		sub: 'user-1',
		dev: 'device-1',
		type,
		iat: now,
		exp: now + expiresInSeconds,
	})}.sig`
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers },
	})
}

async function offlineClient(
	refresh: () => Promise<Response>,
	config: Partial<ConstructorParameters<typeof AuthClient>[0]> = {},
) {
	const storage = createMemoryAuthTokenStorage()
	const original = token('refresh', 90 * 86400)
	await storage.setTokens(token('access', -60), original)
	const calls = { refresh: 0 }
	const fetchFn = (async (input: RequestInfo | URL) => {
		if (String(input).endsWith('/auth/refresh')) {
			calls.refresh++
			return refresh()
		}
		throw new TypeError('offline')
	}) as typeof fetch
	const client = new AuthClient({ serverUrl: SERVER, storage, fetch: fetchFn, ...config })
	return { client, storage, original, calls }
}

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

describe('refresh outcome classification (only the server ends a session)', () => {
	const transient: Array<[string, () => Promise<Response>]> = [
		['401 HTML from a proxy', async () => new Response('<html/>', { status: 401 })],
		['403 JSON', async () => json(403, { error: 'Forbidden' })],
		['407 proxy auth', async () => new Response('', { status: 407 })],
		['400 without invalid_grant', async () => json(400, { error: 'Bad request' })],
		['200 JSON without tokens', async () => json(200, { ok: true })],
		['409 refresh in progress', async () => json(409, { code: 'REFRESH_IN_PROGRESS' })],
	]
	it.each(transient)('%s keeps the session', async (_name, response) => {
		const { client, storage, original } = await offlineClient(response)
		await client.initialize()
		expect(client.state).toBe('authenticated')
		expect(client.session?.status).toBe('offline')
		expect(await storage.getRefreshToken()).toBe(original)
	})

	it.each([
		['400 invalid_grant (RFC 6749)', async () => json(400, { error: 'invalid_grant' })],
		['401 Kora code', async () => json(401, { error: 'x', code: 'REFRESH_TOKEN_INVALID' })],
	])('%s is definitive', async (_name, response) => {
		const { client, storage } = await offlineClient(response)
		await client.initialize()
		expect(client.state).toBe('unauthenticated')
		expect(await storage.getRefreshToken()).toBeNull()
	})

	it('a definitive rejection never clears a newer pair another tab stored meanwhile', async () => {
		const storage = createMemoryAuthTokenStorage()
		await storage.setTokens(token('access', -60), token('refresh', 86400))
		const newer = { access: token('access', 900), refresh: token('refresh', 86400, 1) }
		const fetchFn = (async () => {
			// Another tab rotated while our (now stale) request was in flight.
			await storage.setTokens(newer.access, newer.refresh)
			return json(401, { error: 'Invalid or expired refresh token.' })
		}) as unknown as typeof fetch
		const client = new AuthClient({ serverUrl: SERVER, storage, fetch: fetchFn })
		expect(await client.getAccessToken()).toBe(newer.access)
		expect(await storage.getRefreshToken()).toBe(newer.refresh)
	})
})

describe('backoff and Retry-After', () => {
	it('honours Retry-After and retries on its own once it elapses', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-10-01T08:00:00Z'))
		let answer: () => Promise<Response> = async () =>
			json(503, { error: 'busy' }, { 'Retry-After': '120' })
		const { client, calls } = await offlineClient(() => answer())
		await client.initialize() // attempt 1 -> Retry-After 120s (overrides the free retry)
		await client.getAccessToken()
		await client.getAccessToken()
		expect(calls.refresh).toBe(1)

		const sessions: Array<AuthClientSession | null> = []
		client.onSessionChange((s) => sessions.push(s))
		answer = async () =>
			json(200, {
				data: { accessToken: token('access', 900), refreshToken: token('refresh', 86400) },
			})
		await vi.advanceTimersByTimeAsync(121_000)
		expect(calls.refresh).toBe(2)
		expect(client.session?.status).toBe('fresh')
		expect(sessions.at(-1)?.status).toBe('fresh')
		client.destroy()
	})

	it('retryNow() clears the backoff', async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		const { client, calls } = await offlineClient(async () => {
			throw new TypeError('Failed to fetch')
		})
		await client.initialize()
		await client.getAccessToken()
		await client.getAccessToken()
		expect(calls.refresh).toBe(2)
		await client.retryNow()
		expect(calls.refresh).toBe(3)
		client.destroy()
	})
})

describe('grace period and clock safety', () => {
	it('locks (never signs out) after maxOfflineGraceMs without server contact', async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date('2026-10-01T08:00:00Z'))
		const { client, storage, original } = await offlineClient(
			async () => {
				throw new TypeError('Failed to fetch')
			},
			{ maxOfflineGraceMs: 60 * 60_000 },
		)
		await client.initialize()
		expect(client.session?.status).toBe('offline')
		vi.setSystemTime(new Date('2026-10-01T09:30:00Z'))
		await client.retryNow()
		expect(client.state).toBe('authenticated')
		expect(client.session?.status).toBe('locked')
		expect(await storage.getRefreshToken()).toBe(original)
		client.destroy()
	})

	it('locks when the device clock was set back before the last server contact', async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date('2026-10-01T08:00:00Z'))
		const storage = createMemoryAuthTokenStorage()
		// Credentials issued "tomorrow" by the server clock: this device's clock was rolled back.
		await storage.setTokens(token('access', -60, 86400), token('refresh', 90 * 86400, 86400))
		const client = new AuthClient({
			serverUrl: SERVER,
			storage,
			fetch: (async () => {
				throw new TypeError('offline')
			}) as unknown as typeof fetch,
		})
		await client.initialize()
		expect(client.state).toBe('authenticated')
		expect(client.session?.status).toBe('locked')
		client.destroy()
	})
})

describe('single refresher with Web Locks (NEW-AUTH-2)', () => {
	it('serializes refreshes through navigator.locks and adopts the winner', async () => {
		const held: string[] = []
		let chain: Promise<unknown> = Promise.resolve()
		vi.stubGlobal('navigator', {
			locks: {
				request: (name: string, _opts: unknown, cb: () => Promise<unknown>) => {
					held.push(name)
					const run = chain.then(cb)
					chain = run.catch(() => undefined)
					return run
				},
			},
		})
		const storage = createMemoryAuthTokenStorage()
		await storage.setTokens(token('access', -60), token('refresh', 86400))
		let served = 0
		const fetchFn = (async () => {
			served++
			return json(200, {
				data: { accessToken: token('access', 900), refreshToken: token('refresh', 86400, served) },
			})
		}) as unknown as typeof fetch
		const tabA = new AuthClient({ serverUrl: SERVER, storage, fetch: fetchFn })
		const tabB = new AuthClient({ serverUrl: SERVER, storage, fetch: fetchFn })
		const [a, b] = await Promise.all([tabA.getAccessToken(), tabB.getAccessToken()])
		expect(a).not.toBeNull()
		expect(b).toBe(a)
		expect(served).toBe(1)
		expect(held).toEqual(['kora-auth-refresh:kora_auth', 'kora-auth-refresh:kora_auth'])
	})
})

describe('sync binding uses the stored identity (LMS-2)', () => {
	it('reports authenticated-offline with token null, and fresh once refreshed', async () => {
		let online = false
		const { client } = await offlineClient(async () => {
			if (!online) throw new TypeError('Failed to fetch')
			return json(200, {
				data: { accessToken: token('access', 900), refreshToken: token('refresh', 86400) },
			})
		})
		await client.initialize()
		const binding = createKoraAuthSync({ authClient: client })
		const notified = vi.fn()
		const unsubscribe = binding.subscribe?.(notified)

		expect(await binding.resolveSyncState?.()).toEqual({
			state: 'authenticated',
			userId: 'user-1',
			token: null,
			offline: true,
			locked: false,
			deviceId: 'device-1',
		})
		expect(await binding.resolveNodeId?.()).toBe('device-1')

		online = true
		await client.retryNow()
		const fresh = await binding.resolveSyncState?.()
		expect(fresh).toMatchObject({ state: 'authenticated', userId: 'user-1' })
		expect(fresh && 'token' in fresh ? fresh.token : null).toEqual(expect.any(String))
		expect(notified).toHaveBeenCalled()
		unsubscribe?.()
		client.destroy()
	})

	it('reports signed-out after a definitive rejection', async () => {
		const { client } = await offlineClient(async () =>
			json(401, { error: 'Invalid or expired refresh token.' }),
		)
		await client.initialize()
		const binding = createKoraAuthSync({ authClient: client })
		expect(await binding.resolveSyncState?.()).toEqual({
			state: 'signed-out',
			mayConnectAnonymously: false,
		})
		expect(await binding.resolveUserId?.()).toBeUndefined()
	})
})

describe('refreshAccessToken (AUTH-11)', () => {
	async function freshClient(refresh: () => Promise<Response>) {
		const storage = createMemoryAuthTokenStorage()
		await storage.setTokens(token('access', 600), token('refresh', 90 * 86400))
		const calls = { refresh: 0 }
		const fetchFn = (async (input: RequestInfo | URL) => {
			if (String(input).endsWith('/auth/refresh')) {
				calls.refresh++
				return refresh()
			}
			throw new TypeError('offline')
		}) as typeof fetch
		const client = new AuthClient({ serverUrl: SERVER, storage, fetch: fetchFn })
		return { client, storage, calls }
	}

	it('refreshes even though the cached access token is still valid locally', async () => {
		const next = token('access', 900, 1)
		const { client, calls } = await freshClient(async () =>
			json(200, { data: { accessToken: next, refreshToken: token('refresh', 90 * 86400, 1) } }),
		)
		expect(await client.getAccessToken()).not.toBe(next)
		expect(calls.refresh).toBe(0)
		expect(await client.refreshAccessToken()).toBe(next)
		expect(calls.refresh).toBe(1)
		client.destroy()
	})

	it('a transient failure keeps the session and returns null', async () => {
		const { client, storage } = await freshClient(async () => {
			throw new TypeError('offline')
		})
		expect(await client.refreshAccessToken()).toBeNull()
		expect(await storage.getRefreshToken()).not.toBeNull()
		client.destroy()
	})
})
