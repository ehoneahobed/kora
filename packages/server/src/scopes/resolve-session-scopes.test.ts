import { fc, test as propTest } from '@fast-check/vitest'
import { SCOPE_CLAIMS_KEY, claimScopes, defineSchema, t } from '@korajs/core'
import { describe, expect, test, vi } from 'vitest'
import {
	ScopeRequiredError,
	resolveSessionScopeGrant,
	resolveSessionScopes,
} from './resolve-session-scopes'
import { operationMatchesScopes } from './server-scope-filter'

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

const multiTenant = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), userId: t.string() }, scope: ['userId'] },
		projects: { fields: { name: t.string(), orgId: t.string() }, scope: ['orgId'] },
		settings: { fields: { theme: t.string() } },
	},
})

describe('resolveSessionScopes', () => {
	test('builds scope from schema sync rules and verified scope values', () => {
		const scopes = resolveSessionScopes(schema, {
			scopeValues: { userId: 'user-1' },
		})

		expect(scopes).toEqual({ todos: { userId: 'user-1' } })
	})

	test('auth scopes override handshake scopes per collection', () => {
		const scopes = resolveSessionScopes(schema, {
			handshakeScope: { todos: { userId: 'client-user' } },
			authScopes: { todos: { userId: 'server-user' } },
		})

		expect(scopes).toEqual({ todos: { userId: 'server-user' } })
	})

	// Inverted (AUTH-1): this test used to assert that, with no auth scopes, the
	// handshake scope became the session's scope ("merges handshake scope when
	// auth is absent"). For an authenticated session that let any user claim any
	// tenant. Now an authenticated session without a grant never trusts the
	// handshake: scoped collections are denied.
	test('an authenticated session without a grant does not adopt the handshake scope', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const scopes = resolveSessionScopes(multiTenant, {
			handshakeScope: { todos: { userId: 'client-user' } },
			authenticated: true,
		})
		warn.mockRestore()

		expect(scopes).toEqual({ settings: {} })
	})

	test('without any auth provider the handshake is only a client-side filter', () => {
		const scopes = resolveSessionScopes(null, {
			handshakeScope: { todos: { userId: 'client-user' } },
		})

		expect(scopes).toEqual({ todos: { userId: 'client-user' } })
	})

	test('a handshake can never add a collection the grant omits', () => {
		const scopes = resolveSessionScopes(multiTenant, {
			authScopes: { todos: { userId: 'u1' } },
			handshakeScope: { projects: {}, settings: {}, todos: {} },
		})
		expect(scopes).toEqual({ todos: { userId: 'u1' } })
	})

	test('an empty grant means nothing visible, never "unscoped"', () => {
		const scopes = resolveSessionScopes(multiTenant, { authScopes: {} })
		expect(scopes).toEqual({})
	})

	test('a handshake may narrow an unconstrained field and an $in grant to a subset', () => {
		const scopes = resolveSessionScopes(multiTenant, {
			authScopes: { projects: { orgId: { $in: ['o1', 'o2'] } }, settings: {} },
			handshakeScope: { projects: { orgId: 'o2' }, settings: { theme: 'dark' } },
		})
		expect(scopes).toEqual({ projects: { orgId: 'o2' }, settings: { theme: 'dark' } })
	})

	test('an $in handshake value outside the grant is ignored (grant wins)', () => {
		const scopes = resolveSessionScopes(multiTenant, {
			authScopes: { projects: { orgId: { $in: ['o1', 'o2'] } } },
			handshakeScope: { projects: { orgId: { $in: ['o2', 'o3'] } } },
		})
		expect(scopes).toEqual({ projects: { orgId: { $in: ['o1', 'o2'] } } })
	})

	test('$claims binds every schema-scoped collection from verified values', () => {
		const scopes = resolveSessionScopes(multiTenant, {
			authScopes: claimScopes({ userId: 'u1', orgId: 'o1' }),
		})
		expect(scopes).toEqual({
			todos: { userId: 'u1' },
			projects: { orgId: 'o1' },
			settings: {},
		})
	})

	test('an unresolved binding denies the collection (fail closed, SCOPE_REQUIRED)', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const result = resolveSessionScopeGrant(multiTenant, {
			authScopes: claimScopes({ userId: 'u1' }),
			handshakeScope: { projects: { orgId: 'victim-org' } },
		})
		expect(result.scopes).toEqual({ todos: { userId: 'u1' }, settings: {} })
		expect(result.denied).toEqual([{ collection: 'projects', missingKeys: ['orgId'] }])
		warn.mockRestore()

		expect(() =>
			resolveSessionScopes(multiTenant, {
				authScopes: claimScopes({ userId: 'u1' }),
				onUnresolved: 'throw',
			}),
		).toThrow(ScopeRequiredError)
	})

	test('an explicit grant for a collection covers its unresolved claim binding', () => {
		const result = resolveSessionScopeGrant(multiTenant, {
			authScopes: claimScopes({ userId: 'u1' }, { projects: { orgId: 'o9' } }),
		})
		expect(result.denied).toEqual([])
		expect(result.scopes?.projects).toEqual({ orgId: 'o9' })
	})

	test('array claim values become $in predicates', () => {
		const scopes = resolveSessionScopes(multiTenant, {
			authScopes: claimScopes({ userId: 'u1', orgId: ['o1', 'o2'] }),
		})
		expect(scopes?.projects).toEqual({ orgId: { $in: ['o1', 'o2'] } })
	})

	test('the reserved $claims key never leaks into the effective scope', () => {
		const scopes = resolveSessionScopes(null, {
			handshakeScope: { [SCOPE_CLAIMS_KEY]: { userId: 'x' }, todos: {} },
		})
		expect(scopes).toEqual({ todos: {} })
	})
})

const value = fc.constantFrom('a', 'b', 'c', 'd')
const predicate = fc.oneof(
	value,
	fc.uniqueArray(value, { minLength: 1, maxLength: 4 }).map((values) => ({ $in: values })),
)
const scopeArb = fc.dictionary(
	fc.constantFrom('todos', 'projects', 'settings'),
	fc.dictionary(fc.constantFrom('userId', 'orgId', 'title'), predicate, { maxKeys: 2 }),
	{ maxKeys: 3 },
)
const recordArb = fc.record({
	collection: fc.constantFrom('todos', 'projects', 'settings'),
	userId: value,
	orgId: value,
	title: value,
})

describe('resolveSessionScopes invariant: effective scope ⊆ server grant', () => {
	propTest.prop([scopeArb, scopeArb, recordArb])(
		'every record visible under the effective scope is visible under the grant',
		(grant, handshake, record) => {
			const effective = resolveSessionScopes(multiTenant, {
				authScopes: grant,
				handshakeScope: handshake,
			})
			const op = {
				id: 'op',
				nodeId: 'n',
				type: 'insert' as const,
				collection: record.collection,
				recordId: 'r',
				data: { userId: record.userId, orgId: record.orgId, title: record.title },
				previousData: null,
				timestamp: { wallTime: 1, logical: 0, nodeId: 'n' },
				sequenceNumber: 1,
				causalDeps: [],
				schemaVersion: 1,
			}
			if (operationMatchesScopes(op, effective)) {
				expect(operationMatchesScopes(op, grant)).toBe(true)
			}
			expect(Object.keys(effective ?? {}).every((c) => c in grant)).toBe(true)
		},
	)
})
