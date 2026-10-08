import { fc, test } from '@fast-check/vitest'
import { expect } from 'vitest'
import { compiledBranchCount } from '../../src/access/define-access'
import {
	type MembershipRecord,
	compileReadScope,
	createMembershipView,
	evaluateAccessRule,
} from '../../src/access/evaluate'
import {
	type AccessRule,
	and,
	anyone,
	member,
	or,
	owner,
	serverOnly,
	where,
} from '../../src/access/rules'
import { MAX_SCOPE_BRANCHES, recordMatchesCollectionScope } from '../../src/scopes/scope-predicate'

// The compiled read scope is a cache of the rule for one user: for every record it must
// give the answer evaluating the rule gives. Small domains make collisions common.
const ROLES = ['view', 'edit', 'manage'] as const
const users = fc.constantFrom('u1', 'u2')
const ids = fc.constantFrom('g1', 'g2', 'g3')
const role = fc.constantFrom(...ROLES)

const leaf: fc.Arbitrary<AccessRule> = fc.oneof(
	fc.constantFrom('a', 'b').map((field) => owner(field)),
	fc
		.tuple(fc.constantFrom('id', 'a', 'b'), fc.option(role, { nil: undefined }))
		.map(([field, min]) => member(field, min, { group: 'groups' })),
	fc
		.tuple(fc.constantFrom('a', 'b', 'c'), fc.constantFrom('g1', 'g2', 'u1', 'x'))
		.map(([field, value]) => where({ [field]: value })),
	fc.constant(anyone()),
	fc.constant(serverOnly()),
)
const rule: fc.Arbitrary<AccessRule> = fc
	.letrec<{ node: AccessRule }>((tie) => ({
		node: fc.oneof(
			{ depthSize: 'small', withCrossShrink: true },
			leaf,
			fc.array(tie('node'), { minLength: 1, maxLength: 3 }).map((rules) => or(...rules)),
			fc.array(tie('node'), { minLength: 1, maxLength: 2 }).map((rules) => and(...rules)),
		),
	}))
	.node.filter((r) => compiledBranchCount(r) <= MAX_SCOPE_BRANCHES)

const membership: fc.Arbitrary<MembershipRecord> = fc.record({
	userId: users,
	group: ids.map((id) => `groups:${id}`),
	role,
})
const value = fc.constantFrom('g1', 'g2', 'g3', 'u1', 'u2', 'x')
const record = fc.record({ id: ids, a: value, b: value, c: value })

test.prop([rule, fc.array(membership, { maxLength: 6 }), fc.option(users, { nil: null }), record], {
	numRuns: 1000,
})('the compiled read scope admits a record exactly when the rule does', (r, rows, userId, row) => {
	const memberships =
		userId === null
			? createMembershipView([], '', ROLES, 0)
			: createMembershipView(rows, userId, ROLES, 0)
	const ctx = { user: { userId }, memberships, roles: ROLES }
	const scope = compileReadScope(r, ctx)
	const compiled = scope !== null && recordMatchesCollectionScope(row, scope)
	expect(compiled).toBe(evaluateAccessRule(r, row, ctx))
})
