/**
 * Evaluating access rules: compiling a read rule into the scope predicate the
 * download stream and the client's offline pre-checks use, and deciding a write.
 *
 * The server is the only judge (it evaluates against stored rows and memberships it
 * owns). The same functions run on the client against its cached grant purely to
 * refuse a write early while offline; that is never authority.
 */

import type { CollectionScope, ScopeConjunction } from '../scopes/scope-predicate'
import { MAX_SCOPE_BRANCHES, SCOPE_OR_KEY, matchesFieldPredicate } from '../scopes/scope-predicate'
import type { AccessDefinition, CollectionAccess } from './define-access'
import {
	type AccessPrincipal,
	type AccessRule,
	type MembershipView,
	groupKey,
	parseGroupKey,
} from './rules'

/** One membership row as the memberships collection stores it. */
export interface MembershipRecord {
	readonly userId: string
	readonly group: string
	readonly role: string
	/** Milliseconds since the epoch; absent or null means it does not expire. */
	readonly expiresAt?: number | null
}

/**
 * A membership view over one user's membership rows. Rows of other users, rows with
 * a role outside `roles`, and rows expired at `now` are ignored; when a user holds two
 * live rows for one group, the higher role counts.
 *
 * @param rows - Membership rows (any users)
 * @param userId - The user the view is for
 * @param roles - The schema's roles, lowest to highest
 * @param now - Milliseconds since the epoch the expiry is judged at
 */
export function createMembershipView(
	rows: Iterable<MembershipRecord>,
	userId: string,
	roles: readonly string[],
	now: number,
): MembershipView {
	const best = new Map<string, string>()
	for (const row of rows) {
		if (row.userId !== userId) continue
		if (!roles.includes(row.role)) continue
		// Fail closed: an expiry that is not a finite number (a string from a driver, NaN,
		// a Date) counts as expired, never as "does not expire".
		const expiresAt = row.expiresAt
		if (expiresAt !== undefined && expiresAt !== null) {
			if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= now) continue
		}
		const held = best.get(row.group)
		if (held === undefined || roles.indexOf(row.role) > roles.indexOf(held)) {
			best.set(row.group, row.role)
		}
	}
	const keys = Object.freeze([...best.keys()].sort())
	return {
		roleOf: (key) => best.get(key) ?? null,
		groupKeys: () => keys,
	}
}

/** An empty membership view (anonymous sessions, users with no memberships). */
export const NO_MEMBERSHIPS: MembershipView = Object.freeze({
	roleOf: () => null,
	groupKeys: () => Object.freeze([]),
})

/**
 * True when `role` is at least `minRole` in the schema's ordering. A null `minRole`
 * admits any role the schema knows.
 */
export function roleAtLeast(
	role: string | null,
	minRole: string | null,
	roles: readonly string[],
): boolean {
	if (role === null) return false
	const rank = roles.indexOf(role)
	if (rank < 0) return false
	return minRole === null || rank >= roles.indexOf(minRole)
}

/** What a rule is evaluated against. */
export interface AccessEvaluationContext {
	readonly user: AccessPrincipal
	readonly memberships: MembershipView
	readonly roles: readonly string[]
}

/**
 * True when `rule` admits `record` for the context's user. `null` (no rule) admits
 * nothing. Field values are compared exactly; a missing or non-string key field never
 * matches.
 *
 * @param rule - The rule, as resolved by `defineSchema`
 * @param record - The row to judge
 * @param ctx - The user, their memberships and the schema's roles
 */
export function evaluateAccessRule(
	rule: AccessRule | null,
	record: Readonly<Record<string, unknown>>,
	ctx: AccessEvaluationContext,
): boolean {
	if (rule === null) return false
	switch (rule.kind) {
		case 'owner':
			return ctx.user.userId !== null && record[rule.field] === ctx.user.userId
		case 'member': {
			const value = record[rule.field]
			if (ctx.user.userId === null || typeof value !== 'string' || rule.group === null) {
				return false
			}
			// Same keys the compiler accepts: an empty id names no group.
			if (parseGroupKey(groupKey(rule.group, value)) === null) return false
			return roleAtLeast(
				ctx.memberships.roleOf(groupKey(rule.group, value)),
				rule.minRole,
				ctx.roles,
			)
		}
		case 'memberOfKey': {
			const value = record[rule.field]
			if (ctx.user.userId === null || typeof value !== 'string' || parseGroupKey(value) === null) {
				return false
			}
			return roleAtLeast(ctx.memberships.roleOf(value), rule.minRole, ctx.roles)
		}
		case 'where':
			return Object.entries(rule.equals).every(([field, value]) =>
				matchesFieldPredicate(record[field], value),
			)
		case 'anyone':
			return true
		case 'serverOnly':
			return false
		case 'or':
			return rule.rules.some((child) => evaluateAccessRule(child, record, ctx))
		case 'and':
			return rule.rules.every((child) => evaluateAccessRule(child, record, ctx))
		case 'custom':
			try {
				return rule.check({ record, user: ctx.user, memberships: ctx.memberships }) === true
			} catch {
				// A throwing check denies: failing closed is the only safe answer.
				return false
			}
	}
}

