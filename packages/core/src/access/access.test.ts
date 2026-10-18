import { fc, test as propTest } from '@fast-check/vitest'
import { describe, expect, test } from 'vitest'
import { SchemaValidationError } from '../errors/errors'
import { defineSchema } from '../schema/define'
import { t } from '../schema/types'
import { recordMatchesCollectionScope } from '../scopes/scope-predicate'
import type { AccessDefinition } from './define-access'
import {
	type MembershipRecord,
	NO_MEMBERSHIPS,
	authorizeAccessWrite,
	compileAccessGrant,
	compileReadScope,
	createMembershipView,
	evaluateAccessRule,
} from './evaluate'
import { and, anyone, custom, member, memberOfKey, or, owner, serverOnly, where } from './rules'

const ROLES = ['view', 'comment', 'edit', 'manage'] as const

function docsSchema() {
	return defineSchema({
		version: 1,
		access: {
			memberships: 'members',
			roles: ROLES,
			groups: { documents: { owner: 'ownerId', role: 'manage' } },
		},
		collections: {
			members: {
				fields: {
					userId: t.string(),
					group: t.string(),
					role: t.string(),
					expiresAt: t.timestamp().optional(),
				},
				access: { read: memberOfKey('group') },
			},
			documents: {
				fields: {
					title: t.string(),
					ownerId: t.string().stamp('userId'),
					status: t.enum(['draft', 'published']),
				},
				access: {
					read: or(member('id'), where({ status: 'published' })),
					create: owner('ownerId'),
					update: member('id', 'edit'),
					delete: member('id', 'manage'),
				},
			},
			comments: {
				fields: {
					documentId: t.string(),
					body: t.string(),
					authorId: t.string().stamp('userId'),
				},
				access: {
					read: member('documentId', 'view'),
					create: member('documentId', 'comment'),
					update: and(member('documentId', 'comment'), owner('authorId')),
					delete: or(owner('authorId'), member('documentId', 'manage')),
				},
			},
			submissions: {
				fields: {
					courseId: t.string(),
					learnerId: t.string().stamp('userId'),
					answer: t.string(),
					grade: t.number().optional(),
				},
				access: {
					read: or(owner('learnerId'), member('courseId', 'edit', { group: 'documents' })),
					create: owner('learnerId'),
					update: owner('learnerId'),
					fields: { grade: { write: member('courseId', 'edit', { group: 'documents' }) } },
				},
			},
			templates: {
				fields: { name: t.string() },
				access: { read: anyone(), write: serverOnly() },
			},
			plain: { fields: { name: t.string() } },
		},
		relations: {
			commentDocument: {
				from: 'comments',
				to: 'documents',
				type: 'many-to-one',
				field: 'documentId',
				onDelete: 'cascade',
			},
		},
	})
}

function accessOf(): AccessDefinition {
	const access = docsSchema().access
	if (!access) throw new Error('schema has no access')
	return access
}

const memberships: MembershipRecord[] = [
	{ userId: 'ann', group: 'documents:d1', role: 'manage' },
	{ userId: 'ann', group: 'documents:d2', role: 'view' },
	{ userId: 'ann', group: 'documents:d3', role: 'edit', expiresAt: 1_000 },
	{ userId: 'bob', group: 'documents:d2', role: 'edit' },
]
const NOW = 2_000
const ann = {
	user: { userId: 'ann' },
	memberships: createMembershipView(memberships, 'ann', ROLES, NOW),
}
const bob = {
	user: { userId: 'bob' },
	memberships: createMembershipView(memberships, 'bob', ROLES, NOW),
}
const nobody = { user: { userId: null }, memberships: NO_MEMBERSHIPS }

