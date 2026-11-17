import type { OrgRouteResponse, OrgRoutes } from './org-routes'

/** An HTTP request reduced to what the org routes need. */
export interface OrgHttpRequest {
	method: string
	/** The path below the mount point, e.g. `/orgs/abc/members`. */
	path: string
	/** The signed-in user (resolved by the app's auth middleware). */
	userId: string
	body?: unknown
}

/**
 * The routes the authentication guide's Express example wires (for comparison with OrgClient).
 */
export async function routeOrgRequest(
	routes: OrgRoutes,
	request: OrgHttpRequest,
): Promise<OrgRouteResponse<unknown> | null> {
	const parts = request.path.split('/').filter(Boolean).map(decodeURIComponent)
	const body = (request.body ?? {}) as Record<string, unknown>
	const { method, userId } = request
	const [root, orgId, sub, id] = parts
	if (root !== 'orgs') return null
	if (method === 'POST' && parts.length === 1) return routes.createOrg(userId, body)
	if (method === 'POST' && orgId === 'invitations' && sub === 'accept') {
		return routes.acceptInvitation(userId, { token: body.token })
	}
	if (!orgId) return null
	if (sub === 'members' && method === 'GET' && !id) return routes.listMembers(userId, orgId)
	if (sub === 'members' && method === 'POST' && !id) {
		return routes.addMember(userId, orgId, { targetUserId: body.userId, role: body.role })
	}
	if (sub === 'members' && method === 'PATCH' && id === 'role') {
		return routes.updateMemberRole(userId, orgId, { targetUserId: body.userId, role: body.role })
	}
	if (sub === 'members' && method === 'DELETE' && id) return routes.removeMember(userId, orgId, id)
	if (sub === 'transfer' && method === 'POST') {
		return routes.transferOwnership(userId, orgId, { newOwnerId: body.newOwnerId })
	}
	if (sub === 'invitations' && method === 'POST' && !id) {
		return routes.createInvitation(userId, orgId, { email: body.email, role: body.role })
	}
	if (sub === 'invitations' && method === 'GET' && !id) {
		return routes.listPendingInvitations(userId, orgId)
	}
	if (sub === 'invitations' && method === 'DELETE' && id) {
		return routes.revokeInvitation(userId, orgId, id)
	}
	return null
}
