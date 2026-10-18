import { defineSchema, member, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { accessGrantsChangeKey, accessGrantsKey, validAccessGrants } from './access-grants'

const schema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'edit\u0000x', 'edit'],
		groups: { documents: { owner: 'ownerId', role: 'edit' } },
	},
	collections: {
		members: {
			fields: { userId: t.string(), group: t.string(), role: t.string() },
			access: { read: member('group', 'view', { group: 'documents' }) },
		},
		documents: {
			fields: { ownerId: t.string().stamp('userId') },
			access: { read: member('id') },
		},
	},
})

describe('capability grant keys', () => {
	test('no role or group text can stand for another grant', () => {
		const access = schema.access
		if (!access) throw new Error('schema declares access')
		const one = validAccessGrants(access, [{ group: 'documents:a', role: 'edit\u0000x' }], 0)
		const two = validAccessGrants(
			access,
			[
				{ group: 'documents:a', role: 'edit' },
				{ group: 'documents:b', role: 'view' },
			],
			0,
		)
		expect(accessGrantsKey(one)).not.toBe(accessGrantsKey(two))
		expect(accessGrantsChangeKey(one)).not.toBe(accessGrantsChangeKey(two))
	})
})
