import { groupKey } from '@korajs/core/internal'
import type {
	AccessApi,
	ProductionHttpRouteContext,
	RouteMutation,
	RouteTransaction,
	RouteTransactionRejection,
} from '@korajs/server'
import type { SpaceRef, SpacesErrorCode } from '../protocol'
import {
	SPACE_INVITATIONS,
	SPACE_INVITATION_SECRETS,
	SPACE_MEMBERS,
	type Sharing,
} from '../schema/spaces-collections'
import { invitationIdOfToken, secretIdFor, tokenMatches } from './tokens'

type Record_ = { id: string; [key: string]: unknown }

/** A refusal from a decision: a code from the protocol and a message for the user. */
export interface DecisionRefusal {
	code: SpacesErrorCode
	message: string
}

/** What a decision returns: the writes to commit and what to report, or a refusal. */
export type Decided<T> =
	| { mutations: RouteMutation[]; outcome: T; refuseAfterCommit?: DecisionRefusal }
	| { refuse: DecisionRefusal }

/** The transaction reads plus the kit's configuration, handed to every decision. */
export interface DecisionContext {
	tx: RouteTransaction
	access: AccessApi
	sharing: Sharing
	now: number
}

/** The result of {@link runDecision}. */
export type DecisionResult<T> =
	| { ok: true; outcome: T; refuseAfterCommit?: DecisionRefusal }
	| { ok: false; code: SpacesErrorCode; message: string; retriable: boolean }

/** Server codes that mean "try again": the write lost a race it can win on retry. */
const RETRIABLE_SERVER_CODES = new Set(['TRANSACTION_CONFLICT'])

/**
 * Decide and commit as one `kora.transaction`. The decision may run more than once (a
 * store re-decides when another process committed meanwhile), so it keeps no state of
 * its own: the outcome of the attempt that committed is the one returned.
 */
export async function runDecision<T>(
	kora: ProductionHttpRouteContext,
	access: AccessApi,
	sharing: Sharing,
	now: number,
	decide: (context: DecisionContext) => Promise<Decided<T>>,
): Promise<DecisionResult<T>> {
	let committed: { outcome: T; refuseAfterCommit?: DecisionRefusal } | null = null
	let refused: DecisionRefusal | null = null
	const result = await kora.transaction(async (tx) => {
		committed = null
		refused = null
		const decided = await decide({ tx, access, sharing, now })
		if ('refuse' in decided) {
			refused = decided.refuse
			return tx.reject(decided.refuse.code, decided.refuse.message)
		}
		committed = {
			outcome: decided.outcome,
			...(decided.refuseAfterCommit ? { refuseAfterCommit: decided.refuseAfterCommit } : {}),
		}
		return decided.mutations
	})
	if (!result.ok) {
		const own = refused as DecisionRefusal | null
		if (own && own.code === result.code) {
			return { ok: false, code: own.code, message: own.message, retriable: false }
		}
		const retriable = result.retriable || RETRIABLE_SERVER_CODES.has(result.code)
		return {
			ok: false,
			code: retriable ? 'CONFLICT' : 'WRITE_REFUSED',
			message: result.message,
			retriable,
		}
	}
	const done = committed as { outcome: T; refuseAfterCommit?: DecisionRefusal } | null
	if (!done) {
		return { ok: false, code: 'INTERNAL', message: 'The decision did not run.', retriable: true }
	}
	return { ok: true, ...done }
}

function refuse(code: SpacesErrorCode, message: string): { refuse: DecisionRefusal } {
	return { refuse: { code, message } }
}

/** The access-rules key of a space (`forms:<id>`). */
export function spaceKeyOf(space: SpaceRef): string {
	return groupKey(space[0], space[1])
}

/** True for a record the store reports as soft-deleted. */
function isDeleted(record: Record_): boolean {
	return record._deleted === 1 || record._deleted === true
}

