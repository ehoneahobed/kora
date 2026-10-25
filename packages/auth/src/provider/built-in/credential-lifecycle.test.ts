import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeJwt } from '../../tokens/jwt'
import { InMemoryTokenRevocationStore, TokenManager } from '../../tokens/token-manager'
import type { AuthRevocationEvent } from './auth-routes'
import { InMemoryAuthStoreError, createKoraAuthServer } from './quickstart-server'
import { SqliteUserStore } from './sqlite-user-store'
import { DeviceOwnershipError, InMemoryUserStore } from './user-store'

const SECRET = 'l'.repeat(64)
const require = createRequire(import.meta.url)

type Tokens = { accessToken: string; refreshToken: string }

async function signUp(
	auth: ReturnType<typeof createKoraAuthServer>,
	email: string,
	deviceId?: string,
): Promise<{ userId: string; tokens: Tokens }> {
	const res = await auth.handleRequest({
		method: 'POST',
		path: '/auth/signup',
		body: { email, password: 'password-123', ...(deviceId ? { deviceId } : {}) },
	})
	const data = (res.body as { data: { user: { id: string }; tokens: Tokens } }).data
	return { userId: data.user.id, tokens: data.tokens }
}

function bearer(token: string): Record<string, string> {
	return { authorization: `Bearer ${token}` }
}

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('device ownership (AUTH-5)', () => {
	it('every user store refuses a device id owned by another user', async () => {
		const Database = require('better-sqlite3') as new (f: string) => unknown
		const stores = [
			new InMemoryUserStore(),
			new SqliteUserStore(
				new Database(':memory:') as ConstructorParameters<typeof SqliteUserStore>[0],
			),
		]
		for (const store of stores) {
			const a = await store.createUser({ email: 'a@x.io', passwordHash: 'h', salt: 's', name: 'A' })
			const b = await store.createUser({ email: 'b@x.io', passwordHash: 'h', salt: 's', name: 'B' })
			await store.registerDevice({ id: 'shared', userId: a.id, publicKey: '', name: 'A' })
			await expect(
				store.registerDevice({ id: 'shared', userId: b.id, publicKey: '', name: 'B' }),
			).rejects.toBeInstanceOf(DeviceOwnershipError)
			// The owner can re-register (and re-activate after revocation).
			await store.revokeDevice('shared')
			const again = await store.registerDevice({
				id: 'shared',
				userId: a.id,
				publicKey: '',
				name: 'A',
			})
			expect(again).toMatchObject({ userId: a.id, revoked: false })
		}
	})

	it('sign-in with another user’s device id is a 409, and no id defaults to device-${userId}', async () => {
		const auth = createKoraAuthServer({ jwtSecret: SECRET })
		await signUp(auth, 'alice@example.com', 'alice-phone')
		const mallory = await signUp(auth, 'mallory@example.com')
		expect(decodeJwt(mallory.tokens.accessToken)?.dev).toMatch(/^dev-/)
		expect(decodeJwt(mallory.tokens.accessToken)?.dev).not.toBe(`device-${mallory.userId}`)

		const res = await auth.handleRequest({
			method: 'POST',
			path: '/auth/signin',
			body: { email: 'mallory@example.com', password: 'password-123', deviceId: 'alice-phone' },
		})
		expect(res.status).toBe(409)
		expect(res.body).toMatchObject({ code: 'DEVICE_OWNERSHIP_CONFLICT' })
	})
})

