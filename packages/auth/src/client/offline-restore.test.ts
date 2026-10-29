import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthClient, type AuthOfflineRestoreInfo, CLOCK_ROLLBACK_TOLERANCE_MS } from './auth-client'
import { createKoraAuthSync, judgeOfflineRestore } from './auth-sync'
import {
	createAuthTokenStorage,
	createMemoryAuthTokenStorage,
	createWebStorageAuthTokenStorage,
} from './storage'

const NOW = 1_800_000_000_000
const DAY = 86_400_000

function info(overrides: Partial<AuthOfflineRestoreInfo> = {}): AuthOfflineRestoreInfo {
	return {
		durability: 'durable',
		signedIn: true,
		locked: false,
		hasCredentials: true,
		refreshIssuedAt: NOW - DAY,
		refreshExpiresAt: null,
		maxOfflineGraceMs: undefined,
		...overrides,
	}
}

describe('judgeOfflineRestore (offline-readiness design 8.2)', () => {
	it('restorable with no limit when nothing bounds the offline period', () => {
		expect(judgeOfflineRestore(info(), NOW)).toEqual({ restorable: true, until: null })
	})

	it('signed out, or missing credentials, is not restorable', () => {
		expect(judgeOfflineRestore(info({ signedIn: false }), NOW)).toEqual({
			restorable: false,
			reason: 'signed-out',
		})
		expect(judgeOfflineRestore(info({ hasCredentials: false }), NOW)).toEqual({
			restorable: false,
			reason: 'signed-out',
		})
	})

	it('credentials that do not survive a reload are not restorable (memory, session)', () => {
		for (const durability of ['memory', 'session'] as const) {
			expect(judgeOfflineRestore(info({ durability }), NOW)).toEqual({
				restorable: false,
				reason: 'non-durable-credentials',
			})
		}
	})

	it('a store that did not say is unknown, never restorable', () => {
		expect(judgeOfflineRestore(info({ durability: undefined }), NOW)).toEqual({
			restorable: 'unknown',
			reason: 'credential-durability-unknown',
		})
	})

	it('until is the earlier of the grace end and the refresh token expiry', () => {
		const grace = 7 * DAY
		const issued = NOW - DAY
		expect(
			judgeOfflineRestore(
				info({
					refreshIssuedAt: issued,
					maxOfflineGraceMs: grace,
					refreshExpiresAt: NOW + 30 * DAY,
				}),
				NOW,
			),
		).toEqual({ restorable: true, until: issued + grace })
		expect(
			judgeOfflineRestore(
				info({
					refreshIssuedAt: issued,
					maxOfflineGraceMs: grace,
					refreshExpiresAt: NOW + 2 * DAY,
				}),
				NOW,
			),
		).toEqual({ restorable: true, until: NOW + 2 * DAY })
		expect(judgeOfflineRestore(info({ refreshExpiresAt: NOW + 3 * DAY }), NOW)).toEqual({
			restorable: true,
			until: NOW + 3 * DAY,
		})
	})

	it('the grace measures from the stored refresh issue time, not from the page load', () => {
		const result = judgeOfflineRestore(
			info({ refreshIssuedAt: NOW - 6 * DAY, maxOfflineGraceMs: 7 * DAY }),
			NOW,
		)
		expect(result).toEqual({ restorable: true, until: NOW + DAY })
	})

	it('an elapsed grace or an expired refresh token is expired', () => {
		expect(
			judgeOfflineRestore(
				info({ refreshIssuedAt: NOW - 8 * DAY, maxOfflineGraceMs: 7 * DAY }),
				NOW,
			),
		).toEqual({ restorable: false, reason: 'expired' })
		expect(judgeOfflineRestore(info({ refreshExpiresAt: NOW }), NOW)).toEqual({
			restorable: false,
			reason: 'expired',
		})
	})

	it('a wall clock set back beyond the tolerance is clock-rollback', () => {
		const issued = NOW + CLOCK_ROLLBACK_TOLERANCE_MS + 1
		expect(judgeOfflineRestore(info({ refreshIssuedAt: issued }), NOW)).toEqual({
			restorable: false,
			reason: 'clock-rollback',
		})
		// Inside the tolerance the reload does not lock either.
		expect(
			judgeOfflineRestore(info({ refreshIssuedAt: NOW + CLOCK_ROLLBACK_TOLERANCE_MS }), NOW),
		).toMatchObject({ restorable: true })
	})

	it('a session the client already locked is locked', () => {
		expect(judgeOfflineRestore(info({ locked: true }), NOW)).toEqual({
			restorable: false,
			reason: 'locked',
		})
	})
})

