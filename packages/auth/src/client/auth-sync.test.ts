import { buildScopeMap, defineSchema, extractScopeValuesFromClaims, t } from '@korajs/core'
import { describe, expect, test, vi } from 'vitest'
import { encodeJwt } from '../tokens/jwt'
import { createKoraAuthSync } from './auth-sync'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				userId: t.string(),
				orgId: t.string(),
			},
			scope: ['userId', 'orgId'],
		},
	},
})

function makeToken(payload: Record<string, unknown>, secret = 'test-secret'): string {
	return encodeJwt(payload, secret)
}

describe('createKoraAuthSync', () => {
	test('returns token from auth client', async () => {
		const authClient = {
			getAccessToken: vi.fn().mockResolvedValue('access-token'),
		}

		const binding = createKoraAuthSync({ authClient })
		await expect(binding.auth()).resolves.toEqual({ token: 'access-token' })
	})

	test('returns empty token when unauthenticated', async () => {
		const authClient = {
			getAccessToken: vi.fn().mockResolvedValue(null),
		}

		const binding = createKoraAuthSync({ authClient })
		await expect(binding.auth()).resolves.toEqual({ token: '' })
	})

	test('resolveScopeMap builds map from JWT claims and schema', async () => {
		const token = makeToken({
			sub: 'user-abc',
			dev: 'device-xyz',
			orgId: 'org-1',
			exp: Math.floor(Date.now() / 1000) + 3600,
		})

		const authClient = {
			getAccessToken: vi.fn().mockResolvedValue(token),
		}

		const binding = createKoraAuthSync({ authClient, schema })
		const scopeMap = await binding.resolveScopeMap?.()

		expect(scopeMap).toEqual(
			buildScopeMap(
				schema,
				extractScopeValuesFromClaims(schema, { sub: 'user-abc', orgId: 'org-1' }),
			),
		)
	})

	test('resolveNodeId returns dev claim separate from sub', async () => {
		const token = makeToken({
			sub: 'user-abc',
			dev: 'device-xyz',
			exp: Math.floor(Date.now() / 1000) + 3600,
		})

		const authClient = {
			getAccessToken: vi.fn().mockResolvedValue(token),
		}

		const binding = createKoraAuthSync({ authClient })
		await expect(binding.resolveNodeId?.()).resolves.toBe('device-xyz')
	})

	test('scopeFromClaims override is applied', async () => {
		const token = makeToken({
			sub: 'user-abc',
			dev: 'device-xyz',
			customOrg: 'org-custom',
			exp: Math.floor(Date.now() / 1000) + 3600,
		})

		const authClient = {
			getAccessToken: vi.fn().mockResolvedValue(token),
		}

		const binding = createKoraAuthSync({
			authClient,
			schema,
			scopeFromClaims: () => ({ userId: 'override-user', orgId: 'override-org' }),
		})

		await expect(binding.resolveScopeMap?.()).resolves.toEqual(
			buildScopeMap(schema, { userId: 'override-user', orgId: 'override-org' }),
		)
	})

	test('subscribe forwards auth state changes', () => {
		const listeners = new Set<(state: 'authenticated' | 'unauthenticated') => void>()
		const authClient = {
			getAccessToken: vi.fn().mockResolvedValue(null),
			onAuthChange: (callback: (state: 'authenticated' | 'unauthenticated') => void) => {
				listeners.add(callback)
				return () => listeners.delete(callback)
			},
		}

		const syncListener = vi.fn()
		const binding = createKoraAuthSync({ authClient })
		const unsubscribe = binding.subscribe?.(syncListener)

		for (const listener of listeners) {
			listener('authenticated')
		}

		expect(syncListener).toHaveBeenCalledTimes(1)
		unsubscribe?.()
	})
})
