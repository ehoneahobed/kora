import { fc, test as propTest } from '@fast-check/vitest'
import { describe, expect, test } from 'vitest'
import { InMemoryOrgStore } from '../org/org-store'
import { RbacEngine, defineRoles } from './rbac-engine'
import type { Permission } from './rbac-types'
import { OrgScopeResolver } from './scope-resolver'

/**
 * RBAC sync grants are directional: what a member may download (read permission) and what
 * it may upload (write permission), per collection. Neither direction ever carries a
 * pseudo-field such as `__readonly`, which the sync server would treat as a record filter.
 */

const COLLECTIONS = ['todos', 'projects', 'notes'] as const

async function orgWith(role: 'viewer' | 'member', roles?: ReturnType<typeof defineRoles>) {
	const orgs = new InMemoryOrgStore()
	const org = await orgs.createOrg('owner', { name: 'Acme', slug: 'acme' })
	await orgs.addMember(org.id, 'user', role, 'owner')
	const rbac = new RbacEngine(orgs, roles ? { roles: roles.build() } : undefined)
	return { orgs, orgId: org.id, rbac, resolver: new OrgScopeResolver(orgs, rbac) }
}

function customRoles(viewer: Permission[], member: Permission[]) {
	return defineRoles()
		.role('viewer', viewer)
		.role('member', member, { inherits: ['viewer'] })
		.role('admin', ['org:manage-members'], { inherits: ['member'] })
		.role('owner', ['*:*'])
		.role('billing', ['org:billing'])
}

describe('RbacEngine.resolveScopes / OrgScopeResolver.resolve: directional grants', () => {
	test('built-in viewer: downloads every collection, uploads none', async () => {
		const { orgId, rbac, resolver } = await orgWith('viewer')
		for (const grant of [
			await rbac.resolveScopes('user', orgId, ['todos', 'projects']),
			await resolver.resolve('user', orgId, ['todos', 'projects']),
		]) {
			expect(grant).toEqual({
				type: 'sync-grant',
				downlinkScopes: { todos: { orgId }, projects: { orgId } },
				uplinkScopes: {},
			})
		}
	})

	test('built-in member: downloads and uploads every collection', async () => {
		const { orgId, rbac, resolver } = await orgWith('member')
		const expected = {
			type: 'sync-grant',
			downlinkScopes: { todos: { orgId }, projects: { orgId } },
			uplinkScopes: { todos: { orgId }, projects: { orgId } },
		}
		expect(await rbac.resolveScopes('user', orgId, ['todos', 'projects'])).toEqual(expected)
		expect(await resolver.resolve('user', orgId, ['todos', 'projects'])).toEqual(expected)
	})

	test('collection permissions without a wildcard are honoured per collection', async () => {
		const { orgId, rbac, resolver } = await orgWith(
			'member',
			customRoles(['todos:read'], ['todos:write']),
		)
		const expected = {
			type: 'sync-grant',
			downlinkScopes: { todos: { orgId } },
			uplinkScopes: { todos: { orgId } },
		}
		expect(await rbac.resolveScopes('user', orgId, ['todos', 'projects'])).toEqual(expected)
		expect(await resolver.resolve('user', orgId, ['todos', 'projects'])).toEqual(expected)
	})

	test('a custom collection scope applies to both directions, within the permissions', async () => {
		const { orgId, rbac, resolver } = await orgWith('viewer')
		const own = (ctx: { orgId: string; userId: string }) => ({
			orgId: ctx.orgId,
			userId: ctx.userId,
		})
		rbac.registerScopeResolver('todos', own)
		resolver.registerCollectionScope('todos', own)
		const expected = {
			type: 'sync-grant',
			downlinkScopes: { todos: { orgId, userId: 'user' } },
			uplinkScopes: {},
		}
		expect(await rbac.resolveScopes('user', orgId, ['todos'])).toEqual(expected)
		expect(await resolver.resolve('user', orgId, ['todos'])).toEqual(expected)
	})

	test('a non-member gets null; a billing-only role gets nothing in either direction', async () => {
		const { orgs, orgId, rbac, resolver } = await orgWith('viewer')
		expect(await rbac.resolveScopes('stranger', orgId, ['todos'])).toBeNull()
		await orgs.addMember(orgId, 'payer', 'billing', 'owner')
		const empty = { type: 'sync-grant', downlinkScopes: {}, uplinkScopes: {} }
		expect(await rbac.resolveScopes('payer', orgId, ['todos'])).toEqual(empty)
		expect(await resolver.resolve('payer', orgId, ['todos'])).toEqual(empty)
	})

	const permissionArb = fc.constantFrom<Permission>(
		'*:*',
		'*:read',
		'*:write',
		'todos:*',
		'todos:read',
		'todos:write',
		'projects:read',
		'projects:write',
		'notes:read',
		'org:billing',
	)

	propTest.prop([
		fc.array(permissionArb, { maxLength: 5 }),
		fc.array(permissionArb, { maxLength: 5 }),
	])(
		'grants follow the permissions exactly and never carry a pseudo-field',
		async (viewerPerms, memberPerms) => {
			for (const role of ['viewer', 'member'] as const) {
				const { orgId, rbac, resolver } = await orgWith(role, customRoles(viewerPerms, memberPerms))
				const perms = rbac.getRolePermissions(role)
				const covers = (action: 'read' | 'write', collection: string) =>
					perms.some((p) => {
						const [resource, act] = p.split(':')
						return (resource === '*' || resource === collection) && (act === '*' || act === action)
					})
				for (const grant of [
					await rbac.resolveScopes('user', orgId, [...COLLECTIONS]),
					await resolver.resolve('user', orgId, [...COLLECTIONS]),
				]) {
					if (grant === null) throw new Error('member must get a grant')
					for (const c of COLLECTIONS) {
						expect(c in grant.downlinkScopes).toBe(covers('read', c))
						expect(c in grant.uplinkScopes).toBe(covers('write', c))
						for (const scope of [grant.downlinkScopes[c], grant.uplinkScopes[c]]) {
							if (scope) expect(Object.keys(scope)).toEqual(['orgId'])
						}
					}
				}
			}
		},
	)
})
