import type { OrgStore } from './org-store'
import type {
	CreateOrgParams,
	Membership,
	OrgInvitation,
	OrgRole,
	Organization,
	UpdateOrgParams,
} from './org-types'
import {
	CannotRemoveOwnerError,
	InsufficientRoleError,
	InvitationExpiredError,
	InvitationNotFoundError,
	MemberAlreadyExistsError,
	MembershipNotFoundError,
	OrgNotFoundError,
	OrgSlugTakenError,
	hasRoleLevel,
} from './org-types'

// ============================================================================
// Types
// ============================================================================

/**
 * Response envelope returned by all org route handlers.
 * Mirrors AuthRouteResponse for consistency.
 */
export interface OrgRouteResponse<T> {
	/** HTTP status code */
	status: number
	/** Either the success payload or an error message */
	body: { data: T } | { error: string }
}

/**
 * Configuration for the org route handlers.
 */
export interface OrgRoutesConfig {
	/** The organization store backing all org operations */
	orgStore: OrgStore
}

/** Maximum length for org name */
const MAX_ORG_NAME_LENGTH = 200

/** Maximum length for org slug */
const MAX_SLUG_LENGTH = 100

/** Slug format: lowercase alphanumeric and hyphens, 2-100 chars */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$/

/**
 * Simple email format validation (same logic as auth-routes).
 */
function isValidEmail(email: string): boolean {
	// See the matching guard in auth-routes.ts: request bodies are untyped at
	// runtime, so a missing `email` field must not crash this check.
	if (typeof email !== 'string' || email.length === 0 || email.length > 254) return false
	const atIndex = email.indexOf('@')
	if (atIndex < 1) return false
	const domain = email.slice(atIndex + 1)
	if (domain.length === 0 || !domain.includes('.')) return false
	if (email.indexOf('@', atIndex + 1) !== -1) return false
	if (email.includes(' ')) return false
	return true
}

/**
 * Strip control characters from a string.
 */
function sanitize(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional sanitization
	return value.replace(/[\x00-\x1f\x7f]/g, '').trim()
}

// ============================================================================
// OrgRoutes
// ============================================================================

/**
 * Server-side route handlers for organization management.
 *
 * These handlers enforce authorization (role checks), input validation,
 * and produce transport-agnostic response objects. Wire them to your
 * HTTP framework (Express, Hono, Fastify, etc.):
 *
 * @example
 * ```typescript
 * const orgRoutes = new OrgRoutes({ orgStore: new InMemoryOrgStore() })
 *
 * app.post('/orgs', async (req, res) => {
 *   const result = await orgRoutes.createOrg(req.userId, req.body)
 *   res.status(result.status).json(result.body)
 * })
 * ```
 */
export class OrgRoutes {
	private readonly store: OrgStore

	constructor(config: OrgRoutesConfig) {
		this.store = config.orgStore
	}

	// --- Organizations ---

	/**
	 * Create a new organization. The authenticated user becomes the owner.
	 */
	async createOrg(
		userId: string,
		params: { name?: unknown; slug?: unknown; metadata?: unknown },
	): Promise<OrgRouteResponse<Organization>> {
		// Validate name
		if (typeof params.name !== 'string' || params.name.trim().length === 0) {
			return { status: 400, body: { error: 'Organization name is required.' } }
		}
		const name = sanitize(params.name)
		if (name.length > MAX_ORG_NAME_LENGTH) {
			return {
				status: 400,
				body: { error: `Organization name must be at most ${MAX_ORG_NAME_LENGTH} characters.` },
			}
		}

		// Validate slug (optional)
		let slug: string | undefined
		if (params.slug !== undefined) {
			if (typeof params.slug !== 'string') {
				return { status: 400, body: { error: 'Slug must be a string.' } }
			}
			slug = params.slug.toLowerCase().trim()
			if (slug.length < 2) {
				return { status: 400, body: { error: 'Slug must be at least 2 characters.' } }
			}
			if (slug.length > MAX_SLUG_LENGTH) {
				return {
					status: 400,
					body: { error: `Slug must be at most ${MAX_SLUG_LENGTH} characters.` },
				}
			}
			if (!SLUG_PATTERN.test(slug)) {
				return {
					status: 400,
					body: {
						error:
							'Slug must contain only lowercase letters, numbers, and hyphens, and cannot start or end with a hyphen.',
					},
				}
			}
		}

		// Validate metadata (optional)
		if (
			params.metadata !== undefined &&
			(typeof params.metadata !== 'object' ||
				params.metadata === null ||
				Array.isArray(params.metadata))
		) {
			return { status: 400, body: { error: 'Metadata must be a plain object.' } }
		}

		try {
			const createParams: CreateOrgParams = {
				name,
				slug,
				metadata: params.metadata as Record<string, unknown> | undefined,
			}
			const org = await this.store.createOrg(userId, createParams)
			return { status: 201, body: { data: org } }
		} catch (err) {
			if (err instanceof OrgSlugTakenError) {
				return { status: 409, body: { error: err.message } }
			}
			throw err
		}
	}