/**
 * The live group record of `space`, or a refusal: deleted (`SPACE_NOT_FOUND`) or never
 * seen by the server (`SPACE_NOT_SYNCED`: a space created offline that has not synced).
 */
async function liveSpace(
	tx: RouteTransaction,
	space: SpaceRef,
): Promise<{ record: Record_ } | { refuse: DecisionRefusal }> {
	const record = await tx.findById(space[0], space[1])
	if (record) return { record }
	const stored = await tx.query(space[0], {
		where: { id: space[1] },
		includeDeleted: true,
		limit: 1,
	})
	const row = stored[0]
	if (row && isDeleted(row)) {
		return refuse('SPACE_NOT_FOUND', 'This space was deleted.')
	}
	return refuse(
		'SPACE_NOT_SYNCED',
		'The server does not have this space yet. If it was created offline, try again once it has synced.',
	)
}

/**
 * The role a user holds now, with its proof (`stamp`): it changes whenever the role
 * changes, ends or is granted again. The owner role counts only through the owner
 * field: a membership row holding it (written outside the kit, for example by a
 * backfill) counts as the manager role, so it never makes a second owner and the owner
 * can still demote or remove it.
 */
async function authorityOf(
	tx: RouteTransaction,
	sharing: Sharing,
	userId: string,
	key: string,
): Promise<{
	role: string
	/** The role as stored (differs from `role` only for a membership row holding the owner role). */
	stored: string
	source: 'membership' | 'owner'
	stamp: string
} | null> {
	const held = await tx.roleOf(userId, key)
	if (!held) return null
	const role =
		held.source === 'membership' && held.role === sharing.ownerRole ? sharing.manageRole : held.role
	return { role, stored: held.role, source: held.source, stamp: `${held.source}:${held.since}` }
}

/**
 * The version of the space's ownership: changes on every transfer (by the kit, an
 * operator or `server.access.transfer`), including A to B and back to A.
 */
async function ownerVersionOf(
	tx: RouteTransaction,
	sharing: Sharing,
	space: SpaceRef,
	record: Record_,
): Promise<string> {
	const ownerField = sharing.groups[space[0]]?.owner ?? ''
	const ownerId = record[ownerField]
	if (typeof ownerId !== 'string' || ownerId.length === 0) return 'none'
	const held = await authorityOf(tx, sharing, ownerId, spaceKeyOf(space))
	return `${ownerId}:${held?.stamp ?? 'none'}`
}

/**
 * The sender may revoke (and re-send) their own invitation; anyone else needs at least
 * the manager role and a role strictly above the invited one.
 */
function mayRevoke(
	sharing: Sharing,
	actorId: string,
	actorRole: string,
	invitation: Record_,
): boolean {
	if (invitation.invitedBy === actorId) return true
	const rank = sharing.rank(actorRole)
	return rank >= sharing.rank(sharing.manageRole) && rank > sharing.rank(String(invitation.role))
}

/**
 * True while an invitation can still be accepted as far as its sender is concerned: the
 * sender's role is the very one they held when sending it (not changed, ended or granted
 * again since), still allows granting the invited role, and the space has the same owner.
 */
async function invitationStillValid(
	tx: RouteTransaction,
	sharing: Sharing,
	space: SpaceRef,
	record: Record_,
	invitation: Record_,
	knownSecret?: Record_,
): Promise<boolean> {
	const secret =
		knownSecret ?? (await tx.findById(SPACE_INVITATION_SECRETS, secretIdFor(invitation.id)))
	if (!secret) return false
	const role = String(invitation.role)
	if (role === sharing.ownerRole || sharing.rank(role) === -1) return false
	const inviter = await authorityOf(tx, sharing, String(secret.inviterId), spaceKeyOf(space))
	return (
		inviter !== null &&
		inviter.stamp === secret.authority &&
		sharing.rank(inviter.role) >= sharing.rank(sharing.manageRole) &&
		sharing.rank(inviter.role) > sharing.rank(role) &&
		(await ownerVersionOf(tx, sharing, space, record)) === secret.ownerVersion
	)
}