describe('authenticateAccess is the single access check (AUTH-2, AUTH-8)', () => {
	it('rejects revoked, family-revoked, device-revoked, user-revoked and deleted-user tokens', async () => {
		const auth = createKoraAuthServer({ jwtSecret: SECRET })
		const { userId, tokens } = await signUp(auth, 'u@example.com', 'd1')
		expect(await auth.routes.authenticateAccess(tokens.accessToken)).not.toBeNull()

		await auth.revokeAllForUser(userId)
		expect(await auth.routes.authenticateAccess(tokens.accessToken)).toBeNull()
		const me = await auth.handleRequest({
			method: 'GET',
			path: '/auth/me',
			headers: bearer(tokens.accessToken),
		})
		expect(me.status).toBe(401)
		expect(me.body).toMatchObject({ code: 'ACCESS_TOKEN_INVALID' })

		// A fresh sign-in after the cut-off works again.
		await new Promise((r) => setTimeout(r, 2))
		const fresh = await auth.handleRequest({
			method: 'POST',
			path: '/auth/signin',
			body: { email: 'u@example.com', password: 'password-123', deviceId: 'd1' },
		})
		const freshAccess = (fresh.body as { data: { tokens: Tokens } }).data.tokens.accessToken
		expect(await auth.routes.authenticateAccess(freshAccess)).not.toBeNull()

		await auth.userStore.delete(userId)
		expect(await auth.routes.authenticateAccess(freshAccess)).toBeNull()
	})

	it('a refresh token whose device record was revoked is refused even without a store cut-off', async () => {
		const store = new InMemoryUserStore()
		const tokenManager = new TokenManager({
			secret: SECRET,
			revocationStore: new InMemoryTokenRevocationStore(),
		})
		const auth = createKoraAuthServer({ userStore: store, tokenManager })
		const { tokens } = await signUp(auth, 'r@example.com', 'phone')
		await store.revokeDevice('phone') // record only, e.g. revoked by an admin tool
		const res = await auth.handleRequest({
			method: 'POST',
			path: '/auth/refresh',
			body: { refreshToken: tokens.refreshToken },
		})
		expect(res.status).toBe(401)
		expect(res.body).toMatchObject({ code: 'REFRESH_TOKEN_INVALID' })
	})
})

describe('refresh responses carry machine-readable codes (AUTH-13 server side)', () => {
	it('a duplicate of an in-flight rotation is a retriable 409, never a reuse sign-out', async () => {
		const auth = createKoraAuthServer({ jwtSecret: SECRET })
		const { tokens } = await signUp(auth, 'c@example.com', 'd1')
		const [a, b] = await Promise.all([
			auth.handleRequest({
				method: 'POST',
				path: '/auth/refresh',
				body: { refreshToken: tokens.refreshToken },
			}),
			auth.handleRequest({
				method: 'POST',
				path: '/auth/refresh',
				body: { refreshToken: tokens.refreshToken },
			}),
		])
		expect([a.status, b.status].sort()).toEqual([200, 409])
		const conflict = a.status === 409 ? a : b
		expect(conflict.body).toMatchObject({ code: 'REFRESH_IN_PROGRESS' })
		expect(conflict.headers?.['Retry-After']).toBe('1')
		// The later retry gets the same successor pair (grace replay).
		const retry = await auth.handleRequest({
			method: 'POST',
			path: '/auth/refresh',
			body: { refreshToken: tokens.refreshToken },
		})
		const winner = a.status === 200 ? a : b
		expect(retry.status).toBe(200)
		expect(retry.body).toEqual(winner.body)
	})
})

describe('revocation events (AUTH-11 hook)', () => {
	it('sign-out, device revocation and user revocation reach bindSyncServer', async () => {
		const auth = createKoraAuthServer({ jwtSecret: SECRET })
		const events: AuthRevocationEvent[] = []
		const terminated: Array<{ userId?: string; deviceId?: string }> = []
		auth.onRevoke((e) => {
			events.push(e)
		})
		const unbind = auth.bindSyncServer({ terminateSessions: (f) => terminated.push(f) })
		const { userId, tokens } = await signUp(auth, 'e@example.com', 'phone')
		const laptop = await auth.handleRequest({
			method: 'POST',
			path: '/auth/signin',
			body: { email: 'e@example.com', password: 'password-123', deviceId: 'laptop' },
		})
		const laptopTokens = (laptop.body as { data: { tokens: Tokens } }).data.tokens

		await auth.handleRequest({
			method: 'DELETE',
			path: '/auth/device/laptop',
			headers: bearer(tokens.accessToken),
		})
		await auth.handleRequest({
			method: 'POST',
			path: '/auth/signout',
			headers: bearer(tokens.accessToken),
			body: { refreshToken: tokens.refreshToken },
		})
		await auth.revokeAllForUser(userId)
		unbind()
		await auth.revokeAllForUser(userId)

		expect(events.map((e) => e.kind)).toEqual(['device', 'session', 'user', 'user'])
		expect(terminated).toEqual([
			{ userId, deviceId: 'laptop' },
			{ userId, deviceId: 'phone' },
			{ userId },
		])
		expect(await auth.routes.authenticateAccess(laptopTokens.accessToken)).toBeNull()
	})

	it('sign-out revokes the whole refresh family, including a just-rotated successor', async () => {
		const auth = createKoraAuthServer({ jwtSecret: SECRET })
		const { tokens } = await signUp(auth, 'f@example.com', 'd1')
		const rotated = await auth.handleRequest({
			method: 'POST',
			path: '/auth/refresh',
			body: { refreshToken: tokens.refreshToken },
		})
		const successor = (rotated.body as { data: Tokens }).data
		await auth.handleRequest({
			method: 'POST',
			path: '/auth/signout',
			headers: bearer(successor.accessToken),
			body: { refreshToken: successor.refreshToken },
		})
		// Neither the old token's grace replay nor the successor work any more.
		const replay = await auth.handleRequest({
			method: 'POST',
			path: '/auth/refresh',
			body: { refreshToken: tokens.refreshToken },
		})
		expect(replay.status).toBe(401)
		expect(await auth.routes.authenticateAccess(successor.accessToken)).toBeNull()
	})
})

