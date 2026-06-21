import { createKoraAuthSync } from '@korajs/auth'
import { encodeJwt } from '@korajs/auth/server'
import { buildScopeMap, defineSchema, extractScopeValuesFromClaims, t } from '@korajs/core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createApp } from '../../src/create-app'

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

function makeAccessToken(payload: Record<string, unknown>): string {
	return encodeJwt(
		{
			type: 'access',
			iat: Math.floor(Date.now() / 1000),
			exp: Math.floor(Date.now() / 1000) + 3600,
			jti: 'test-jti',
			...payload,
		},
		'test-secret',
	)
}

describe('createApp auth sync binding', () => {
	afterEach(async () => {
		vi.restoreAllMocks()
	})

	test('uses device dev claim as store node id separate from user sub', async () => {
		const token = makeAccessToken({
			sub: 'user-123',
			dev: 'device-456',
			orgId: 'org-789',
		})

		const authClient = {
			getAccessToken: vi.fn().mockResolvedValue(token),
		}

		const app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:auth-node' },
			sync: {
				url: 'wss://localhost:9999',
				authClient: createKoraAuthSync({ authClient, schema }),
			},
		})

		await app.ready
		expect(app.getStore()?.getNodeId()).toBe('device-456')
		await app.close()
	})

	test('builds scope map from JWT claims via auth binding', async () => {
		const token = makeAccessToken({
			sub: 'user-abc',
			dev: 'device-xyz',
			orgId: 'org-42',
		})

		const authClient = {
			getAccessToken: vi.fn().mockResolvedValue(token),
		}

		const app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:auth-scope' },
			sync: {
				url: 'wss://localhost:9999',
				authClient: createKoraAuthSync({ authClient, schema }),
			},
		})

		await app.ready

		const expectedScope = buildScopeMap(
			schema,
			extractScopeValuesFromClaims(schema, { sub: 'user-abc', orgId: 'org-42' }),
		)

		expect(app.getSyncEngine()?.getActiveScope()).toEqual(expectedScope)
		await app.close()
	})
})