/** Deletes of `invitation` and its secret (the secret only if it exists). */
async function deleteInvitation(
	tx: RouteTransaction,
	invitationId: string,
): Promise<RouteMutation[]> {
	const out: RouteMutation[] = [
		{ collection: SPACE_INVITATIONS, type: 'delete', recordId: invitationId },
	]
	if (await tx.findById(SPACE_INVITATION_SECRETS, secretIdFor(invitationId))) {
		out.push({
			collection: SPACE_INVITATION_SECRETS,
			type: 'delete',
			recordId: secretIdFor(invitationId),
		})
	}
	return out
}

/** Deletes of every pending invitation of `key` (sent by `invitedBy`, when given). */
async function deleteInvitationsOf(
	tx: RouteTransaction,
	key: string,
	invitedBy?: string,
): Promise<{ mutations: RouteMutation[]; count: number }> {
	const pending = await tx.query(SPACE_INVITATIONS, {
		where: invitedBy === undefined ? { group: key } : { group: key, invitedBy },
	})
	const mutations: RouteMutation[] = []
	for (const invitation of pending) mutations.push(...(await deleteInvitation(tx, invitation.id)))
	return { mutations, count: pending.length }
}

// ─── Invitations ─────────────────────────────────────────────────────────────

/** Input of {@link decideCreateInvitation}. */
export interface CreateInvitationInput {
	actorId: string
	space: SpaceRef
	email: string
	role: string
	/** The invitee's user id, when the app can look addresses up (refuses members early). */
	inviteeId: string | null
	tokenHash: string
	expiresAt: number
	pendingLimit: number | null
}

/** Outcome of {@link decideCreateInvitation}. */
export interface CreatedInvitation {
	invitationId: string
	resent: boolean
}

/**
 * Create (or re-send) the pending invitation of `email` to `space`: the actor must hold
 * at least the manager role and a role strictly above the one granted. The secret row
 * records the actor's authority and the space's ownership as they are now; accepting
 * requires both unchanged.
 */
