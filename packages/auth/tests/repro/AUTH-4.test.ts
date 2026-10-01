/**
 * AUTH-4 repro (OrgRoutes):
 *  (a) listMyInvitations(email) takes a caller-supplied email (the shipped OrgClient
 *      sends GET /invitations?email=<any>) and returns the secret invitation tokens;
 *  (b) acceptInvitation() never checks that the accepting user owns the invited email;
 *  (c) revokeInvitation() authorizes against orgId but revokes any invitationId,
 *      including invitations of a different org.
 * Asserts CORRECT behavior, so it FAILS today.
 */
import { describe, expect, test } from 'vitest'
import { OrgRoutes } from '../../src/org/org-routes'
import { InMemoryOrgStore } from '../../src/org/org-store'

type Data<T> = { data: T }

async function setup() {
	const routes = new OrgRoutes({ orgStore: new InMemoryOrgStore() })
	const org = ((await routes.createOrg('owner-1', { name: 'Acme', slug: 'acme' })).body as Data<{ id: string }>).data
	const inv = (
		(await routes.createInvitation('owner-1', org.id, { email: 'bob@example.com', role: 'admin' })).body as Data<{
			id: string
			token: string
		}>
	).data
	return { routes, org, inv }
}

describe('AUTH-4: invitation authorization', () => {
	test('(a+b) a stranger cannot harvest and redeem an invitation addressed to someone else', async () => {
		const { routes, org, inv } = await setup()

		// Mallory asks for "her" invitations, passing Bob's email.
		const listed = await routes.listMyInvitations('bob@example.com')
		const leaked = ((listed.body as Data<Array<{ token?: string }>>).data ?? []).map((i) => i.token)
		expect.soft(leaked).not.toContain(inv.token)

		// Mallory redeems Bob's admin invitation with her own user id.
		const accepted = await routes.acceptInvitation('mallory-1', { token: inv.token })
		expect.soft(accepted.status).toBe(403)
		const members = (await routes.listMembers('owner-1', org.id)).body as Data<Array<{ userId: string }>>
		expect(members.data.map((m) => m.userId)).not.toContain('mallory-1')
	})

	test('(c) admin of org B cannot revoke an invitation that belongs to org A', async () => {
		const { routes, org, inv } = await setup()
		const orgB = ((await routes.createOrg('mallory-1', { name: 'Evil', slug: 'evil' })).body as Data<{ id: string }>)
			.data
		const res = await routes.revokeInvitation('mallory-1', orgB.id, inv.id)
		expect.soft(res.status).toBe(404)
		const pending = (await routes.listPendingInvitations('owner-1', org.id)).body as Data<Array<{ id: string }>>
		expect(pending.data.map((i) => i.id)).toContain(inv.id)
	})
})
