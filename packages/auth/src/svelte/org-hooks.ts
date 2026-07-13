import { derived, get, readable, writable, type Readable } from 'svelte/store'
import type {
	ClientInvitation,
	ClientMembership,
	ClientOrganization,
} from '../client/org-client'
import {
	checkOrgPermission,
	createOrgMembersActions,
	loadOrgMembers,
} from '../bindings/create-org-session'
import { getOrgContext } from './org-context'

export interface UseOrgResult {
	subscribe: Readable<{
		org: ClientOrganization | null
		role: string | null
		orgId: string | null
		error: string | null
	}>['subscribe']
	get org(): ClientOrganization | null
	get role(): string | null
	get orgId(): string | null
	switchOrg: (orgId: string) => Promise<void>
	createOrg: (params: { name: string; slug?: string }) => Promise<ClientOrganization>
	leaveOrg: () => Promise<void>
	clearOrg: () => void
	listOrgs: () => Promise<ClientOrganization[]>
}

export interface UseOrgMembersResult {
	subscribe: Readable<{
		members: ClientMembership[]
		isLoading: boolean
		error: string | null
	}>['subscribe']
	refresh: () => Promise<void>
	invite: (email: string, role: string) => Promise<ClientInvitation>
	removeMember: (userId: string) => Promise<void>
	updateRole: (userId: string, role: string) => Promise<void>
}

function createOrgSnapshotStore(): Readable<{
	org: ClientOrganization | null
	role: string | null
	orgId: string | null
}> {
	const { session } = getOrgContext()

	return readable(session.getSnapshot(), (set) => {
		set(session.getSnapshot())
		return session.subscribe(() => {
			set(session.getSnapshot())
		})
	})
}

export function useOrg(): UseOrgResult {
	const { client, session } = getOrgContext()
	const snapshotStore = createOrgSnapshotStore()
	const error = writable<string | null>(null)

	const store = derived([snapshotStore, error], ([snapshot, errorValue]) => ({
		...snapshot,
		error: errorValue,
	}))

	const switchOrg = async (orgId: string): Promise<void> => {
		error.set(null)
		try {
			await client.switchOrg(orgId)
		} catch (err) {
			error.set(err instanceof Error ? err.message : String(err))
		}
	}

	const createOrg = async (params: {
		name: string
		slug?: string
	}): Promise<ClientOrganization> => {
		error.set(null)
		try {
			return await client.createOrg(params)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			error.set(message)
			throw err
		}
	}

	const leaveOrg = async (): Promise<void> => {
		const orgId = get(snapshotStore).orgId
		if (!orgId) return
		error.set(null)
		try {
			await client.leaveOrg(orgId)
		} catch (err) {
			error.set(err instanceof Error ? err.message : String(err))
		}
	}

	const clearOrg = (): void => {
		client.clearActiveOrg()
	}

	const listOrgs = async (): Promise<ClientOrganization[]> => {
		try {
			return await client.listOrgs()
		} catch (err) {
			error.set(err instanceof Error ? err.message : String(err))
			return []
		}
	}

	return {
		subscribe: store.subscribe,
		get org() {
			return get(snapshotStore).org
		},
		get role() {
			return get(snapshotStore).role
		},
		get orgId() {
			return get(snapshotStore).orgId
		},
		switchOrg,
		createOrg,
		leaveOrg,
		clearOrg,
		listOrgs,
	}
}

export function useOrgMembers(orgId: string): UseOrgMembersResult {
	const { client } = getOrgContext()
	const members = writable<ClientMembership[]>([])
	const isLoading = writable(true)
	const error = writable<string | null>(null)

	const refresh = async (targetOrgId: string): Promise<void> => {
		isLoading.set(true)
		error.set(null)
		try {
			members.set(await loadOrgMembers(client, targetOrgId))
		} catch (err) {
			error.set(err instanceof Error ? err.message : String(err))
		} finally {
			isLoading.set(false)
		}
	}

	$effect(() => {
		void refresh(orgId)
	})

	const actions = createOrgMembersActions(client, orgId, (message) => {
		error.set(message)
	})

	const invite = async (email: string, role: string): Promise<ClientInvitation> => {
		const result = await actions.invite(email, role)
		await refresh(orgId)
		return result
	}

	const removeMember = async (userId: string): Promise<void> => {
		await actions.removeMember(userId)
		await refresh(orgId)
	}

	const updateRole = async (userId: string, role: string): Promise<void> => {
		await actions.updateRole(userId, role)
		await refresh(orgId)
	}

	const store = derived([members, isLoading, error], ([memberList, loading, errorValue]) => ({
		members: memberList,
		isLoading: loading,
		error: errorValue,
	}))

	return {
		subscribe: store.subscribe,
		refresh: () => refresh(orgId),
		invite,
		removeMember,
		updateRole,
	}
}

export function createPermissionStore(requiredRole: string): Readable<boolean> {
	const { session } = getOrgContext()

	return readable(session.checkPermission(requiredRole), (set) => {
		set(session.checkPermission(requiredRole))
		return session.subscribe(() => {
			set(session.checkPermission(requiredRole))
		})
	})
}

/** Alias for {@link createPermissionStore}. */
export const usePermission = createPermissionStore

export { checkOrgPermission }