describe('persistent revocation by default (AUTH-12)', () => {
	it('uses the user store’s revocation store, so a second instance sees sign-outs', async () => {
		const Database = require('better-sqlite3') as new (f: string) => unknown
		const db = new Database(':memory:')
		const userStore = new SqliteUserStore(db as ConstructorParameters<typeof SqliteUserStore>[0])
		const one = createKoraAuthServer({ jwtSecret: SECRET, userStore })
		const { tokens } = await signUp(one, 's@example.com', 'd1')
		await one.handleRequest({
			method: 'POST',
			path: '/auth/signout',
			headers: bearer(tokens.accessToken),
			body: { refreshToken: tokens.refreshToken },
		})
		const two = createKoraAuthServer({ jwtSecret: SECRET, userStore })
		const res = await two.handleRequest({
			method: 'POST',
			path: '/auth/refresh',
			body: { refreshToken: tokens.refreshToken },
		})
		expect(res.status).toBe(401)
	})

	it('production refuses in-memory stores unless allowInMemory is set', () => {
		vi.stubEnv('NODE_ENV', 'production')
		expect(() => createKoraAuthServer({ jwtSecret: SECRET })).toThrow(InMemoryAuthStoreError)
		const Database = require('better-sqlite3') as new (f: string) => unknown
		const userStore = new SqliteUserStore(
			new Database(':memory:') as ConstructorParameters<typeof SqliteUserStore>[0],
		)
		expect(() =>
			createKoraAuthServer({
				jwtSecret: SECRET,
				userStore,
				revocationStore: new InMemoryTokenRevocationStore(),
			}),
		).toThrow(InMemoryAuthStoreError)
		expect(() => createKoraAuthServer({ jwtSecret: SECRET, userStore })).not.toThrow()
		expect(() => createKoraAuthServer({ jwtSecret: SECRET, allowInMemory: true })).not.toThrow()
	})
})

describe('sign-in throttling and timing (AUTH-9)', () => {
	it('limits per account across IPs and per IP across accounts', async () => {
		const auth = createKoraAuthServer({ jwtSecret: SECRET })
		await signUp(auth, 'k@example.com')
		const statuses: number[] = []
		for (let i = 0; i < 11; i++) {
			const r = await auth.handleRequest({
				method: 'POST',
				path: '/auth/signin',
				body: { email: 'unknown-user@example.com', password: 'nope-nope' },
				ip: '198.51.100.7',
			})
			statuses.push(r.status)
		}
		expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true)
		expect(statuses[10]).toBe(429)
		// Another account from the same (now throttled) IP is refused too.
		const other = await auth.handleRequest({
			method: 'POST',
			path: '/auth/signin',
			body: { email: 'k@example.com', password: 'password-123' },
			ip: '198.51.100.7',
		})
		expect(other.status).toBe(429)
		expect(other.headers?.['Retry-After']).toBe('60')
	}, 60_000)
})