	/**
	 * Get an organization by ID. Requires membership.
	 */
	async getOrg(userId: string, orgId: string): Promise<OrgRouteResponse<Organization>> {
		const membership = await this.store.getMembership(orgId, userId)
		if (!membership) {
			return { status: 404, body: { error: 'Organization not found.' } }
		}

		const org = await this.store.getOrg(orgId)
		if (!org) {
			return { status: 404, body: { error: 'Organization not found.' } }
		}

		return { status: 200, body: { data: org } }
	}

	/**
	 * Update an organization. Requires admin or higher.
	 */
	async updateOrg(
		userId: string,
		orgId: string,
		params: { name?: unknown; slug?: unknown; metadata?: unknown },
	): Promise<OrgRouteResponse<Organization>> {
		const authResult = await this.requireRole(orgId, userId, 'admin')
		if (authResult) return authResult

		const updateParams: UpdateOrgParams = {}

		// Validate name
		if (params.name !== undefined) {
			if (typeof params.name !== 'string' || params.name.trim().length === 0) {
				return { status: 400, body: { error: 'Organization name must be a non-empty string.' } }
			}
			updateParams.name = sanitize(params.name as string)
			if (updateParams.name.length > MAX_ORG_NAME_LENGTH) {
				return {
					status: 400,
					body: { error: `Organization name must be at most ${MAX_ORG_NAME_LENGTH} characters.` },
				}
			}
		}

		// Validate slug
		if (params.slug !== undefined) {
			if (typeof params.slug !== 'string') {
				return { status: 400, body: { error: 'Slug must be a string.' } }
			}
			updateParams.slug = (params.slug as string).toLowerCase().trim()
			if (updateParams.slug.length < 2) {
				return { status: 400, body: { error: 'Slug must be at least 2 characters.' } }
			}
			if (updateParams.slug.length > MAX_SLUG_LENGTH) {
				return {
					status: 400,
					body: { error: `Slug must be at most ${MAX_SLUG_LENGTH} characters.` },
				}
			}
			if (!SLUG_PATTERN.test(updateParams.slug)) {
				return {
					status: 400,
					body: {
						error:
							'Slug must contain only lowercase letters, numbers, and hyphens, and cannot start or end with a hyphen.',
					},
				}
			}
		}

		// Validate metadata
		if (params.metadata !== undefined) {
			if (
				typeof params.metadata !== 'object' ||
				params.metadata === null ||
				Array.isArray(params.metadata)
			) {
				return { status: 400, body: { error: 'Metadata must be a plain object.' } }
			}
			updateParams.metadata = params.metadata as Record<string, unknown>
		}

		try {
			const org = await this.store.updateOrg(orgId, updateParams)
			return { status: 200, body: { data: org } }
		} catch (err) {
			if (err instanceof OrgNotFoundError) {
				return { status: 404, body: { error: err.message } }
			}
			if (err instanceof OrgSlugTakenError) {
				return { status: 409, body: { error: err.message } }
			}
			throw err
		}
	}

