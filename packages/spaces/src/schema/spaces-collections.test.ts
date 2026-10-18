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
		// Who is in a space, and who is invited, is for real members: a capability grant
		// (a share link) satisfies neither rule.
		expect(sharing.collections.space_members.access?.read).toMatchObject({
			kind: 'memberOfKey',
			field: 'group',
			grants: false,
		})
		expect(sharing.collections.space_invitations.access?.read).toMatchObject({
			kind: 'memberOfKey',
			minRole: 'admin',
			grants: false,
		})
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
		[{ ...valid, roles: ['viewer', 'leave', 'admin', 'owner'] }, 'cannot be a role name'],
		[{ ...valid, groups: { forms: { owner: '' } } }, 'owner field'],
		[{ ...valid, groups: { space_members: { owner: 'x' } } }, "kit's own"],
	])('refuses %j', (config, message) => {
		expect(() => spacesCollections(config as typeof valid)).toThrow(SpacesConfigError)
		expect(() => spacesCollections(config as typeof valid)).toThrow(message)
	})
})