describe('defineSchema access', () => {
	test('resolves rules, member() groups, access fields and stamps', () => {
		const access = accessOf()
		expect(access.memberships).toBe('members')
		expect(access.roles).toEqual(ROLES)
		const comments = access.collections.comments
		expect(comments?.accessFields).toEqual(['authorId', 'documentId'])
		expect(comments?.stampedFields).toEqual(['authorId'])
		// member('documentId') resolved through the relation.
		const read = comments?.read
		expect(read?.kind === 'member' ? read.group : null).toBe('documents')
		expect(access.collections.documents?.accessFields).toEqual(['ownerId'])
		expect(access.collections.members?.accessFields).toEqual(['group', 'userId'])
		expect(access.collections.plain).toBeUndefined()
		expect(access.collections.templates?.create?.kind).toBe('serverOnly')
	})

	test('where() may target the record id', () => {
		const schema = defineSchema({
			version: 1,
			collections: {
				docs: { fields: { title: t.string() }, access: { read: where({ id: 'd1' }) } },
			},
		})
		expect(schema.access?.collections.docs?.read).toEqual({ kind: 'where', equals: { id: 'd1' } })
	})

	test('stamp() makes the field optional on insert and records the stamp', () => {
		const field = docsSchema().collections.documents?.fields.ownerId
		expect(field?.stamp).toBe('userId')
		expect(field?.required).toBe(false)
	})

	const base = {
		title: t.string(),
		ownerId: t.string(),
		status: t.enum(['draft', 'published']),
		docId: t.string(),
		count: t.number(),
	}
	const invalid: Array<[string, () => unknown]> = [
		[
			'unknown field',
			() =>
				defineSchema({
					version: 1,
					collections: { docs: { fields: base, access: { read: owner('nope') } } },
				}),
		],
		[
			'owner on a number field',
			() =>
				defineSchema({
					version: 1,
					collections: { docs: { fields: base, access: { read: owner('count') } } },
				}),
		],
		[
			'member without memberships',
			() =>
				defineSchema({
					version: 1,
					collections: { docs: { fields: base, access: { read: member('id') } } },
				}),
		],
		[
			'where() value of the wrong type',
			() =>
				defineSchema({
					version: 1,
					collections: { docs: { fields: base, access: { read: where({ count: '1' }) } } },
				}),
		],
		[
			'where() timestamp outside the Date range',
			() =>
				defineSchema({
					version: 1,
					collections: {
						docs: {
							fields: { ...base, at: t.timestamp() },
							access: { read: where({ at: 8_700_000_000_000_000 }) },
						},
					},
				}),
		],
		[
			'where() enum value outside the enum',
			() =>
				defineSchema({
					version: 1,
					collections: { docs: { fields: base, access: { read: where({ status: 'gone' }) } } },
				}),
		],
		[
			'groups without memberships',
			() =>
				defineSchema({
					version: 1,
					access: { roles: ['manage'], groups: { docs: { owner: 'by', role: 'manage' } } },
					collections: {
						docs: {
							fields: { by: t.string().stamp('userId') },
							access: { read: owner('by') },
						},
					},
				}),
		],
		[
			'group owner not stamped',
			() =>
				defineSchema({
					version: 1,
					access: {
						memberships: 'm',
						roles: ['manage'],
						groups: { docs: { owner: 'ownerId', role: 'manage' } },
					},
					collections: {
						m: { fields: { userId: t.string(), group: t.string(), role: t.string() } },
						docs: { fields: base, access: { read: member('id') } },
					},
				}),
		],
		[
			'membership role enum outside roles',
			() =>
				defineSchema({
					version: 1,
					access: { memberships: 'm', roles: ['view'] },
					collections: {
						m: {
							fields: { userId: t.string(), group: t.string(), role: t.enum(['view', 'boss']) },
						},
					},
				}),
		],
		[
			'hand-built rule with rules not an array',
			() =>
				defineSchema({
					version: 1,
					collections: {
						docs: { fields: base, access: { read: { kind: 'or', rules: 'x' } as never } },
					},
				}),
		],
		[
			'hand-built where without equals',
			() =>
				defineSchema({
					version: 1,
					collections: {
						docs: { fields: base, access: { read: { kind: 'where', equals: null } as never } },
					},
				}),
		],
		[
			'anyone() with a non-boolean writes',
			() =>
				defineSchema({
					version: 1,
					collections: {
						docs: {
							fields: base,
							access: { read: anyone(), write: { kind: 'anyone', writes: 'yes' } as never },
						},
					},
				}),
		],
		[
			'memberships without roles',
			() =>
				defineSchema({
					version: 1,
					access: { memberships: 'm' },
					collections: {
						m: { fields: { userId: t.string(), group: t.string(), role: t.string() } },
						docs: { fields: base, access: { read: member('id') } },
					},
				}),
		],
		[
			'unknown role',
			() =>
				defineSchema({
					version: 1,
					access: { memberships: 'm', roles: ['view'] },
					collections: {
						m: { fields: { userId: t.string(), group: t.string(), role: t.string() } },
						docs: { fields: base, access: { read: member('id', 'admin') } },
					},
				}),
		],
		[
			'ambiguous member group',
			() =>
				defineSchema({
					version: 1,
					access: { memberships: 'm', roles: ['view'] },
					collections: {
						m: { fields: { userId: t.string(), group: t.string(), role: t.string() } },
						docs: { fields: base, access: { read: member('docId') } },
					},
				}),
		],
		[
			'anyone() write without opt-in',
			() =>
				defineSchema({
					version: 1,
					collections: { docs: { fields: base, access: { read: anyone(), write: anyone() } } },
				}),
		],
		[
			'custom() in a read rule',
			() =>
				defineSchema({
					version: 1,
					collections: { docs: { fields: base, access: { read: custom(() => true) } } },
				}),
		],
		[
			'write and create together',
			() =>
				defineSchema({
					version: 1,
					collections: {
						docs: { fields: base, access: { write: owner('ownerId'), create: owner('ownerId') } },
					},
				}),
		],
		[
			'empty or()',
			() =>
				defineSchema({
					version: 1,
					collections: { docs: { fields: base, access: { read: or() } } },
				}),
		],
		[
			'too many read alternatives',
			() =>
				defineSchema({
					version: 1,
					collections: {
						docs: {
							fields: base,
							access: {
								read: and(
									or(where({ title: 'a' }), where({ title: 'b' }), where({ title: 'c' })),
									or(where({ status: 'draft' }), where({ ownerId: 'x' }), where({ docId: 'y' })),
								),
							},
						},
					},
				}),
		],
		[
			'memberships collection with write rules',
			() =>
				defineSchema({
					version: 1,
					access: { memberships: 'm', roles: ['view'] },
					collections: {
						m: {
							fields: { userId: t.string(), group: t.string(), role: t.string() },
							access: { read: memberOfKey('group'), write: anyone({ writes: true }) },
						},
					},
				}),
		],
		[
			'memberships with an optional group',
			() =>
				defineSchema({
					version: 1,
					access: { memberships: 'm', roles: ['view'] },
					collections: {
						m: { fields: { userId: t.string(), group: t.string().optional(), role: t.string() } },
					},
				}),
		],
		[
			'memberships collection missing group',
			() =>
				defineSchema({
					version: 1,
					access: { memberships: 'm', roles: ['view'] },
					collections: { m: { fields: { userId: t.string(), role: t.string() } } },
				}),
		],
		[
			'stamp outside access',
			() =>
				defineSchema({
					version: 1,
					collections: { docs: { fields: { by: t.string().stamp('userId') } } },
				}),
		],
		[
			'access together with a scope',
			() =>
				defineSchema({
					version: 1,
					collections: {
						docs: { fields: base, scope: ['ownerId'], access: { read: owner('ownerId') } },
					},
				}),
		],
		[
			'group collection without access',
			() =>
				defineSchema({
					version: 1,
					access: {
						memberships: 'm',
						roles: ['manage'],
						groups: { docs: { owner: 'ownerId', role: 'manage' } },
					},
					collections: {
						m: { fields: { userId: t.string(), group: t.string(), role: t.string() } },
						docs: { fields: base },
					},
				}),
		],
		[
			'duplicate roles',
			() =>
				defineSchema({
					version: 1,
					access: { roles: ['a', 'a'] },
					collections: { x: { fields: base } },
				}),
		],
	]
	test.each(invalid)('refuses %s', (_name, build) => {
		expect(build).toThrow(SchemaValidationError)
	})

	test('stamp() is refused with auto() or a default', () => {
		expect(() => t.string().stamp('userId').auto()).toThrow(SchemaValidationError)
		expect(() => t.string().stamp('userId').default('x')).toThrow(SchemaValidationError)
		expect(t.string().optional().stamp('userId')._build().stamp).toBe('userId')
		expect(t.string().stamp('userId').optional()._build().stamp).toBe('userId')
	})
})

