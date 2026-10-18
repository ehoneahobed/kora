/**
 * Access rules: the vocabulary a schema uses to say who may read and write a record
 * (`owner('ownerId')`, `member('documentId', 'edit')`, `or(...)`, ...).
 *
 * A rule is plain, frozen data. `defineSchema` validates it against the schema and
 * resolves defaults (which group collection a `member()` rule points at), the server
 * evaluates it against stored rows and memberships it owns, and the compiler turns a
 * read rule into the scope predicate the download stream and the client's offline
 * pre-checks use. Nothing here trusts a client.
 */

/** Scalar values a `where()` rule may compare against. */
export type AccessScalar = string | number | boolean

/** `r[field] === user.id`. */
export interface OwnerRule {
	readonly kind: 'owner'
	readonly field: string
}

/**
 * The user holds a live membership of at least `minRole` in group
 * `<group>:<r[field]>`. `group` is null until `defineSchema` resolves it.
 */
export interface MemberRule {
	readonly kind: 'member'
	readonly field: string
	readonly minRole: string | null
	readonly group: string | null
	/**
	 * `false`: only real memberships (memberships-collection rows and the group owner)
	 * satisfy the rule; a capability grant (`AuthContext.accessGrants`) does not. Absent
	 * (the normalized form of `true`, the default) admits grants too.
	 */
	readonly grants?: boolean
}

/** `r[field]` is a group key (`documents:<id>`) the user is a live member of. */
export interface MemberOfKeyRule {
	readonly kind: 'memberOfKey'
	readonly field: string
	readonly minRole: string | null
	/** As {@link MemberRule.grants}. */
	readonly grants?: boolean
}

/** Options of `member()`. */
export interface MemberRuleOptions {
	/**
	 * The group collection `field` names. Defaults to the collection itself for
	 * `member('id')` and otherwise to the collection a relation on `field` points at.
	 */
	group?: string
	/**
	 * Whether a capability grant (`AuthContext.accessGrants`, such as a share link)
	 * satisfies the rule. Default `true`. `false` requires a real membership (a
	 * memberships-collection row or group ownership): use it for collaborator
	 * information, such as who has access, that a link holder should not see.
	 */
	grants?: boolean
}

/** Options of `memberOfKey()`. */
export interface MemberOfKeyRuleOptions {
	/** As {@link MemberRuleOptions.grants}. */
	grants?: boolean
}

/** Every listed field equals its value. */
export interface WhereRule {
	readonly kind: 'where'
	readonly equals: Readonly<Record<string, AccessScalar>>
}

/** Always, anonymous sessions included. Writes need `anyone({ writes: true })`. */
export interface AnyoneRule {
	readonly kind: 'anyone'
	readonly writes: boolean
}

/** Never from a client: only the server (routes, `server.access`, migrations) writes. */
export interface ServerOnlyRule {
	readonly kind: 'serverOnly'
}

/** At least one rule holds. */
export interface OrRule {
	readonly kind: 'or'
	readonly rules: readonly AccessRule[]
}

/** Every rule holds. */
export interface AndRule {
	readonly kind: 'and'
	readonly rules: readonly AccessRule[]
}

/**
 * Server-side escape hatch: a pure function of the record, the user and their
 * memberships. Allowed in write rules only (a read rule must compile to a predicate
 * the download stream can evaluate).
 */
export interface CustomRule {
	readonly kind: 'custom'
	readonly check: CustomAccessCheck
}

/** What a `custom()` rule receives. */
export interface CustomAccessInput {
	readonly record: Readonly<Record<string, unknown>>
	readonly user: AccessPrincipal
	readonly memberships: MembershipView
}

/** A `custom()` rule's check. Must be pure and synchronous. */
export type CustomAccessCheck = (input: CustomAccessInput) => boolean

/** Any access rule. */
export type AccessRule =
	| OwnerRule
	| MemberRule
	| MemberOfKeyRule
	| WhereRule
	| AnyoneRule
	| ServerOnlyRule
	| OrRule
	| AndRule
	| CustomRule

/** The user a decision is made for. `userId` is null for an anonymous session. */
export interface AccessPrincipal {
	readonly userId: string | null
}

/** Which memberships a {@link MembershipView} question counts. */
export interface MembershipQuery {
	/**
	 * Whether capability grants (`AuthContext.accessGrants`) count. Default `true`.
	 * `false` counts only real memberships: memberships-collection rows and group
	 * ownership.
	 */
	readonly grants?: boolean
}

/**
 * The live memberships of one user, as the server's membership index (or the
 * client's cached grant) knows them, together with the session's capability grants.
 * Expired memberships are not live.
 *
 * An implementation must honor `options.grants === false` (leave grants out); the
 * views Kora builds do.
 */
export interface MembershipView {
	/**
	 * The user's role in `groupKey`, or null when they are not a live member. With
	 * `{ grants: false }`, the role of their real memberships only (a group reached only
	 * through a capability grant gives null).
	 */
	roleOf(groupKey: string, options?: MembershipQuery): string | null
	/** Every group key the user is a live member of (`{ grants: false }`: real memberships only). */
	groupKeys(options?: MembershipQuery): readonly string[]
}

