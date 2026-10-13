import { describe, expect, test } from 'vitest'
import { SpacesConfigError, spacesCollections } from './spaces-collections'

const valid = {
	roles: ['viewer', 'editor', 'admin', 'owner'],
	ownerRole: 'owner',
	manageRole: 'admin',
	groups: { forms: { owner: 'ownerId' } },
} as const

describe('spacesCollections', () => {
	test('produces the access configuration and the three collections', () => {
		const sharing = spacesCollections(valid)
		expect(sharing.access).toEqual({
			memberships: 'space_members',
			roles: ['viewer', 'editor', 'admin', 'owner'],
			groups: { forms: { owner: 'ownerId', role: 'owner' } },
		})
		expect(Object.keys(sharing.collections)).toEqual([
			'space_members',
			'space_invitations',
			'space_invitation_secrets',
		])
		expect(sharing.rank('admin')).toBe(2)
		expect(sharing.rank('nope')).toBe(-1)
	})

	test.each([
		[{ ...valid, roles: ['owner'] }, 'at least two roles'],
		[{ ...valid, roles: ['viewer', 'viewer', 'owner'] }, 'listed twice'],
		[{ ...valid, ownerRole: 'boss' }, 'ownerRole'],
		[{ ...valid, manageRole: 'boss' }, 'manageRole'],
		[{ ...valid, roles: ['viewer', 'owner', 'admin'] }, 'highest role'],
		[{ ...valid, manageRole: 'owner' }, 'below ownerRole'],
		[{ ...valid, groups: {} }, 'at least one group'],
		[{ ...valid, groups: { forms: { owner: '' } } }, 'owner field'],
		[{ ...valid, groups: { space_members: { owner: 'x' } } }, "kit's own"],
	])('refuses %j', (config, message) => {
		expect(() => spacesCollections(config as typeof valid)).toThrow(SpacesConfigError)
		expect(() => spacesCollections(config as typeof valid)).toThrow(message)
	})
})