export async function decideCreateInvitation(
	{ tx, sharing, now }: DecisionContext,
	input: CreateInvitationInput & { invitationId: string },
): Promise<Decided<CreatedInvitation>> {
	const live = await liveSpace(tx, input.space)
	if ('refuse' in live) return live
	const key = spaceKeyOf(input.space)
	const actor = await authorityOf(tx, sharing, input.actorId, key)
	const actorRank = actor ? sharing.rank(actor.role) : -1
	if (!actor || actorRank < sharing.rank(sharing.manageRole)) {
		return refuse('FORBIDDEN', 'Only the space’s managers can invite people.')
	}
	if (sharing.rank(input.role) >= actorRank) {
		return refuse('ROLE_TOO_HIGH', 'You can only invite people to a role below your own.')
	}
	if (input.inviteeId !== null && (await tx.roleOf(input.inviteeId, key))) {
		return refuse(
			'ALREADY_MEMBER',
			'This person is already in the space. Change their role instead.',
		)
	}
	const existing = await tx.findById(SPACE_INVITATIONS, input.invitationId)
	// Re-sending replaces the pending invitation (and kills its link): only its sender, or
	// someone who could revoke it, may do that.
	if (existing && !mayRevoke(sharing, input.actorId, actor.role, existing)) {
		return refuse(
			'FORBIDDEN',
			'This address already has a pending invitation that you cannot change.',
		)
	}
	const swept: RouteMutation[] = []
	if (!existing && input.pendingLimit !== null) {
		const pending = await tx.query(SPACE_INVITATIONS, { where: { group: key } })
		let remaining = pending.length
		if (remaining >= input.pendingLimit) {
			// Expired invitations, and those whose sender lost the authority to send them
			// (outside the kit: server.access, an expiry, a raw transfer), can never be
			// accepted: clear them before refusing.
			for (const invitation of pending) {
				const expired = typeof invitation.expiresAt !== 'number' || invitation.expiresAt <= now
				if (
					expired ||
					!(await invitationStillValid(tx, sharing, input.space, live.record, invitation))
				) {
					swept.push(...(await deleteInvitation(tx, invitation.id)))
					remaining -= 1
				}
			}
		}
		if (remaining >= input.pendingLimit) {
			return refuse(
				'TOO_MANY_PENDING',
				`This space already has ${input.pendingLimit} pending invitations. Revoke some before inviting more.`,
			)
		}
	}
	const tokenVersion = (typeof existing?.tokenVersion === 'number' ? existing.tokenVersion : 0) + 1
	const invitation = {
		group: key,
		email: input.email,
		role: input.role,
		invitedBy: input.actorId,
		expiresAt: input.expiresAt,
		createdAt: now,
		tokenVersion,
	}
	const secretId = secretIdFor(input.invitationId)
	const secret = {
		invitationId: input.invitationId,
		group: key,
		tokenHash: input.tokenHash,
		tokenVersion,
		inviterId: input.actorId,
		authority: actor.stamp,
		ownerVersion: await ownerVersionOf(tx, sharing, input.space, live.record),
	}
	const hasSecret = (await tx.findById(SPACE_INVITATION_SECRETS, secretId)) !== null
	return {
		mutations: [
			...swept,
			existing
				? {
						collection: SPACE_INVITATIONS,
						type: 'update',
						recordId: input.invitationId,
						data: invitation,
					}
				: {
						collection: SPACE_INVITATIONS,
						type: 'insert',
						recordId: input.invitationId,
						data: invitation,
					},
			hasSecret
				? { collection: SPACE_INVITATION_SECRETS, type: 'update', recordId: secretId, data: secret }
				: {
						collection: SPACE_INVITATION_SECRETS,
						type: 'insert',
						recordId: secretId,
						data: secret,
					},
		],
		outcome: { invitationId: input.invitationId, resent: existing !== null },
	}
}

/** A pending invitation found by its token, with its secret. */
export interface ResolvedInvitation {
	invitation: Record_
	secret: Record_
	space: SpaceRef
}

/** Parse a stored group key back into a space of a configured group collection. */
export function spaceOfKey(sharing: Sharing, key: unknown): SpaceRef | null {
	if (typeof key !== 'string') return null
	const at = key.indexOf(':')
	if (at <= 0) return null
	const collection = key.slice(0, at)
	if (!Object.prototype.hasOwnProperty.call(sharing.groups, collection)) return null
	return [collection, key.slice(at + 1)]
}

/**
 * The pending invitation `token` opens, or null: unknown, malformed, rotated (re-sent),
 * revoked and used tokens are all simply not found.
 */
export async function resolveInvitation(
	read: Pick<RouteTransaction, 'findById'>,
	sharing: Sharing,
	token: unknown,
): Promise<ResolvedInvitation | null> {
	const invitationId = invitationIdOfToken(token)
	if (!invitationId || typeof token !== 'string') return null
	const invitation = await read.findById(SPACE_INVITATIONS, invitationId)
	const secret = await read.findById(SPACE_INVITATION_SECRETS, secretIdFor(invitationId))
	if (!invitation || !secret) return null
	if (!tokenMatches(token, secret.tokenHash)) return null
	if (secret.invitationId !== invitationId || secret.tokenVersion !== invitation.tokenVersion)
		return null
	const space = spaceOfKey(sharing, invitation.group)
	return space ? { invitation, secret, space } : null
}

/** The invitee as the route identified them. */
export interface Invitee {
	userId: string
	email: string | null
	emailVerified: boolean
}

