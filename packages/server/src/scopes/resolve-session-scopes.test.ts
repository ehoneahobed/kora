import { buildScopeMap, defineSchema, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { resolveSessionScopes } from './resolve-session-scopes'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				userId: t.string(),
			},
		},
	},
	sync: {
		todos: { where: { userId: true } },
	},
})

describe('resolveSessionScopes', () => {
	test('builds scope from schema sync rules and scope values', () => {
		const scopes = resolveSessionScopes(schema, {
			scopeValues: { userId: 'user-1' },
		})

		expect(scopes).toEqual(buildScopeMap(schema, { userId: 'user-1' }))
	})

	test('auth scopes override handshake scopes per collection', () => {
		const scopes = resolveSessionScopes(schema, {
			handshakeScope: { todos: { userId: 'client-user' } },
			authScopes: { todos: { userId: 'server-user' } },
		})

		expect(scopes).toEqual({ todos: { userId: 'server-user' } })
	})

	test('merges handshake scope when auth is absent', () => {
		const scopes = resolveSessionScopes(null, {
			handshakeScope: { todos: { userId: 'client-user' } },
		})

		expect(scopes).toEqual({ todos: { userId: 'client-user' } })
	})
})
