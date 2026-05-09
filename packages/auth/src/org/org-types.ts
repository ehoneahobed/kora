import { KoraError } from '@korajs/core'

// ============================================================================
// Organization
// ============================================================================

/**
 * An organization (workspace/team) that groups users together.
 *
 * Organizations are the fundamental unit of multi-tenancy in Kora.
 * Data is scoped to organizations, and users access data through
 * their organization memberships and roles.
 */
export interface Organization {
	/** Unique identifier (UUID v7) */
	id: string
	/** Display name of the organization */
	name: string
	/** URL-friendly identifier (unique, lowercase, alphanumeric + hyphens) */
	slug: string
	/** User ID of the organization owner */
	ownerId: string
	/** When the organization was created (ms since epoch) */
	createdAt: number
	/** When the organization was last updated (ms since epoch) */
	updatedAt: number
	/** Arbitrary metadata (plan, billing info, settings, etc.) */
	metadata: Record<string, unknown>
}

/**
 * Parameters for creating a new organization.
 */
export interface CreateOrgParams {
	/** Display name */
	name: string
	/** URL-friendly slug (auto-generated from name if omitted) */
	slug?: string
	/** Optional metadata to attach */
	metadata?: Record<string, unknown>
}

/**
 * Parameters for updating an existing organization.
 */
export interface UpdateOrgParams {
	/** New display name */
	name?: string
	/** New slug */
	slug?: string
	/** Metadata to merge (shallow merge) */
	metadata?: Record<string, unknown>
}

// ============================================================================
// Roles
// ============================================================================

/**
 * Built-in organization roles, ordered by decreasing privilege.
 *
 * - **owner**: Full control, can delete org, transfer ownership, manage billing
 * - **admin**: Manage members and settings, full data access
 * - **member**: Read + write own data, read shared data
 * - **viewer**: Read-only access to shared data
 * - **billing**: Billing management only, no data access
 */
export const ORG_ROLES = ['owner', 'admin', 'member', 'viewer', 'billing'] as const
export type OrgRole = (typeof ORG_ROLES)[number]

/**
 * Role hierarchy for permission inheritance.
 * Higher number = more privilege.
 */
export const ROLE_HIERARCHY: Record<OrgRole, number> = {
	viewer: 10,
	billing: 15,
	member: 20,
	admin: 30,
	owner: 40,
} as const

/**
 * Check if one role has at least the privilege level of another.
 *
 * @param userRole - The user's current role
 * @param requiredRole - The minimum role required
 * @returns true if userRole >= requiredRole in the hierarchy
 */
export function hasRoleLevel(userRole: OrgRole, requiredRole: OrgRole): boolean {
	return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole]
}

// ============================================================================
// Membership
// ============================================================================

/**
 * A user's membership in an organization.
 */
export interface Membership {
	/** Unique identifier for this membership record */
	id: string
	/** Organization this membership belongs to */
	orgId: string
	/** User who is a member */
	userId: string
	/** Role within the organization */
	role: OrgRole
	/** User who invited this member (null if founder) */
	invitedBy: string | null
	/** When the user joined the organization (ms since epoch) */
	joinedAt: number
	/** Arbitrary metadata (department, title, etc.) */
	metadata: Record<string, unknown>
}

// ============================================================================
// Invitations
// ============================================================================

/**
 * Invitation status lifecycle.
 */
export const INVITATION_STATUSES = ['pending', 'accepted', 'revoked', 'expired'] as const
export type InvitationStatus = (typeof INVITATION_STATUSES)[number]

/**
 * An invitation to join an organization.
 *
 * Invitations are sent by email and include a single-use token.
 * They expire after a configurable duration (default: 7 days).
 */
export interface OrgInvitation {
	/** Unique identifier */
	id: string
	/** Organization the invitation is for */
	orgId: string
	/** Email address of the invitee */
	email: string
	/** Role the invitee will receive upon accepting */
	role: OrgRole
	/** User who created the invitation */
	invitedBy: string
	/** Cryptographically random single-use token */
	token: string
	/** When the invitation was created (ms since epoch) */
	createdAt: number
	/** When the invitation expires (ms since epoch) */
	expiresAt: number
	/** Current status */
	status: InvitationStatus
}

/**
 * Parameters for creating an invitation.
 */
export interface CreateInvitationParams {
	/** Email address to invite */
	email: string
	/** Role to assign when the invitation is accepted */
	role: OrgRole
}

// ============================================================================
// Errors
// ============================================================================

/**
 * Base error for organization-related operations.
 */
export class OrgError extends KoraError {
	constructor(message: string, code: string, context?: Record<string, unknown>) {
		super(message, code, context)
		this.name = 'OrgError'
	}
}

export class OrgNotFoundError extends OrgError {
	constructor() {
		super('Organization not found.', 'ORG_NOT_FOUND')
	}
}

export class OrgSlugTakenError extends OrgError {
	constructor() {
		super('An organization with this slug already exists.', 'ORG_SLUG_TAKEN')
	}
}

export class MembershipNotFoundError extends OrgError {
	constructor() {
		super('User is not a member of this organization.', 'MEMBERSHIP_NOT_FOUND')
	}
}

export class MemberAlreadyExistsError extends OrgError {
	constructor() {
		super('User is already a member of this organization.', 'MEMBER_ALREADY_EXISTS')
	}
}

export class InsufficientRoleError extends OrgError {
	constructor(required: OrgRole) {
		super(`This action requires at least the "${required}" role.`, 'INSUFFICIENT_ROLE', {
			requiredRole: required,
		})
	}
}

export class CannotRemoveOwnerError extends OrgError {
	constructor() {
		super(
			'The organization owner cannot be removed. Transfer ownership first.',
			'CANNOT_REMOVE_OWNER',
		)
	}
}

export class InvitationNotFoundError extends OrgError {
	constructor() {
		super('Invitation not found or has already been used.', 'INVITATION_NOT_FOUND')
	}
}

export class InvitationExpiredError extends OrgError {
	constructor() {
		super('This invitation has expired.', 'INVITATION_EXPIRED')
	}
}
