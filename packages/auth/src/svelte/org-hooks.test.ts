import { get } from 'svelte/store'
import { describe, expect, test, vi } from 'vitest'
import type { OrgContextValue } from './org-context'
import { useOrgMembers } from './org-hooks'

const listMembers = vi.fn()

vi.mock('./org-context', () => ({
	getOrgContext: (): Partial<OrgContextValue> => ({
		client: { listMembers } as unknown as OrgContextValue['client'],
	}),
}))

describe('svelte useOrgMembers', () => {
	test('loads the members of the org when called (no Svelte compiler involved)', async () => {
		const members = [{ userId: 'u1', orgId: 'o1', role: 'member' }]
		listMembers.mockResolvedValue(members)

		const result = useOrgMembers('o1')
		expect(listMembers).toHaveBeenCalledWith('o1')

		await vi.waitFor(() => {
			expect(get(result).isLoading).toBe(false)
		})
		expect(get(result).members).toEqual(members)
	})
})
