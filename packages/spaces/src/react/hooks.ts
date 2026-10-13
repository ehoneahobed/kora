import { groupKey } from '@korajs/core/internal'
import { useApp, useQuery } from '@korajs/react'
import { useMemo } from 'react'
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
} {
	const app = useApp()
	const store = app.getStore()
	const access = store.getSchema().access
	const group = space ? access?.groups[space[0]] : undefined
	return {
		store,
		roles: access?.roles ?? [],
		ownerField: group?.owner ?? null,
		ownerRole: group?.role ?? null,
	}
}

function isLive(row: Row, now: number): boolean {
	return typeof row.expiresAt !== 'number' || row.expiresAt > now
}

/** The group record of `space` (empty when it is not readable on this device). */
function useSpaceRecord(space: SpaceRef | null): readonly Row[] {
	const { store } = useSpaceAccess(space)
	const collection = space?.[0] ?? SPACE_MEMBERS
	return useQuery(store.collection(collection).where({ id: space?.[1] ?? '' }), {
		enabled: space !== null,
	}) as readonly Row[]
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
	const { roles, ownerField, ownerRole } = useSpaceAccess(space)
	const records = useSpaceRecord(space)
	const rows = useMemberRows(space)
	const profile = options?.profile
	const key = space ? groupKey(space[0], space[1]) : null
	const spaceId = space?.[1] ?? null
	return useMemo(() => {
		const now = Date.now()
		const rank = (role: string): number => roles.indexOf(role)
		const record = records.find((row) => row.id === spaceId)
		const ownerValue = ownerField ? record?.[ownerField] : undefined
		const ownerId = typeof ownerValue === 'string' && ownerValue.length > 0 ? ownerValue : null
		const best = new Map<string, Row>()
		for (const row of rows) {
			if (row.group !== key || !isLive(row, now)) continue
			if (typeof row.userId !== 'string' || row.userId === ownerId) continue
			const current = best.get(row.userId)
			if (!current || rank(String(row.role)) > rank(String(current.role))) best.set(row.userId, row)
		}
		const members = [...best.values()]
			.map((row) => ({
				userId: String(row.userId),
				role: String(row.role),
				isOwner: false,
				invitedBy: typeof row.invitedBy === 'string' ? row.invitedBy : null,
			}))
			.sort((a, b) => rank(b.role) - rank(a.role) || a.userId.localeCompare(b.userId))
		const all =
			ownerId && ownerRole
				? [{ userId: ownerId, role: ownerRole, isOwner: true, invitedBy: null }, ...members]
				: members
		return all.map((member) => ({ ...member, profile: profile?.(member.userId) as Profile }))
	}, [key, spaceId, records, rows, roles, ownerField, ownerRole, profile])
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
	return useMemo(() => {
		const now = Date.now()
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
	}, [key, rows])
}

/**
 * The role `userId` holds in a space, from this device's data, or null. For showing and
 * hiding controls only: the server decides every action.
 *
 * @param space - `[collection, id]` of the space, or null
 * @param userId - The signed-in user's id, or null
 */
export function useMyRole(space: SpaceRef | null, userId: string | null): string | null {
	const { roles, ownerField, ownerRole } = useSpaceAccess(space)
	const records = useSpaceRecord(space)
	const rows = useMemberRows(space)
	const key = space ? groupKey(space[0], space[1]) : null
	const spaceId = space?.[1] ?? null
	return useMemo(() => {
		if (!userId || !key) return null
		const record = records.find((row) => row.id === spaceId)
		if (ownerField && ownerRole && record?.[ownerField] === userId) return ownerRole
		const now = Date.now()
		let role: string | null = null
		for (const row of rows) {
			if (row.group !== key || row.userId !== userId || !isLive(row, now)) continue
			const candidate = String(row.role)
			if (role === null || roles.indexOf(candidate) > roles.indexOf(role)) role = candidate
		}
		return role
	}, [userId, key, spaceId, records, rows, roles, ownerField, ownerRole])
}
