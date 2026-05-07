import { describe, test, expect, beforeEach } from 'vitest'
import { RbacEngine, defineRoles } from './rbac-engine'
import { InMemoryOrgStore } from '../org/org-store'
import {
	BUILT_IN_ROLES,
	parsePermission,
	permissionCovers,
	RoleNotFoundError,
	CircularInheritanceError,
	InvalidPermissionError,
} from './rbac-types'
import type { Permission } from './rbac-types'

// =========================================================================
// Permission helpers
// =========================================================================

describe('parsePermission', () => {
	test('parses resource:action', () => {
		const result = parsePermission('todos:read')
		expect(result).toEqual({ resource: 'todos', action: 'read' })
	})

	test('parses wildcards', () => {
		expect(parsePermission('*:*')).toEqual({ resource: '*', action: '*' })
		expect(parsePermission('todos:*')).toEqual({ resource: 'todos', action: '*' })
		expect(parsePermission('*:read')).toEqual({ resource: '*', action: 'read' })
	})

	test('handles colons in action', () => {
		const result = parsePermission('org:manage-members')
		expect(result).toEqual({ resource: 'org', action: 'manage-members' })
	})

	test('rejects missing colon', () => {
		expect(() => parsePermission('invalid' as Permission)).toThrow(InvalidPermissionError)
	})

	test('rejects empty resource', () => {
		expect(() => parsePermission(':action' as Permission)).toThrow(InvalidPermissionError)
	})

	test('rejects empty action', () => {
		expect(() => parsePermission('resource:' as Permission)).toThrow(InvalidPermissionError)
	})
})

describe('permissionCovers', () => {
	test('exact match', () => {
		expect(permissionCovers('todos:read', 'todos:read')).toBe(true)
	})

	test('different permission', () => {
		expect(permissionCovers('todos:read', 'todos:write')).toBe(false)
		expect(permissionCovers('todos:read', 'projects:read')).toBe(false)
	})

	test('action wildcard covers specific action', () => {
		expect(permissionCovers('todos:*', 'todos:read')).toBe(true)
		expect(permissionCovers('todos:*', 'todos:write')).toBe(true)
		expect(permissionCovers('todos:*', 'todos:delete')).toBe(true)
	})

	test('action wildcard does not cover different resource', () => {
		expect(permissionCovers('todos:*', 'projects:read')).toBe(false)
	})

	test('resource wildcard covers specific resource', () => {
		expect(permissionCovers('*:read', 'todos:read')).toBe(true)
		expect(permissionCovers('*:read', 'projects:read')).toBe(true)
	})

	test('resource wildcard does not cover different action', () => {
		expect(permissionCovers('*:read', 'todos:write')).toBe(false)
	})

	test('full wildcard covers everything', () => {
		expect(permissionCovers('*:*', 'todos:read')).toBe(true)
		expect(permissionCovers('*:*', 'projects:write')).toBe(true)
		expect(permissionCovers('*:*', 'org:manage-members')).toBe(true)
	})
})

// =========================================================================
// RbacEngine
// =========================================================================