	/**
	 * Delete an organization. Requires owner.
	 */
	async deleteOrg(userId: string, orgId: string): Promise<OrgRouteResponse<{ deleted: true }>> {
		const authResult = await this.requireRole(orgId, userId, 'owner')
		if (authResult) return authResult

		try {
			await this.store.deleteOrg(orgId)
			return { status: 200, body: { data: { deleted: true } } }
		} catch (err) {
			if (err instanceof OrgNotFoundError) {
				return { status: 404, body: { error: err.message } }
			}
			throw err
		}
	}

	/**
	 * List all organizations the authenticated user belongs to.
	 */
	async listUserOrgs(userId: string): Promise<OrgRouteResponse<Organization[]>> {
		const orgs = await this.store.listUserOrgs(userId)
		return { status: 200, body: { data: orgs } }
	}

	// --- Members ---

	/**
	 * Add a member to an organization. Requires admin or higher.
	 */
	async addMember(
		userId: string,
		orgId: string,
		params: { targetUserId?: unknown; role?: unknown },
	): Promise<OrgRouteResponse<Membership>> {
		const authResult = await this.requireRole(orgId, userId, 'admin')
		if (authResult) return authResult

		if (typeof params.targetUserId !== 'string' || params.targetUserId.length === 0) {
			return { status: 400, body: { error: 'Target user ID is required.' } }
		}
		if (typeof params.role !== 'string' || !isValidRole(params.role)) {
			return {
				status: 400,
				body: { error: 'A valid role is required (admin, member, viewer, billing).' },
			}
		}

		// Cannot assign owner role via addMember — use transferOwnership
		if (params.role === 'owner') {
			return {
				status: 400,
				body: { error: 'Cannot assign owner role directly. Use ownership transfer.' },
			}
		}

		// Admins cannot add other admins (only owner can)
		const callerMembership = await this.store.getMembership(orgId, userId)
		if (callerMembership && callerMembership.role !== 'owner' && params.role === 'admin') {
			return { status: 403, body: { error: 'Only the owner can add admin members.' } }
		}

		try {
			const membership = await this.store.addMember(
				orgId,
				params.targetUserId,
				params.role as OrgRole,
				userId,
			)
			return { status: 201, body: { data: membership } }
		} catch (err) {
			if (err instanceof OrgNotFoundError) {
				return { status: 404, body: { error: err.message } }
			}
			if (err instanceof MemberAlreadyExistsError) {
				return { status: 409, body: { error: err.message } }
			}
			throw err
		}
	}

	/**
	 * Remove a member from an organization. Requires admin or higher.
	 * Members can also remove themselves (leave).
	 */
	async removeMember(
		userId: string,
		orgId: string,
		targetUserId: string,
	): Promise<OrgRouteResponse<{ removed: true }>> {
		// Allow self-removal (leaving) for any member
		const isSelfRemoval = userId === targetUserId

		if (!isSelfRemoval) {
			const authResult = await this.requireRole(orgId, userId, 'admin')
			if (authResult) return authResult
		} else {
			// Verify caller is a member
			const membership = await this.store.getMembership(orgId, userId)
			if (!membership) {
				return { status: 404, body: { error: 'Organization not found.' } }
			}
		}

		try {
			await this.store.removeMember(orgId, targetUserId)
			return { status: 200, body: { data: { removed: true } } }
		} catch (err) {
			if (err instanceof OrgNotFoundError) {
				return { status: 404, body: { error: err.message } }
			}
			if (err instanceof CannotRemoveOwnerError) {
				return { status: 400, body: { error: err.message } }
			}
			if (err instanceof MembershipNotFoundError) {
				return { status: 404, body: { error: err.message } }
			}
			throw err
		}
	}

