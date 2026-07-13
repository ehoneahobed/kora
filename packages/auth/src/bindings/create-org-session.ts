import type {
	ClientInvitation,
	ClientMembership,
	ClientOrganization,
	OrgClient,
} from '../client/org-client'

export interface OrgSnapshot {
	orgId: string | null
	org: ClientOrganization | null
	role: string | null
}

export interface OrgSession {
	readonly client: OrgClient
	getSnapshot(): OrgSnapshot
	subscribe(listener: () => void): () => void
	checkPermission(requiredRole: string): boolean
	destroy(): void
}

const ROLE_LEVELS: Record<string, number> = {
	viewer: 10,
	billing: 15,
	member: 20,
	admin: 30,
	owner: 40,
}

export function checkOrgPermission(currentRole: string | null, requiredRole: string): boolean {
	if (!currentRole) return false
	const currentLevel = ROLE_LEVELS[currentRole] ?? 0
	const requiredLevel = ROLE_LEVELS[requiredRole] ?? 0
	return currentLevel >= requiredLevel
}

/**
 * Framework-agnostic org session with reactive snapshot subscription.
 */
export function createOrgSession(client: OrgClient): OrgSession {
	let snapshot = buildSnapshot(client)
	const listeners = new Set<() => void>()

	const notify = (): void => {
		snapshot = buildSnapshot(client)
		for (const listener of listeners) {
			listener()
		}
	}

	const unsubscribeOrgChange = client.onOrgChange(notify)

	return {
		client,
		getSnapshot: () => snapshot,
		subscribe(listener: () => void): () => void {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		checkPermission(requiredRole: string): boolean {
			return checkOrgPermission(snapshot.role, requiredRole)
		},
		destroy(): void {
			unsubscribeOrgChange()
			listeners.clear()
		},
	}
}

function buildSnapshot(client: OrgClient): OrgSnapshot {
	return {
		orgId: client.activeOrgId,
		org: client.activeOrg,
		role: client.activeRole,
	}
}

export interface UseOrgMembersActions {
	refresh: () => Promise<void>
	invite: (email: string, role: string) => Promise<ClientInvitation>
	removeMember: (userId: string) => Promise<void>
	updateRole: (userId: string, role: string) => Promise<void>
}

/**
 * Shared org member management actions (loading state remains framework-specific).
 */
export function createOrgMembersActions(
	client: OrgClient,
	orgId: string,
	onError: (message: string) => void,
): UseOrgMembersActions {
	return {
		async refresh(): Promise<void> {
			await client.listMembers(orgId)
		},
		async invite(email: string, role: string): Promise<ClientInvitation> {
			try {
				return await client.inviteMember(orgId, { email, role })
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				onError(message)
				throw error
			}
		},
		async removeMember(userId: string): Promise<void> {
			try {
				await client.removeMember(orgId, userId)
			} catch (error) {
				onError(error instanceof Error ? error.message : String(error))
			}
		},
		async updateRole(userId: string, role: string): Promise<void> {
			try {
				await client.updateMemberRole(orgId, userId, role)
			} catch (error) {
				onError(error instanceof Error ? error.message : String(error))
			}
		},
	}
}

export async function loadOrgMembers(
	client: OrgClient,
	orgId: string,
): Promise<ClientMembership[]> {
	return client.listMembers(orgId)
}