describe('RbacEngine', () => {
	let store: InMemoryOrgStore
	let rbac: RbacEngine

	beforeEach(async () => {
		store = new InMemoryOrgStore()
		rbac = new RbacEngine(store)
	})

	describe('built-in roles', () => {
		test('recognizes all built-in roles', () => {
			const names = rbac.getRoleNames()
			expect(names).toContain('owner')
			expect(names).toContain('admin')
			expect(names).toContain('member')
			expect(names).toContain('viewer')
			expect(names).toContain('billing')
		})

		test('owner has wildcard permission', () => {
			expect(rbac.roleHasPermission('owner', 'anything:everything')).toBe(true)
			expect(rbac.roleHasPermission('owner', 'todos:read')).toBe(true)
			expect(rbac.roleHasPermission('owner', 'org:manage-members')).toBe(true)
		})

		test('admin inherits from member which inherits from viewer', () => {
			const adminPerms = rbac.getRolePermissions('admin')
			// Admin has org management
			expect(adminPerms).toContain('org:manage-members')
			expect(adminPerms).toContain('org:manage-settings')
			// Inherited from member
			expect(adminPerms).toContain('*:write')
			expect(adminPerms).toContain('*:delete')
			// Inherited from viewer (through member)
			expect(adminPerms).toContain('*:read')
		})

		test('member inherits from viewer', () => {
			const memberPerms = rbac.getRolePermissions('member')
			expect(memberPerms).toContain('*:write')
			expect(memberPerms).toContain('*:read') // inherited from viewer
		})

		test('viewer only has read', () => {
			const viewerPerms = rbac.getRolePermissions('viewer')
			expect(viewerPerms).toEqual(['*:read'])
		})

		test('billing has no data permissions', () => {
			expect(rbac.roleHasPermission('billing', 'todos:read')).toBe(false)
			expect(rbac.roleHasPermission('billing', 'org:billing')).toBe(true)
		})
	})

	describe('hasPermission', () => {
		test('returns true for permitted action', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			expect(await rbac.hasPermission('user-1', org.id, 'todos:read')).toBe(true)
		})

		test('returns false for non-member', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			expect(await rbac.hasPermission('user-999', org.id, 'todos:read')).toBe(false)
		})

		test('viewer cannot write', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'viewer', 'user-1')
			expect(await rbac.hasPermission('user-2', org.id, 'todos:write')).toBe(false)
			expect(await rbac.hasPermission('user-2', org.id, 'todos:read')).toBe(true)
		})

		test('member can read and write', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'member', 'user-1')
			expect(await rbac.hasPermission('user-2', org.id, 'todos:read')).toBe(true)
			expect(await rbac.hasPermission('user-2', org.id, 'todos:write')).toBe(true)
		})

		test('admin can manage members', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'admin', 'user-1')
			expect(await rbac.hasPermission('user-2', org.id, 'org:manage-members')).toBe(true)
		})

		test('member cannot manage members', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'member', 'user-1')
			expect(await rbac.hasPermission('user-2', org.id, 'org:manage-members')).toBe(false)
		})
	})

	describe('getUserPermissions', () => {
		test('returns permissions for a member', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'viewer', 'user-1')

			const perms = await rbac.getUserPermissions('user-2', org.id)
			expect(perms).toEqual(['*:read'])
		})

		test('returns empty for non-member', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const perms = await rbac.getUserPermissions('user-999', org.id)
			expect(perms).toEqual([])
		})
	})

	describe('resolveScopes', () => {
		test('returns scopes for a member', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'member', 'user-1')

			const scopes = await rbac.resolveScopes('user-2', org.id, ['todos', 'projects'])
			expect(scopes).not.toBeNull()
			expect(scopes!.todos).toEqual({ orgId: org.id })
			expect(scopes!.projects).toEqual({ orgId: org.id })
		})

		test('viewer gets read-only scopes', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'viewer', 'user-1')

			const scopes = await rbac.resolveScopes('user-2', org.id, ['todos'])
			expect(scopes).not.toBeNull()
			expect(scopes!.todos).toEqual({ orgId: org.id, __readonly: true })
		})

		test('billing gets empty scopes (no data access)', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'billing', 'user-1')

			const scopes = await rbac.resolveScopes('user-2', org.id, ['todos'])
			expect(scopes).not.toBeNull()
			expect(scopes).toEqual({})
		})

		test('returns null for non-member', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const scopes = await rbac.resolveScopes('user-999', org.id, ['todos'])
			expect(scopes).toBeNull()
		})

		test('uses custom collection resolver when registered', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'member', 'user-1')

			rbac.registerScopeResolver('todos', (ctx) => ({
				orgId: ctx.orgId,
				userId: ctx.userId,
			}))

			const scopes = await rbac.resolveScopes('user-2', org.id, ['todos', 'projects'])
			expect(scopes!.todos).toEqual({ orgId: org.id, userId: 'user-2' })
			expect(scopes!.projects).toEqual({ orgId: org.id }) // default
		})

		test('custom resolver returning null excludes the collection', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'member', 'user-1')

			rbac.registerScopeResolver('secret', () => null)

			const scopes = await rbac.resolveScopes('user-2', org.id, ['todos', 'secret'])
			expect(scopes!.todos).toBeDefined()
			expect(scopes!.secret).toBeUndefined()
		})
	})

	describe('getRoleDefinition', () => {
		test('returns role definition', () => {
			const def = rbac.getRoleDefinition('admin')
			expect(def).not.toBeNull()
			expect(def!.name).toBe('admin')
			expect(def!.inherits).toContain('member')
		})

		test('returns null for unknown role', () => {
			expect(rbac.getRoleDefinition('superadmin')).toBeNull()
		})
	})
})

// =========================================================================
// Custom Roles
// =========================================================================

describe('custom roles', () => {
	test('engine works with custom role definitions', async () => {
		const store = new InMemoryOrgStore()
		const roles = defineRoles()
			.role('reader', ['todos:read', 'projects:read'])
			.role('editor', ['todos:write', 'projects:write'], { inherits: ['reader'] })
			.role('manager', ['org:manage-members'], { inherits: ['editor'] })
			.build()

		const rbac = new RbacEngine(store, { roles })

		expect(rbac.roleHasPermission('reader', 'todos:read')).toBe(true)
		expect(rbac.roleHasPermission('reader', 'todos:write')).toBe(false)

		expect(rbac.roleHasPermission('editor', 'todos:write')).toBe(true)
		expect(rbac.roleHasPermission('editor', 'todos:read')).toBe(true) // inherited

		expect(rbac.roleHasPermission('manager', 'org:manage-members')).toBe(true)
		expect(rbac.roleHasPermission('manager', 'todos:read')).toBe(true) // inherited through editor → reader
	})

	test('defineRoles builder with built-in roles', () => {
		const roles = defineRoles()
			.withBuiltInRoles()
			.role('super-admin', ['org:danger-zone'], { inherits: ['admin'] })
			.build()

		expect(roles.find((r) => r.name === 'owner')).toBeDefined()
		expect(roles.find((r) => r.name === 'super-admin')).toBeDefined()
	})

	test('rejects circular inheritance', () => {
		const store = new InMemoryOrgStore()
		const roles = defineRoles()
			.role('a', ['x:y'], { inherits: ['b'] })
			.role('b', ['x:z'], { inherits: ['a'] })
			.build()

		expect(() => new RbacEngine(store, { roles })).toThrow(CircularInheritanceError)
	})

	test('rejects unknown inherited role', () => {
		const store = new InMemoryOrgStore()
		const roles = defineRoles()
			.role('a', ['x:y'], { inherits: ['nonexistent'] })
			.build()

		expect(() => new RbacEngine(store, { roles })).toThrow(RoleNotFoundError)
	})

	test('getRolePermissions throws for unknown role', () => {
		const store = new InMemoryOrgStore()
		const rbac = new RbacEngine(store)
		expect(() => rbac.getRolePermissions('nonexistent')).toThrow(RoleNotFoundError)
	})
})
