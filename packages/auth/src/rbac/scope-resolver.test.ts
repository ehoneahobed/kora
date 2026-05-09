import { beforeEach, describe, expect, test } from 'vitest'
import { InMemoryOrgStore } from '../org/org-store'
import { RbacEngine } from './rbac-engine'
import type { Permission } from './rbac-types'
import { OrgScopeResolver } from './scope-resolver'

describe('OrgScopeResolver', () => {
	let store: InMemoryOrgStore
	let rbac: RbacEngine
	let resolver: OrgScopeResolver

	beforeEach(() => {
		store = new InMemoryOrgStore()
		rbac = new RbacEngine(store)
		resolver = new OrgScopeResolver(store, rbac)
	})

	describe('resolve', () => {
		test('returns org-scoped data for owner', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })

			const scopes = await resolver.resolve('user-1', org.id, ['todos', 'projects'])
			expect(scopes).not.toBeNull()
			expect(scopes?.todos).toEqual({ orgId: org.id })
			expect(scopes?.projects).toEqual({ orgId: org.id })
		})

		test('returns read-only scopes for viewer', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'viewer', 'user-1')

			const scopes = await resolver.resolve('user-2', org.id, ['todos'])
			expect(scopes?.todos).toEqual({ orgId: org.id, __readonly: true })
		})

		test('returns writable scopes for member', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'member', 'user-1')

			const scopes = await resolver.resolve('user-2', org.id, ['todos'])
			expect(scopes?.todos).toEqual({ orgId: org.id })
			expect(scopes?.todos.__readonly).toBeUndefined()
		})

		test('returns null for non-member', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			expect(await resolver.resolve('user-999', org.id, ['todos'])).toBeNull()
		})

		test('billing role gets empty scopes', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'billing', 'user-1')

			const scopes = await resolver.resolve('user-2', org.id, ['todos'])
			expect(scopes).toEqual({})
		})
	})

	describe('custom collection scopes', () => {
		test('uses custom resolver for registered collection', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'member', 'user-1')

			resolver.registerCollectionScope('todos', (ctx) => ({
				orgId: ctx.orgId,
				assignee: ctx.userId,
			}))

			const scopes = await resolver.resolve('user-2', org.id, ['todos', 'projects'])
			expect(scopes?.todos).toEqual({ orgId: org.id, assignee: 'user-2' })
			expect(scopes?.projects).toEqual({ orgId: org.id }) // default
		})

		test('custom resolver can exclude collection by returning null', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'member', 'user-1')

			resolver.registerCollectionScope('audit-log', () => null)

			const scopes = await resolver.resolve('user-2', org.id, ['todos', 'audit-log'])
			expect(scopes?.todos).toBeDefined()
			expect(scopes?.['audit-log']).toBeUndefined()
		})

		test('custom resolver receives full context', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'admin', 'user-1')

			let capturedCtx: Record<string, unknown> | null = null
			resolver.registerCollectionScope('todos', (ctx) => {
				capturedCtx = ctx
				return { orgId: ctx.orgId }
			})

			await resolver.resolve('user-2', org.id, ['todos'])
			expect(capturedCtx).not.toBeNull()
			expect(capturedCtx.userId).toBe('user-2')
			expect(capturedCtx.orgId).toBe(org.id)
			expect(capturedCtx.role).toBe('admin')
			expect(capturedCtx.permissions.length).toBeGreaterThan(0)
		})

		test('role-dependent custom resolver', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'member', 'user-1')
			await store.addMember(org.id, 'user-3', 'admin', 'user-1')

			resolver.registerCollectionScope('todos', (ctx) => {
				if (ctx.role === 'member') {
					return { orgId: ctx.orgId, userId: ctx.userId }
				}
				return { orgId: ctx.orgId }
			})

			const memberScopes = await resolver.resolve('user-2', org.id, ['todos'])
			expect(memberScopes?.todos).toEqual({ orgId: org.id, userId: 'user-2' })

			const adminScopes = await resolver.resolve('user-3', org.id, ['todos'])
			expect(adminScopes?.todos).toEqual({ orgId: org.id })
		})
	})

	describe('canWrite', () => {
		test('member can write', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'member', 'user-1')

			expect(await resolver.canWrite('user-2', org.id, 'todos')).toBe(true)
		})

		test('viewer cannot write', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'viewer', 'user-1')

			expect(await resolver.canWrite('user-2', org.id, 'todos')).toBe(false)
		})

		test('non-member cannot write', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			expect(await resolver.canWrite('user-999', org.id, 'todos')).toBe(false)
		})
	})

	describe('canRead', () => {
		test('viewer can read', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'viewer', 'user-1')

			expect(await resolver.canRead('user-2', org.id, 'todos')).toBe(true)
		})

		test('billing cannot read data', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'billing', 'user-1')

			expect(await resolver.canRead('user-2', org.id, 'todos')).toBe(false)
		})

		test('non-member cannot read', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			expect(await resolver.canRead('user-999', org.id, 'todos')).toBe(false)
		})
	})
})
