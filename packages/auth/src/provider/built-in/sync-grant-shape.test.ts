import { describe, expect, test } from 'vitest'
import { isSyncGrant, sessionScopes } from './sync-scopes'

/**
 * A directional grant must be told apart from a scope map by an explicit marker, never by its
 * key names: collections may be named anything, including `downlinkScopes` and `uplinkScopes`.
 */
describe('directional grant vs scope map', () => {
	test('a scope map whose collections are named downlinkScopes and uplinkScopes stays a scope map', () => {
		const legacy = {
			downlinkScopes: { orgId: 'org-1' },
			uplinkScopes: { orgId: 'org-1' },
		}
		expect(isSyncGrant(legacy)).toBe(false)
		expect(sessionScopes(legacy)).toEqual({ scopes: legacy })
	})

	test('a marked grant is directional', () => {
		const grant = {
			type: 'sync-grant' as const,
			downlinkScopes: { todos: { orgId: 'org-1' } },
			uplinkScopes: {},
		}
		expect(isSyncGrant(grant)).toBe(true)
		expect(sessionScopes(grant)).toEqual({
			downlinkScopes: { todos: { orgId: 'org-1' } },
			uplinkScopes: {},
		})
	})
})