/** Refuse unless the signed-in user is the verified owner of the invited address. */
function inviteeRefusal(invitation: Record_, invitee: Invitee): { refuse: DecisionRefusal } | null {
	if (invitee.email === null || invitee.email !== invitation.email) {
		return refuse('EMAIL_MISMATCH', 'This invitation was sent to another email address.')
	}
	if (!invitee.emailVerified) {
		return refuse('EMAIL_NOT_VERIFIED', 'Verify your email address to accept this invitation.')
	}
	return null
}

/** Outcome of {@link decideAcceptInvitation}. */
export interface AcceptedInvitation {
	space: SpaceRef
	role: string
	invitationId: string
	email: string
	inviterId: string
}

/**
 * Accept: the token is current, the invitation unexpired, the caller the verified
 * invitee, the space alive, its ownership and the inviter's authority unchanged since the
 * invitation was sent, and the caller not already in the space. The membership is
 * written, and the invitation and its secret deleted, in one step.
 */
export async function decideAcceptInvitation(
	{ tx, access, sharing, now }: DecisionContext,
	token: string,
	invitee: Invitee,
): Promise<Decided<AcceptedInvitation>> {
	const found = await resolveInvitation(tx, sharing, token)
	if (!found) return refuse('INVITATION_NOT_FOUND', 'This invitation is no longer valid.')
	const { invitation, secret, space } = found
	const mismatch = inviteeRefusal(invitation, invitee)
	if (mismatch) return mismatch
	if (typeof invitation.expiresAt !== 'number' || invitation.expiresAt <= now) {
		return refuse('INVITATION_EXPIRED', 'This invitation has expired. Ask for a new one.')
	}
	const live = await liveSpace(tx, space)
	if ('refuse' in live) {
		return live.refuse.code === 'SPACE_NOT_SYNCED'
			? refuse('INVITATION_NOT_FOUND', 'This invitation is no longer valid.')
			: live
	}
	const record = live.record
	const key = spaceKeyOf(space)
	const role = String(invitation.role)
	const inviterId = String(secret.inviterId)
	if (!(await invitationStillValid(tx, sharing, space, record, invitation, secret))) {
		return refuse(
			'INVITER_NO_LONGER_AUTHORIZED',
			'The person who invited you can no longer grant this access. Ask for a new invitation.',
		)
	}
	const cleanup = await deleteInvitation(tx, invitation.id)
	const outcome: AcceptedInvitation = {
		space,
		role,
		invitationId: invitation.id,
		email: String(invitation.email),
		inviterId,
	}
	// An invitation never changes an existing member's role (it could demote them): it is
	// consumed and the caller told, and a role change stays its own action.
	if (await tx.roleOf(invitee.userId, key)) {
		return {
			mutations: cleanup,
			outcome,
			refuseAfterCommit: { code: 'ALREADY_MEMBER', message: 'You are already in this space.' },
		}
	}
	const grant = await access.prepareGrant(tx, { userId: invitee.userId, group: key, role })
	return { mutations: [...withInviter(grant, inviterId), ...cleanup], outcome }
}

/** Record who invited the member on the membership row the grant writes. */
function withInviter(mutations: RouteMutation[], inviterId: string): RouteMutation[] {
	return mutations.map((mutation) =>
		mutation.collection === SPACE_MEMBERS && mutation.type !== 'delete'
			? { ...mutation, data: { ...(mutation.data ?? {}), invitedBy: inviterId } }
			: mutation,
	)
}

/** Outcome of {@link decideDeclineInvitation}. */
export interface DeclinedInvitation {
	space: SpaceRef
	invitationId: string
	email: string
}

/** Decline: the verified invitee deletes the invitation (expired ones too). */
export async function decideDeclineInvitation(
	{ tx, sharing }: DecisionContext,
	token: string,
	invitee: Invitee,
): Promise<Decided<DeclinedInvitation>> {
	const found = await resolveInvitation(tx, sharing, token)
	if (!found) return refuse('INVITATION_NOT_FOUND', 'This invitation is no longer valid.')
	const mismatch = inviteeRefusal(found.invitation, invitee)
	if (mismatch) return mismatch
	return {
		mutations: await deleteInvitation(tx, found.invitation.id),
		outcome: {
			space: found.space,
			invitationId: found.invitation.id,
			email: String(found.invitation.email),
		},
	}
}

