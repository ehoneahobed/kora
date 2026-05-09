import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react'
import type {
	ClientInvitation,
	ClientMembership,
	ClientOrganization,
	OrgClient,
} from '../client/org-client'

// ============================================================================
// OrgContext
// ============================================================================

/**
 * Shape of the OrgContext value.
 */
export interface OrgContextValue {
	/** The OrgClient instance */
	client: OrgClient
}

/**
 * React context for organization state.
 */
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

// ============================================================================
// useOrg
// ============================================================================

/**
 * Return value of the {@link useOrg} hook.
 */
export interface UseOrgResult {
	/** Currently active organization, or null */
	org: ClientOrganization | null
	/** Current user's role in the active organization, or null */
	role: string | null
	/** Active organization ID, or null */
	orgId: string | null
	/** Switch to a different organization */
	switchOrg: (orgId: string) => Promise<void>
	/** Create a new organization */
	createOrg: (params: { name: string; slug?: string }) => Promise<ClientOrganization>
	/** Leave the active organization */
	leaveOrg: () => Promise<void>
	/** Clear the active organization */
	clearOrg: () => void
	/** List all organizations the user belongs to */
	listOrgs: () => Promise<ClientOrganization[]>
	/** Last error, or null */
	error: string | null
}

/**
 * React hook for organization management and context switching.
 *
 * Re-renders when the active organization changes.
 *
 * @example
 * ```typescript
 * function OrgSwitcher() {
 *   const { org, switchOrg, listOrgs, error } = useOrg()
 *   const [orgs, setOrgs] = useState<ClientOrganization[]>([])
 *
 *   useEffect(() => { listOrgs().then(setOrgs) }, [listOrgs])
 *
 *   return (
 *     <select value={org?.id ?? ''} onChange={(e) => switchOrg(e.target.value)}>
 *       <option value="">Select org...</option>
 *       {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
 *     </select>
 *   )
 * }
 * ```
 */
export function useOrg(): UseOrgResult {
	const { client } = useOrgContext()
	const [error, setError] = useState<string | null>(null)

	// Track active org reactively
	const orgSnapshotRef = useRef({
		orgId: client.activeOrgId,
		org: client.activeOrg,
		role: client.activeRole,
	})

	const subscribe = useCallback(
		(onStoreChange: () => void): (() => void) => {
			return client.onOrgChange(() => {
				orgSnapshotRef.current = {
					orgId: client.activeOrgId,
					org: client.activeOrg,
					role: client.activeRole,
				}
				onStoreChange()
			})
		},
		[client],
	)

	const getSnapshot = useCallback(() => orgSnapshotRef.current, [])

	const { orgId, org, role } = useSyncExternalStore(subscribe, getSnapshot)

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

// ============================================================================
// useOrgMembers
// ============================================================================

/**
 * Return value of the {@link useOrgMembers} hook.
 */
export interface UseOrgMembersResult {
	/** Members of the organization (empty until loaded) */
	members: ClientMembership[]
	/** Whether members are being loaded */
	isLoading: boolean
	/** Reload the members list */
	refresh: () => Promise<void>
	/** Invite a user by email */
	invite: (email: string, role: string) => Promise<ClientInvitation>
	/** Remove a member */
	removeMember: (userId: string) => Promise<void>
	/** Update a member's role */
	updateRole: (userId: string, role: string) => Promise<void>
	/** Last error, or null */
	error: string | null
}

/**
 * React hook for managing organization members.
 *
 * Automatically loads members when the orgId changes.
 *
 * @param orgId - Organization ID to manage members for
 */
export function useOrgMembers(orgId: string): UseOrgMembersResult {
	const { client } = useOrgContext()
	const [members, setMembers] = useState<ClientMembership[]>([])
	const [isLoading, setIsLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)

	const refresh = useCallback(async () => {
		setIsLoading(true)
		setError(null)
		try {
			const result = await client.listMembers(orgId)
			setMembers(result)
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setIsLoading(false)
		}
	}, [client, orgId])

	useEffect(() => {
		refresh()
	}, [refresh])

	const invite = useCallback(
		async (email: string, role: string): Promise<ClientInvitation> => {
			setError(null)
			try {
				const result = await client.inviteMember(orgId, { email, role })
				return result
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				setError(msg)
				throw err
			}
		},
		[client, orgId],
	)

	const removeMember = useCallback(
		async (userId: string): Promise<void> => {
			setError(null)
			try {
				await client.removeMember(orgId, userId)
				await refresh()
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err))
			}
		},
		[client, orgId, refresh],
	)

	const updateRole = useCallback(
		async (userId: string, role: string): Promise<void> => {
			setError(null)
			try {
				await client.updateMemberRole(orgId, userId, role)
				await refresh()
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err))
			}
		},
		[client, orgId, refresh],
	)

	return { members, isLoading, refresh, invite, removeMember, updateRole, error }
}

// ============================================================================
// usePermission
// ============================================================================

/**
 * React hook that checks if the current user has a specific role level
 * in the active organization.
 *
 * @param requiredRole - Minimum role required (uses ROLE_HIERARCHY from org-types)
 * @returns true if the user's role is at least requiredRole
 *
 * @example
 * ```typescript
 * function AdminPanel() {
 *   const canManage = usePermission('admin')
 *   if (!canManage) return <p>Access denied</p>
 *   return <AdminSettings />
 * }
 * ```
 */
export function usePermission(requiredRole: string): boolean {
	const { client } = useOrgContext()

	const snapshotRef = useRef(checkPermission(client.activeRole, requiredRole))

	const subscribe = useCallback(
		(onStoreChange: () => void): (() => void) => {
			return client.onOrgChange(() => {
				const newValue = checkPermission(client.activeRole, requiredRole)
				if (newValue !== snapshotRef.current) {
					snapshotRef.current = newValue
					onStoreChange()
				}
			})
		},
		[client, requiredRole],
	)

	const getSnapshot = useCallback(() => snapshotRef.current, [])

	return useSyncExternalStore(subscribe, getSnapshot)
}

// Simple role hierarchy check (mirrors ROLE_HIERARCHY from org-types)
const ROLE_LEVELS: Record<string, number> = {
	viewer: 10,
	billing: 15,
	member: 20,
	admin: 30,
	owner: 40,
}

function checkPermission(currentRole: string | null, requiredRole: string): boolean {
	if (!currentRole) return false
	const currentLevel = ROLE_LEVELS[currentRole] ?? 0
	const requiredLevel = ROLE_LEVELS[requiredRole] ?? 0
	return currentLevel >= requiredLevel
}