describe('memberships', () => {
	test('expired, foreign and unknown-role rows are not live; the higher role wins', () => {
		const view = createMembershipView(
			[
				...memberships,
				{ userId: 'ann', group: 'documents:d2', role: 'edit' },
				{ userId: 'ann', group: 'documents:d9', role: 'owner' },
			],
			'ann',
			ROLES,
			NOW,
		)
		expect(view.roleOf('documents:d1')).toBe('manage')
		expect(view.roleOf('documents:d2')).toBe('edit')
		expect(view.roleOf('documents:d3')).toBeNull()
		expect(view.roleOf('documents:d9')).toBeNull()
		// An expiry that is not a finite number counts as expired (fail closed).
		const odd = createMembershipView(
			[
				{ userId: 'ann', group: 'documents:a', role: 'view', expiresAt: '99999' as never },
				{ userId: 'ann', group: 'documents:b', role: 'view', expiresAt: Number.NaN },
			],
			'ann',
			ROLES,
			NOW,
		)
		expect(odd.groupKeys()).toEqual([])
		const malformed = createMembershipView(
			[
				{ userId: 'ann', group: null as never, role: 'view' },
				{ userId: 'ann', group: 'documents:d1', role: 'view' },
			],
			'ann',
			ROLES,
			NOW,
		)
		expect(malformed.groupKeys()).toEqual(['documents:d1'])
		expect(
			compileReadScope(member('id', undefined, { group: 'documents' }), {
				user: { userId: 'ann' },
				memberships: malformed,
				roles: ROLES,
			}),
		).toEqual({ id: { $in: ['d1'] } })
		expect(view.groupKeys()).toEqual(['documents:d1', 'documents:d2'])
	})
})

describe('compileReadScope', () => {
	const access = accessOf()

	test('member() compiles to the ids of the user live groups', () => {
		expect(
			compileReadScope(access.collections.comments?.read ?? null, { ...ann, roles: ROLES }),
		).toEqual({
			documentId: { $in: ['d1', 'd2'] },
		})
	})

	test('or() compiles to a disjunction', () => {
		expect(
			compileReadScope(access.collections.documents?.read ?? null, { ...ann, roles: ROLES }),
		).toEqual({ $or: [{ id: { $in: ['d1', 'd2'] } }, { status: 'published' }] })
	})

	test('a role threshold filters the groups', () => {
		expect(
			compileReadScope(member('id', 'edit', { group: 'documents' }), { ...ann, roles: ROLES }),
		).toEqual({ id: { $in: ['d1'] } })
	})

	test('no matching branch is a deny (null), never {}', () => {
		expect(
			compileReadScope(access.collections.comments?.read ?? null, { ...nobody, roles: ROLES }),
		).toBeNull()
		expect(compileReadScope(null, { ...ann, roles: ROLES })).toBeNull()
		expect(compileReadScope(serverOnly(), { ...ann, roles: ROLES })).toBeNull()
	})

	test('anyone() is unrestricted, even for anonymous sessions', () => {
		expect(compileReadScope(anyone(), { ...nobody, roles: ROLES })).toEqual({})
		expect(compileReadScope(or(owner('ownerId'), anyone()), { ...ann, roles: ROLES })).toEqual({})
	})

	test('and() intersects predicates on the same field', () => {
		const rule = and(member('id', undefined, { group: 'documents' }), where({ id: 'd2' }))
		expect(compileReadScope(rule, { ...ann, roles: ROLES })).toEqual({ id: { $in: ['d2'] } })
		expect(
			compileReadScope(and(where({ status: 'a' }), where({ status: 'b' })), {
				...ann,
				roles: ROLES,
			}),
		).toBeNull()
	})

	test('memberOfKey() compiles to group keys', () => {
		expect(
			compileReadScope(access.collections.members?.read ?? null, { ...bob, roles: ROLES }),
		).toEqual({
			group: { $in: ['documents:d2'] },
		})
	})

	test('member() on an empty id admits nothing, like the compiler', () => {
		const view = createMembershipView(
			[{ userId: 'ann', group: 'documents:', role: 'manage' }],
			'ann',
			ROLES,
			NOW,
		)
		const ctx = { user: { userId: 'ann' }, memberships: view, roles: ROLES }
		const rule = member('id', undefined, { group: 'documents' })
		expect(evaluateAccessRule(rule, { id: '' }, ctx)).toBe(false)
		expect(compileReadScope(rule, ctx)).toBeNull()
	})

	test('memberOfKey() leaves malformed group keys out of the grant', () => {
		const view = createMembershipView(
			[
				{ userId: 'ann', group: 'nocolon', role: 'view' },
				{ userId: 'ann', group: 'documents:d1', role: 'view' },
			],
			'ann',
			ROLES,
			NOW,
		)
		const rule = memberOfKey('group')
		const ctx = { user: { userId: 'ann' }, memberships: view, roles: ROLES }
		expect(compileReadScope(rule, ctx)).toEqual({ group: { $in: ['documents:d1'] } })
		expect(evaluateAccessRule(rule, { group: 'nocolon' }, ctx)).toBe(false)
	})

	test('the grant leaves out collections the user may not read', () => {
		const grant = compileAccessGrant(access, nobody)
		expect(Object.keys(grant).sort()).toEqual(['documents', 'templates'])
		expect(grant.documents).toEqual({ status: 'published' })
	})

	test('the compiled scope agrees with evaluating the rule on records', () => {
		const records = [
			{ id: 'd1', status: 'draft' },
			{ id: 'd2', status: 'draft' },
			{ id: 'd3', status: 'draft' },
			{ id: 'd4', status: 'published' },
			{ id: 'd5' },
		]
		for (const ctx of [ann, bob, nobody]) {
			const rule = access.collections.documents?.read ?? null
			const scope = compileReadScope(rule, { ...ctx, roles: ROLES })
			for (const record of records) {
				const evaluated = evaluateAccessRule(rule, record, { ...ctx, roles: ROLES })
				expect(scope !== null && recordMatchesCollectionScope(record, scope)).toBe(evaluated)
			}
		}
	})
})