/**
 * True when a rule (or a {@link MembershipQuery}) admits capability grants. Only an
 * absent value or `true` does: any other value (a hand-built rule with a malformed
 * flag) counts as `false`, so a mistake narrows access instead of widening it.
 */
export function admitsGrants(flag: unknown): boolean {
	return flag === undefined || flag === true
}

/** Separator between a group's collection and its record id. */
export const GROUP_KEY_SEPARATOR = ':'

/**
 * The key of a group: its collection and record id (`documents:<id>`). Namespacing
 * means a document whose id equals a course id grants nothing on the course.
 *
 * @param collection - The group's collection
 * @param id - The group record's id
 */
export function groupKey(collection: string, id: string): string {
	return `${collection}${GROUP_KEY_SEPARATOR}${id}`
}

/**
 * Split a group key into collection and id, or null when it is not one. Collection
 * names never contain `:`, so the first separator splits.
 */
export function parseGroupKey(key: string): { collection: string; id: string } | null {
	const at = key.indexOf(GROUP_KEY_SEPARATOR)
	if (at <= 0 || at === key.length - 1) return null
	return { collection: key.slice(0, at), id: key.slice(at + 1) }
}

/** True when `value` is an access rule built by this module. */
export function isAccessRule(value: unknown): value is AccessRule {
	if (value === null || typeof value !== 'object') return false
	const kind = (value as { kind?: unknown }).kind
	return (
		kind === 'owner' ||
		kind === 'member' ||
		kind === 'memberOfKey' ||
		kind === 'where' ||
		kind === 'anyone' ||
		kind === 'serverOnly' ||
		kind === 'or' ||
		kind === 'and' ||
		kind === 'custom'
	)
}

/**
 * The record's `field` is the user's id.
 *
 * @example
 * ```typescript
 * access: { read: owner('userId'), write: owner('userId') }
 * ```
 */
export function owner(field: string): OwnerRule {
	return Object.freeze({ kind: 'owner', field })
}

/**
 * The user is a live member, with at least `minRole`, of the group the record's
 * `field` names. The group collection defaults to the collection itself for
 * `member('id')` and otherwise to the collection a relation on `field` points at.
 * A capability grant (a share link) counts as a membership unless
 * `{ grants: false }`.
 *
 * @example
 * ```typescript
 * read: member('documentId', 'view', { group: 'documents' })
 * // Collaborators only: a share link to the document does not satisfy it.
 * read: member('documentId', 'view', { group: 'documents', grants: false })
 * ```
 */
export function member(field: string, minRole?: string, options?: MemberRuleOptions): MemberRule {
	return Object.freeze({
		kind: 'member',
		field,
		minRole: minRole ?? null,
		group: options?.group ?? null,
		// Carried as given so defineSchema can refuse a non-boolean; it drops `true`.
		...(options?.grants === undefined ? {} : { grants: options.grants }),
	})
}

/**
 * The record's `field` holds a group key (`documents:<id>`) the user is a live member
 * of. For the memberships collection itself: members see a group's member list. Pass
 * `{ grants: false }` so a capability grant (a share link) does not reveal it.
 *
 * @example
 * ```typescript
 * read: memberOfKey('group', undefined, { grants: false })
 * ```
 */
export function memberOfKey(
	field: string,
	minRole?: string,
	options?: MemberOfKeyRuleOptions,
): MemberOfKeyRule {
	return Object.freeze({
		kind: 'memberOfKey',
		field,
		minRole: minRole ?? null,
		...(options?.grants === undefined ? {} : { grants: options.grants }),
	})
}

/** Every listed field equals its value (`where({ status: 'published' })`). */
export function where(equals: Record<string, AccessScalar>): WhereRule {
	return Object.freeze({ kind: 'where', equals: Object.freeze({ ...equals }) })
}

/**
 * Always, anonymous sessions included. Allowed in `read`; a write rule needs
 * `anyone({ writes: true })` so opening writes to everyone is never an accident.
 */
export function anyone(options?: { writes?: boolean }): AnyoneRule {
	return Object.freeze({ kind: 'anyone', writes: options?.writes === true })
}

/** Never from a client. */
export function serverOnly(): ServerOnlyRule {
	return Object.freeze({ kind: 'serverOnly' })
}

/** At least one of `rules` holds. */
export function or(...rules: AccessRule[]): OrRule {
	return Object.freeze({ kind: 'or', rules: Object.freeze([...rules]) })
}

/** Every one of `rules` holds. */
export function and(...rules: AccessRule[]): AndRule {
	return Object.freeze({ kind: 'and', rules: Object.freeze([...rules]) })
}

/**
 * Server-side escape hatch for write rules: a pure, synchronous function of the
 * record, the user and their memberships. It may not depend on time or other records,
 * because nothing would tell sessions when its answer changes.
 */
export function custom(check: CustomAccessCheck): CustomRule {
	return Object.freeze({ kind: 'custom', check })
}