	/**
	 * Update a member's role. Requires admin or higher.
	 */
	async updateMemberRole(
		userId: string,
		orgId: string,
		params: { targetUserId?: unknown; role?: unknown },
	): Promise<OrgRouteResponse<Membership>> {
		const authResult = await this.requireRole(orgId, userId, 'admin')
		if (authResult) return authResult

		if (typeof params.targetUserId !== 'string' || params.targetUserId.length === 0) {
			return { status: 400, body: { error: 'Target user ID is required.' } }
		}
		if (typeof params.role !== 'string' || !isValidRole(params.role)) {
			return {
				status: 400,
				body: { error: 'A valid role is required (admin, member, viewer, billing).' },
			}
		}
		if (params.role === 'owner') {
			return {
				status: 400,
				body: { error: 'Cannot assign owner role directly. Use ownership transfer.' },
			}
		}

		// The owner's role cannot be changed through this endpoint. Without this
		// guard an admin could demote the owner (e.g. to "viewer"), stripping the
		// owner of owner-gated powers while org.ownerId still points at them —
		// locking the account out of deleteOrg / transferOwnership. Ownership
		// changes must go through transferOwnership.
		const org = await this.store.getOrg(orgId)
		if (org && org.ownerId === params.targetUserId) {
			return {
				status: 403,
				body: { error: "The organization owner's role cannot be changed. Use ownership transfer." },
			}
		}

		// Admins cannot promote to admin (only owner can)
		const callerMembership = await this.store.getMembership(orgId, userId)
		if (callerMembership && callerMembership.role !== 'owner' && params.role === 'admin') {
			return { status: 403, body: { error: 'Only the owner can assign admin role.' } }
		}

		try {
			const membership = await this.store.updateMemberRole(
				orgId,
				params.targetUserId,
				params.role as OrgRole,
			)
			return { status: 200, body: { data: membership } }
		} catch (err) {
			if (err instanceof MembershipNotFoundError) {
				return { status: 404, body: { error: err.message } }
			}
			throw err
		}
	}

	/**
	 * List all members of an organization. Requires membership.
	 */
	async listMembers(userId: string, orgId: string): Promise<OrgRouteResponse<Membership[]>> {
		const membership = await this.store.getMembership(orgId, userId)
		if (!membership) {
			return { status: 404, body: { error: 'Organization not found.' } }
		}

		try {
			const members = await this.store.listMembers(orgId)
			return { status: 200, body: { data: members } }
		} catch (err) {
			if (err instanceof OrgNotFoundError) {
				return { status: 404, body: { error: err.message } }
			}
			throw err
		}
	}

	/**
	 * Transfer ownership to another member. Requires owner.
	 */
	async transferOwnership(
		userId: string,
		orgId: string,
		params: { newOwnerId?: unknown },
	): Promise<OrgRouteResponse<{ transferred: true }>> {
		const authResult = await this.requireRole(orgId, userId, 'owner')
		if (authResult) return authResult

		if (typeof params.newOwnerId !== 'string' || params.newOwnerId.length === 0) {
			return { status: 400, body: { error: 'New owner ID is required.' } }
		}

		if (params.newOwnerId === userId) {
			return { status: 400, body: { error: 'You are already the owner.' } }
		}

		try {
			await this.store.transferOwnership(orgId, params.newOwnerId)
			return { status: 200, body: { data: { transferred: true } } }
		} catch (err) {
			if (err instanceof OrgNotFoundError) {
				return { status: 404, body: { error: err.message } }
			}
			if (err instanceof MembershipNotFoundError) {
				return { status: 404, body: { error: 'Target user is not a member of this organization.' } }
			}
			throw err
		}
	}

	// --- Invitations ---

	/**
	 * Create an invitation to join the organization. Requires admin or higher.
	 */
	async createInvitation(
		userId: string,
		orgId: string,
		params: { email?: unknown; role?: unknown },
	): Promise<OrgRouteResponse<OrgInvitation>> {
		const authResult = await this.requireRole(orgId, userId, 'admin')
		if (authResult) return authResult

		if (typeof params.email !== 'string' || !isValidEmail(params.email.trim())) {
			return { status: 400, body: { error: 'A valid email address is required.' } }
		}
		if (typeof params.role !== 'string' || !isValidRole(params.role)) {
			return {
				status: 400,
				body: { error: 'A valid role is required (admin, member, viewer, billing).' },
			}
		}
		if (params.role === 'owner') {
			return {
				status: 400,
				body: { error: 'Cannot invite with owner role. Use ownership transfer.' },
			}
		}

		// Admins cannot invite admins
		const callerMembership = await this.store.getMembership(orgId, userId)
		if (callerMembership && callerMembership.role !== 'owner' && params.role === 'admin') {
			return { status: 403, body: { error: 'Only the owner can invite admin members.' } }
		}

		try {
			const invitation = await this.store.createInvitation(orgId, userId, {
				email: params.email.trim(),
				role: params.role as OrgRole,
			})
			return { status: 201, body: { data: invitation } }
		} catch (err) {
			if (err instanceof OrgNotFoundError) {
				return { status: 404, body: { error: err.message } }
			}
			throw err
		}
	}

