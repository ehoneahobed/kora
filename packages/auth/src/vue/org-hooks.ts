import { onScopeDispose, reactive, readonly, ref, watch } from 'vue'
import type {
	ClientInvitation,
	ClientMembership,
	ClientOrganization,
} from '../client/org-client'
import {
	createOrgMembersActions,
	loadOrgMembers,
	type OrgSnapshot,
} from '../bindings/create-org-session'
import { useOrgContext } from './org-provider'

export interface UseOrgResult {
	org: ClientOrganization | null
	role: string | null
	orgId: string | null
	switchOrg: (orgId: string) => Promise<void>
	createOrg: (params: { name: string; slug?: string }) => Promise<ClientOrganization>
	leaveOrg: () => Promise<void>
	clearOrg: () => void
	listOrgs: () => Promise<ClientOrganization[]>
	error: string | null
}

export interface UseOrgMembersResult {
	members: ClientMembership[]
	isLoading: boolean
	refresh: () => Promise<void>
	invite: (email: string, role: string) => Promise<ClientInvitation>
	removeMember: (userId: string) => Promise<void>
	updateRole: (userId: string, role: string) => Promise<void>
	error: string | null
}

function useOrgSnapshot(session: ReturnType<typeof useOrgContext>['session']): OrgSnapshot {
	const state = reactive({ ...session.getSnapshot() })

	const sync = (): void => {
		Object.assign(state, session.getSnapshot())
	}

	const unsubscribe = session.subscribe(sync)
	sync()

	onScopeDispose(unsubscribe)

	return state
}

export function useOrg(): UseOrgResult {
	const { client, session } = useOrgContext()
	const snapshot = useOrgSnapshot(session)
	const error = ref<string | null>(null)

	const switchOrg = async (orgId: string): Promise<void> => {
		error.value = null
		try {
			await client.switchOrg(orgId)
		} catch (err) {
			error.value = err instanceof Error ? err.message : String(err)
		}
	}

	const createOrg = async (params: {
		name: string
		slug?: string
	}): Promise<ClientOrganization> => {
		error.value = null
		try {
			return await client.createOrg(params)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			error.value = message
			throw err
		}
	}

	const leaveOrg = async (): Promise<void> => {
		if (!snapshot.orgId) return
		error.value = null
		try {
			await client.leaveOrg(snapshot.orgId)
		} catch (err) {
			error.value = err instanceof Error ? err.message : String(err)
		}
	}

	const clearOrg = (): void => {
		client.clearActiveOrg()
	}

	const listOrgs = async (): Promise<ClientOrganization[]> => {
		try {
			return await client.listOrgs()
		} catch (err) {
			error.value = err instanceof Error ? err.message : String(err)
			return []
		}
	}

	return {
		get org() {
			return snapshot.org
		},
		get role() {
			return snapshot.role
		},
		get orgId() {
			return snapshot.orgId
		},
		switchOrg,
		createOrg,
		leaveOrg,
		clearOrg,
		listOrgs,
		get error() {
			return error.value
		},
	}
}

export function useOrgMembers(orgId: string): UseOrgMembersResult {
	const { client } = useOrgContext()
	const members = ref<ClientMembership[]>([])
	const isLoading = ref(true)
	const error = ref<string | null>(null)

	const refresh = async (): Promise<void> => {
		isLoading.value = true
		error.value = null
		try {
			members.value = await loadOrgMembers(client, orgId)
		} catch (err) {
			error.value = err instanceof Error ? err.message : String(err)
		} finally {
			isLoading.value = false
		}
	}

	watch(
		() => orgId,
		() => {
			void refresh()
		},
		{ immediate: true },
	)

	const actions = createOrgMembersActions(client, orgId, (message) => {
		error.value = message
	})

	const invite = async (email: string, role: string): Promise<ClientInvitation> => {
		const result = await actions.invite(email, role)
		await refresh()
		return result
	}

	const removeMember = async (userId: string): Promise<void> => {
		await actions.removeMember(userId)
		await refresh()
	}

	const updateRole = async (userId: string, role: string): Promise<void> => {
		await actions.updateRole(userId, role)
		await refresh()
	}

	return {
		get members() {
			return members.value
		},
		get isLoading() {
			return isLoading.value
		},
		refresh,
		invite,
		removeMember,
		updateRole,
		get error() {
			return error.value
		},
	}
}

export function usePermission(requiredRole: string): Readonly<{ value: boolean }> {
	const { session } = useOrgContext()
	const allowed = ref(session.checkPermission(requiredRole))

	const unsubscribe = session.subscribe(() => {
		allowed.value = session.checkPermission(requiredRole)
	})

	onScopeDispose(unsubscribe)

	return readonly(allowed)
}