/** Outcome of {@link decideRevokeInvitation}. */
export interface RevokedInvitation {
	space: SpaceRef
	invitationId: string
	email: string
}

/**
 * Revoke a pending invitation: its sender, or a member who outranks the invited role
 * and holds at least the manager role. Anyone else is told it does not exist.
 */
export async function decideRevokeInvitation(
	{ tx, sharing }: DecisionContext,
	actorId: string,
	invitationId: string,
): Promise<Decided<RevokedInvitation>> {
	const notFound = refuse(
		'INVITATION_NOT_FOUND',
		'This invitation does not exist or was already answered.',
	)
	const invitation = await tx.findById(SPACE_INVITATIONS, invitationId)
	const space = invitation ? spaceOfKey(sharing, invitation.group) : null
	if (!invitation || !space) return notFound
	const actor = await authorityOf(tx, sharing, actorId, String(invitation.group))
	// Pending invitations (and so who is invited) are visible to managers only: anyone
	// else is told nothing exists, whether or not it does.
	const sees =
		actor !== null &&
		(invitation.invitedBy === actorId ||
			sharing.rank(actor.role) >= sharing.rank(sharing.manageRole))
	if (!actor || !sees) return notFound
	if (!mayRevoke(sharing, actorId, actor.role, invitation)) {
		return refuse('FORBIDDEN', 'You cannot revoke this invitation.')
	}
	return {
		mutations: await deleteInvitation(tx, invitationId),
		outcome: { space, invitationId, email: String(invitation.email) },
	}
}

// ─── Members ─────────────────────────────────────────────────────────────────

/** Outcome of the member decisions. */
export interface MemberChange {
	space: SpaceRef
	previousRole: string | null
	invitationsRevoked: number
	changed: boolean
}

/**
 * The actor may act on `target`: the actor holds at least the manager role and a role
 * strictly above the target's (so a manager can neither demote nor remove another).
 */
function mayActOn(sharing: Sharing, actorRole: string | null, targetRole: string): boolean {
	if (actorRole === null) return false
	const actorRank = sharing.rank(actorRole)
	return actorRank >= sharing.rank(sharing.manageRole) && actorRank > sharing.rank(targetRole)
}

/**
 * The expiry of `userId`'s membership of `key`: the latest of its rows' expiries, or
 * null when any row does not expire.
 */
async function membershipExpiry(
	tx: RouteTransaction,
	userId: string,
	key: string,
): Promise<number | null> {
	const rows = await tx.query(SPACE_MEMBERS, { where: { userId, group: key } })
	let latest: number | null = null
	for (const row of rows) {
		// No expiry: the membership does not end. A value that is not a time grants
		// nothing (the index ignores the row), so it does not make the membership permanent.
		if (row.expiresAt === null || row.expiresAt === undefined) return null
		if (typeof row.expiresAt !== 'number' || !Number.isFinite(row.expiresAt)) continue
		latest = latest === null ? row.expiresAt : Math.max(latest, row.expiresAt)
	}
	return latest
}

/** Input of {@link decideChangeRole}. */
export interface ChangeRoleInput {
	actorId: string
	space: SpaceRef
	userId: string
	role: string
	/** The role the actor saw; the change is refused when the member's role is no longer it. */
	from?: string
}

/**
 * Change a member's role. The owner's role moves only by transfer. Any change also
 * revokes the member's pending invitations: their authority to send them changed.
 */