	/**
	 * Accept an invitation by its token. The authenticated user joins the org.
	 */
	async acceptInvitation(
		userId: string,
		params: { token?: unknown },
	): Promise<OrgRouteResponse<Membership>> {
		if (typeof params.token !== 'string' || params.token.length === 0) {
			return { status: 400, body: { error: 'Invitation token is required.' } }
		}

		try {
			const invitation = await this.store.consumeInvitation(params.token)

			// Add the user as a member with the invited role
			const membership = await this.store.addMember(
				invitation.orgId,
				userId,
				invitation.role,
				invitation.invitedBy,
			)
			return { status: 200, body: { data: membership } }
		} catch (err) {
			if (err instanceof InvitationNotFoundError) {
				return { status: 404, body: { error: err.message } }
			}
			if (err instanceof InvitationExpiredError) {
				return { status: 410, body: { error: err.message } }
			}
			if (err instanceof MemberAlreadyExistsError) {
				return { status: 409, body: { error: 'You are already a member of this organization.' } }
			}
			throw err
		}
	}

	/**
	 * Revoke a pending invitation. Requires admin or higher.
	 */
	async revokeInvitation(
		userId: string,
		orgId: string,
		invitationId: string,
	): Promise<OrgRouteResponse<{ revoked: true }>> {
		const authResult = await this.requireRole(orgId, userId, 'admin')
		if (authResult) return authResult

		try {
			await this.store.revokeInvitation(invitationId)
			return { status: 200, body: { data: { revoked: true } } }
		} catch (err) {
			if (err instanceof InvitationNotFoundError) {
				return { status: 404, body: { error: err.message } }
			}
			throw err
		}
	}

	/**
	 * List pending invitations for an organization. Requires admin or higher.
	 */
	async listPendingInvitations(
		userId: string,
		orgId: string,
	): Promise<OrgRouteResponse<OrgInvitation[]>> {
		const authResult = await this.requireRole(orgId, userId, 'admin')
		if (authResult) return authResult

		try {
			const invitations = await this.store.listPendingInvitations(orgId)
			return { status: 200, body: { data: invitations } }
		} catch (err) {
			if (err instanceof OrgNotFoundError) {
				return { status: 404, body: { error: err.message } }
			}
			throw err
		}
	}

	/**
	 * List pending invitations for the authenticated user's email.
	 */
	async listMyInvitations(email: string): Promise<OrgRouteResponse<OrgInvitation[]>> {
		if (!isValidEmail(email)) {
			return { status: 400, body: { error: 'A valid email address is required.' } }
		}

		const invitations = await this.store.listInvitationsForEmail(email)
		return { status: 200, body: { data: invitations } }
	}

	// --- Private helpers ---

	/**
	 * Check if the caller has the required role in the org.
	 * Returns an error response if not authorized, or null if authorized.
	 */
	private async requireRole(
		orgId: string,
		userId: string,
		requiredRole: OrgRole,
	): Promise<OrgRouteResponse<never> | null> {
		const membership = await this.store.getMembership(orgId, userId)
		if (!membership) {
			return { status: 404, body: { error: 'Organization not found.' } }
		}
		if (!hasRoleLevel(membership.role, requiredRole)) {
			return {
				status: 403,
				body: { error: `This action requires at least the "${requiredRole}" role.` },
			}
		}
		return null
	}
}

// ============================================================================
// Helpers
// ============================================================================

const ASSIGNABLE_ROLES = new Set<string>(['admin', 'member', 'viewer', 'billing'])

function isValidRole(role: string): boolean {
	return ASSIGNABLE_ROLES.has(role) || role === 'owner'
}
