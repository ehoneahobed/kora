import { groupKey } from '@korajs/core/internal'
import { useApp, useQuery } from '@korajs/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SpaceRef } from '../protocol'
import { SPACE_INVITATIONS, SPACE_MEMBERS } from '../schema/spaces-collections'

/** A member of a space, as {@link useMembers} lists it. */
export interface SpaceMember<Profile = undefined> {
	userId: string
	role: string
	/** True for the owner (the group record's owner field). */
	isOwner: boolean
	/** Who invited them (absent for the owner and for members added by the server). */
	invitedBy: string | null
	/** When they accepted their invitation (null for the owner and members added by the server). */
	joinedAt: number | null
	/** `options.profile(userId)`, when given. */
	profile: Profile
}

/** A pending invitation, as {@link useInvitations} lists it. */
export interface SpaceInvitation {
	id: string
	email: string
	role: string
	invitedBy: string
	createdAt: number
	expiresAt: number
	/** Expired invitations stay listed until revoked or re-sent. */
	expired: boolean
}

type Row = Record<string, unknown>

/** The access configuration of the app's schema, which `spacesCollections` produced. */
function useSpaceAccess(space: SpaceRef | null): {
	store: ReturnType<ReturnType<typeof useApp>['getStore']>
	roles: readonly string[]
	ownerField: string | null
	ownerRole: string | null
	/** The manager role, which a membership row holding the owner role counts as. */
	manageRole: string | null
} {
	const app = useApp()
	const store = app.getStore()
	const access = store.getSchema().access
	const group = space ? access?.groups[space[0]] : undefined
	const ownerRole = group?.role ?? null
	// spacesCollections writes the invitations read rule as memberOfKey('group', manageRole).
	const invitationsRead = access?.collections[SPACE_INVITATIONS]?.read
	const manageRole =
		invitationsRead?.kind === 'memberOfKey' && typeof invitationsRead.minRole === 'string'
			? invitationsRead.minRole
			: null
	return {
		store,
		roles: access?.roles ?? [],
		ownerField: group?.owner ?? null,
		ownerRole,
		manageRole,
	}
}

/** A membership row's role as the server's routes judge it: only the owner field makes an owner. */
function memberRole(role: string, ownerRole: string | null, manageRole: string | null): string {
	return role === ownerRole && manageRole !== null ? manageRole : role
}

/**
 * Live as the access engine judges it: no expiry, or a finite time still ahead. Any other
 * value (a string, `Infinity`) grants nothing on the server, so it shows nothing here.
 */
function isLive(row: Row, now: number): boolean {
	const at = row.expiresAt
	if (at === null || at === undefined) return true
	return typeof at === 'number' && Number.isFinite(at) && at > now
}

/** Longest timer browsers run (about 24.8 days); later expiries re-arm when it fires. */
const MAX_TIMER_MS = 2_147_483_647

/**
 * The time the hook judges expiry at. It advances when the earliest future `expiresAt`
 * among `rows` passes, so a hook re-evaluates at that moment even when no row changes.
 * Timers longer than the browser maximum fire early and re-arm (`now` changes).
 */
function useExpiryClock(rows: readonly Row[]): number {
	const [now, setNow] = useState(() => Date.now())
	let next: number | null = null
	for (const row of rows) {
		const at = row.expiresAt
		if (typeof at === 'number' && at > now && (next === null || at < next)) next = at
	}
	useEffect(() => {
		if (next === null) return
		const timer = setTimeout(
			() => setNow(Date.now()),
			// `now` is when the clock last advanced; a timer that fired early (beyond the
			// browser maximum) advanced it, which re-arms this one.
			Math.max(0, Math.min(next - Math.max(now, Date.now()) + 1, MAX_TIMER_MS)),
		)
		return () => clearTimeout(timer)
	}, [next, now])
	return now
}

const NO_ROWS: readonly Row[] = []

/**
 * The group record of `space` (empty when it is not readable on this device). While a
 * switch to another collection loads, `useQuery` still returns the previous query's rows;
 * they are not this space's (an id can repeat across collections), so none are returned.
 */
function useSpaceRecord(space: SpaceRef | null): readonly Row[] {
	const { store } = useSpaceAccess(space)
	const collection = space?.[0] ?? SPACE_MEMBERS
	const records = useQuery(store.collection(collection).where({ id: space?.[1] ?? '' }), {
		enabled: space !== null,
	}) as readonly Row[]
	const source = useRef<{ records: readonly Row[]; collection: string } | null>(null)
	if (source.current === null) source.current = { records, collection }
	else if (source.current.records !== records) source.current = { records, collection }
	return source.current.collection === collection ? records : NO_ROWS
}

/** The membership rows of `space` on this device. */
function useMemberRows(space: SpaceRef | null): readonly Row[] {
	const { store } = useSpaceAccess(space)
	return useQuery(
		store.collection(SPACE_MEMBERS).where({ group: space ? groupKey(space[0], space[1]) : '' }),
		{
			enabled: space !== null,
		},
	) as readonly Row[]
}