describe('member rules that need a real membership ({ grants: false })', () => {
	// ann: a real membership of d1 (view) and a capability grant of d1 (manage) and d2 (edit).
	const rows: MembershipRecord[] = [
		{ userId: 'ann', group: 'documents:d1', role: 'view' },
		{ userId: 'ann', group: 'documents:d1', role: 'manage', viaGrant: true },
		{ userId: 'ann', group: 'documents:d2', role: 'edit', viaGrant: true },
	]
	const view = createMembershipView(rows, 'ann', ROLES, NOW)
	const ctx = { user: { userId: 'ann' }, memberships: view, roles: ROLES }
	const anonymous = {
		user: { userId: null },
		memberships: createMembershipView(
			[{ userId: 'anon', group: 'documents:d2', role: 'view', viaGrant: true }],
			'anon',
			ROLES,
			NOW,
		),
		roles: ROLES,
	}

	test('the view answers with and without grants', () => {
		expect(view.roleOf('documents:d1')).toBe('manage')
		expect(view.roleOf('documents:d1', { grants: false })).toBe('view')
		expect(view.roleOf('documents:d2')).toBe('edit')
		expect(view.roleOf('documents:d2', { grants: false })).toBeNull()
		expect(view.roleOf('documents:d2', { grants: true })).toBe('edit')
		expect(view.groupKeys()).toEqual(['documents:d1', 'documents:d2'])
		expect(view.groupKeys({ grants: false })).toEqual(['documents:d1'])
		// A malformed marker counts as a grant (fail closed).
		const odd = createMembershipView(
			[{ userId: 'ann', group: 'documents:d1', role: 'view', viaGrant: 'no' as never }],
			'ann',
			ROLES,
			NOW,
		)
		expect(odd.roleOf('documents:d1', { grants: false })).toBeNull()
		expect(NO_MEMBERSHIPS.roleOf('documents:d1', { grants: false })).toBeNull()
		expect(NO_MEMBERSHIPS.groupKeys({ grants: false })).toEqual([])
	})

	test('member() with grants: false ignores a group reached only through a grant', () => {
		const strict = member('id', undefined, { group: 'documents', grants: false })
		const loose = member('id', undefined, { group: 'documents' })
		expect(evaluateAccessRule(loose, { id: 'd2' }, ctx)).toBe(true)
		expect(evaluateAccessRule(strict, { id: 'd2' }, ctx)).toBe(false)
		expect(evaluateAccessRule(strict, { id: 'd1' }, ctx)).toBe(true)
		expect(compileReadScope(loose, ctx)).toEqual({ id: { $in: ['d1', 'd2'] } })
		expect(compileReadScope(strict, ctx)).toEqual({ id: { $in: ['d1'] } })
		expect(compileReadScope(strict, anonymous)).toBeNull()
		expect(compileReadScope(loose, anonymous)).toEqual({ id: { $in: ['d2'] } })
	})

	test('with a grant and a membership in one group, the membership role counts', () => {
		const manage = member('id', 'manage', { group: 'documents', grants: false })
		// The grant's manage role does not count; the membership's view role is too low.
		expect(evaluateAccessRule(manage, { id: 'd1' }, ctx)).toBe(false)
		expect(compileReadScope(manage, ctx)).toBeNull()
		const view1 = member('id', 'view', { group: 'documents', grants: false })
		expect(evaluateAccessRule(view1, { id: 'd1' }, ctx)).toBe(true)
		// The default keeps the higher of both.
		expect(
			evaluateAccessRule(member('id', 'manage', { group: 'documents' }), { id: 'd1' }, ctx),
		).toBe(true)
	})

	test('memberOfKey() with grants: false', () => {
		const strict = memberOfKey('group', undefined, { grants: false })
		expect(evaluateAccessRule(strict, { group: 'documents:d2' }, ctx)).toBe(false)
		expect(evaluateAccessRule(memberOfKey('group'), { group: 'documents:d2' }, ctx)).toBe(true)
		expect(compileReadScope(strict, ctx)).toEqual({ group: { $in: ['documents:d1'] } })
		expect(compileReadScope(strict, anonymous)).toBeNull()
		expect(compileReadScope(memberOfKey('group', 'edit', { grants: false }), ctx)).toBeNull()
		expect(compileReadScope(memberOfKey('group', 'edit'), ctx)).toEqual({
			group: { $in: ['documents:d1', 'documents:d2'] },
		})
	})

	test('or() mixes strict and default branches', () => {
		const rule = or(
			memberOfKey('group', 'manage'),
			memberOfKey('group', undefined, { grants: false }),
		)
		expect(compileReadScope(rule, ctx)).toEqual({ group: { $in: ['documents:d1'] } })
		expect(evaluateAccessRule(rule, { group: 'documents:d2' }, ctx)).toBe(false)
	})

	test('a malformed flag on a hand-built rule fails closed', () => {
		const rule = { ...member('id', undefined, { group: 'documents' }), grants: 'yes' as never }
		expect(evaluateAccessRule(rule, { id: 'd2' }, ctx)).toBe(false)
		expect(compileReadScope(rule, ctx)).toEqual({ id: { $in: ['d1'] } })
	})

	test('custom() checks can ask either question; existing calls keep counting grants', () => {
		const withGrants = custom(({ memberships }) => memberships.roleOf('documents:d2') !== null)
		const membersOnly = custom(
			({ memberships }) => memberships.roleOf('documents:d2', { grants: false }) !== null,
		)
		expect(evaluateAccessRule(withGrants, {}, ctx)).toBe(true)
		expect(evaluateAccessRule(membersOnly, {}, ctx)).toBe(false)
	})

	test('builders carry the flag; defineSchema drops the default and refuses a non-boolean', () => {
		expect(member('id').grants).toBeUndefined()
		expect(member('id', undefined, { grants: false }).grants).toBe(false)
		expect(memberOfKey('group', undefined, { grants: true }).grants).toBe(true)
		expect(Object.isFrozen(memberOfKey('group', undefined, { grants: false }))).toBe(true)
		const schemaWith = (read: ReturnType<typeof memberOfKey>) =>
			defineSchema({
				version: 1,
				access: { memberships: 'members', roles: ROLES },
				collections: {
					members: {
						fields: { userId: t.string(), group: t.string(), role: t.string() },
						access: { read },
					},
				},
			})
		const strict = schemaWith(memberOfKey('group', undefined, { grants: false })).access
		expect(strict?.collections.members?.read).toEqual({
			kind: 'memberOfKey',
			field: 'group',
			minRole: null,
			grants: false,
		})
		// The default is left out, so read rules (and their key) stay as before.
		const loose = schemaWith(memberOfKey('group', undefined, { grants: true })).access
		expect(loose?.collections.members?.read).toEqual({
			kind: 'memberOfKey',
			field: 'group',
			minRole: null,
		})
		expect(
			Object.prototype.hasOwnProperty.call(loose?.collections.members?.read ?? {}, 'grants'),
		).toBe(false)
		expect(() => schemaWith(memberOfKey('group', undefined, { grants: 'no' as never }))).toThrow(
			/grants must be a boolean/,
		)
		expect(() =>
			defineSchema({
				version: 1,
				access: { memberships: 'members', roles: ROLES },
				collections: {
					members: {
						fields: { userId: t.string(), group: t.string(), role: t.string() },
						access: { read: memberOfKey('group') },
					},
					notes: {
						fields: { docId: t.string() },
						access: {
							read: member('docId', undefined, { group: 'members', grants: 1 as never }),
						},
					},
				},
			}),
		).toThrow(/member\(\) options.grants must be a boolean/)
	})

	const roleArb = fc.constantFrom(...ROLES)
	const rowArb = fc.record({
		userId: fc.constant('ann'),
		group: fc.constantFrom('documents:d1', 'documents:d2', 'documents:d3'),
		role: roleArb,
		viaGrant: fc.boolean(),
	})
	propTest.prop([fc.array(rowArb, { maxLength: 8 }), fc.option(roleArb, { nil: undefined })])(
		'compiled scope agrees with evaluation, and grants: false never admits more',
		(generated, minRole) => {
			const v = createMembershipView(generated, 'ann', ROLES, NOW)
			const c = { user: { userId: 'ann' }, memberships: v, roles: ROLES }
			const strict = member('id', minRole, { group: 'documents', grants: false })
			const loose = member('id', minRole, { group: 'documents' })
			const strictScope = compileReadScope(strict, c)
			const looseScope = compileReadScope(loose, c)
			for (const id of ['d1', 'd2', 'd3']) {
				const record = { id }
				const s1 = evaluateAccessRule(strict, record, c)
				const l1 = evaluateAccessRule(loose, record, c)
				expect(strictScope !== null && recordMatchesCollectionScope(record, strictScope)).toBe(s1)
				expect(looseScope !== null && recordMatchesCollectionScope(record, looseScope)).toBe(l1)
				if (s1) expect(l1).toBe(true)
				// Without grant rows, both rules agree.
				const real = generated.filter((row) => !row.viaGrant)
				const onlyReal = {
					...c,
					memberships: createMembershipView(real, 'ann', ROLES, NOW),
				}
				expect(evaluateAccessRule(loose, record, onlyReal)).toBe(s1)
			}
		},
	)
})

