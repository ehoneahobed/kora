import { beforeEach, describe, expect, test } from 'vitest'
import { OrgRoutes } from './org-routes'
import { InMemoryOrgStore } from './org-store'

describe('OrgRoutes', () => {
	let store: InMemoryOrgStore
	let routes: OrgRoutes

	beforeEach(() => {
		store = new InMemoryOrgStore()
		routes = new OrgRoutes({ orgStore: store })
	})

	// =========================================================================
	// createOrg
	// =========================================================================

	describe('createOrg', () => {
		test('creates an org and returns 201', async () => {
			const result = await routes.createOrg('user-1', { name: 'Acme Inc', slug: 'acme' })
			expect(result.status).toBe(201)
			expect('data' in result.body && result.body.data.name).toBe('Acme Inc')
			expect('data' in result.body && result.body.data.slug).toBe('acme')
			expect('data' in result.body && result.body.data.ownerId).toBe('user-1')
		})

		test('auto-generates slug from name', async () => {
			const result = await routes.createOrg('user-1', { name: 'My Company' })
			expect(result.status).toBe(201)
			expect('data' in result.body && result.body.data.slug).toBe('my-company')
		})

		test('rejects missing name', async () => {
			const result = await routes.createOrg('user-1', {})
			expect(result.status).toBe(400)
			expect('error' in result.body && result.body.error).toContain('name is required')
		})

		test('rejects empty name', async () => {
			const result = await routes.createOrg('user-1', { name: '   ' })
			expect(result.status).toBe(400)
		})

		test('rejects name exceeding max length', async () => {
			const result = await routes.createOrg('user-1', { name: 'a'.repeat(201) })
			expect(result.status).toBe(400)
			expect('error' in result.body && result.body.error).toContain('200 characters')
		})

		test('rejects invalid slug format', async () => {
			const result = await routes.createOrg('user-1', { name: 'Acme', slug: '-bad-slug-' })
			expect(result.status).toBe(400)
			expect('error' in result.body && result.body.error).toContain('lowercase')
		})

		test('rejects slug shorter than 2 chars', async () => {
			const result = await routes.createOrg('user-1', { name: 'Acme', slug: 'a' })
			expect(result.status).toBe(400)
			expect('error' in result.body && result.body.error).toContain('at least 2')
		})

		test('rejects non-string slug', async () => {
			const result = await routes.createOrg('user-1', { name: 'Acme', slug: 123 })
			expect(result.status).toBe(400)
		})

		test('rejects invalid metadata (array)', async () => {
			const result = await routes.createOrg('user-1', { name: 'Acme', metadata: [1, 2] })
			expect(result.status).toBe(400)
			expect('error' in result.body && result.body.error).toContain('Metadata')
		})

		test('rejects invalid metadata (null)', async () => {
			const result = await routes.createOrg('user-1', { name: 'Acme', metadata: null })
			expect(result.status).toBe(400)
		})

		test('returns 409 for duplicate slug', async () => {
			await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const result = await routes.createOrg('user-2', { name: 'Acme 2', slug: 'acme' })
			expect(result.status).toBe(409)
		})

		test('sanitizes control characters from name', async () => {
			const result = await routes.createOrg('user-1', { name: 'Acme\x00Inc' })
			expect(result.status).toBe(201)
			expect('data' in result.body && result.body.data.name).toBe('AcmeInc')
		})
	})

	// =========================================================================
	// getOrg
	// =========================================================================

	describe('getOrg', () => {
		test('returns org for a member', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.getOrg('user-1', orgId)
			expect(result.status).toBe(200)
			expect('data' in result.body && result.body.data.name).toBe('Acme')
		})

		test('returns 404 for non-member', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.getOrg('user-999', orgId)
			expect(result.status).toBe(404)
		})

		test('returns 404 for non-existent org', async () => {
			const result = await routes.getOrg('user-1', 'bogus')
			expect(result.status).toBe(404)
		})
	})

	// =========================================================================
	// updateOrg
	// =========================================================================

	describe('updateOrg', () => {
		test('owner can update org name', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.updateOrg('user-1', orgId, { name: 'Acme Inc' })
			expect(result.status).toBe(200)
			expect('data' in result.body && result.body.data.name).toBe('Acme Inc')
		})

		test('admin can update org', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''
			await store.addMember(orgId, 'user-2', 'admin', 'user-1')

			const result = await routes.updateOrg('user-2', orgId, { name: 'New Name' })
			expect(result.status).toBe(200)
		})

		test('member cannot update org (403)', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''
			await store.addMember(orgId, 'user-2', 'member', 'user-1')

			const result = await routes.updateOrg('user-2', orgId, { name: 'Nope' })
			expect(result.status).toBe(403)
		})

		test('non-member gets 404', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.updateOrg('user-999', orgId, { name: 'X' })
			expect(result.status).toBe(404)
		})

		test('rejects empty name', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.updateOrg('user-1', orgId, { name: '' })
			expect(result.status).toBe(400)
		})

		test('rejects invalid slug on update', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.updateOrg('user-1', orgId, { slug: 'BAD SLUG!' })
			expect(result.status).toBe(400)
		})

		test('returns 409 for conflicting slug', async () => {
			await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const createResult = await routes.createOrg('user-1', { name: 'Beta', slug: 'beta' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.updateOrg('user-1', orgId, { slug: 'acme' })
			expect(result.status).toBe(409)
		})
	})

	// =========================================================================
	// deleteOrg
	// =========================================================================

	describe('deleteOrg', () => {
		test('owner can delete org', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.deleteOrg('user-1', orgId)
			expect(result.status).toBe(200)
			expect('data' in result.body && result.body.data).toEqual({ deleted: true })
		})

		test('admin cannot delete org (403)', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''
			await store.addMember(orgId, 'user-2', 'admin', 'user-1')

			const result = await routes.deleteOrg('user-2', orgId)
			expect(result.status).toBe(403)
		})

		test('non-member gets 404', async () => {
			const result = await routes.deleteOrg('user-999', 'bogus')
			expect(result.status).toBe(404)
		})
	})

	// =========================================================================
	// listUserOrgs
	// =========================================================================

	describe('listUserOrgs', () => {
		test('lists orgs for authenticated user', async () => {
			await routes.createOrg('user-1', { name: 'Org 1', slug: 'org-1' })
			await routes.createOrg('user-1', { name: 'Org 2', slug: 'org-2' })

			const result = await routes.listUserOrgs('user-1')
			expect(result.status).toBe(200)
			expect('data' in result.body && result.body.data).toHaveLength(2)
		})

		test('returns empty array for user with no orgs', async () => {
			const result = await routes.listUserOrgs('user-nobody')
			expect(result.status).toBe(200)
			expect('data' in result.body && result.body.data).toEqual([])
		})
	})

	// =========================================================================
	// addMember
	// =========================================================================

	describe('addMember', () => {
		test('owner can add a member', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.addMember('user-1', orgId, {
				targetUserId: 'user-2',
				role: 'member',
			})
			expect(result.status).toBe(201)
			expect('data' in result.body && result.body.data.role).toBe('member')
		})

		test('admin can add members but not admins', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''
			await store.addMember(orgId, 'user-2', 'admin', 'user-1')

			// Admin can add member
			const result1 = await routes.addMember('user-2', orgId, {
				targetUserId: 'user-3',
				role: 'member',
			})
			expect(result1.status).toBe(201)

			// Admin cannot add admin
			const result2 = await routes.addMember('user-2', orgId, {
				targetUserId: 'user-4',
				role: 'admin',
			})
			expect(result2.status).toBe(403)
		})

		test('owner can add admins', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.addMember('user-1', orgId, {
				targetUserId: 'user-2',
				role: 'admin',
			})
			expect(result.status).toBe(201)
		})

		test('cannot assign owner role via addMember', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.addMember('user-1', orgId, {
				targetUserId: 'user-2',
				role: 'owner',
			})
			expect(result.status).toBe(400)
			expect('error' in result.body && result.body.error).toContain('ownership transfer')
		})

		test('member cannot add members (403)', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''
			await store.addMember(orgId, 'user-2', 'member', 'user-1')

			const result = await routes.addMember('user-2', orgId, {
				targetUserId: 'user-3',
				role: 'member',
			})
			expect(result.status).toBe(403)
		})

		test('rejects missing targetUserId', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.addMember('user-1', orgId, { role: 'member' })
			expect(result.status).toBe(400)
		})

		test('rejects invalid role', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.addMember('user-1', orgId, {
				targetUserId: 'user-2',
				role: 'superadmin',
			})
			expect(result.status).toBe(400)
		})

		test('returns 409 for duplicate member', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''
			await store.addMember(orgId, 'user-2', 'member', 'user-1')

			const result = await routes.addMember('user-1', orgId, {
				targetUserId: 'user-2',
				role: 'member',
			})
			expect(result.status).toBe(409)
		})
	})

	// =========================================================================
	// removeMember
	// =========================================================================

	describe('removeMember', () => {
		test('admin can remove a member', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''
			await store.addMember(orgId, 'user-2', 'admin', 'user-1')
			await store.addMember(orgId, 'user-3', 'member', 'user-1')

			const result = await routes.removeMember('user-2', orgId, 'user-3')
			expect(result.status).toBe(200)
		})

		test('member can remove themselves (leave)', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''
			await store.addMember(orgId, 'user-2', 'member', 'user-1')

			const result = await routes.removeMember('user-2', orgId, 'user-2')
			expect(result.status).toBe(200)
		})

		test('cannot remove the owner', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.removeMember('user-1', orgId, 'user-1')
			expect(result.status).toBe(400)
			expect('error' in result.body && result.body.error).toContain('owner')
		})

		test('regular member cannot remove others (403)', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''
			await store.addMember(orgId, 'user-2', 'member', 'user-1')
			await store.addMember(orgId, 'user-3', 'member', 'user-1')

			const result = await routes.removeMember('user-2', orgId, 'user-3')
			expect(result.status).toBe(403)
		})

		test('returns 404 for non-existent member', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.removeMember('user-1', orgId, 'user-999')
			expect(result.status).toBe(404)
		})
	})

	// =========================================================================
	// updateMemberRole
	// =========================================================================

	describe('updateMemberRole', () => {
		test('owner can change a member role', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''
			await store.addMember(orgId, 'user-2', 'member', 'user-1')

			const result = await routes.updateMemberRole('user-1', orgId, {
				targetUserId: 'user-2',
				role: 'admin',
			})
			expect(result.status).toBe(200)
			expect('data' in result.body && result.body.data.role).toBe('admin')
		})

		test('admin cannot promote to admin', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''
			await store.addMember(orgId, 'user-2', 'admin', 'user-1')
			await store.addMember(orgId, 'user-3', 'member', 'user-1')

			const result = await routes.updateMemberRole('user-2', orgId, {
				targetUserId: 'user-3',
				role: 'admin',
			})
			expect(result.status).toBe(403)
		})

		test('cannot assign owner via role update', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''
			await store.addMember(orgId, 'user-2', 'admin', 'user-1')

			const result = await routes.updateMemberRole('user-1', orgId, {
				targetUserId: 'user-2',
				role: 'owner',
			})
			expect(result.status).toBe(400)
		})

		test('rejects invalid role', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.updateMemberRole('user-1', orgId, {
				targetUserId: 'user-1',
				role: 'ceo',
			})
			expect(result.status).toBe(400)
		})
	})

	// =========================================================================
	// listMembers
	// =========================================================================

	describe('listMembers', () => {
		test('member can list members', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''
			await store.addMember(orgId, 'user-2', 'member', 'user-1')

			const result = await routes.listMembers('user-2', orgId)
			expect(result.status).toBe(200)
			expect('data' in result.body && result.body.data).toHaveLength(2)
		})

		test('non-member gets 404', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.listMembers('user-999', orgId)
			expect(result.status).toBe(404)
		})
	})

	// =========================================================================
	// transferOwnership
	// =========================================================================

	describe('transferOwnership', () => {
		test('owner can transfer ownership', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''
			await store.addMember(orgId, 'user-2', 'admin', 'user-1')

			const result = await routes.transferOwnership('user-1', orgId, { newOwnerId: 'user-2' })
			expect(result.status).toBe(200)

			// Verify new owner
			const org = await store.getOrg(orgId)
			expect(org?.ownerId).toBe('user-2')
		})

		test('admin cannot transfer ownership (403)', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''
			await store.addMember(orgId, 'user-2', 'admin', 'user-1')

			const result = await routes.transferOwnership('user-2', orgId, { newOwnerId: 'user-2' })
			expect(result.status).toBe(403)
		})

		test('rejects transfer to self', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.transferOwnership('user-1', orgId, { newOwnerId: 'user-1' })
			expect(result.status).toBe(400)
			expect('error' in result.body && result.body.error).toContain('already the owner')
		})

		test('rejects transfer to non-member', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.transferOwnership('user-1', orgId, { newOwnerId: 'user-999' })
			expect(result.status).toBe(404)
			expect('error' in result.body && result.body.error).toContain('not a member')
		})

		test('rejects missing newOwnerId', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.transferOwnership('user-1', orgId, {})
			expect(result.status).toBe(400)
		})
	})

	// =========================================================================
	// createInvitation
	// =========================================================================

	describe('createInvitation', () => {
		test('admin can create an invitation', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.createInvitation('user-1', orgId, {
				email: 'bob@example.com',
				role: 'member',
			})
			expect(result.status).toBe(201)
			expect('data' in result.body && result.body.data.email).toBe('bob@example.com')
			expect('data' in result.body && result.body.data.role).toBe('member')
			expect('data' in result.body && result.body.data.token.length).toBeGreaterThan(20)
		})

		test('rejects invalid email', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.createInvitation('user-1', orgId, {
				email: 'not-an-email',
				role: 'member',
			})
			expect(result.status).toBe(400)
		})

		test('cannot invite as owner', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.createInvitation('user-1', orgId, {
				email: 'bob@example.com',
				role: 'owner',
			})
			expect(result.status).toBe(400)
		})

		test('admin cannot invite as admin', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''
			await store.addMember(orgId, 'user-2', 'admin', 'user-1')

			const result = await routes.createInvitation('user-2', orgId, {
				email: 'bob@example.com',
				role: 'admin',
			})
			expect(result.status).toBe(403)
		})

		test('owner can invite as admin', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.createInvitation('user-1', orgId, {
				email: 'bob@example.com',
				role: 'admin',
			})
			expect(result.status).toBe(201)
		})

		test('member cannot create invitation (403)', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''
			await store.addMember(orgId, 'user-2', 'member', 'user-1')

			const result = await routes.createInvitation('user-2', orgId, {
				email: 'bob@example.com',
				role: 'member',
			})
			expect(result.status).toBe(403)
		})
	})

	// =========================================================================
	// acceptInvitation
	// =========================================================================

	describe('acceptInvitation', () => {
		test('user can accept a valid invitation', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const invResult = await routes.createInvitation('user-1', orgId, {
				email: 'bob@example.com',
				role: 'member',
			})
			const token = 'data' in invResult.body ? invResult.body.data.token : ''

			const result = await routes.acceptInvitation('user-2', { token })
			expect(result.status).toBe(200)
			expect('data' in result.body && result.body.data.role).toBe('member')
			expect('data' in result.body && result.body.data.userId).toBe('user-2')
		})

		test('rejects already consumed token', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const invResult = await routes.createInvitation('user-1', orgId, {
				email: 'bob@example.com',
				role: 'member',
			})
			const token = 'data' in invResult.body ? invResult.body.data.token : ''

			await routes.acceptInvitation('user-2', { token })
			const result = await routes.acceptInvitation('user-3', { token })
			expect(result.status).toBe(404)
		})

		test('rejects expired invitation', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const invResult = await routes.createInvitation('user-1', orgId, {
				email: 'bob@example.com',
				role: 'member',
			})
			const invId = 'data' in invResult.body ? invResult.body.data.id : ''
			const token = 'data' in invResult.body ? invResult.body.data.token : ''

			// Expire the invitation
			const invitations = (
				store as unknown as { invitations: Map<string, Record<string, unknown>> }
			).invitations
			const stored = invitations.get(invId)
			if (stored) invitations.set(invId, { ...stored, expiresAt: Date.now() - 1000 })

			const result = await routes.acceptInvitation('user-2', { token })
			expect(result.status).toBe(410)
		})

		test('returns 409 if user is already a member', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''
			await store.addMember(orgId, 'user-2', 'member', 'user-1')

			const invResult = await routes.createInvitation('user-1', orgId, {
				email: 'bob@example.com',
				role: 'admin',
			})
			const token = 'data' in invResult.body ? invResult.body.data.token : ''

			const result = await routes.acceptInvitation('user-2', { token })
			expect(result.status).toBe(409)
		})

		test('rejects missing token', async () => {
			const result = await routes.acceptInvitation('user-2', {})
			expect(result.status).toBe(400)
		})
	})

	// =========================================================================
	// revokeInvitation
	// =========================================================================

	describe('revokeInvitation', () => {
		test('admin can revoke a pending invitation', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const invResult = await routes.createInvitation('user-1', orgId, {
				email: 'bob@example.com',
				role: 'member',
			})
			const invId = 'data' in invResult.body ? invResult.body.data.id : ''

			const result = await routes.revokeInvitation('user-1', orgId, invId)
			expect(result.status).toBe(200)
		})

		test('member cannot revoke (403)', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''
			await store.addMember(orgId, 'user-2', 'member', 'user-1')

			const invResult = await routes.createInvitation('user-1', orgId, {
				email: 'bob@example.com',
				role: 'member',
			})
			const invId = 'data' in invResult.body ? invResult.body.data.id : ''

			const result = await routes.revokeInvitation('user-2', orgId, invId)
			expect(result.status).toBe(403)
		})

		test('returns 404 for non-existent invitation', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			const result = await routes.revokeInvitation('user-1', orgId, 'bogus')
			expect(result.status).toBe(404)
		})
	})

	// =========================================================================
	// listPendingInvitations
	// =========================================================================

	describe('listPendingInvitations', () => {
		test('admin can list pending invitations', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			await routes.createInvitation('user-1', orgId, { email: 'a@b.com', role: 'member' })
			await routes.createInvitation('user-1', orgId, { email: 'c@d.com', role: 'member' })

			const result = await routes.listPendingInvitations('user-1', orgId)
			expect(result.status).toBe(200)
			expect('data' in result.body && result.body.data).toHaveLength(2)
		})

		test('member cannot list invitations (403)', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''
			await store.addMember(orgId, 'user-2', 'member', 'user-1')

			const result = await routes.listPendingInvitations('user-2', orgId)
			expect(result.status).toBe(403)
		})
	})

	// =========================================================================
	// listMyInvitations
	// =========================================================================

	describe('listMyInvitations', () => {
		test('returns pending invitations for email', async () => {
			const createResult = await routes.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const orgId = 'data' in createResult.body ? createResult.body.data.id : ''

			await routes.createInvitation('user-1', orgId, { email: 'bob@example.com', role: 'member' })

			const result = await routes.listMyInvitations('bob@example.com')
			expect(result.status).toBe(200)
			expect('data' in result.body && result.body.data).toHaveLength(1)
		})

		test('rejects invalid email', async () => {
			const result = await routes.listMyInvitations('not-valid')
			expect(result.status).toBe(400)
		})

		test('returns empty for unknown email', async () => {
			const result = await routes.listMyInvitations('nobody@example.com')
			expect(result.status).toBe(200)
			expect('data' in result.body && result.body.data).toEqual([])
		})
	})
})