/**
 * The members of a space: the owner first, then members from the highest role down.
 * Local and reactive: it works offline and updates as memberships sync. Users are ids;
 * render them with your own profiles (`profile` joins them here).
 *
 * @param space - `[collection, id]` of the space, or null (no query)
 * @param options - `profile(userId)` to attach your own profile data to each member. Pass a
 *   stable function (`useCallback`): a new one each render rebuilds the list each render.
 *
 * @example
 * ```tsx
 * const members = useMembers(['forms', formId], { profile: (id) => profiles.get(id) })
 * ```
 */
export function useMembers<Profile = undefined>(
	space: SpaceRef | null,
	options?: { profile?: (userId: string) => Profile },
): readonly SpaceMember<Profile>[] {
	const { roles, ownerField, ownerRole, manageRole } = useSpaceAccess(space)
	const records = useSpaceRecord(space)
	const rows = useMemberRows(space)
	const profile = options?.profile
	const key = space ? groupKey(space[0], space[1]) : null
	const spaceId = space?.[1] ?? null
	const now = useExpiryClock(rows)
	return useMemo(() => {
		const rank = (role: string): number => roles.indexOf(role)
		const record = records.find((row) => row.id === spaceId)
		const ownerValue = ownerField ? record?.[ownerField] : undefined
		const ownerId = typeof ownerValue === 'string' && ownerValue.length > 0 ? ownerValue : null
		const best = new Map<string, Row>()
		for (const row of rows) {
			if (row.group !== key || !isLive(row, now)) continue
			if (typeof row.userId !== 'string' || row.userId === ownerId) continue
			// A role the schema no longer has grants nothing (the access engine ignores it).
			if (rank(String(row.role)) === -1) continue
			const current = best.get(row.userId)
			// Compare as the server does: an owner-role row counts as the manager role first.
			const shown = (r: Row): number => rank(memberRole(String(r.role), ownerRole, manageRole))
			if (!current || shown(row) > shown(current)) best.set(row.userId, row)
		}
		const members = [...best.values()]
			.map((row) => ({
				userId: String(row.userId),
				role: memberRole(String(row.role), ownerRole, manageRole),
				isOwner: false,
				invitedBy: typeof row.invitedBy === 'string' ? row.invitedBy : null,
				joinedAt: typeof row.joinedAt === 'number' ? row.joinedAt : null,
			}))
			.sort((a, b) => rank(b.role) - rank(a.role) || a.userId.localeCompare(b.userId))
		const all =
			ownerId && ownerRole
				? [
						{ userId: ownerId, role: ownerRole, isOwner: true, invitedBy: null, joinedAt: null },
						...members,
					]
				: members
		return all.map((member) => ({ ...member, profile: profile?.(member.userId) as Profile }))
	}, [key, spaceId, records, rows, roles, ownerField, ownerRole, manageRole, profile, now])
}

/**
 * The pending invitations of a space, newest first (expired ones flagged). Only the
 * space's managers receive invitations, so for anyone else this is empty.
 *
 * @param space - `[collection, id]` of the space, or null
 */
export function useInvitations(space: SpaceRef | null): readonly SpaceInvitation[] {
	const { store } = useSpaceAccess(space)
	const rows = useQuery(
		store.collection(SPACE_INVITATIONS).where({ group: space ? groupKey(space[0], space[1]) : '' }),
		{ enabled: space !== null },
	) as readonly Row[]
	const key = space ? groupKey(space[0], space[1]) : null
	const now = useExpiryClock(rows)
	return useMemo(() => {
		return rows
			.filter((row) => row.group === key)
			.map((row) => ({
				id: String(row.id),
				email: String(row.email),
				role: String(row.role),
				invitedBy: String(row.invitedBy),
				createdAt: Number(row.createdAt),
				expiresAt: Number(row.expiresAt),
				expired: Number(row.expiresAt) <= now,
			}))
			.sort((a, b) => b.createdAt - a.createdAt)
	}, [key, rows, now])
}

/**
 * The role `userId` holds in a space, from this device's data, or null. For showing and
 * hiding controls only: the server decides every action.
 *
 * @param space - `[collection, id]` of the space, or null
 * @param userId - The signed-in user's id, or null
 */
export function useMyRole(space: SpaceRef | null, userId: string | null): string | null {
	const { roles, ownerField, ownerRole, manageRole } = useSpaceAccess(space)
	const records = useSpaceRecord(space)
	const rows = useMemberRows(space)
	const key = space ? groupKey(space[0], space[1]) : null
	const spaceId = space?.[1] ?? null
	const now = useExpiryClock(rows)
	return useMemo(() => {
		if (!userId || !key) return null
		const record = records.find((row) => row.id === spaceId)
		if (ownerField && ownerRole && record?.[ownerField] === userId) return ownerRole
		let role: string | null = null
		for (const row of rows) {
			if (row.group !== key || row.userId !== userId || !isLive(row, now)) continue
			if (roles.indexOf(String(row.role)) === -1) continue
			const candidate = memberRole(String(row.role), ownerRole, manageRole)
			if (role === null || roles.indexOf(candidate) > roles.indexOf(role)) role = candidate
		}
		return role
	}, [userId, key, spaceId, records, rows, roles, ownerField, ownerRole, manageRole, now])
}