export async function decideChangeRole(
	{ tx, access, sharing }: DecisionContext,
	input: ChangeRoleInput,
): Promise<Decided<MemberChange>> {
	const live = await liveSpace(tx, input.space)
	if ('refuse' in live) return live
	const key = spaceKeyOf(input.space)
	const target = await authorityOf(tx, sharing, input.userId, key)
	if (!target) return refuse('NOT_A_MEMBER', 'This person is not in the space.')
	if (target.source === 'owner') {
		return refuse('CANNOT_CHANGE_OWNER', 'The owner’s role changes only by transferring the space.')
	}
	if (input.from !== undefined && input.from !== target.role && input.from !== target.stored) {
		return refuse('ROLE_CHANGED', 'This member’s role changed meanwhile. Reload and try again.')
	}
	const actor = await authorityOf(tx, sharing, input.actorId, key)
	if (!mayActOn(sharing, actor?.role ?? null, target.role)) {
		return refuse('FORBIDDEN', 'You can only change the role of members below you.')
	}
	if (sharing.rank(input.role) >= sharing.rank(actor?.role ?? '')) {
		return refuse('ROLE_TOO_HIGH', 'You can only grant a role below your own.')
	}
	if (input.role === target.stored) {
		return {
			mutations: [],
			outcome: {
				space: input.space,
				previousRole: target.role,
				invitationsRevoked: 0,
				changed: false,
			},
		}
	}
	const revoked = await deleteInvitationsOf(tx, key, input.userId)
	// A role change keeps the membership's expiry (a time-limited grant stays time-limited).
	const grant = await access.prepareGrant(tx, {
		userId: input.userId,
		group: key,
		role: input.role,
		expiresAt: await membershipExpiry(tx, input.userId, key),
	})
	return {
		mutations: [...grant, ...revoked.mutations],
		outcome: {
			space: input.space,
			previousRole: target.role,
			invitationsRevoked: revoked.count,
			changed: true,
		},
	}
}

/** Input of {@link decideRemoveMember}. */
export interface RemoveMemberInput {
	actorId: string
	space: SpaceRef
	userId: string
	from?: string
}

/** Remove a member below the actor, with their pending invitations. */
export async function decideRemoveMember(
	{ tx, access, sharing }: DecisionContext,
	input: RemoveMemberInput,
): Promise<Decided<MemberChange>> {
	const live = await liveSpace(tx, input.space)
	if ('refuse' in live) return live
	const key = spaceKeyOf(input.space)
	const target = await authorityOf(tx, sharing, input.userId, key)
	if (!target) return refuse('NOT_A_MEMBER', 'This person is not in the space.')
	if (target.source === 'owner') {
		return refuse(
			'CANNOT_CHANGE_OWNER',
			'The owner cannot be removed. They can transfer the space.',
		)
	}
	if (input.from !== undefined && input.from !== target.role && input.from !== target.stored) {
		return refuse('ROLE_CHANGED', 'This member’s role changed meanwhile. Reload and try again.')
	}
	const actor = await authorityOf(tx, sharing, input.actorId, key)
	if (!mayActOn(sharing, actor?.role ?? null, target.role)) {
		return refuse('FORBIDDEN', 'You can only remove members below you.')
	}
	const revoked = await deleteInvitationsOf(tx, key, input.userId)
	const revoke = await access.prepareRevoke(tx, { userId: input.userId, group: key })
	return {
		mutations: [...revoke, ...revoked.mutations],
		outcome: {
			space: input.space,
			previousRole: target.role,
			invitationsRevoked: revoked.count,
			changed: true,
		},
	}
}

/** Leave a space: any member but the owner (who transfers it first). */
export async function decideLeave(
	{ tx, access, sharing }: DecisionContext,
	actorId: string,
	space: SpaceRef,
): Promise<Decided<MemberChange>> {
	const key = spaceKeyOf(space)
	const held = await authorityOf(tx, sharing, actorId, key)
	if (held?.source === 'owner') {
		return refuse('OWNER_CANNOT_LEAVE', 'Transfer the space to someone else before leaving it.')
	}
	// A deleted space grants its members nothing, but their rows remain (and would grant
	// again if the space were restored): leaving removes them too.
	const rows = held
		? []
		: await tx.query(SPACE_MEMBERS, { where: { userId: actorId, group: key }, limit: 1 })
	if (!held && rows.length === 0) return refuse('NOT_A_MEMBER', 'You are not in this space.')
	const revoked = await deleteInvitationsOf(tx, key, actorId)
	const revoke = await access.prepareRevoke(tx, { userId: actorId, group: key })
	return {
		mutations: [...revoke, ...revoked.mutations],
		outcome: {
			space,
			previousRole: held?.role ?? (rows[0] ? String(rows[0].role) : null),
			invitationsRevoked: revoked.count,
			changed: true,
		},
	}
}

