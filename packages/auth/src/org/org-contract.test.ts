import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { OrgClient } from '../client/org-client'
import { routeOrgRequest } from './org-http'
import { OrgRoutes } from './org-routes'
import { InMemoryOrgStore } from './org-store'

/**
 * The contract between OrgClient and the server: every client method reaches an OrgRoutes
 * handler through routeOrgRequest, the router the docs mount. The access token here is the
 * user id, and fetch is served in memory.
 */
const BASE = 'http://kora.test/auth'
const identities: Record<string, { email: string; emailVerified: boolean }> = {
	owner: { email: 'owner@example.com', emailVerified: true },
	invitee: { email: 'invitee@example.com', emailVerified: true },
}

let routes: OrgRoutes
const seen: string[] = []

beforeEach(() => {
	routes = new OrgRoutes({
		orgStore: new InMemoryOrgStore(),
		userLookup: { findById: async (id) => identities[id] ?? null },
	})
	seen.length = 0
	vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
		const url = new URL(input)
		const path = url.pathname.slice(new URL(BASE).pathname.length)
		seen.push(`${init.method} ${path}`)
		const userId = String(new Headers(init.headers).get('Authorization')).replace('Bearer ', '')
		const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
		const result = await routeOrgRequest(routes, {
			method: init.method ?? 'GET',
			path,
			userId,
			body,
		})
		if (!result) return new Response(JSON.stringify({ error: 'no route' }), { status: 404 })
		return new Response(JSON.stringify(result.body), { status: result.status })
	})
})
afterEach(() => {
	vi.unstubAllGlobals()
})

const clientAs = (userId: string) =>
	new OrgClient({ serverUrl: BASE, getAccessToken: async () => userId })

describe('OrgClient against OrgRoutes through routeOrgRequest', () => {
	test('every client method has a route, including switchOrg and leaveOrg', async () => {
		const owner = clientAs('owner')
		const invitee = clientAs('invitee')

		const org = await owner.createOrg({ name: 'Acme', slug: 'acme' })
		expect((await owner.listOrgs()).map((o) => o.id)).toEqual([org.id])
		expect((await owner.getOrg(org.id)).name).toBe('Acme')
		expect((await owner.updateOrg(org.id, { name: 'Acme Inc' })).name).toBe('Acme Inc')

		await owner.switchOrg(org.id)
		expect(owner.activeRole).toBe('owner')

		const invitation = await owner.inviteMember(org.id, {
			email: 'invitee@example.com',
			role: 'member',
		})
		expect((await owner.listInvitations(org.id)).length).toBe(1)
		expect((await invitee.listMyInvitations()).length).toBe(1)
		const joined = await invitee.acceptInvitation(invitation.token)
		expect(joined.role).toBe('member')
		expect((await owner.listMembers(org.id)).map((m) => m.userId).sort()).toEqual([
			'invitee',
			'owner',
		])

		expect((await owner.updateMemberRole(org.id, 'invitee', 'viewer')).role).toBe('viewer')
		await invitee.switchOrg(org.id)
		expect(invitee.activeRole).toBe('viewer')
		await invitee.leaveOrg(org.id)
		expect(invitee.activeOrgId).toBeNull()
		expect((await owner.listMembers(org.id)).map((m) => m.userId)).toEqual(['owner'])

		const second = await owner.inviteMember(org.id, {
			email: 'invitee@example.com',
			role: 'member',
		})
		await owner.revokeInvitation(org.id, second.id)
		expect(await owner.listInvitations(org.id)).toEqual([])

		const again = await owner.inviteMember(org.id, { email: 'invitee@example.com', role: 'admin' })
		await invitee.acceptInvitation(again.token)
		await owner.removeMember(org.id, 'invitee')
		const third = await owner.inviteMember(org.id, { email: 'invitee@example.com', role: 'member' })
		await invitee.acceptInvitation(third.token)
		await owner.transferOwnership(org.id, 'invitee')
		await invitee.deleteOrg(org.id)
		expect(await invitee.listOrgs()).toEqual([])
	})

	test('ids are sent as encoded path segments', async () => {
		const owner = clientAs('owner')
		await expect(owner.getOrg('a/b?c')).rejects.toMatchObject({ context: { status: 404 } })
		expect(seen.at(-1)).toBe('GET /orgs/a%2Fb%3Fc')
	})
})