/**
 * Compile a read rule into a collection scope for one user: the predicate the
 * download stream and the client's pre-checks evaluate. Returns null when the user may
 * read nothing (a deny is the collection left out of the grant, never `{}`).
 *
 * @param rule - The collection's read rule (null: readable by no client)
 * @param ctx - The user, their memberships and the schema's roles
 */
export function compileReadScope(
	rule: AccessRule | null,
	ctx: AccessEvaluationContext,
): CollectionScope | null {
	if (rule === null) return null
	const branches = dedupeBranches(compileBranches(rule, ctx))
	if (branches.length === 0) return null
	if (branches.some((branch) => Object.keys(branch).length === 0)) return {}
	if (branches.length === 1 && branches[0]) return branches[0]
	if (branches.length > MAX_SCOPE_BRANCHES) {
		// defineSchema bounds the branch count, so this is unreachable for a valid schema.
		// Deny rather than produce a grant the matcher refuses.
		return null
	}
	return { [SCOPE_OR_KEY]: branches } as CollectionScope
}

/**
 * Compile every read rule of a schema's access collections for one user. Collections
 * the user may not read are absent from the result.
 */
export function compileAccessGrant(
	access: AccessDefinition,
	ctx: Omit<AccessEvaluationContext, 'roles'>,
): Record<string, CollectionScope> {
	const grant: Record<string, CollectionScope> = {}
	const full = { ...ctx, roles: access.roles }
	for (const [name, collection] of Object.entries(access.collections)) {
		const scope = compileReadScope(collection.read, full)
		if (scope !== null) grant[name] = scope
	}
	return grant
}

/** The rule compiled to a disjunction of conjunctions; `[]` means false. */
function compileBranches(rule: AccessRule, ctx: AccessEvaluationContext): ScopeConjunction[] {
	switch (rule.kind) {
		case 'owner':
			return ctx.user.userId === null ? [] : [{ [rule.field]: ctx.user.userId }]
		case 'member': {
			if (ctx.user.userId === null || rule.group === null) return []
			const ids: string[] = []
			for (const key of ctx.memberships.groupKeys()) {
				const parsed = parseGroupKey(key)
				if (parsed?.collection !== rule.group) continue
				if (roleAtLeast(ctx.memberships.roleOf(key), rule.minRole, ctx.roles)) ids.push(parsed.id)
			}
			return ids.length === 0 ? [] : [{ [rule.field]: { $in: ids.sort() } }]
		}
		case 'memberOfKey': {
			if (ctx.user.userId === null) return []
			const keys = ctx.memberships.groupKeys().filter(
				// A key that is not `collection:id` never admits a record under evaluation, so
				// it must not enter the compiled grant either.
				(key) =>
					parseGroupKey(key) !== null &&
					roleAtLeast(ctx.memberships.roleOf(key), rule.minRole, ctx.roles),
			)
			return keys.length === 0 ? [] : [{ [rule.field]: { $in: [...keys].sort() } }]
		}
		case 'where':
			return [{ ...rule.equals }]
		case 'anyone':
			return [{}]
		case 'serverOnly':
			return []
		case 'or':
			return rule.rules.flatMap((child) => compileBranches(child, ctx))
		case 'and': {
			let product: ScopeConjunction[] = [{}]
			for (const child of rule.rules) {
				const next: ScopeConjunction[] = []
				for (const left of product) {
					for (const right of compileBranches(child, ctx)) {
						const both = intersectConjunctions(left, right)
						if (both !== null) next.push(both)
					}
				}
				product = next
				if (product.length === 0) return []
			}
			return product
		}
		case 'custom':
			// defineSchema refuses custom() in read rules; deny if one gets here anyway.
			return []
	}
}