describe('authorizeAccessWrite', () => {
	const access = accessOf()
	const doc = { id: 'd1', title: 'T', ownerId: 'ann', status: 'draft' }

	test('insert: the stamp must be the writing user; anonymous cannot insert a stamped row', () => {
		expect(
			authorizeAccessWrite(
				access,
				{ collection: 'documents', type: 'insert', stored: null, next: doc },
				ann,
			),
		).toEqual({ allowed: true })
		const spoofed = authorizeAccessWrite(
			access,
			{ collection: 'documents', type: 'insert', stored: null, next: { ...doc, ownerId: 'ann' } },
			bob,
		)
		expect(spoofed).toMatchObject({ allowed: false, code: 'STAMP_MISMATCH', field: 'ownerId' })
		expect(
			authorizeAccessWrite(
				access,
				{ collection: 'documents', type: 'insert', stored: null, next: doc },
				nobody,
			),
		).toMatchObject({ allowed: false, code: 'STAMP_MISMATCH' })
	})

	test('update needs the rule on the stored and resulting rows; access fields never change', () => {
		const edit = (ctx: typeof ann, next: Record<string, unknown>) =>
			authorizeAccessWrite(
				access,
				{ collection: 'documents', type: 'update', stored: doc, next },
				ctx,
			)
		expect(edit(ann, { ...doc, title: 'U' })).toEqual({ allowed: true })
		expect(edit(bob, { ...doc, title: 'U' })).toMatchObject({
			allowed: false,
			code: 'ACCESS_DENIED',
		})
		expect(edit(ann, { ...doc, ownerId: 'bob' })).toMatchObject({ code: 'STAMP_MISMATCH' })
	})

	test('an insert that omits a stamped field is judged with the stamp applied', () => {
		const { ownerId: _omitted, ...withoutOwner } = doc
		expect(
			authorizeAccessWrite(
				access,
				{ collection: 'documents', type: 'insert', stored: null, next: withoutOwner },
				ann,
			),
		).toEqual({ allowed: true })
	})

	test('omitting keys from the resulting row skips no check', () => {
		const sub = { id: 's1', courseId: 'd2', learnerId: 'ann', answer: 'a', grade: 90 }
		const { grade: _g, ...noGrade } = sub
		// The learner cannot clear the grade by leaving it out.
		expect(
			authorizeAccessWrite(
				access,
				{ collection: 'submissions', type: 'update', stored: sub, next: noGrade },
				ann,
			),
		).toMatchObject({ allowed: false, field: 'grade' })
		const { courseId: _c, ...noCourse } = sub
		expect(
			authorizeAccessWrite(
				access,
				{ collection: 'submissions', type: 'update', stored: sub, next: noCourse },
				ann,
			),
		).toMatchObject({ allowed: false, code: 'IMMUTABLE_ACCESS_FIELD' })
		// An insert with no fields still needs the collection's create rule.
		expect(
			authorizeAccessWrite(
				access,
				{ collection: 'templates', type: 'insert', stored: null, next: { id: 't1' } },
				ann,
			),
		).toMatchObject({ allowed: false, code: 'ACCESS_DENIED' })
	})

	test('an insert onto an existing record is judged as an update', () => {
		expect(
			authorizeAccessWrite(
				access,
				{ collection: 'documents', type: 'insert', stored: doc, next: { ...doc, title: 'X' } },
				bob,
			),
		).toMatchObject({ allowed: false, code: 'ACCESS_DENIED' })
	})

	test('an or() branch cannot be kept by rewriting the field it keys on', () => {
		const comment = { id: 'c1', documentId: 'd1', body: 'hi', authorId: 'ann' }
		expect(
			authorizeAccessWrite(
				access,
				{
					collection: 'comments',
					type: 'update',
					stored: comment,
					next: { ...comment, documentId: 'd2' },
				},
				ann,
			),
		).toMatchObject({ allowed: false, code: 'IMMUTABLE_ACCESS_FIELD', field: 'documentId' })
	})

	test('field rules: the learner cannot grade; the grader needs only the field rule', () => {
		const sub = { id: 's1', courseId: 'd2', learnerId: 'ann', answer: 'a', grade: null }
		const insertWithGrade = authorizeAccessWrite(
			access,
			{ collection: 'submissions', type: 'insert', stored: null, next: { ...sub, grade: 5 } },
			ann,
		)
		expect(insertWithGrade).toMatchObject({ allowed: false, code: 'ACCESS_DENIED', field: 'grade' })
		expect(
			authorizeAccessWrite(
				access,
				{ collection: 'submissions', type: 'insert', stored: null, next: sub },
				ann,
			),
		).toEqual({ allowed: true })
		expect(
			authorizeAccessWrite(
				access,
				{ collection: 'submissions', type: 'update', stored: sub, next: { ...sub, grade: 7 } },
				bob,
			),
		).toEqual({ allowed: true })
		expect(
			authorizeAccessWrite(
				access,
				{
					collection: 'submissions',
					type: 'update',
					stored: sub,
					next: { ...sub, grade: 7, answer: 'b' },
				},
				bob,
			),
		).toMatchObject({ allowed: false, code: 'ACCESS_DENIED' })
	})

	test('delete uses the stored row; memberships and serverOnly collections refuse clients', () => {
		expect(
			authorizeAccessWrite(
				access,
				{ collection: 'documents', type: 'delete', stored: doc, next: null },
				ann,
			),
		).toEqual({ allowed: true })
		expect(
			authorizeAccessWrite(
				access,
				{ collection: 'documents', type: 'delete', stored: doc, next: null },
				bob,
			),
		).toMatchObject({ allowed: false })
		expect(
			authorizeAccessWrite(
				access,
				{
					collection: 'members',
					type: 'insert',
					stored: null,
					next: { userId: 'ann', group: 'documents:d9', role: 'manage' },
				},
				ann,
			),
		).toMatchObject({ allowed: false, code: 'SERVER_OWNED' })
		expect(
			authorizeAccessWrite(
				access,
				{ collection: 'templates', type: 'insert', stored: null, next: { name: 'x' } },
				ann,
			),
		).toMatchObject({ allowed: false, code: 'ACCESS_DENIED' })
	})

	test('collections without access are not judged here', () => {
		expect(
			authorizeAccessWrite(
				access,
				{ collection: 'plain', type: 'insert', stored: null, next: { name: 'x' } },
				nobody,
			),
		).toEqual({ allowed: true })
	})

	test('fields named like Object.prototype members fall back to the collection rule', () => {
		const schema = defineSchema({
			version: 1,
			collections: {
				odd: {
					fields: { owner: t.string(), toString: t.string(), constructor: t.string() },
					access: { read: owner('owner'), write: owner('owner') },
				},
			},
		})
		const odd = schema.access
		if (!odd) throw new Error('no access')
		const row = { id: 'o1', owner: 'ann', toString: 'a', constructor: 'b' }
		expect(
			authorizeAccessWrite(
				odd,
				{ collection: 'odd', type: 'insert', stored: null, next: row },
				ann,
			),
		).toEqual({ allowed: true })
		expect(
			authorizeAccessWrite(
				odd,
				{ collection: 'odd', type: 'update', stored: row, next: { ...row, toString: 'c' } },
				bob,
			),
		).toMatchObject({ allowed: false, code: 'ACCESS_DENIED' })
	})

	test('and() compiles fields named like Object.prototype members', () => {
		const rule = and(anyone(), where({ constructor: 'x' }))
		const ctx = { ...ann, roles: ROLES }
		expect(compileReadScope(rule, ctx)).toEqual({ constructor: 'x' })
		expect(evaluateAccessRule(rule, { constructor: 'x' }, ctx)).toBe(true)
	})

	test('a memberships collection named constructor is accepted', () => {
		const schema = defineSchema({
			version: 1,
			access: { memberships: 'constructor', roles: ['view'] },
			collections: {
				constructor: { fields: { userId: t.string(), group: t.string(), role: t.string() } },
			},
		})
		expect(schema.access?.memberships).toBe('constructor')
		const entry = Object.entries(schema.access?.collections ?? {}).find(
			([name]) => name === 'constructor',
		)
		expect(entry?.[1].accessFields).toEqual(['group', 'userId'])
	})

	test('no-op updates, atomic intents and restores still need their rules', () => {
		const stored = { id: 'd1', title: 'T', ownerId: 'ann', status: 'draft' }
		const write = (extra: object) =>
			authorizeAccessWrite(
				access,
				{ collection: 'documents', type: 'update', stored, next: { ...stored }, ...extra },
				bob,
			)
		expect(write({})).toMatchObject({ allowed: false, code: 'ACCESS_DENIED' })
		expect(write({ touchedFields: ['title'] })).toMatchObject({ allowed: false })
		// ann manages d1: she may restore it; an editor could not.
		expect(
			authorizeAccessWrite(
				access,
				{
					collection: 'documents',
					type: 'update',
					stored,
					next: { ...stored, title: 'Back' },
					storedDeleted: true,
				},
				ann,
			),
		).toEqual({ allowed: true })
	})

	test('a throwing custom() check denies', () => {
		const rule = custom(() => {
			throw new Error('boom')
		})
		expect(evaluateAccessRule(rule, {}, { ...ann, roles: ROLES })).toBe(false)
	})
})

