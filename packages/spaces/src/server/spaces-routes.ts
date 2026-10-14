import type {
	AccessApi,
	ProductionHttpRoute,
	ProductionHttpRouteContext,
	ProductionHttpRouteRequest,
	ProductionHttpRouteResponse,
} from '@korajs/server'
import type {
	AcceptInvitationResponse,
	CreateInvitationResponse,
	InvitationDescription,
	MemberChangeResponse,
	SpaceRef,
	SpacesErrorCode,
} from '../protocol'
import type { Sharing } from '../schema/spaces-collections'
import {
	type DecisionRefusal,
	type DecisionResult,
	type Invitee,
	type MemberChange,
	decideAcceptInvitation,
	decideChangeRole,
	decideCreateInvitation,
	decideDeclineInvitation,
	decideLeave,
	decideRemoveMember,
	decideRevokeInvitation,
	decideTransfer,
	resolveInvitation,
	runDecision,
	spaceKeyOf,
} from './decisions'
import { type SpacesLimiter, memoryLimiter } from './limiter'
import {
	emailHint,
	hashToken,
	invitationIdFor,
	isEmail,
	newInvitationToken,
	normalizeEmail,
} from './tokens'

/** The signed-in caller of a spaces route, as the app's `identify` resolves it. */
export interface SpacesIdentity {
	userId: string
	/** The account's email address. Accepting an invitation requires it to be the invited one. */
	email?: string | null
	/** Whether the app verified that the user controls `email`. Accepting requires it. */
	emailVerified?: boolean
}

/** What `deliverInvitation` receives: everything needed to send the invitation email. */
export interface InvitationDelivery {
	invitationId: string
	email: string
	/** The accept link (`acceptUrl(token)`). Send it only to `email`. */
	url: string
	space: SpaceRef
	role: string
	invitedBy: string
	expiresAt: number
	/** True when this re-sends an earlier invitation (its previous link stopped working). */
	resent: boolean
}

/** An audit event: one per committed action. */
export interface SpacesEvent {
	type:
		| 'invitation.created'
		| 'invitation.resent'
		| 'invitation.revoked'
		| 'invitation.accepted'
		| 'invitation.declined'
		/** Accepted by someone already in the space: the invitation was deleted, nothing granted. */
		| 'invitation.discarded'
		| 'member.role-changed'
		| 'member.removed'
		| 'member.left'
		| 'space.transferred'
	space: SpaceRef
	/** Who acted (the invitee for accept and decline). */
	actorId: string
	targetUserId?: string
	/** The role granted, set or kept (on a transfer: the previous owner's; absent when they left). */
	role?: string
	previousRole?: string
	invitationId?: string
	/** The invitee's address, on invitation events. */
	email?: string
	/** Pending invitations revoked as part of a member change or a transfer. */
	invitationsRevoked?: number
}

/** What `beforeInvite` receives. Return a refusal (or throw) to stop the invitation. */
export interface BeforeInviteContext {
	actorId: string
	space: SpaceRef
	email: string
	role: string
	request: ProductionHttpRouteRequest
}

/** `beforeInvite`'s answer: a refusal shown to the inviter, or nothing to let the invitation through. */
export type BeforeInviteResult = { message: string } | null | undefined

/** Limits on invitations and requests. `false` turns one off. */
export interface SpacesLimits {
	/** Pending invitations per space (default 50). Best effort under concurrent invites. */
	pendingPerSpace?: number | false
	/** Invitations from one user to one address per day, across all spaces (default 5). */
	perRecipientPerDay?: number | false
	/** Invitations to one address per day from everyone, across all spaces (default 20). */
	perAddressPerDay?: number | false
	/** Invitations one user sends per day, across all spaces (default 200). With the above, protects your sender reputation. */
	perInviterPerDay?: number | false
	/** Requests per user per minute, across all spaces routes (default 60). */
	requestsPerUserPerMinute?: number | false
}