/** Both conjunctions at once, or null when no record can satisfy both. */
function intersectConjunctions(
	left: ScopeConjunction,
	right: ScopeConjunction,
): ScopeConjunction | null {
	const out: Record<string, unknown> = { ...left }
	for (const [field, predicate] of Object.entries(right)) {
		if (!(field in out)) {
			out[field] = predicate
			continue
		}
		const values = intersectValues(valuesOf(out[field]), valuesOf(predicate))
		if (values.length === 0) return null
		out[field] =
			values.length === 1 && !isIn(out[field]) && !isIn(predicate) ? values[0] : { $in: values }
	}
	return out
}

function isIn(predicate: unknown): predicate is { $in: readonly unknown[] } {
	return (
		predicate !== null &&
		typeof predicate === 'object' &&
		Array.isArray((predicate as { $in?: unknown }).$in)
	)
}

function valuesOf(predicate: unknown): readonly unknown[] {
	return isIn(predicate) ? predicate.$in : [predicate]
}

function intersectValues(a: readonly unknown[], b: readonly unknown[]): unknown[] {
	return a.filter((value) => b.some((other) => Object.is(value, other)))
}

function dedupeBranches(branches: ScopeConjunction[]): ScopeConjunction[] {
	const seen = new Set<string>()
	const out: ScopeConjunction[] = []
	for (const branch of branches) {
		const key = JSON.stringify(Object.entries(branch).sort(([a], [b]) => (a < b ? -1 : 1)))
		if (seen.has(key)) continue
		seen.add(key)
		out.push(branch)
	}
	return out
}

/** Why a write was refused. */
export type AccessDenialCode =
	/** No rule admits the write. */
	| 'ACCESS_DENIED'
	/** The write changes a field an owner/member rule keys on. */
	| 'IMMUTABLE_ACCESS_FIELD'
	/** A stamped field is not the writing user, or was changed. */
	| 'STAMP_MISMATCH'
	/** The collection is written by the server only (memberships). */
	| 'SERVER_OWNED'

/** The outcome of a write decision. */
export type AccessDecision =
	| { readonly allowed: true }
	| {
			readonly allowed: false
			readonly code: AccessDenialCode
			readonly field?: string
			readonly message: string
	  }

/** A client write to judge. */
export interface AccessWrite {
	readonly collection: string
	readonly type: 'insert' | 'update' | 'delete'
	/** The stored row (null for an insert of a new record). */
	readonly stored: Readonly<Record<string, unknown>> | null
	/** The row after the write (null for a delete). */
	readonly next: Readonly<Record<string, unknown>> | null
}

/**
 * Decide a client write under a collection's access rules:
 *
 * - The memberships collection is never written by clients (`SERVER_OWNED`).
 * - Stamped fields must equal the writing user on insert and never change.
 * - Fields an owner/member rule keys on never change (`IMMUTABLE_ACCESS_FIELD`).
 * - Insert of a new record: every field it sets that has a field rule needs that rule's `create` on the
 *   resulting row; the collection's `create` is needed when some field it sets has no
 *   field rule (an insert sets every field, defaults included).
 * - Update (and an insert onto an existing record): every changed field with a field rule needs its `update` on the stored and
 *   the resulting row; the collection's `update` (on both rows) is needed when some
 *   changed field has none.
 * - Delete: the collection's `delete` on the stored row.
 *
 * @returns `{ allowed: true }` or the reason it is refused
 */
