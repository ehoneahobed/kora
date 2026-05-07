import type {
	Organization,
	CreateOrgParams,
	UpdateOrgParams,
	Membership,
	OrgRole,
	OrgInvitation,
	CreateInvitationParams,
	InvitationStatus,
} from './org-types'
import {
	OrgNotFoundError,
	OrgSlugTakenError,
	MembershipNotFoundError,
	MemberAlreadyExistsError,
	CannotRemoveOwnerError,
	InvitationNotFoundError,
	InvitationExpiredError,
} from './org-types'

// ============================================================================
// OrgStore interface
// ============================================================================

/**
 * Persistence interface for organizations, memberships, and invitations.
 *
 * Implement this interface to back organizations with any storage:
 * - `InMemoryOrgStore` for development and testing
 * - PostgreSQL/MySQL via Drizzle for production
 * - SQLite for self-hosted or embedded scenarios
 *
 * All methods are async to support any storage backend.
 */
export interface OrgStore {
	// --- Organizations ---

	/** Create a new organization. The caller becomes the owner. */
	createOrg(ownerId: string, params: CreateOrgParams): Promise<Organization>

	/** Get an organization by ID. Returns null if not found. */
	getOrg(orgId: string): Promise<Organization | null>

	/** Get an organization by slug. Returns null if not found. */
	getOrgBySlug(slug: string): Promise<Organization | null>

	/** Update an organization's mutable fields. */
	updateOrg(orgId: string, params: UpdateOrgParams): Promise<Organization>

	/** Delete an organization and all its memberships and invitations. */
	deleteOrg(orgId: string): Promise<void>

	/** List all organizations a user is a member of. */
	listUserOrgs(userId: string): Promise<Organization[]>

	// --- Memberships ---

	/** Add a user as a member of an organization. */
	addMember(orgId: string, userId: string, role: OrgRole, invitedBy: string | null): Promise<Membership>

	/** Remove a user from an organization. Cannot remove the owner. */
	removeMember(orgId: string, userId: string): Promise<void>

	/** Update a member's role within an organization. */
	updateMemberRole(orgId: string, userId: string, role: OrgRole): Promise<Membership>

	/** List all members of an organization. */
	listMembers(orgId: string): Promise<Membership[]>

	/** Get a specific user's membership in an organization. Returns null if not a member. */
	getMembership(orgId: string, userId: string): Promise<Membership | null>

	/** Transfer ownership of an organization to another member. */
	transferOwnership(orgId: string, newOwnerId: string): Promise<void>

	// --- Invitations ---

	/** Create an invitation to join an organization. */
	createInvitation(orgId: string, invitedBy: string, params: CreateInvitationParams): Promise<OrgInvitation>

	/** Look up an invitation by its single-use token. Returns null if not found or already consumed. */
	getInvitationByToken(token: string): Promise<OrgInvitation | null>

	/** Consume an invitation (mark as accepted). Returns the invitation details. */
	consumeInvitation(token: string): Promise<OrgInvitation>

	/** Revoke a pending invitation. */
	revokeInvitation(invitationId: string): Promise<void>

	/** List pending invitations for an organization. */
	listPendingInvitations(orgId: string): Promise<OrgInvitation[]>

	/** List pending invitations for a specific email address. */
	listInvitationsForEmail(email: string): Promise<OrgInvitation[]>

	/** Remove expired invitations. Returns count of removed invitations. */
	cleanExpiredInvitations(): Promise<number>
}

// ============================================================================
// InMemoryOrgStore
// ============================================================================

/**
 * In-memory implementation of OrgStore for development and testing.
 *
 * Data is lost when the process exits. For production, implement OrgStore
 * with a persistent backend (PostgreSQL, MySQL, SQLite via Drizzle).
 *
 * @example
 * ```typescript
 * const orgStore = new InMemoryOrgStore()
 * const org = await orgStore.createOrg('user-1', { name: 'Acme Inc', slug: 'acme' })
 * ```
 */
export class InMemoryOrgStore implements OrgStore {
	private orgs = new Map<string, Organization>()
	private memberships = new Map<string, Membership>()
	private invitations = new Map<string, OrgInvitation>()

	// --- Organizations ---

	async createOrg(ownerId: string, params: CreateOrgParams): Promise<Organization> {
		const slug = params.slug ?? slugify(params.name)

		// Check slug uniqueness
		for (const org of this.orgs.values()) {
			if (org.slug === slug) {
				throw new OrgSlugTakenError()
			}
		}

		const now = Date.now()
		const org: Organization = {
			id: generateId(),
			name: params.name,
			slug,
			ownerId,
			createdAt: now,
			updatedAt: now,
			metadata: params.metadata ?? {},
		}

		this.orgs.set(org.id, org)

		// Add the creator as owner
		await this.addMember(org.id, ownerId, 'owner', null)

		return org
	}

