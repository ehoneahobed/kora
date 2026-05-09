import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { OrgClient, OrgClientError } from './org-client'

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockJsonResponse(data: unknown, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => data,
		text: async () => JSON.stringify(data),
	}
}

function mockEmptyResponse(status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => ({}),
		text: async () => '',
	}
}

describe('OrgClient', () => {
	let client: OrgClient
	const getAccessToken = vi.fn().mockResolvedValue('mock-token')

	beforeEach(() => {
		client = new OrgClient({
			serverUrl: 'http://localhost:3001',
			getAccessToken,
		})
		mockFetch.mockReset()
		getAccessToken.mockResolvedValue('mock-token')
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	// --- Organization CRUD ---

	describe('createOrg', () => {
		test('sends POST to /orgs', async () => {
			const org = { id: 'org-1', name: 'Acme', slug: 'acme', ownerId: 'u1' }
			mockFetch.mockResolvedValue(mockJsonResponse({ data: org }, 201))

			const result = await client.createOrg({ name: 'Acme', slug: 'acme' })
			expect(result).toEqual(org)
			expect(mockFetch).toHaveBeenCalledWith(
				'http://localhost:3001/orgs',
				expect.objectContaining({
					method: 'POST',
					headers: expect.objectContaining({
						Authorization: 'Bearer mock-token',
						'Content-Type': 'application/json',
					}),
				}),
			)
		})
	})

	describe('listOrgs', () => {
		test('sends GET to /orgs', async () => {
			const orgs = [{ id: 'org-1', name: 'Acme' }]
			mockFetch.mockResolvedValue(mockJsonResponse({ data: orgs }))

			const result = await client.listOrgs()
			expect(result).toEqual(orgs)
		})
	})

	describe('getOrg', () => {
		test('sends GET to /orgs/:id', async () => {
			const org = { id: 'org-1', name: 'Acme' }
			mockFetch.mockResolvedValue(mockJsonResponse({ data: org }))

			const result = await client.getOrg('org-1')
			expect(result).toEqual(org)
			expect(mockFetch).toHaveBeenCalledWith(
				'http://localhost:3001/orgs/org-1',
				expect.objectContaining({ method: 'GET' }),
			)
		})
	})

	describe('updateOrg', () => {
		test('sends PATCH to /orgs/:id', async () => {
			const org = { id: 'org-1', name: 'Updated' }
			mockFetch.mockResolvedValue(mockJsonResponse({ data: org }))

			const result = await client.updateOrg('org-1', { name: 'Updated' })
			expect(result).toEqual(org)
		})

		test('updates cached active org if same ID', async () => {
			// First set up active org
			const org = { id: 'org-1', name: 'Acme', slug: 'acme', ownerId: 'u1' }
			const membership = { id: 'm1', orgId: 'org-1', userId: 'u1', role: 'owner' }
			mockFetch
				.mockResolvedValueOnce(mockJsonResponse({ data: org })) // switchOrg getOrg
				.mockResolvedValueOnce(mockJsonResponse({ data: membership })) // switchOrg getMembership

			await client.switchOrg('org-1')
			expect(client.activeOrg?.name).toBe('Acme')

			// Now update
			const updated = { ...org, name: 'Updated' }
			mockFetch.mockResolvedValueOnce(mockJsonResponse({ data: updated }))
			await client.updateOrg('org-1', { name: 'Updated' })

			expect(client.activeOrg?.name).toBe('Updated')
		})
	})

	describe('deleteOrg', () => {
		test('sends DELETE and clears active if same org', async () => {
			const org = { id: 'org-1', name: 'Acme' }
			const membership = { id: 'm1', orgId: 'org-1', userId: 'u1', role: 'owner' }
			mockFetch
				.mockResolvedValueOnce(mockJsonResponse({ data: org }))
				.mockResolvedValueOnce(mockJsonResponse({ data: membership }))

			await client.switchOrg('org-1')
			expect(client.activeOrgId).toBe('org-1')

			mockFetch.mockResolvedValueOnce(mockEmptyResponse())
			await client.deleteOrg('org-1')

			expect(client.activeOrgId).toBeNull()
			expect(client.activeOrg).toBeNull()
			expect(client.activeRole).toBeNull()
		})
	})

	// --- Org Switching ---

	describe('switchOrg', () => {
		test('sets active org and role', async () => {
			const org = { id: 'org-1', name: 'Acme', slug: 'acme', ownerId: 'u1' }
			const membership = { id: 'm1', orgId: 'org-1', userId: 'u1', role: 'admin' }
			mockFetch
				.mockResolvedValueOnce(mockJsonResponse({ data: org }))
				.mockResolvedValueOnce(mockJsonResponse({ data: membership }))

			await client.switchOrg('org-1')

			expect(client.activeOrgId).toBe('org-1')
			expect(client.activeOrg).toEqual(org)
			expect(client.activeRole).toBe('admin')
		})

		test('notifies listeners on switch', async () => {
			const listener = vi.fn()
			client.onOrgChange(listener)

			const org = { id: 'org-1', name: 'Acme' }
			const membership = { id: 'm1', orgId: 'org-1', userId: 'u1', role: 'member' }
			mockFetch
				.mockResolvedValueOnce(mockJsonResponse({ data: org }))
				.mockResolvedValueOnce(mockJsonResponse({ data: membership }))

			await client.switchOrg('org-1')
			expect(listener).toHaveBeenCalledWith('org-1')
		})
	})

	describe('clearActiveOrg', () => {
		test('clears active org and notifies', async () => {
			const org = { id: 'org-1', name: 'Acme' }
			const membership = { id: 'm1', orgId: 'org-1', userId: 'u1', role: 'owner' }
			mockFetch
				.mockResolvedValueOnce(mockJsonResponse({ data: org }))
				.mockResolvedValueOnce(mockJsonResponse({ data: membership }))
			await client.switchOrg('org-1')

			const listener = vi.fn()
			client.onOrgChange(listener)

			client.clearActiveOrg()
			expect(client.activeOrgId).toBeNull()
			expect(listener).toHaveBeenCalledWith(null)
		})
	})

	// --- Member Management ---

	describe('listMembers', () => {
		test('sends GET to /orgs/:id/members', async () => {
			const members = [{ id: 'm1', userId: 'u1', role: 'owner' }]
			mockFetch.mockResolvedValue(mockJsonResponse({ data: members }))

			const result = await client.listMembers('org-1')
			expect(result).toEqual(members)
		})
	})

	describe('removeMember', () => {
		test('sends DELETE to /orgs/:id/members/:userId', async () => {
			mockFetch.mockResolvedValue(mockEmptyResponse())
			await client.removeMember('org-1', 'u2')
			expect(mockFetch).toHaveBeenCalledWith(
				'http://localhost:3001/orgs/org-1/members/u2',
				expect.objectContaining({ method: 'DELETE' }),
			)
		})
	})

	describe('leaveOrg', () => {
		test('sends POST and clears active if same org', async () => {
			const org = { id: 'org-1', name: 'Acme' }
			const membership = { id: 'm1', orgId: 'org-1', userId: 'u1', role: 'member' }
			mockFetch
				.mockResolvedValueOnce(mockJsonResponse({ data: org }))
				.mockResolvedValueOnce(mockJsonResponse({ data: membership }))
			await client.switchOrg('org-1')

			mockFetch.mockResolvedValueOnce(mockEmptyResponse())
			await client.leaveOrg('org-1')

			expect(client.activeOrgId).toBeNull()
		})
	})

	// --- Invitations ---

	describe('inviteMember', () => {
		test('sends POST to /orgs/:id/invitations', async () => {
			const inv = { id: 'inv-1', email: 'bob@example.com', role: 'member', token: 'tok' }
			mockFetch.mockResolvedValue(mockJsonResponse({ data: inv }, 201))

			const result = await client.inviteMember('org-1', {
				email: 'bob@example.com',
				role: 'member',
			})
			expect(result).toEqual(inv)
		})
	})

	describe('acceptInvitation', () => {
		test('sends POST to /invitations/accept', async () => {
			const membership = { id: 'm1', orgId: 'org-1', userId: 'u2', role: 'member' }
			mockFetch.mockResolvedValue(mockJsonResponse({ data: membership }))

			const result = await client.acceptInvitation('some-token')
			expect(result).toEqual(membership)
		})
	})

	describe('revokeInvitation', () => {
		test('sends DELETE to /orgs/:id/invitations/:invId', async () => {
			mockFetch.mockResolvedValue(mockEmptyResponse())
			await client.revokeInvitation('org-1', 'inv-1')
			expect(mockFetch).toHaveBeenCalledWith(
				'http://localhost:3001/orgs/org-1/invitations/inv-1',
				expect.objectContaining({ method: 'DELETE' }),
			)
		})
	})

	// --- Error handling ---

	describe('error handling', () => {
		test('throws OrgClientError when not authenticated', async () => {
			getAccessToken.mockResolvedValue(null)
			await expect(client.listOrgs()).rejects.toThrow(OrgClientError)
			await expect(client.listOrgs()).rejects.toThrow('Not authenticated')
		})

		test('throws OrgClientError on server error', async () => {
			mockFetch.mockResolvedValue(mockJsonResponse({ error: 'Organization not found.' }, 404))
			await expect(client.getOrg('bogus')).rejects.toThrow('Organization not found.')
		})

		test('throws OrgClientError on network failure', async () => {
			mockFetch.mockRejectedValue(new Error('network down'))
			await expect(client.listOrgs()).rejects.toThrow(OrgClientError)
		})
	})

	// --- Listener unsubscribe ---

	describe('onOrgChange', () => {
		test('unsubscribe removes listener', async () => {
			const listener = vi.fn()
			const unsub = client.onOrgChange(listener)

			const org = { id: 'org-1', name: 'Acme' }
			const membership = { id: 'm1', orgId: 'org-1', userId: 'u1', role: 'owner' }
			mockFetch
				.mockResolvedValueOnce(mockJsonResponse({ data: org }))
				.mockResolvedValueOnce(mockJsonResponse({ data: membership }))

			await client.switchOrg('org-1')
			expect(listener).toHaveBeenCalledTimes(1)

			unsub()
			client.clearActiveOrg()
			expect(listener).toHaveBeenCalledTimes(1) // not called again
		})
	})
})
