import { beforeEach, describe, expect, test } from 'vitest'
import { InMemoryOrgStore } from './org-store'
import {
	CannotRemoveOwnerError,
	InvitationExpiredError,
	InvitationNotFoundError,
	MemberAlreadyExistsError,
	MembershipNotFoundError,
	OrgNotFoundError,
	OrgSlugTakenError,
	ROLE_HIERARCHY,
	hasRoleLevel,
} from './org-types'

describe('InMemoryOrgStore', () => {
	let store: InMemoryOrgStore

	beforeEach(() => {
		store = new InMemoryOrgStore()
	})

	// =========================================================================
	// Organizations
	// =========================================================================

	describe('createOrg', () => {
		test('creates an organization with all fields populated', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme Inc', slug: 'acme' })

			expect(org.id).toBeTruthy()
			expect(org.name).toBe('Acme Inc')
			expect(org.slug).toBe('acme')
			expect(org.ownerId).toBe('user-1')
			expect(org.createdAt).toBeGreaterThan(0)
			expect(org.updatedAt).toBe(org.createdAt)
			expect(org.metadata).toEqual({})
		})

		test('auto-generates slug from name when not provided', async () => {
			const org = await store.createOrg('user-1', { name: 'My Cool Company!' })
			expect(org.slug).toBe('my-cool-company')
		})

		test('stores optional metadata', async () => {
			const org = await store.createOrg('user-1', {
				name: 'Acme',
				metadata: { plan: 'pro', seats: 10 },
			})
			expect(org.metadata).toEqual({ plan: 'pro', seats: 10 })
		})

		test('adds creator as owner member automatically', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const membership = await store.getMembership(org.id, 'user-1')

			expect(membership).not.toBeNull()
			expect(membership?.role).toBe('owner')
			expect(membership?.invitedBy).toBeNull()
		})

		test('rejects duplicate slug', async () => {
			await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await expect(store.createOrg('user-2', { name: 'Acme 2', slug: 'acme' })).rejects.toThrow(
				OrgSlugTakenError,
			)
		})

		test('allows different slugs', async () => {
			await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const org2 = await store.createOrg('user-2', { name: 'Acme 2', slug: 'acme-2' })
			expect(org2.slug).toBe('acme-2')
		})
	})

	describe('getOrg', () => {
		test('returns org by ID', async () => {
			const created = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const fetched = await store.getOrg(created.id)
			expect(fetched).toEqual(created)
		})

		test('returns null for non-existent org', async () => {
			expect(await store.getOrg('non-existent')).toBeNull()
		})
	})

	describe('getOrgBySlug', () => {
		test('returns org by slug', async () => {
			const created = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const fetched = await store.getOrgBySlug('acme')
			expect(fetched).toEqual(created)
		})

		test('returns null for non-existent slug', async () => {
			expect(await store.getOrgBySlug('nope')).toBeNull()
		})
	})

	describe('updateOrg', () => {
		test('updates name', async () => {
			const org = await store.createOrg('user-1', { name: 'Old Name', slug: 'old' })
			const updated = await store.updateOrg(org.id, { name: 'New Name' })

			expect(updated.name).toBe('New Name')
			expect(updated.slug).toBe('old')
			expect(updated.updatedAt).toBeGreaterThanOrEqual(org.updatedAt)
		})

		test('updates slug with uniqueness check', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const updated = await store.updateOrg(org.id, { slug: 'acme-inc' })
			expect(updated.slug).toBe('acme-inc')
		})

		test('rejects slug that conflicts with another org', async () => {
			await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const org2 = await store.createOrg('user-2', { name: 'Beta', slug: 'beta' })

			await expect(store.updateOrg(org2.id, { slug: 'acme' })).rejects.toThrow(OrgSlugTakenError)
		})

		test('allows updating slug to same value', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const updated = await store.updateOrg(org.id, { slug: 'acme' })
			expect(updated.slug).toBe('acme')
		})

		test('merges metadata shallowly', async () => {
			const org = await store.createOrg('user-1', {
				name: 'Acme',
				metadata: { plan: 'free', region: 'us' },
			})
			const updated = await store.updateOrg(org.id, { metadata: { plan: 'pro' } })
			expect(updated.metadata).toEqual({ plan: 'pro', region: 'us' })
		})

		test('throws for non-existent org', async () => {
			await expect(store.updateOrg('nope', { name: 'X' })).rejects.toThrow(OrgNotFoundError)
		})
	})

	describe('deleteOrg', () => {
		test('removes org and all memberships and invitations', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'member', 'user-1')
			await store.createInvitation(org.id, 'user-1', { email: 'a@b.com', role: 'member' })

			await store.deleteOrg(org.id)

			expect(await store.getOrg(org.id)).toBeNull()
			expect(await store.listMembers(org.id).catch(() => [])).toEqual([])
		})

		test('throws for non-existent org', async () => {
			await expect(store.deleteOrg('nope')).rejects.toThrow(OrgNotFoundError)
		})
	})

	describe('listUserOrgs', () => {
		test('returns all orgs a user belongs to', async () => {
			const org1 = await store.createOrg('user-1', { name: 'Org 1', slug: 'org-1' })
			const org2 = await store.createOrg('user-1', { name: 'Org 2', slug: 'org-2' })
			await store.createOrg('user-2', { name: 'Org 3', slug: 'org-3' })

			const orgs = await store.listUserOrgs('user-1')
			expect(orgs).toHaveLength(2)
			expect(orgs.map((o) => o.id).sort()).toEqual([org1.id, org2.id].sort())
		})

		test('returns empty array for user with no orgs', async () => {
			expect(await store.listUserOrgs('nobody')).toEqual([])
		})

		test('includes orgs where user is a member but not owner', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'member', 'user-1')

			const orgs = await store.listUserOrgs('user-2')
			expect(orgs).toHaveLength(1)
			expect(orgs[0].id).toBe(org.id)
		})
	})

	// =========================================================================
	// Memberships
	// =========================================================================

	describe('addMember', () => {
		test('adds a member with the specified role', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const membership = await store.addMember(org.id, 'user-2', 'admin', 'user-1')

			expect(membership.orgId).toBe(org.id)
			expect(membership.userId).toBe('user-2')
			expect(membership.role).toBe('admin')
			expect(membership.invitedBy).toBe('user-1')
			expect(membership.joinedAt).toBeGreaterThan(0)
		})

		test('throws if org does not exist', async () => {
			await expect(store.addMember('nope', 'user-2', 'member', null)).rejects.toThrow(
				OrgNotFoundError,
			)
		})

		test('throws if user is already a member', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await expect(store.addMember(org.id, 'user-1', 'admin', null)).rejects.toThrow(
				MemberAlreadyExistsError,
			)
		})
	})

	describe('removeMember', () => {
		test('removes a member', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'member', 'user-1')

			await store.removeMember(org.id, 'user-2')
			expect(await store.getMembership(org.id, 'user-2')).toBeNull()
		})

		test('cannot remove the owner', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await expect(store.removeMember(org.id, 'user-1')).rejects.toThrow(CannotRemoveOwnerError)
		})

		test('throws if member not found', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await expect(store.removeMember(org.id, 'user-999')).rejects.toThrow(MembershipNotFoundError)
		})

		test('throws if org not found', async () => {
			await expect(store.removeMember('nope', 'user-1')).rejects.toThrow(OrgNotFoundError)
		})
	})

	describe('updateMemberRole', () => {
		test('updates a member role', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'member', 'user-1')

			const updated = await store.updateMemberRole(org.id, 'user-2', 'admin')
			expect(updated.role).toBe('admin')
		})

		test('promoting to owner demotes previous owner to admin', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'admin', 'user-1')

			await store.updateMemberRole(org.id, 'user-2', 'owner')

			const oldOwner = await store.getMembership(org.id, 'user-1')
			expect(oldOwner?.role).toBe('admin')

			const newOwner = await store.getMembership(org.id, 'user-2')
			expect(newOwner?.role).toBe('owner')

			const updatedOrg = await store.getOrg(org.id)
			expect(updatedOrg?.ownerId).toBe('user-2')
		})

		test('throws if member not found', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await expect(store.updateMemberRole(org.id, 'user-999', 'admin')).rejects.toThrow(
				MembershipNotFoundError,
			)
		})
	})

	describe('listMembers', () => {
		test('lists all members of an org', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'admin', 'user-1')
			await store.addMember(org.id, 'user-3', 'member', 'user-1')

			const members = await store.listMembers(org.id)
			expect(members).toHaveLength(3) // owner + 2 added
		})

		test('throws if org not found', async () => {
			await expect(store.listMembers('nope')).rejects.toThrow(OrgNotFoundError)
		})
	})

	describe('getMembership', () => {
		test('returns membership for a valid member', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const membership = await store.getMembership(org.id, 'user-1')
			expect(membership).not.toBeNull()
			expect(membership?.role).toBe('owner')
		})

		test('returns null for non-member', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			expect(await store.getMembership(org.id, 'user-999')).toBeNull()
		})
	})

	describe('transferOwnership', () => {
		test('transfers ownership from current owner to another member', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.addMember(org.id, 'user-2', 'admin', 'user-1')

			await store.transferOwnership(org.id, 'user-2')

			const updatedOrg = await store.getOrg(org.id)
			expect(updatedOrg?.ownerId).toBe('user-2')

			const oldOwner = await store.getMembership(org.id, 'user-1')
			expect(oldOwner?.role).toBe('admin')

			const newOwner = await store.getMembership(org.id, 'user-2')
			expect(newOwner?.role).toBe('owner')
		})

		test('throws if org not found', async () => {
			await expect(store.transferOwnership('nope', 'user-2')).rejects.toThrow(OrgNotFoundError)
		})

		test('throws if new owner is not a member', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await expect(store.transferOwnership(org.id, 'user-999')).rejects.toThrow(
				MembershipNotFoundError,
			)
		})
	})

	// =========================================================================
	// Invitations
	// =========================================================================

	describe('createInvitation', () => {
		test('creates a pending invitation with token and expiry', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const inv = await store.createInvitation(org.id, 'user-1', {
				email: 'bob@example.com',
				role: 'member',
			})

			expect(inv.id).toBeTruthy()
			expect(inv.orgId).toBe(org.id)
			expect(inv.email).toBe('bob@example.com')
			expect(inv.role).toBe('member')
			expect(inv.invitedBy).toBe('user-1')
			expect(inv.token).toBeTruthy()
			expect(inv.token.length).toBeGreaterThan(20)
			expect(inv.status).toBe('pending')
			expect(inv.expiresAt).toBeGreaterThan(inv.createdAt)
		})

		test('normalizes email to lowercase and trims', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const inv = await store.createInvitation(org.id, 'user-1', {
				email: '  Bob@Example.COM  ',
				role: 'member',
			})
			expect(inv.email).toBe('bob@example.com')
		})

		test('throws if org not found', async () => {
			await expect(
				store.createInvitation('nope', 'user-1', { email: 'a@b.com', role: 'member' }),
			).rejects.toThrow(OrgNotFoundError)
		})
	})

	describe('getInvitationByToken', () => {
		test('returns pending invitation by token', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const inv = await store.createInvitation(org.id, 'user-1', {
				email: 'bob@example.com',
				role: 'member',
			})

			const fetched = await store.getInvitationByToken(inv.token)
			expect(fetched).not.toBeNull()
			expect(fetched?.id).toBe(inv.id)
		})

		test('returns null for non-existent token', async () => {
			expect(await store.getInvitationByToken('bogus')).toBeNull()
		})

		test('returns null for consumed invitation', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const inv = await store.createInvitation(org.id, 'user-1', {
				email: 'bob@example.com',
				role: 'member',
			})

			await store.consumeInvitation(inv.token)
			expect(await store.getInvitationByToken(inv.token)).toBeNull()
		})
	})

	describe('consumeInvitation', () => {
		test('marks invitation as accepted', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const inv = await store.createInvitation(org.id, 'user-1', {
				email: 'bob@example.com',
				role: 'member',
			})

			const consumed = await store.consumeInvitation(inv.token)
			expect(consumed.status).toBe('accepted')
			expect(consumed.id).toBe(inv.id)
		})

		test('throws for already consumed invitation', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const inv = await store.createInvitation(org.id, 'user-1', {
				email: 'bob@example.com',
				role: 'member',
			})

			await store.consumeInvitation(inv.token)
			await expect(store.consumeInvitation(inv.token)).rejects.toThrow(InvitationNotFoundError)
		})

		test('throws for non-existent token', async () => {
			await expect(store.consumeInvitation('bogus')).rejects.toThrow(InvitationNotFoundError)
		})

		test('throws and marks as expired if past expiry', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const inv = await store.createInvitation(org.id, 'user-1', {
				email: 'bob@example.com',
				role: 'member',
			})

			// Manually expire the invitation by patching the store internals
			// We access the private map through any cast for testing only
			const invitations = (
				store as unknown as { invitations: Map<string, Record<string, unknown>> }
			).invitations
			const stored = invitations.get(inv.id)
			if (stored) invitations.set(inv.id, { ...stored, expiresAt: Date.now() - 1000 })

			await expect(store.consumeInvitation(inv.token)).rejects.toThrow(InvitationExpiredError)
		})
	})

	describe('revokeInvitation', () => {
		test('revokes a pending invitation', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const inv = await store.createInvitation(org.id, 'user-1', {
				email: 'bob@example.com',
				role: 'member',
			})

			await store.revokeInvitation(inv.id)
			expect(await store.getInvitationByToken(inv.token)).toBeNull()
		})

		test('throws for non-existent invitation', async () => {
			await expect(store.revokeInvitation('bogus')).rejects.toThrow(InvitationNotFoundError)
		})

		test('throws for already accepted invitation', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const inv = await store.createInvitation(org.id, 'user-1', {
				email: 'bob@example.com',
				role: 'member',
			})

			await store.consumeInvitation(inv.token)
			await expect(store.revokeInvitation(inv.id)).rejects.toThrow(InvitationNotFoundError)
		})
	})

	describe('listPendingInvitations', () => {
		test('lists only pending non-expired invitations for an org', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.createInvitation(org.id, 'user-1', { email: 'a@b.com', role: 'member' })
			await store.createInvitation(org.id, 'user-1', { email: 'c@d.com', role: 'admin' })

			const inv3 = await store.createInvitation(org.id, 'user-1', {
				email: 'e@f.com',
				role: 'member',
			})
			await store.consumeInvitation(inv3.token)

			const pending = await store.listPendingInvitations(org.id)
			expect(pending).toHaveLength(2)
		})

		test('excludes expired invitations', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const inv = await store.createInvitation(org.id, 'user-1', {
				email: 'a@b.com',
				role: 'member',
			})

			// Expire it
			const invitations = (
				store as unknown as { invitations: Map<string, Record<string, unknown>> }
			).invitations
			const stored = invitations.get(inv.id)
			if (stored) invitations.set(inv.id, { ...stored, expiresAt: Date.now() - 1000 })

			const pending = await store.listPendingInvitations(org.id)
			expect(pending).toHaveLength(0)
		})

		test('throws if org not found', async () => {
			await expect(store.listPendingInvitations('nope')).rejects.toThrow(OrgNotFoundError)
		})
	})

	describe('listInvitationsForEmail', () => {
		test('lists pending invitations for an email across orgs', async () => {
			const org1 = await store.createOrg('user-1', { name: 'Org 1', slug: 'org-1' })
			const org2 = await store.createOrg('user-2', { name: 'Org 2', slug: 'org-2' })

			await store.createInvitation(org1.id, 'user-1', { email: 'bob@example.com', role: 'member' })
			await store.createInvitation(org2.id, 'user-2', { email: 'bob@example.com', role: 'admin' })
			await store.createInvitation(org1.id, 'user-1', {
				email: 'alice@example.com',
				role: 'member',
			})

			const invitations = await store.listInvitationsForEmail('bob@example.com')
			expect(invitations).toHaveLength(2)
		})

		test('normalizes email for lookup', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			await store.createInvitation(org.id, 'user-1', { email: 'bob@example.com', role: 'member' })

			const invitations = await store.listInvitationsForEmail('  BOB@Example.COM  ')
			expect(invitations).toHaveLength(1)
		})

		test('excludes expired invitations', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const inv = await store.createInvitation(org.id, 'user-1', {
				email: 'bob@example.com',
				role: 'member',
			})

			const invitations = (
				store as unknown as { invitations: Map<string, Record<string, unknown>> }
			).invitations
			const stored = invitations.get(inv.id)
			if (stored) invitations.set(inv.id, { ...stored, expiresAt: Date.now() - 1000 })

			expect(await store.listInvitationsForEmail('bob@example.com')).toHaveLength(0)
		})
	})

	describe('cleanExpiredInvitations', () => {
		test('marks expired pending invitations as expired', async () => {
			const org = await store.createOrg('user-1', { name: 'Acme', slug: 'acme' })
			const inv1 = await store.createInvitation(org.id, 'user-1', {
				email: 'a@b.com',
				role: 'member',
			})
			await store.createInvitation(org.id, 'user-1', { email: 'c@d.com', role: 'member' })

			// Expire one
			const invitations = (
				store as unknown as { invitations: Map<string, Record<string, unknown>> }
			).invitations
			const stored = invitations.get(inv1.id)
			if (stored) invitations.set(inv1.id, { ...stored, expiresAt: Date.now() - 1000 })

			const count = await store.cleanExpiredInvitations()
			expect(count).toBe(1)

			// The non-expired one should still be pending
			const pending = await store.listPendingInvitations(org.id)
			expect(pending).toHaveLength(1)
		})

		test('returns 0 when nothing to clean', async () => {
			expect(await store.cleanExpiredInvitations()).toBe(0)
		})
	})
})

