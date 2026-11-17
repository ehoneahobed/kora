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
 * Dispatch an HTTP request to the {@link OrgRoutes} handler that answers it: the routes
 * {@link OrgClient} calls, so a server that mounts this serves every client method.
 * Path segments are URL-decoded. Returns null for a path that is not an org route.
 *
 * | Method and path | Handler |
 * | --- | --- |
 * | `POST /orgs`, `GET /orgs` | createOrg, listUserOrgs |
 * | `GET`, `PATCH`, `DELETE /orgs/:orgId` | getOrg, updateOrg, deleteOrg |
 * | `GET /orgs/:orgId/membership` | getMyMembership |
 * | `POST /orgs/:orgId/leave` | leaveOrg |
 * | `GET`, `POST /orgs/:orgId/members` | listMembers, addMember (`{ userId, role }`) |
 * | `DELETE /orgs/:orgId/members/:userId` | removeMember |
 * | `PATCH /orgs/:orgId/members/:userId/role` | updateMemberRole (`{ role }`) |
 * | `POST /orgs/:orgId/transfer` | transferOwnership (`{ newOwnerId }`) |
 * | `GET`, `POST /orgs/:orgId/invitations` | listPendingInvitations, createInvitation |
 * | `DELETE /orgs/:orgId/invitations/:invitationId` | revokeInvitation |
 * | `GET /invitations`, `POST /invitations/accept` | listMyInvitations, acceptInvitation |
 *
 * @example
 * ```typescript
 * app.all(['/auth/orgs*', '/auth/invitations*'], async (req, res) => {
 *   const result = await routeOrgRequest(orgRoutes, {
 *     method: req.method,
 *     path: req.path.slice('/auth'.length),
 *     userId: req.userId,
 *     body: req.body,
 *   })
 *   if (!result) return res.status(404).json({ error: 'Not found.' })
 *   res.status(result.status).json(result.body)
 * })
 * ```
 */
export async function routeOrgRequest(
	routes: OrgRoutes,
	request: OrgHttpRequest,
): Promise<OrgRouteResponse<unknown> | null> {
	let parts: string[]
	try {
		parts = request.path.split('/').filter(Boolean).map(decodeURIComponent)
	} catch {
		return null
	}
	const body = (request.body && typeof request.body === 'object' ? request.body : {}) as Record<
		string,
		unknown
	>
	const { userId } = request
	const method = request.method.toUpperCase()
	const [root, orgId, sub, id, leaf] = parts

	if (root === 'invitations') {
		if (parts.length === 1 && method === 'GET') return routes.listMyInvitations(userId)
		if (parts.length === 2 && orgId === 'accept' && method === 'POST') {
			return routes.acceptInvitation(userId, { token: body.token })
		}
		return null
	}
	if (root !== 'orgs') return null
	if (parts.length === 1) {
		if (method === 'POST') return routes.createOrg(userId, body)
		if (method === 'GET') return routes.listUserOrgs(userId)
		return null
	}
	if (!orgId) return null
	if (parts.length === 2) {
		if (method === 'GET') return routes.getOrg(userId, orgId)
		if (method === 'PATCH') return routes.updateOrg(userId, orgId, body)
		if (method === 'DELETE') return routes.deleteOrg(userId, orgId)
		return null
	}
	if (parts.length === 3) {
		if (sub === 'membership' && method === 'GET') return routes.getMyMembership(userId, orgId)
		if (sub === 'leave' && method === 'POST') return routes.leaveOrg(userId, orgId)
		if (sub === 'transfer' && method === 'POST') {
			return routes.transferOwnership(userId, orgId, { newOwnerId: body.newOwnerId })
		}
		if (sub === 'members' && method === 'GET') return routes.listMembers(userId, orgId)
		if (sub === 'members' && method === 'POST') {
			return routes.addMember(userId, orgId, { targetUserId: body.userId, role: body.role })
		}
		if (sub === 'invitations' && method === 'GET')
			return routes.listPendingInvitations(userId, orgId)
		if (sub === 'invitations' && method === 'POST') {
			return routes.createInvitation(userId, orgId, { email: body.email, role: body.role })
		}
		return null
	}
	if (!id) return null
	if (parts.length === 4) {
		if (sub === 'members' && method === 'DELETE') return routes.removeMember(userId, orgId, id)
		if (sub === 'invitations' && method === 'DELETE')
			return routes.revokeInvitation(userId, orgId, id)
		return null
	}
	if (parts.length === 5 && sub === 'members' && leaf === 'role' && method === 'PATCH') {
		return routes.updateMemberRole(userId, orgId, { targetUserId: id, role: body.role })
	}
	return null
}
