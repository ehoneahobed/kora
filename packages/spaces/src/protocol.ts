/**
 * The wire contract between `@korajs/spaces/server` and `@korajs/spaces/client`:
 * shared by both so a route and its client never disagree on a shape or a code.
 */

/** A shared space: a record of a group collection, as `[collection, id]`. */
export type SpaceRef = readonly [collection: string, id: string]

/** Every error code a spaces route answers with (`{ error: { code, message } }`). */
export const SPACES_ERROR_CODES = [
	'INVALID_REQUEST',
	'UNAUTHENTICATED',
	'FORBIDDEN',
	'RATE_LIMITED',
	'ROLE_NOT_ALLOWED',
	'ROLE_TOO_HIGH',
	'ROLE_CHANGED',
	'SPACE_NOT_FOUND',
	'SPACE_NOT_SYNCED',
	'NOT_A_MEMBER',
	'ALREADY_MEMBER',
	'ALREADY_OWNER',
	'CANNOT_CHANGE_OWNER',
	'OWNER_CANNOT_LEAVE',
	'TOO_MANY_PENDING',
	'INVITE_REFUSED',
	'INVITATION_NOT_FOUND',
	'INVITATION_EXPIRED',
	'INVITER_NO_LONGER_AUTHORIZED',
	'EMAIL_NOT_VERIFIED',
	'EMAIL_MISMATCH',
	'DELIVERY_FAILED',
	'WRITE_REFUSED',
	'CONFLICT',
	'INTERNAL',
] as const

/** A code from {@link SPACES_ERROR_CODES}. */
export type SpacesErrorCode = (typeof SPACES_ERROR_CODES)[number]

/** An invitation as the create route returns it. */
export interface InvitationSummary {
	id: string
	space: SpaceRef
	email: string
	role: string
	expiresAt: number
}

/** `invitations/create` response. */
export interface CreateInvitationResponse {
	invitation: InvitationSummary
	/** True when an earlier pending invitation to the same address was re-sent (its old link no longer works). */
	resent: boolean
	/**
	 * The accept link, returned only when the server has no `deliverInvitation` (so the app
	 * can show it to the inviter, for example in development).
	 */
	url?: string
}

/** `invitations/describe` response: what an invitee may learn before accepting. */
export interface InvitationDescription {
	role: string
	expiresAt: number
	expired: boolean
	/** The invited address, masked (`j***@example.com`). */
	emailHint: string
	/** `yes`: the signed-in user's verified email is the invited one; `unverified`: it matches but is not verified. */
	match: 'yes' | 'unverified' | 'no'
	/** The app's `describeInvitation` result (space title, inviter name), only when `match` is `yes`. */
	details?: Record<string, unknown>
}

/** `invitations/accept` response. */
export interface AcceptInvitationResponse {
	space: SpaceRef
	role: string
	/** The new member (the signed-in caller). */
	userId: string
}

/** `members/role`, `members/remove`, `leave` and `transfer` response. */
export interface MemberChangeResponse {
	space: SpaceRef
	/** Pending invitations sent by the affected member that were revoked with the change. */
	invitationsRevoked: number
	/** False when nothing needed to change (the member already held that role). */
	changed: boolean
}