describe('token storage durability', () => {
	it('memory storage is memory', () => {
		expect(createMemoryAuthTokenStorage().durability).toBe('memory')
	})

	it('a custom key-value store is unknown unless the app declares it', () => {
		const store = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
		expect(createAuthTokenStorage({ store }).durability).toBeUndefined()
		expect(createAuthTokenStorage({ store, durability: 'durable' }).durability).toBe('durable')
	})

	it('the two Web Storage areas are told apart by identity', () => {
		const make = () => {
			const values = new Map<string, string>()
			return {
				getItem: (k: string) => values.get(k) ?? null,
				setItem: (k: string, v: string) => void values.set(k, v),
				removeItem: (k: string) => void values.delete(k),
				clear: () => values.clear(),
				key: () => null,
				length: 0,
			} as unknown as Storage
		}
		const local = make()
		const session = make()
		vi.stubGlobal('localStorage', local)
		vi.stubGlobal('sessionStorage', session)
		expect(createWebStorageAuthTokenStorage(local).durability).toBe('durable')
		expect(createWebStorageAuthTokenStorage(session).durability).toBe('session')
		expect(createWebStorageAuthTokenStorage(make()).durability).toBeUndefined()
	})
})

function b64url(value: unknown): string {
	return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function jwt(type: 'access' | 'refresh', expiresInSeconds: number): string {
	const iat = Math.floor(Date.now() / 1000)
	return `${b64url({ alg: 'HS256' })}.${b64url({
		sub: 'user-1',
		dev: 'device-1',
		type,
		iat,
		exp: iat + expiresInSeconds,
	})}.sig`
}

describe('AuthClient offline restore, end to end through createKoraAuthSync', () => {
	afterEach(() => vi.useRealTimers())

	async function offlineClient(durability: 'durable' | undefined, grace?: number) {
		const values = new Map<string, string>()
		const storage = createAuthTokenStorage({
			store: {
				getItem: (k) => values.get(k) ?? null,
				setItem: (k, v) => void values.set(k, v),
				removeItem: (k) => void values.delete(k),
			},
			...(durability ? { durability } : {}),
		})
		await storage.setTokens(jwt('access', -60), jwt('refresh', 90 * 86400))
		const fetchFn = (async () => {
			throw new TypeError('offline')
		}) as typeof fetch
		const client = new AuthClient({
			serverUrl: 'https://auth.example.test',
			storage,
			fetch: fetchFn,
			...(grace === undefined ? {} : { maxOfflineGraceMs: grace }),
		})
		await client.initialize()
		return client
	}

	it('a signed-in offline session on durable storage is restorable until the refresh expiry', async () => {
		const client = await offlineClient('durable')
		const binding = createKoraAuthSync({ authClient: client })
		const result = await binding.resolveOfflineRestore?.()
		expect(result).toMatchObject({ restorable: true })
		expect((result as { until: number }).until).toBeGreaterThan(Date.now() + 80 * 86400_000)
	})

	it('storage that never said it is durable reports unknown (never ready)', async () => {
		const client = await offlineClient(undefined)
		const binding = createKoraAuthSync({ authClient: client })
		await expect(binding.resolveOfflineRestore?.()).resolves.toEqual({
			restorable: 'unknown',
			reason: 'credential-durability-unknown',
		})
	})

	it('a signed-out client is not restorable', async () => {
		const client = new AuthClient({
			serverUrl: 'https://auth.example.test',
			storage: createAuthTokenStorage({
				store: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
				durability: 'durable',
			}),
		})
		await client.initialize()
		const binding = createKoraAuthSync({ authClient: client })
		await expect(binding.resolveOfflineRestore?.()).resolves.toEqual({
			restorable: false,
			reason: 'signed-out',
		})
	})

	it('a grace shorter than the offline period reports expired', async () => {
		const client = await offlineClient('durable', 60_000)
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(Date.now() + 10 * 60_000)
		const binding = createKoraAuthSync({ authClient: client })
		await expect(binding.resolveOfflineRestore?.()).resolves.toEqual({
			restorable: false,
			reason: 'expired',
		})
	})

	it('a client without getOfflineRestoreInfo gives the binding no answer (unknown upstream)', () => {
		const binding = createKoraAuthSync({
			authClient: { getAccessToken: async () => null },
		})
		expect(binding.resolveOfflineRestore).toBeUndefined()
	})
})
