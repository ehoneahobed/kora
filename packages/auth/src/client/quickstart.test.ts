import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createKoraAuth } from './quickstart'
import type { AuthKeyValueStorage } from './storage'

function createStore(): AuthKeyValueStorage & { values: Map<string, string> } {
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

describe('createKoraAuth', () => {
	beforeEach(() => {
		vi.stubGlobal('fetch', vi.fn())
	})

	it('creates an auth client from a credential store', async () => {
		const store = createStore()
		const auth = createKoraAuth({
			serverUrl: 'https://api.example.com',
			credentialStore: store,
			deviceIdentity: false,
		})

		await auth.initialize()
		expect(auth.state).toBe('unauthenticated')

		await auth.signOut()
		expect(store.values.has('kora_auth_access_token')).toBe(false)
	})

	it('uses an explicit device identity provider', async () => {
		const fetchMock = vi.fn<typeof fetch>()
		vi.stubGlobal('fetch', fetchMock)
		fetchMock
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						data: {
							tokens: {
								accessToken: jwt({ sub: 'user-1', exp: future(), type: 'access' }),
								refreshToken: jwt({ sub: 'user-1', exp: future(), type: 'refresh' }),
							},
							user: { id: 'user-1', email: 'a@b.com', name: 'Alice' },
						},
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ data: { id: 'user-1', email: 'a@b.com', name: 'Alice' } }), {
					status: 200,
				}),
			)

		const auth = createKoraAuth({
			serverUrl: 'https://api.example.com',
			credentialStore: createStore(),
			deviceIdentity: {
				async getDeviceIdentity() {
					return {
						deviceId: 'device-1',
						devicePublicKey: '{"kty":"EC"}',
					}
				},
			},
		})

		await auth.initialize()
		await auth.signIn({ email: 'a@b.com', password: 'password123' })

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(JSON.parse(init.body as string)).toMatchObject({
			deviceId: 'device-1',
			devicePublicKey: '{"kty":"EC"}',
		})
	})
})

function future(): number {
	return Math.floor(Date.now() / 1000) + 3600
}

function jwt(payload: Record<string, unknown>): string {
	const encode = (value: unknown) =>
		btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
	return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`
}
