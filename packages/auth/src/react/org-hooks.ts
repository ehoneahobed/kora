import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react'
import {
	type OrgSession,
	type OrgSnapshot,
	checkOrgPermission,
	createOrgMembersActions,
	createOrgSession,
	loadOrgMembers,
} from '../bindings/create-org-session'
import type {
	ClientInvitation,
	ClientMembership,
	ClientOrganization,
	OrgClient,
} from '../client/org-client'

export interface OrgContextValue {
	client: OrgClient
	session: OrgSession
}

export const OrgContext = createContext<OrgContextValue | null>(null)

function useOrgContext(): OrgContextValue {
	const ctx = useContext(OrgContext)
	if (ctx === null) {
		throw new Error(
			'useOrg / useOrgMembers / usePermission must be used within an <OrgProvider>. ' +
				'Wrap your component tree with <OrgProvider client={orgClient}>.',
		)
	}
	return ctx
}

function useOrgSnapshot(session: OrgSession): OrgSnapshot {
	const snapshotRef = useRef(session.getSnapshot())

	const subscribe = useCallback(
		(onStoreChange: () => void): (() => void) => {
			return session.subscribe(() => {
				snapshotRef.current = session.getSnapshot()
				onStoreChange()
			})
		},
		[session],
	)

	const getSnapshot = useCallback(() => snapshotRef.current, [])

	return useSyncExternalStore(subscribe, getSnapshot)
}

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

export function useOrg(): UseOrgResult {
	const { client, session } = useOrgContext()
	const { orgId, org, role } = useOrgSnapshot(session)
	const [error, setError] = useState<string | null>(null)

	const switchOrg = useCallback(
		async (newOrgId: string): Promise<void> => {
			setError(null)
			try {
				await client.switchOrg(newOrgId)
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err))
			}
		},
		[client],
	)

	const createOrg = useCallback(
		async (params: { name: string; slug?: string }): Promise<ClientOrganization> => {
			setError(null)
			try {
				return await client.createOrg(params)
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				setError(msg)
				throw err
			}
		},
		[client],
	)

	const leaveOrg = useCallback(async (): Promise<void> => {
		if (!orgId) return
		setError(null)
		try {
			await client.leaveOrg(orgId)
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		}
	}, [client, orgId])

	const clearOrg = useCallback((): void => {
		client.clearActiveOrg()
	}, [client])

	const listOrgs = useCallback(async (): Promise<ClientOrganization[]> => {
		try {
			return await client.listOrgs()
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
			return []
		}
	}, [client])

	return { org, role, orgId, switchOrg, createOrg, leaveOrg, clearOrg, listOrgs, error }
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

export function useOrgMembers(orgId: string): UseOrgMembersResult {
	const { client } = useOrgContext()
	const [members, setMembers] = useState<ClientMembership[]>([])
	const [isLoading, setIsLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)

	const refresh = useCallback(async () => {
		setIsLoading(true)
		setError(null)
		try {
			setMembers(await loadOrgMembers(client, orgId))
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setIsLoading(false)
		}
	}, [client, orgId])

	useEffect(() => {
		void refresh()
	}, [refresh])

	const actions = createOrgMembersActions(client, orgId, setError)

	const invite = useCallback(
		async (email: string, role: string): Promise<ClientInvitation> => {
			const result = await actions.invite(email, role)
			await refresh()
			return result
		},
		[actions, refresh],
	)

	const removeMember = useCallback(
		async (userId: string): Promise<void> => {
			await actions.removeMember(userId)
			await refresh()
		},
		[actions, refresh],
	)

	const updateRole = useCallback(
		async (userId: string, role: string): Promise<void> => {
			await actions.updateRole(userId, role)
			await refresh()
		},
		[actions, refresh],
	)

	return { members, isLoading, refresh, invite, removeMember, updateRole, error }
}

export function usePermission(requiredRole: string): boolean {
	const { session } = useOrgContext()
	const snapshotRef = useRef(session.checkPermission(requiredRole))

	const subscribe = useCallback(
		(onStoreChange: () => void): (() => void) => {
			return session.subscribe(() => {
				const next = session.checkPermission(requiredRole)
				if (next !== snapshotRef.current) {
					snapshotRef.current = next
					onStoreChange()
				}
			})
		},
		[session, requiredRole],
	)

	const getSnapshot = useCallback(() => snapshotRef.current, [])

	return useSyncExternalStore(subscribe, getSnapshot)
}

export { checkOrgPermission }
