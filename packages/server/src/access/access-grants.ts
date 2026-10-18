import type { AccessDefinition } from '@korajs/core'
import { groupKey, parseGroupKey } from '@korajs/core/internal'
import type { AccessGrant } from '../types'
import { ANONYMOUS_GRANT_HOLDER } from './access-authorizer'
import { type MembershipInterval, groupCollectionOf } from './membership-index'

/**
 * The most capability grants one session holds (more are ignored): grants are for
 * credentials such as share links; many groups belong in memberships, which the store
 * indexes.
 */
export const MAX_ACCESS_GRANTS = 100

/** A capability grant the schema can honor (see {@link validAccessGrants}). */
export interface ValidAccessGrant {
	/** The group key (`documents:<id>`). */
	readonly group: string
	/** The group collection. */
	readonly collection: string
	/** The group record's id. */
	readonly id: string
	readonly role: string
	/** Milliseconds since the epoch, or null when the grant lasts as long as the session. */
	readonly expiresAt: number | null
}

/**
 * The capability grants of an auth context (`AuthContext.accessGrants`) the schema can
 * honor: a group of a group collection, a role the schema orders, an expiry that is a
 * finite number in the future (or none). Anything else gives nothing (fail closed). One
 * grant per group, the highest role (the earliest expiry among those).
 */
export function validAccessGrants(
	access: AccessDefinition,
	grants: readonly AccessGrant[] | undefined,
	now: number,
): ValidAccessGrant[] {
	if (!Array.isArray(grants) || grants.length === 0) return []
	const best = new Map<string, ValidAccessGrant>()
	for (const grant of grants.slice(0, MAX_ACCESS_GRANTS)) {
		if (grant === null || typeof grant !== 'object') continue
		const key = groupKeyOfGrant(grant.group)
		if (key === null) continue
		const collection = groupCollectionOf(access, key)
		const parsed = parseGroupKey(key)
		if (collection === null || parsed === null) continue
		if (typeof grant.role !== 'string' || !access.roles.includes(grant.role)) continue
		let expiresAt: number | null = null
		if (grant.expiresAt !== undefined) {
			if (typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt)) continue
			if (grant.expiresAt <= now) continue
			expiresAt = grant.expiresAt
		}
		const candidate: ValidAccessGrant = {
			group: key,
			collection,
			id: parsed.id,
			role: grant.role,
			expiresAt,
		}
		const held = best.get(key)
		if (held === undefined || outranks(access, candidate, held)) best.set(key, candidate)
	}
	return [...best.values()].sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0))
}

/**
 * A canonical name of a session's capability grants: equal for grants that admit the
 * same, different when a grant was added, removed or changed role (it re-scopes a
 * device in full and ends a session whose grants changed).
 */
export function accessGrantsKey(
	grants: readonly { readonly group: string; readonly role: string }[],
): string {
	return [...grants]
		.map((grant) => `${grant.group}\u0000${grant.role}`)
		.sort()
		.join('\u0001')
}

/** {@link accessGrantsKey} with each grant's expiry: any change of a credential's grants. */
export function accessGrantsChangeKey(grants: readonly ValidAccessGrant[]): string {
	return grants
		.map((grant) => `${grant.group}\u0000${grant.role}\u0000${grant.expiresAt ?? ''}`)
		.join('\u0001')
}

/**
 * Capability grants as membership intervals of the session's principal (an anonymous
 * principal holds them under {@link ANONYMOUS_GRANT_HOLDER}), held from the start of
 * the group's history and open for the session.
 */
export function grantIntervals(
	grants: readonly ValidAccessGrant[],
	userId: string | null,
): MembershipInterval[] {
	const holder = userId ?? ANONYMOUS_GRANT_HOLDER
	return grants.map((grant) => ({
		userId: holder,
		group: grant.group,
		source: 'membership' as const,
		recordId: '',
		role: grant.role,
		expiresAt: grant.expiresAt,
		joinedSeq: 0,
		roleSeq: 0,
		leftSeq: null,
	}))
}

function groupKeyOfGrant(group: unknown): string | null {
	if (typeof group === 'string') return group.length > 0 ? group : null
	if (
		Array.isArray(group) &&
		group.length === 2 &&
		typeof group[0] === 'string' &&
		typeof group[1] === 'string' &&
		group[0].length > 0 &&
		group[1].length > 0
	) {
		return groupKey(group[0], group[1])
	}
	return null
}

function outranks(
	access: AccessDefinition,
	candidate: ValidAccessGrant,
	held: ValidAccessGrant,
): boolean {
	const a = access.roles.indexOf(candidate.role)
	const b = access.roles.indexOf(held.role)
	if (a !== b) return a > b
	// Same role: the one that ends first, so a grant never outlives the shortest one.
	if (candidate.expiresAt === null) return false
	return held.expiresAt === null || candidate.expiresAt < held.expiresAt
}