	async getOrg(orgId: string): Promise<Organization | null> {
		return this.orgs.get(orgId) ?? null
	}

	async getOrgBySlug(slug: string): Promise<Organization | null> {
		for (const org of this.orgs.values()) {
			if (org.slug === slug) return org
		}
		return null
	}

	async updateOrg(orgId: string, params: UpdateOrgParams): Promise<Organization> {
		const org = this.orgs.get(orgId)
		if (!org) throw new OrgNotFoundError()

		if (params.slug !== undefined && params.slug !== org.slug) {
			// Check slug uniqueness
			for (const existing of this.orgs.values()) {
				if (existing.slug === params.slug && existing.id !== orgId) {
					throw new OrgSlugTakenError()
				}
			}
		}

		const updated: Organization = {
			...org,
			name: params.name ?? org.name,
			slug: params.slug ?? org.slug,
			updatedAt: Date.now(),
			metadata: params.metadata
				? { ...org.metadata, ...params.metadata }
				: org.metadata,
		}

		this.orgs.set(orgId, updated)
		return updated
	}

	async deleteOrg(orgId: string): Promise<void> {
		if (!this.orgs.has(orgId)) throw new OrgNotFoundError()

		// Remove all memberships
		for (const [id, membership] of this.memberships) {
			if (membership.orgId === orgId) {
				this.memberships.delete(id)
			}
		}

		// Remove all invitations
		for (const [id, invitation] of this.invitations) {
			if (invitation.orgId === orgId) {
				this.invitations.delete(id)
			}
		}

		this.orgs.delete(orgId)
	}

	async listUserOrgs(userId: string): Promise<Organization[]> {
		const orgIds = new Set<string>()
		for (const membership of this.memberships.values()) {
			if (membership.userId === userId) {
				orgIds.add(membership.orgId)
			}
		}

		const result: Organization[] = []
		for (const orgId of orgIds) {
			const org = this.orgs.get(orgId)
			if (org) result.push(org)
		}
		return result
	}

	// --- Memberships ---

	async addMember(
		orgId: string,
		userId: string,
		role: OrgRole,
		invitedBy: string | null,
	): Promise<Membership> {
		if (!this.orgs.has(orgId)) throw new OrgNotFoundError()

		// Check if already a member
		for (const membership of this.memberships.values()) {
			if (membership.orgId === orgId && membership.userId === userId) {
				throw new MemberAlreadyExistsError()
			}
		}

		const membership: Membership = {
			id: generateId(),
			orgId,
			userId,
			role,
			invitedBy,
			joinedAt: Date.now(),
			metadata: {},
		}

		this.memberships.set(membership.id, membership)
		return membership
	}

	async removeMember(orgId: string, userId: string): Promise<void> {
		const org = this.orgs.get(orgId)
		if (!org) throw new OrgNotFoundError()

		if (org.ownerId === userId) {
			throw new CannotRemoveOwnerError()
		}

		let found = false
		for (const [id, membership] of this.memberships) {
			if (membership.orgId === orgId && membership.userId === userId) {
				this.memberships.delete(id)
				found = true
				break
			}
		}

		if (!found) throw new MembershipNotFoundError()
	}

	async updateMemberRole(orgId: string, userId: string, role: OrgRole): Promise<Membership> {
		for (const [id, membership] of this.memberships) {
			if (membership.orgId === orgId && membership.userId === userId) {
				const updated = { ...membership, role }
				this.memberships.set(id, updated)

				// If promoting to owner, update the org's ownerId and demote previous owner
				if (role === 'owner') {
					const org = this.orgs.get(orgId)
					if (org) {
						// Demote previous owner to admin
						for (const [mId, m] of this.memberships) {
							if (m.orgId === orgId && m.userId === org.ownerId && m.userId !== userId) {
								this.memberships.set(mId, { ...m, role: 'admin' })
							}
						}
						this.orgs.set(orgId, { ...org, ownerId: userId, updatedAt: Date.now() })
					}
				}

				return updated
			}
		}

		throw new MembershipNotFoundError()
	}