describe('field rules on insert', () => {
	const DOC = { group: 'documents' }
	// Comments in documents d1/d2: commenters create them, the author edits them, and
	// fields carry their own rules. `resolved` and `tags` declare only `update`, `pinned`
	// only managers may choose, and `label` has no default.
	function commentsAccess(): AccessDefinition {
		const access = defineSchema({
			version: 1,
			access: {
				memberships: 'members',
				roles: ROLES,
				groups: { documents: { owner: 'ownerId', role: 'manage' } },
			},
			collections: {
				members: {
					fields: { userId: t.string(), group: t.string(), role: t.string() },
					access: { read: memberOfKey('group') },
				},
				documents: {
					fields: { title: t.string(), ownerId: t.string().stamp('userId') },
					access: { read: member('id'), create: owner('ownerId'), update: member('id', 'edit') },
				},
				comments: {
					fields: {
						documentId: t.string(),
						body: t.string(),
						authorId: t.string().stamp('userId'),
						resolved: t.boolean().default(false),
						pinned: t.boolean().default(false),
						tags: t.array(t.string()).default([]),
						status: t.enum(['open', 'closed']).default('open'),
						label: t.string().optional(),
						createdAt: t.timestamp().auto(),
					},
					access: {
						read: member('documentId', 'view', DOC),
						create: member('documentId', 'comment', DOC),
						update: owner('authorId'),
						fields: {
							resolved: { update: member('documentId', 'comment', DOC) },
							tags: { update: owner('authorId') },
							status: { update: member('documentId', 'comment', DOC) },
							pinned: {
								create: member('documentId', 'manage', DOC),
								update: member('documentId', 'manage', DOC),
							},
							label: { update: owner('authorId') },
							createdAt: { update: serverOnly() },
						},
					},
				},
			},
		}).access
		if (!access) throw new Error('schema has no access')
		return access
	}
	const access = commentsAccess()
	// ann manages d1 and views d2; bob edits d2.
	const insert = (ctx: Parameters<typeof authorizeAccessWrite>[2], next: Record<string, unknown>) =>
		authorizeAccessWrite(
			access,
			{ collection: 'comments', type: 'insert', stored: null, next },
			ctx,
		)
	const base = {
		id: 'c1',
		documentId: 'd2',
		body: 'Hi',
		authorId: 'bob',
		resolved: false,
		pinned: false,
		tags: [],
		status: 'open',
	}

	test('a field rule without create accepts the schema default on insert', () => {
		expect(insert(bob, base)).toEqual({ allowed: true })
		// Left out entirely (the server fills the default) is the same.
		const { resolved: _r, tags: _t, status: _s, pinned: _p, ...bare } = base
		expect(insert(bob, bare)).toEqual({ allowed: true })
	})

	test('a field rule without create refuses any other value on insert', () => {
		expect(insert(bob, { ...base, resolved: true })).toMatchObject({
			allowed: false,
			code: 'ACCESS_DENIED',
			field: 'resolved',
		})
		expect(insert(bob, { ...base, tags: ['urgent'] })).toMatchObject({
			allowed: false,
			field: 'tags',
		})
		expect(insert(bob, { ...base, status: 'closed' })).toMatchObject({
			allowed: false,
			field: 'status',
		})
		// No default: any value is a choice.
		expect(insert(bob, { ...base, label: 'x' })).toMatchObject({ allowed: false, field: 'label' })
		// auto() values are chosen by the device, not the schema: a rule without create refuses them.
		expect(insert(bob, { ...base, createdAt: 1_000 })).toMatchObject({
			allowed: false,
			field: 'createdAt',
		})
		const denied = insert(bob, { ...base, resolved: true })
		expect(denied.allowed === false && denied.message).toContain('create')
	})

	test('a field create rule judges only a value other than the default', () => {
		// bob edits d2 but does not manage it: he may not pin, but may leave it unpinned.
		expect(insert(bob, { ...base, pinned: true })).toMatchObject({
			allowed: false,
			field: 'pinned',
		})
		// ann manages d1: she may create it pinned.
		expect(
			insert(ann, { ...base, documentId: 'd1', authorId: 'ann', pinned: true, id: 'c2' }),
		).toEqual({ allowed: true })
	})

	test('a default never bypasses the collection create rule', () => {
		// ann only views d2: commenting needs `comment`, defaults or not.
		expect(insert(ann, { ...base, authorId: 'ann' })).toMatchObject({
			allowed: false,
			code: 'ACCESS_DENIED',
		})
		expect(insert(nobody, base)).toMatchObject({ allowed: false })
	})

	test('a collection whose every field has a rule still needs its create rule', () => {
		const schema = defineSchema({
			version: 1,
			collections: {
				flags: {
					fields: { on: t.boolean().default(false), note: t.string().optional() },
					access: {
						read: anyone(),
						fields: {
							on: { write: anyone({ writes: true }) },
							note: { write: anyone({ writes: true }) },
						},
					},
				},
			},
		})
		const flags = schema.access
		if (!flags) throw new Error('schema has no access')
		const write = (next: Record<string, unknown>) =>
			authorizeAccessWrite(flags, { collection: 'flags', type: 'insert', stored: null, next }, bob)
		// No collection create rule: no client creates a flag, whatever its fields hold.
		expect(write({ id: 'f1', on: false })).toMatchObject({ allowed: false, code: 'ACCESS_DENIED' })
		expect(write({ id: 'f2' })).toMatchObject({ allowed: false, code: 'ACCESS_DENIED' })
		expect(write({ id: 'f3', on: true, note: 'x' })).toMatchObject({ allowed: false })
	})

	test('updates are unchanged: a field rule replaces the collection update for that field', () => {
		const stored = { ...base, createdAt: 1 }
		const update = (
			ctx: Parameters<typeof authorizeAccessWrite>[2],
			next: Record<string, unknown>,
		) => authorizeAccessWrite(access, { collection: 'comments', type: 'update', stored, next }, ctx)
		// A commenter who is not the author resolves the thread (field rule), but cannot
		// edit the body (collection update: the author).
		const carol = {
			user: { userId: 'carol' },
			memberships: createMembershipView(
				[{ userId: 'carol', group: 'documents:d2', role: 'comment' }],
				'carol',
				ROLES,
				NOW,
			),
		}
		expect(update(carol, { ...stored, resolved: true })).toEqual({ allowed: true })
		expect(update(carol, { ...stored, body: 'Mine' })).toMatchObject({ allowed: false })
		// Going back to the default on update is a change like any other.
		expect(update(bob, { ...stored, createdAt: 2 })).toMatchObject({ allowed: false })
	})
})