/** Options of {@link spacesRoutes}. */
export interface SpacesRoutesOptions {
	/** The `spacesCollections(...)` result the schema uses. */
	sharing: Sharing
	/** Where the routes live (default `/api/spaces`). */
	basePath?: string
	/** Resolve the request's signed-in user, or null. `koraAuthIdentity(auth)` does this for `@korajs/auth`. */
	identify(
		request: ProductionHttpRouteRequest,
	): Promise<SpacesIdentity | null> | SpacesIdentity | null
	/** Look a user up by email, so inviting an existing member is refused at once instead of at accept. */
	findUserByEmail?(email: string): Promise<string | null> | string | null
	/**
	 * The accept link for a token. Put the token in the URL fragment (`/invite#<token>`):
	 * fragments are never sent to servers or in `Referer` headers.
	 */
	acceptUrl(token: string): string
	/**
	 * Send the invitation (your mailer). Runs after the invitation is committed; a failure
	 * is reported to the inviter as `DELIVERY_FAILED` and the invitation stays pending (re-send
	 * it). Without it, the create route returns the link to the inviter instead.
	 */
	deliverInvitation?(delivery: InvitationDelivery): Promise<void> | void
	/**
	 * What the accept page may show the invitee (the space's title, the inviter's name).
	 * Called only for a signed-in caller whose verified email is the invited one.
	 */
	describeInvitation?(input: {
		space: SpaceRef
		invitedBy: string
		role: string
	}): Promise<Record<string, unknown> | null> | Record<string, unknown> | null
	/** Product rules for invitations (plans, allowed domains). Return a refusal to stop it. */
	beforeInvite?(context: BeforeInviteContext): BeforeInviteResult | Promise<BeforeInviteResult>
	/** Audit hook, called after each committed action. Errors are logged, never returned. */
	onEvent?(event: SpacesEvent): Promise<void> | void
	/** How long an invitation stays valid (default 7 days). */
	invitationTtlMs?: number
	limits?: SpacesLimits
	/** Counts requests for the limits (default: in memory, per instance). */
	limiter?: SpacesLimiter
	/** The clock (for tests). Expiry is always judged on the server's clock. */
	now?(): number
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

/** HTTP status of each error code. */
const STATUS: Record<SpacesErrorCode, number> = {
	INVALID_REQUEST: 400,
	UNAUTHENTICATED: 401,
	FORBIDDEN: 403,
	RATE_LIMITED: 429,
	ROLE_NOT_ALLOWED: 400,
	ROLE_TOO_HIGH: 403,
	ROLE_CHANGED: 409,
	SPACE_NOT_FOUND: 404,
	SPACE_NOT_SYNCED: 409,
	NOT_A_MEMBER: 404,
	ALREADY_MEMBER: 409,
	ALREADY_OWNER: 409,
	CANNOT_CHANGE_OWNER: 409,
	OWNER_CANNOT_LEAVE: 409,
	TOO_MANY_PENDING: 429,
	INVITE_REFUSED: 403,
	INVITATION_NOT_FOUND: 404,
	INVITATION_EXPIRED: 410,
	INVITER_NO_LONGER_AUTHORIZED: 409,
	EMAIL_NOT_VERIFIED: 403,
	EMAIL_MISMATCH: 403,
	DELIVERY_FAILED: 502,
	WRITE_REFUSED: 409,
	CONFLICT: 503,
	INTERNAL: 500,
}

/** Tokens and invitee emails must not be cached or leak through a `Referer`. */
const HEADERS = { 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' }

class RouteRefusal extends Error {
	constructor(
		readonly code: SpacesErrorCode,
		message: string,
	) {
		super(message)
		this.name = 'RouteRefusal'
	}
}

function ok(body: unknown): ProductionHttpRouteResponse {
	return { status: 200, body, headers: HEADERS }
}

function failure(code: SpacesErrorCode, message: string): ProductionHttpRouteResponse {
	return { status: STATUS[code], body: { error: { code, message } }, headers: HEADERS }
}

function fromRefusal(refusal: DecisionRefusal): ProductionHttpRouteResponse {
	return failure(refusal.code, refusal.message)
}

/** The request body as an object, or a refusal. */
function bodyOf(request: ProductionHttpRouteRequest): Record<string, unknown> {
	const body = request.body
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		throw new RouteRefusal('INVALID_REQUEST', 'Send a JSON object.')
	}
	return body as Record<string, unknown>
}

function stringField(body: Record<string, unknown>, name: string, max = 256): string {
	const value = body[name]
	if (typeof value !== 'string' || value.length === 0 || value.length > max) {
		throw new RouteRefusal('INVALID_REQUEST', `"${name}" must be a non-empty string.`)
	}
	return value
}

function optionalString(body: Record<string, unknown>, name: string): string | undefined {
	return body[name] === undefined ? undefined : stringField(body, name)
}

/** Answer with the outcome, or with the refusal of a decision. */
function answer<T>(
	result: DecisionResult<T>,
	respond: (outcome: T) => ProductionHttpRouteResponse,
): ProductionHttpRouteResponse {
	if (!result.ok) return failure(result.code, result.message)
	if (result.refuseAfterCommit) return fromRefusal(result.refuseAfterCommit)
	return respond(result.outcome)
}

function memberChangeBody(change: MemberChange): MemberChangeResponse {
	return {
		space: change.space,
		invitationsRevoked: change.invitationsRevoked,
		changed: change.changed,
	}
}

/**
 * The HTTP routes of sharing: invite, re-send, revoke, describe, accept and decline
 * invitations; change roles, remove members, leave and transfer. Every action is one
 * `kora.transaction`: its checks (the caller's role, the target's, the invitation's
 * token, the inviter's authority) and its writes commit together, so no concurrent
 * request, device upload or other server instance can slip between them.
 *
 * All routes are `POST` with a JSON body; responses are `{ error: { code, message } }` on
 * failure and never cached.
 *
 * @example
 * ```typescript
 * createProductionServer({
 *   httpRoutes: [
 *     spacesRoutes({
 *       sharing,
 *       ...koraAuthIdentity(auth),
 *       acceptUrl: (token) => `${PUBLIC_URL}/invite#${token}`,
 *       deliverInvitation: ({ email, url }) => mailer.send({ to: email, text: url }),
 *     }),
 *   ],
 * })
 * ```
 */
export function spacesRoutes(options: SpacesRoutesOptions): ProductionHttpRoute {
	// The same form the server's router matches: one leading slash, no trailing one.
	const basePath = `/${(options.basePath ?? '/api/spaces').replace(/^\/+|\/+$/g, '')}`
	const { sharing } = options
	const limiter = options.limiter ?? memoryLimiter()
	const now = options.now ?? Date.now
	const ttl = options.invitationTtlMs ?? DEFAULT_TTL_MS
	const limit = (value: number | false | undefined, fallback: number): number | null =>
		value === false ? null : (value ?? fallback)
	const pendingPerSpace = limit(options.limits?.pendingPerSpace, 50)
	const perRecipientPerDay = limit(options.limits?.perRecipientPerDay, 5)
	const perInviterPerDay = limit(options.limits?.perInviterPerDay, 200)
	const perAddressPerDay = limit(options.limits?.perAddressPerDay, 20)
	const perUserPerMinute = limit(options.limits?.requestsPerUserPerMinute, 60)

	const emit = async (event: SpacesEvent): Promise<void> => {
		if (!options.onEvent) return
		try {
			await options.onEvent(event)
		} catch (error) {
			console.error('[kora] spaces onEvent failed', error)
		}
	}

	const spaceOf = (value: unknown): SpaceRef => {
		let collection: unknown
		let id: unknown
		if (Array.isArray(value) && value.length === 2) [collection, id] = value
		else if (typeof value === 'string' && value.indexOf(':') > 0) {
			collection = value.slice(0, value.indexOf(':'))
			id = value.slice(value.indexOf(':') + 1)
		}
		if (
			typeof collection !== 'string' ||
			typeof id !== 'string' ||
			id.length === 0 ||
			id.length > 256 ||
			!Object.prototype.hasOwnProperty.call(sharing.groups, collection)
		) {
			throw new RouteRefusal(
				'INVALID_REQUEST',
				'"space" must be [collection, id] of a shared collection.',
			)
		}
		return [collection, id]
	}

	const roleOf = (body: Record<string, unknown>, name = 'role'): string => {
		const role = stringField(body, name)
		if (sharing.rank(role) === -1)
			throw new RouteRefusal('ROLE_NOT_ALLOWED', `"${role}" is not a role.`)
		if (role === sharing.ownerRole) {
			throw new RouteRefusal(
				'ROLE_NOT_ALLOWED',
				'The owner role is given only by transferring the space.',
			)
		}
		return role
	}

	const signedIn = async (request: ProductionHttpRouteRequest): Promise<SpacesIdentity> => {
		const identity = await options.identify(request)
		if (!identity || typeof identity.userId !== 'string' || identity.userId.length === 0) {
			throw new RouteRefusal('UNAUTHENTICATED', 'Sign in to continue.')
		}
		if (
			perUserPerMinute !== null &&
			!(await limiter.hit(`spaces:user:${identity.userId}`, perUserPerMinute, MINUTE_MS))
		) {
			throw new RouteRefusal('RATE_LIMITED', 'Too many requests. Try again in a minute.')
		}
		return identity
	}

	const inviteeOf = (identity: SpacesIdentity): Invitee => ({
		userId: identity.userId,
		email: typeof identity.email === 'string' ? normalizeEmail(identity.email) : null,
		emailVerified: identity.emailVerified === true,
	})

	const decide = <T>(
		kora: ProductionHttpRouteContext,
		access: AccessApi,
		run: Parameters<typeof runDecision<T>>[4],
	): Promise<DecisionResult<T>> => runDecision(kora, access, sharing, now(), run)

	type Handler = (request: ProductionHttpRouteRequest) => Promise<ProductionHttpRouteResponse>

	const handlers: Record<string, Handler> = {
		'/invitations/create': async (request) => {
			const identity = await signedIn(request)
			const body = bodyOf(request)
			const space = spaceOf(body.space)
			const role = roleOf(body)
			const email = normalizeEmail(stringField(body, 'email', 254))
			if (!isEmail(email)) throw new RouteRefusal('INVALID_REQUEST', 'Enter a valid email address.')
			// Early, non-binding check (the transaction decides): refuse a caller who cannot
			// invite before counting the request against the recipient's daily limit.
			const held = await request.access.roleOf(identity.userId, spaceKeyOf(space))
			if (!held) {
				const stored = await request.kora.query(space[0], {
					where: { id: space[1] },
					includeDeleted: true,
					limit: 1,
				})
				const row = stored[0]
				if (!row) {
					throw new RouteRefusal(
						'SPACE_NOT_SYNCED',
						'The server does not have this space yet. If it was created offline, try again once it has synced.',
					)
				}
				if (row._deleted === 1 || row._deleted === true) {
					throw new RouteRefusal('SPACE_NOT_FOUND', 'This space was deleted.')
				}
			}
			if (!held || sharing.rank(held.role) < sharing.rank(sharing.manageRole)) {
				throw new RouteRefusal('FORBIDDEN', 'Only the space’s managers can invite people.')
			}
			if (sharing.rank(role) >= sharing.rank(held.role)) {
				throw new RouteRefusal(
					'ROLE_TOO_HIGH',
					'You can only invite people to a role below your own.',
				)
			}
			const inviteeId = options.findUserByEmail ? await options.findUserByEmail(email) : null
			if (inviteeId && (await request.access.roleOf(inviteeId, spaceKeyOf(space)))) {
				throw new RouteRefusal(
					'ALREADY_MEMBER',
					'This person is already in the space. Change their role instead.',
				)
			}
			if (options.beforeInvite) {
				const refused = await options.beforeInvite({
					actorId: identity.userId,
					space,
					email,
					role,
					request,
				})
				if (refused) throw new RouteRefusal('INVITE_REFUSED', refused.message)
			}
			// Counted only once the early checks pass. The per-inviter caps come first, so an
			// inviter over their own limit adds nothing to the others; the per-address cap,
			// higher, bounds what many accounts together can send to one address.
			const caps: Array<[number | null, string, string]> = [
				[
					perInviterPerDay,
					`spaces:inviter:${identity.userId}`,
					'You sent too many invitations today. Try again tomorrow.',
				],
				[
					perRecipientPerDay,
					`spaces:recipient:${identity.userId}:${email}`,
					'You invited this address too many times today. Try again tomorrow.',
				],
				[
					perAddressPerDay,
					`spaces:address:${email}`,
					'This address was invited too many times today. Try again tomorrow.',
				],
			]
			// Hits are given back when the invitation is not created (a later cap or the
			// transaction refused it), so only invitations that commit count.
			const counted: string[] = []
			const giveBack = async (): Promise<void> => {
				if (!limiter.release) return
				for (const key of counted) await limiter.release(key, DAY_MS)
			}
			for (const [cap, key, message] of caps) {
				if (cap === null) continue
				counted.push(key)
				if (!(await limiter.hit(key, cap, DAY_MS))) {
					await giveBack()
					throw new RouteRefusal('RATE_LIMITED', message)
				}
			}
			const invitationId = invitationIdFor(spaceKeyOf(space), email)
			const token = newInvitationToken(invitationId)
			const expiresAt = now() + ttl
			const result = await decide(request.kora, request.access, (context) =>
				decideCreateInvitation(context, {
					actorId: identity.userId,
					space,
					email,
					role,
					inviteeId: inviteeId ?? null,
					tokenHash: hashToken(token),
					expiresAt,
					pendingLimit: pendingPerSpace,
					invitationId,
				}),
			)
			if (!result.ok) {
				await giveBack()
				return failure(result.code, result.message)
			}
			const { resent } = result.outcome
			await emit({
				type: resent ? 'invitation.resent' : 'invitation.created',
				space,
				actorId: identity.userId,
				role,
				invitationId,
				email,
			})
			const url = options.acceptUrl(token)
			const response: CreateInvitationResponse = {
				invitation: { id: invitationId, space, email, role, expiresAt },
				resent,
				...(options.deliverInvitation ? {} : { url }),
			}
			if (options.deliverInvitation) {
				try {
					await options.deliverInvitation({
						invitationId,
						email,
						url,
						space,
						role,
						invitedBy: identity.userId,
						expiresAt,
						resent,
					})
				} catch (error) {
					console.error('[kora] spaces deliverInvitation failed', error)
					return {
						status: STATUS.DELIVERY_FAILED,
						body: {
							error: {
								code: 'DELIVERY_FAILED',
								message: 'The invitation was saved but the email could not be sent. Re-send it.',
							},
							invitation: response.invitation,
						},
						headers: HEADERS,
					}
				}
			}
			return ok(response)
		},

		'/invitations/revoke': async (request) => {
			const identity = await signedIn(request)
			const invitationId = stringField(bodyOf(request), 'invitationId', 64)
			const result = await decide(request.kora, request.access, (context) =>
				decideRevokeInvitation(context, identity.userId, invitationId),
			)
			if (result.ok) {
				await emit({
					type: 'invitation.revoked',
					space: result.outcome.space,
					actorId: identity.userId,
					invitationId,
					email: result.outcome.email,
				})
			}
			return answer(result, (outcome) => ok({ space: outcome.space, invitationId }))
		},

		'/invitations/describe': async (request) => {
			const identity = inviteeOf(await signedIn(request))
			const token = stringField(bodyOf(request), 'token', 128)
			const found = await resolveInvitation(request.kora, sharing, token)
			if (!found) return failure('INVITATION_NOT_FOUND', 'This invitation is no longer valid.')
			const email = String(found.invitation.email)
			const match = identity.email !== email ? 'no' : identity.emailVerified ? 'yes' : 'unverified'
			const expiresAt = Number(found.invitation.expiresAt)
			const description: InvitationDescription = {
				role: String(found.invitation.role),
				expiresAt,
				expired: expiresAt <= now(),
				emailHint: emailHint(email),
				match,
			}
			if (match === 'yes' && options.describeInvitation) {
				const details = await options.describeInvitation({
					space: found.space,
					invitedBy: String(found.invitation.invitedBy),
					role: description.role,
				})
				if (details) description.details = details
			}
			return ok(description)
		},

		'/invitations/accept': async (request) => {
			const identity = inviteeOf(await signedIn(request))
			const token = stringField(bodyOf(request), 'token', 128)
			const result = await decide(request.kora, request.access, (context) =>
				decideAcceptInvitation(context, token, identity),
			)
			if (result.ok) {
				await emit({
					type: result.refuseAfterCommit ? 'invitation.discarded' : 'invitation.accepted',
					space: result.outcome.space,
					actorId: identity.userId,
					targetUserId: identity.userId,
					role: result.outcome.role,
					invitationId: result.outcome.invitationId,
					email: result.outcome.email,
				})
			}
			return answer(result, (outcome): ProductionHttpRouteResponse => {
				const body: AcceptInvitationResponse = {
					space: outcome.space,
					role: outcome.role,
					userId: identity.userId,
				}
				return ok(body)
			})
		},

		'/invitations/decline': async (request) => {
			const identity = inviteeOf(await signedIn(request))
			const token = stringField(bodyOf(request), 'token', 128)
			const result = await decide(request.kora, request.access, (context) =>
				decideDeclineInvitation(context, token, identity),
			)
			if (result.ok) {
				await emit({
					type: 'invitation.declined',
					space: result.outcome.space,
					actorId: identity.userId,
					invitationId: result.outcome.invitationId,
					email: result.outcome.email,
				})
			}
			return answer(result, (outcome) => ok({ space: outcome.space }))
		},

		'/members/role': async (request) => {
			const identity = await signedIn(request)
			const body = bodyOf(request)
			const space = spaceOf(body.space)
			const userId = stringField(body, 'userId')
			const role = roleOf(body)
			const from = optionalString(body, 'from')
			const result = await decide(request.kora, request.access, (context) =>
				decideChangeRole(context, {
					actorId: identity.userId,
					space,
					userId,
					role,
					...(from ? { from } : {}),
				}),
			)
			if (result.ok && result.outcome.changed) {
				await emit({
					type: 'member.role-changed',
					space,
					actorId: identity.userId,
					targetUserId: userId,
					role,
					...(result.outcome.previousRole ? { previousRole: result.outcome.previousRole } : {}),
					invitationsRevoked: result.outcome.invitationsRevoked,
				})
			}
			return answer(result, (outcome) => ok(memberChangeBody(outcome)))
		},

		'/members/remove': async (request) => {
			const identity = await signedIn(request)
			const body = bodyOf(request)
			const space = spaceOf(body.space)
			const userId = stringField(body, 'userId')
			const from = optionalString(body, 'from')
			const result = await decide(request.kora, request.access, (context) =>
				decideRemoveMember(context, {
					actorId: identity.userId,
					space,
					userId,
					...(from ? { from } : {}),
				}),
			)
			if (result.ok) {
				await emit({
					type: 'member.removed',
					space,
					actorId: identity.userId,
					targetUserId: userId,
					...(result.outcome.previousRole ? { previousRole: result.outcome.previousRole } : {}),
					invitationsRevoked: result.outcome.invitationsRevoked,
				})
			}
			return answer(result, (outcome) => ok(memberChangeBody(outcome)))
		},

		'/leave': async (request) => {
			const identity = await signedIn(request)
			const space = spaceOf(bodyOf(request).space)
			const result = await decide(request.kora, request.access, (context) =>
				decideLeave(context, identity.userId, space),
			)
			if (result.ok) {
				await emit({
					type: 'member.left',
					space,
					actorId: identity.userId,
					targetUserId: identity.userId,
					...(result.outcome.previousRole ? { previousRole: result.outcome.previousRole } : {}),
					invitationsRevoked: result.outcome.invitationsRevoked,
				})
			}
			return answer(result, (outcome) => ok(memberChangeBody(outcome)))
		},

		'/transfer': async (request) => {
			const identity = await signedIn(request)
			const body = bodyOf(request)
			const space = spaceOf(body.space)
			const toUserId = stringField(body, 'toUserId')
			const previousOwner = optionalString(body, 'previousOwner')
			const result = await decide(request.kora, request.access, (context) =>
				decideTransfer(context, {
					actorId: identity.userId,
					space,
					toUserId,
					...(previousOwner ? { previousOwner } : {}),
					requireMember: true,
				}),
			)
			if (result.ok) {
				await emit({
					type: 'space.transferred',
					space,
					actorId: identity.userId,
					targetUserId: toUserId,
					// The role the previous owner keeps; absent when they left the space.
					...(previousOwner === 'leave' ? {} : { role: previousOwner ?? sharing.manageRole }),
					invitationsRevoked: result.outcome.invitationsRevoked,
				})
			}
			return answer(result, (outcome) => ok(memberChangeBody(outcome)))
		},
	}

	return {
		path: basePath,
		async handle(request) {
			const handler = handlers[request.path.slice(basePath.length)]
			if (!handler) {
				return {
					status: 404,
					body: { error: { code: 'INVALID_REQUEST', message: 'Unknown spaces route.' } },
					headers: HEADERS,
				}
			}
			if (request.method !== 'POST') {
				return {
					status: 405,
					body: { error: { code: 'INVALID_REQUEST', message: 'Use POST.' } },
					headers: { ...HEADERS, Allow: 'POST' },
				}
			}
			try {
				return await handler(request)
			} catch (error) {
				if (error instanceof RouteRefusal) return failure(error.code, error.message)
				console.error('[kora] spaces route failed', error)
				return failure('INTERNAL', 'Something went wrong. Try again.')
			}
		},
	}
}