	async listMembers(orgId: string): Promise<Membership[]> {
		if (!this.orgs.has(orgId)) throw new OrgNotFoundError()

		const result: Membership[] = []
		for (const membership of this.memberships.values()) {
			if (membership.orgId === orgId) {
				result.push(membership)
			}
		}
		return result
	}

	async getMembership(orgId: string, userId: string): Promise<Membership | null> {
		for (const membership of this.memberships.values()) {
			if (membership.orgId === orgId && membership.userId === userId) {
				return membership
			}
		}
		return null
	}

	async transferOwnership(orgId: string, newOwnerId: string): Promise<void> {
		const org = this.orgs.get(orgId)
		if (!org) throw new OrgNotFoundError()

		// Verify new owner is a member
		const membership = await this.getMembership(orgId, newOwnerId)
		if (!membership) throw new MembershipNotFoundError()

		// Demote current owner to admin
		await this.updateMemberRole(orgId, org.ownerId, 'admin')

		// Promote new owner
		await this.updateMemberRole(orgId, newOwnerId, 'owner')
	}

	// --- Invitations ---

	async createInvitation(
		orgId: string,
		invitedBy: string,
		params: CreateInvitationParams,
	): Promise<OrgInvitation> {
		if (!this.orgs.has(orgId)) throw new OrgNotFoundError()

		const now = Date.now()
		const invitation: OrgInvitation = {
			id: generateId(),
			orgId,
			email: params.email.toLowerCase().trim(),
			role: params.role,
			invitedBy,
			token: generateToken(),
			createdAt: now,
			expiresAt: now + 7 * 24 * 60 * 60 * 1000, // 7 days
			status: 'pending',
		}

		this.invitations.set(invitation.id, invitation)
		return invitation
	}

	async getInvitationByToken(token: string): Promise<OrgInvitation | null> {
		for (const invitation of this.invitations.values()) {
			if (invitation.token === token && invitation.status === 'pending') {
				return invitation
			}
		}
		return null
	}

	async consumeInvitation(token: string): Promise<OrgInvitation> {
		for (const [id, invitation] of this.invitations) {
			if (invitation.token === token) {
				if (invitation.status !== 'pending') {
					throw new InvitationNotFoundError()
				}
				if (Date.now() > invitation.expiresAt) {
					this.invitations.set(id, { ...invitation, status: 'expired' })
					throw new InvitationExpiredError()
				}

				const consumed = { ...invitation, status: 'accepted' as InvitationStatus }
				this.invitations.set(id, consumed)
				return consumed
			}
		}

		throw new InvitationNotFoundError()
	}

	async revokeInvitation(invitationId: string): Promise<void> {
		const invitation = this.invitations.get(invitationId)
		if (!invitation || invitation.status !== 'pending') {
			throw new InvitationNotFoundError()
		}
		this.invitations.set(invitationId, { ...invitation, status: 'revoked' })
	}

	async listPendingInvitations(orgId: string): Promise<OrgInvitation[]> {
		if (!this.orgs.has(orgId)) throw new OrgNotFoundError()

		const result: OrgInvitation[] = []
		const now = Date.now()
		for (const invitation of this.invitations.values()) {
			if (invitation.orgId === orgId && invitation.status === 'pending') {
				if (now > invitation.expiresAt) {
					// Auto-expire
					continue
				}
				result.push(invitation)
			}
		}
		return result
	}

	async listInvitationsForEmail(email: string): Promise<OrgInvitation[]> {
		const normalizedEmail = email.toLowerCase().trim()
		const result: OrgInvitation[] = []
		const now = Date.now()
		for (const invitation of this.invitations.values()) {
			if (
				invitation.email === normalizedEmail &&
				invitation.status === 'pending' &&
				now <= invitation.expiresAt
			) {
				result.push(invitation)
			}
		}
		return result
	}

	async cleanExpiredInvitations(): Promise<number> {
		let count = 0
		const now = Date.now()
		for (const [id, invitation] of this.invitations) {
			if (invitation.status === 'pending' && now > invitation.expiresAt) {
				this.invitations.set(id, { ...invitation, status: 'expired' })
				count++
			}
		}
		return count
	}
}

// ============================================================================
// Internal helpers
// ============================================================================

function generateId(): string {
	return globalThis.crypto.randomUUID()
}

function generateToken(): string {
	const bytes = new Uint8Array(32)
	globalThis.crypto.getRandomValues(bytes)
	let binary = ''
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i] as number)
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Convert a name to a URL-friendly slug.
 * Lowercase, replace spaces/special chars with hyphens, collapse multiple hyphens.
 */
function slugify(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\s-]/g, '')
		.replace(/[\s]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
}