export function authorizeAccessWrite(
	access: AccessDefinition,
	write: AccessWrite,
	ctx: Omit<AccessEvaluationContext, 'roles'>,
): AccessDecision {
	const rules = access.collections[write.collection]
	if (!rules) return { allowed: true }
	const full: AccessEvaluationContext = { ...ctx, roles: access.roles }
	if (write.collection === access.memberships) {
		return deny('SERVER_OWNED', `"${write.collection}" is written by the server only.`)
	}

	if (write.type === 'delete') {
		return write.stored !== null && evaluateAccessRule(rules.delete, write.stored, full)
			? { allowed: true }
			: deny('ACCESS_DENIED', `Not allowed to delete this "${write.collection}" record.`)
	}
	const next = write.next
	if (next === null) return deny('ACCESS_DENIED', 'A write without a resulting row is refused.')

	const stampDenial = checkStamps(rules, write, full)
	if (stampDenial) return stampDenial

	// An insert onto an existing record is an update for authorization.
	if (write.stored === null) {
		// Rules judge the row the server will store: stamped fields hold the writing user
		// (checkStamps already refused a submitted value that differs).
		return authorizeCreate(rules, write.collection, withStamps(rules, next, full), full)
	}

	const stored = write.stored
	// Over both rows and every schema field: a key missing from one side counts as
	// unset, so leaving a field out of the resulting row cannot skip its checks.
	const candidates = new Set([...rules.fieldNames, ...Object.keys(stored), ...Object.keys(next)])
	const changed = [...candidates].filter(
		(field) => field !== 'id' && !sameValue(stored[field], next[field]),
	)
	for (const field of rules.accessFields) {
		if (changed.includes(field)) {
			return deny(
				'IMMUTABLE_ACCESS_FIELD',
				`"${write.collection}.${field}" decides who may access the record; clients cannot change it. Move records between owners or groups from the server.`,
				field,
			)
		}
	}
	let needsCollectionRule = false
	for (const field of changed) {
		const fieldRule = rules.fields[field]
		if (!fieldRule) {
			needsCollectionRule = true
			continue
		}
		if (
			!evaluateAccessRule(fieldRule.update, stored, full) ||
			!evaluateAccessRule(fieldRule.update, next, full)
		) {
			return deny('ACCESS_DENIED', `Not allowed to change "${write.collection}.${field}".`, field)
		}
	}
	if (
		needsCollectionRule &&
		!(
			evaluateAccessRule(rules.update, stored, full) && evaluateAccessRule(rules.update, next, full)
		)
	) {
		return deny('ACCESS_DENIED', `Not allowed to update this "${write.collection}" record.`)
	}
	return { allowed: true }
}

function authorizeCreate(
	rules: CollectionAccess,
	collection: string,
	next: Readonly<Record<string, unknown>>,
	ctx: AccessEvaluationContext,
): AccessDecision {
	// An insert sets every field of the collection (defaults included), so the
	// collection rule applies whenever some field has no field rule, whatever keys the
	// submitted row carries.
	let needsCollectionRule = rules.fieldNames.some((field) => !rules.fields[field])
	for (const field of new Set([...rules.fieldNames, ...Object.keys(next)])) {
		if (field === 'id') continue
		const fieldRule = rules.fields[field]
		if (!fieldRule) {
			needsCollectionRule = true
			continue
		}
		const value = next[field]
		if (value === undefined || value === null) continue
		if (!evaluateAccessRule(fieldRule.create, next, ctx)) {
			return deny('ACCESS_DENIED', `Not allowed to set "${collection}.${field}".`, field)
		}
	}
	if (needsCollectionRule && !evaluateAccessRule(rules.create, next, ctx)) {
		return deny('ACCESS_DENIED', `Not allowed to create a "${collection}" record.`)
	}
	return { allowed: true }
}

/** The row with every stamped field set to the writing user. */
function withStamps(
	rules: CollectionAccess,
	row: Readonly<Record<string, unknown>>,
	ctx: AccessEvaluationContext,
): Readonly<Record<string, unknown>> {
	if (rules.stampedFields.length === 0 || ctx.user.userId === null) return row
	const out: Record<string, unknown> = { ...row }
	for (const field of rules.stampedFields) out[field] = ctx.user.userId
	return out
}

function checkStamps(
	rules: CollectionAccess,
	write: AccessWrite,
	ctx: AccessEvaluationContext,
): AccessDecision | null {
	const next = write.next
	if (next === null) return null
	for (const field of rules.stampedFields) {
		if (write.stored === null) {
			if (ctx.user.userId === null) {
				return deny('STAMP_MISMATCH', `"${field}" needs a signed-in user.`, field)
			}
			const value = next[field]
			if (value !== undefined && value !== null && value !== ctx.user.userId) {
				return deny(
					'STAMP_MISMATCH',
					`"${field}" is set by the server to the writing user; a different value is refused.`,
					field,
				)
			}
		} else if (!sameValue(write.stored[field], next[field])) {
			return deny(
				'STAMP_MISMATCH',
				`"${field}" is set once by the server and cannot change.`,
				field,
			)
		}
	}
	return null
}

function sameValue(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true
	if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
		// undefined and null are both "not set".
		return (a === undefined || a === null) && (b === undefined || b === null)
	}
	return JSON.stringify(a) === JSON.stringify(b)
}

function deny(code: AccessDenialCode, message: string, field?: string): AccessDecision {
	return field === undefined
		? { allowed: false, code, message }
		: { allowed: false, code, message, field }
}