/** Input of {@link decideTransfer}. */
export interface TransferInput {
	/** The owner making the transfer, or null for an operator (`transferSpace`). */
	actorId: string | null
	space: SpaceRef
	toUserId: string
	/** The previous owner's role afterwards, or `leave` for none. Defaults to the manager role. */
	previousOwner?: string
	/** Require the new owner to be a member already (the route does; operators may not). */
	requireMember: boolean
}

/** Outcome of {@link decideTransfer}. */
export interface TransferredSpace extends MemberChange {
	previousOwnerId: string | null
}

/**
 * Give a space to another user: the owner field changes, the new owner's membership rows
 * go (they hold the owner role through the field), the previous owner keeps
 * `previousOwner` (the manager role by default) and every pending invitation is revoked
 * (each was sent under the previous ownership).
 */
export async function decideTransfer(
	{ tx, access, sharing }: DecisionContext,
	input: TransferInput,
): Promise<Decided<TransferredSpace>> {
	const live = await liveSpace(tx, input.space)
	if ('refuse' in live) return live
	const record = live.record
	const key = spaceKeyOf(input.space)
	const ownerField = sharing.groups[input.space[0]]?.owner ?? ''
	const ownerValue = record[ownerField]
	const ownerId = typeof ownerValue === 'string' && ownerValue.length > 0 ? ownerValue : null
	if (input.actorId !== null) {
		const actor = await authorityOf(tx, sharing, input.actorId, key)
		if (ownerId !== input.actorId || actor?.source !== 'owner') {
			return refuse('FORBIDDEN', 'Only the owner can transfer the space.')
		}
	}
	if (input.toUserId === ownerId)
		return refuse('ALREADY_OWNER', 'This person already owns the space.')
	const previousOwner = input.previousOwner ?? sharing.manageRole
	if (
		previousOwner !== 'leave' &&
		(sharing.rank(previousOwner) === -1 || previousOwner === sharing.ownerRole)
	) {
		return refuse(
			'ROLE_NOT_ALLOWED',
			'The previous owner keeps a role below the owner role, or leaves.',
		)
	}
	if (input.requireMember && !(await tx.roleOf(input.toUserId, key))) {
		return refuse('NOT_A_MEMBER', 'Transfer the space to one of its members.')
	}
	const revoked = await deleteInvitationsOf(tx, key)
	const mutations: RouteMutation[] = [
		{
			collection: input.space[0],
			type: 'update',
			recordId: input.space[1],
			data: { [ownerField]: input.toUserId },
		},
		...(await access.prepareRevoke(tx, { userId: input.toUserId, group: key })),
		...revoked.mutations,
	]
	if (ownerId !== null) {
		// The previous owner keeps exactly `previousOwner`, or nothing: a membership row they
		// already held (a backfill, an earlier raw transfer) is replaced or removed with it.
		mutations.push(
			...(previousOwner === 'leave'
				? await access.prepareRevoke(tx, { userId: ownerId, group: key })
				: await access.prepareGrant(tx, { userId: ownerId, group: key, role: previousOwner })),
		)
	}
	return {
		mutations,
		outcome: {
			space: input.space,
			previousRole: sharing.ownerRole,
			invitationsRevoked: revoked.count,
			changed: true,
			previousOwnerId: ownerId,
		},
	}
}
