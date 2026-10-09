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

	test('a throwing custom() check denies', () => {
		const rule = custom(() => {
			throw new Error('boom')
		})
		expect(evaluateAccessRule(rule, {}, { ...ann, roles: ROLES })).toBe(false)
	})
})
