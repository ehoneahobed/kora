/**
 * Integration tests for organizations, memberships, invitations, and RBAC.
 *
 * Tests the flow: create org → invite member → accept invitation → role checks →
 * scope resolution for sync filtering.
 */
import { describe, test, expect, beforeEach } from 'vitest'
import {
	BuiltInAuthRoutes,
	InMemoryUserStore,
	TokenManager,
	OrgRoutes,
	InMemoryOrgStore,
	RbacEngine,
	OrgScopeResolver,
	BUILT_IN_ROLES,
} from '../../src/server'
import type { OrgStore } from '../../src/server'
import type { Organization, OrgInvitation, Membership } from '../../src/server'

describe('Organization + RBAC integration', () => {
	let userStore: InstanceType<typeof InMemoryUserStore>
	let tokenManager: InstanceType<typeof TokenManager>
	let routes: InstanceType<typeof BuiltInAuthRoutes>
	let orgRoutes: InstanceType<typeof OrgRoutes>
	let orgStore: InstanceType<typeof InMemoryOrgStore>

	beforeEach(() => {
		userStore = new InMemoryUserStore()
		tokenManager = new TokenManager({
			secret: TokenManager.generateSecret(),
		})
		routes = new BuiltInAuthRoutes({ userStore, tokenManager })
		orgStore = new InMemoryOrgStore()
		orgRoutes = new OrgRoutes({ orgStore })
	})

	// ========================================================================
	// Create org → invite → accept flow
	// ========================================================================

	test('full org creation → invitation → acceptance flow', async () => {
		// Create two users
		const ownerSignUp = await routes.handleSignUp({
			email: 'owner@example.com',
			password: 'securePassword123',
		})
		const ownerId = (ownerSignUp.body as { data: { user: { id: string } } }).data.user.id

		const memberSignUp = await routes.handleSignUp({
			email: 'member@example.com',
			password: 'securePassword123',
		})
		const memberId = (memberSignUp.body as { data: { user: { id: string } } }).data.user.id

		// Owner creates org
		const createOrg = await orgRoutes.createOrg(ownerId, {
			name: 'Acme Corp',
			slug: 'acme-corp',
		})
		expect(createOrg.status).toBe(201)
		const org = (createOrg.body as { data: Organization }).data
		expect(org.id).toBeTruthy()
		expect(org.name).toBe('Acme Corp')
		expect(org.ownerId).toBe(ownerId)

		// Owner invites member (requires admin role, owner has it)
		const invite = await orgRoutes.createInvitation(ownerId, org.id, {
			email: 'member@example.com',
			role: 'member',
		})
		expect(invite.status).toBe(201)
		const invitation = (invite.body as { data: OrgInvitation }).data
		expect(invitation.email).toBe('member@example.com')
		expect(invitation.role).toBe('member')

		// Member accepts invitation
		const accept = await orgRoutes.acceptInvitation(memberId, { token: invitation.token })
		expect(accept.status).toBe(200)
		const membership = (accept.body as { data: Membership }).data
		expect(membership.userId).toBe(memberId)
		expect(membership.role).toBe('member')

		// List org members
		const members = await orgRoutes.listMembers(ownerId, org.id)
		expect(members.status).toBe(200)
		const memberList = (members.body as { data: Membership[] }).data
		expect(memberList).toHaveLength(2) // owner + member
	})

	// ========================================================================
	// RBAC permission checks via RbacEngine
	// ========================================================================

	test('role hierarchy grants inherited permissions via RbacEngine', async () => {
		// Set up org with owner and member
		const ownerSignUp = await routes.handleSignUp({
			email: 'rbac-owner@example.com',
			password: 'securePassword123',
		})
		const ownerId = (ownerSignUp.body as { data: { user: { id: string } } }).data.user.id

		const memberSignUp = await routes.handleSignUp({
			email: 'rbac-member@example.com',
			password: 'securePassword123',
		})
		const memberId = (memberSignUp.body as { data: { user: { id: string } } }).data.user.id

		const createOrg = await orgRoutes.createOrg(ownerId, {
			name: 'RBAC Org',
			slug: 'rbac-org',
		})
		const org = (createOrg.body as { data: Organization }).data

		// Invite and add member
		const invite = await orgRoutes.createInvitation(ownerId, org.id, {
			email: 'rbac-member@example.com',
			role: 'member',
		})
		const token = (invite.body as { data: OrgInvitation }).data.token
		await orgRoutes.acceptInvitation(memberId, { token })

		// Create RbacEngine with the org store
		const rbac = new RbacEngine(orgStore as unknown as OrgStore)

		// Owner should have all permissions (inherits admin → member → viewer)
		expect(await rbac.hasPermission(ownerId, org.id, 'org:manage-members')).toBe(true)
		expect(await rbac.hasPermission(ownerId, org.id, 'data:write')).toBe(true)
		expect(await rbac.hasPermission(ownerId, org.id, 'data:read')).toBe(true)

		// Member should have data access but not admin permissions
		expect(await rbac.hasPermission(memberId, org.id, 'data:read')).toBe(true)
		expect(await rbac.hasPermission(memberId, org.id, 'data:write')).toBe(true)
		expect(await rbac.hasPermission(memberId, org.id, 'org:manage-members')).toBe(false)

		// Non-member should have no permissions
		expect(await rbac.hasPermission('nobody-id', org.id, 'data:read')).toBe(false)
	})

	// ========================================================================
	// Insufficient role enforcement
	// ========================================================================

	test('member cannot create invitations (requires admin)', async () => {
		const ownerSignUp = await routes.handleSignUp({
			email: 'orgowner@example.com',
			password: 'securePassword123',
		})
		const ownerId = (ownerSignUp.body as { data: { user: { id: string } } }).data.user.id

		const memberSignUp = await routes.handleSignUp({
			email: 'orgmember@example.com',
			password: 'securePassword123',
		})
		const memberId = (memberSignUp.body as { data: { user: { id: string } } }).data.user.id

		// Create org
		const createOrg = await orgRoutes.createOrg(ownerId, {
			name: 'Test Org',
			slug: 'test-org',
		})
		const org = (createOrg.body as { data: Organization }).data

		// Invite as member
		const invite = await orgRoutes.createInvitation(ownerId, org.id, {
			email: 'orgmember@example.com',
			role: 'member',
		})
		const token = (invite.body as { data: OrgInvitation }).data.token
		await orgRoutes.acceptInvitation(memberId, { token })

		// Member tries to invite — should fail (requires admin)
		const memberInvite = await orgRoutes.createInvitation(memberId, org.id, {
			email: 'another@example.com',
			role: 'viewer',
		})
		expect(memberInvite.status).toBe(403)
	})

	// ========================================================================
	// Invitation edge cases
	// ========================================================================

	test('invitation token is single-use', async () => {
		const ownerSignUp = await routes.handleSignUp({
			email: 'inv-owner@example.com',
			password: 'securePassword123',
		})
		const ownerId = (ownerSignUp.body as { data: { user: { id: string } } }).data.user.id

		const user1SignUp = await routes.handleSignUp({
			email: 'inv-user1@example.com',
			password: 'securePassword123',
		})
		const user1Id = (user1SignUp.body as { data: { user: { id: string } } }).data.user.id

		const user2SignUp = await routes.handleSignUp({
			email: 'inv-user2@example.com',
			password: 'securePassword123',
		})
		const user2Id = (user2SignUp.body as { data: { user: { id: string } } }).data.user.id

		const createOrg = await orgRoutes.createOrg(ownerId, {
			name: 'SingleUse Org',
			slug: 'singleuse-org',
		})
		const org = (createOrg.body as { data: Organization }).data

		const invite = await orgRoutes.createInvitation(ownerId, org.id, {
			email: 'inv-user1@example.com',
			role: 'member',
		})
		const token = (invite.body as { data: OrgInvitation }).data.token

		// First acceptance
		const first = await orgRoutes.acceptInvitation(user1Id, { token })
		expect(first.status).toBe(200)

		// Second user tries same token
		const second = await orgRoutes.acceptInvitation(user2Id, { token })
		expect(second.status).not.toBe(200)
	})

	test('duplicate slug is rejected', async () => {
		const ownerSignUp = await routes.handleSignUp({
			email: 'slug-owner@example.com',
			password: 'securePassword123',
		})
		const ownerId = (ownerSignUp.body as { data: { user: { id: string } } }).data.user.id

		await orgRoutes.createOrg(ownerId, { name: 'First', slug: 'my-org' })
		const dup = await orgRoutes.createOrg(ownerId, { name: 'Second', slug: 'my-org' })
		expect(dup.status).toBe(409)
	})

	// ========================================================================
	// Scope resolver
	// ========================================================================

	test('OrgScopeResolver generates correct sync filters', async () => {
		const ownerSignUp = await routes.handleSignUp({
			email: 'scope-owner@example.com',
			password: 'securePassword123',
		})
		const ownerId = (ownerSignUp.body as { data: { user: { id: string } } }).data.user.id

		const createOrg = await orgRoutes.createOrg(ownerId, {
			name: 'Scope Org',
			slug: 'scope-org',
		})
		const org = (createOrg.body as { data: Organization }).data

		const rbac = new RbacEngine(orgStore as unknown as OrgStore)
		const resolver = new OrgScopeResolver(orgStore as unknown as OrgStore, rbac)

		const scopes = await resolver.resolve(ownerId, org.id, ['todos', 'projects'])

		// Owner should have scopes
		expect(scopes).not.toBeNull()
		// Scopes include orgId-based filtering
		expect(scopes!['todos']).toBeDefined()
		expect(scopes!['projects']).toBeDefined()
	})

	test('OrgScopeResolver returns null for non-member', async () => {
		const ownerSignUp = await routes.handleSignUp({
			email: 'scope-owner2@example.com',
			password: 'securePassword123',
		})
		const ownerId = (ownerSignUp.body as { data: { user: { id: string } } }).data.user.id

		const createOrg = await orgRoutes.createOrg(ownerId, {
			name: 'NoAccess Org',
			slug: 'noaccess-org',
		})
		const org = (createOrg.body as { data: Organization }).data

		const rbac = new RbacEngine(orgStore as unknown as OrgStore)
		const resolver = new OrgScopeResolver(orgStore as unknown as OrgStore, rbac)

		const scopes = await resolver.resolve('non-member-id', org.id, ['todos'])
		expect(scopes).toBeNull()
	})

	// ========================================================================
	// Remove member
	// ========================================================================

	test('admin can remove a member but not the owner', async () => {
		const ownerSignUp = await routes.handleSignUp({
			email: 'rm-owner@example.com',
			password: 'securePassword123',
		})
		const ownerId = (ownerSignUp.body as { data: { user: { id: string } } }).data.user.id

		const adminSignUp = await routes.handleSignUp({
			email: 'rm-admin@example.com',
			password: 'securePassword123',
		})
		const adminId = (adminSignUp.body as { data: { user: { id: string } } }).data.user.id

		const memberSignUp = await routes.handleSignUp({
			email: 'rm-member@example.com',
			password: 'securePassword123',
		})
		const memberId = (memberSignUp.body as { data: { user: { id: string } } }).data.user.id

		// Create org
		const createOrg = await orgRoutes.createOrg(ownerId, {
			name: 'Remove Test Org',
			slug: 'remove-test',
		})
		const org = (createOrg.body as { data: Organization }).data

		// Add admin (owner invites admin)
		const adminInvite = await orgRoutes.createInvitation(ownerId, org.id, {
			email: 'rm-admin@example.com',
			role: 'admin',
		})
		await orgRoutes.acceptInvitation(adminId, {
			token: (adminInvite.body as { data: OrgInvitation }).data.token,
		})

		// Add member
		const memberInvite = await orgRoutes.createInvitation(ownerId, org.id, {
			email: 'rm-member@example.com',
			role: 'member',
		})
		await orgRoutes.acceptInvitation(memberId, {
			token: (memberInvite.body as { data: OrgInvitation }).data.token,
		})

		// Admin removes member — should succeed
		const removeMember = await orgRoutes.removeMember(adminId, org.id, memberId)
		expect(removeMember.status).toBe(200)

		// Admin tries to remove owner — should fail (CannotRemoveOwnerError → 400)
		const removeOwner = await orgRoutes.removeMember(adminId, org.id, ownerId)
		expect(removeOwner.status).toBe(400)
	})
})