// =========================================================================
// Role Hierarchy Helpers
// =========================================================================

describe('hasRoleLevel', () => {
	test('owner has level of all roles', () => {
		expect(hasRoleLevel('owner', 'owner')).toBe(true)
		expect(hasRoleLevel('owner', 'admin')).toBe(true)
		expect(hasRoleLevel('owner', 'member')).toBe(true)
		expect(hasRoleLevel('owner', 'viewer')).toBe(true)
		expect(hasRoleLevel('owner', 'billing')).toBe(true)
	})

	test('viewer does not have admin level', () => {
		expect(hasRoleLevel('viewer', 'admin')).toBe(false)
		expect(hasRoleLevel('viewer', 'member')).toBe(false)
	})

	test('admin has member level but not owner level', () => {
		expect(hasRoleLevel('admin', 'member')).toBe(true)
		expect(hasRoleLevel('admin', 'owner')).toBe(false)
	})

	test('billing has billing level but not member level', () => {
		expect(hasRoleLevel('billing', 'billing')).toBe(true)
		expect(hasRoleLevel('billing', 'member')).toBe(false)
	})
})

describe('ROLE_HIERARCHY', () => {
	test('roles are ordered correctly', () => {
		expect(ROLE_HIERARCHY.owner).toBeGreaterThan(ROLE_HIERARCHY.admin)
		expect(ROLE_HIERARCHY.admin).toBeGreaterThan(ROLE_HIERARCHY.member)
		expect(ROLE_HIERARCHY.member).toBeGreaterThan(ROLE_HIERARCHY.billing)
		expect(ROLE_HIERARCHY.billing).toBeGreaterThan(ROLE_HIERARCHY.viewer)
	})
})
