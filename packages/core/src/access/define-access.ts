/**
 * Validates a schema's `access` declarations and resolves them into an
 * `AccessDefinition`: every rule checked against the schema, every `member()` rule's
 * group collection resolved, `write` expanded, and the fields the rules key on
 * collected (clients may never change those).
 *
 * Validation runs in `defineSchema`, so a mistake fails at app start with a message
 * that names the collection, the rule and the fix.
 */

import { SchemaValidationError } from '../errors/errors'
import { MAX_SCOPE_BRANCHES } from '../scopes/scope-predicate'
import type { CollectionDefinition, FieldDescriptor, RelationDefinition } from '../types'
import { type AccessRule, isAccessRule } from './rules'

/** The schema-level `access` block. */
export interface AccessConfigInput {
	/** The collection holding memberships: `{ userId, group, role, expiresAt? }`. */
	memberships?: string
	/** Roles ordered lowest to highest: `member(f, 'comment')` admits every higher role too. */
	roles?: readonly string[]
	/**
	 * Group collections whose creator becomes a member: when the server takes in the
	 * first insert of `documents`, the user in `owner` joins `documents:<id>` as `role`.
	 */
	groups?: Readonly<Record<string, { owner: string; role: string }>>
}

/** Field-level write rules. `write` is shorthand for `create` and `update`. */
export interface FieldAccessInput {
	write?: AccessRule
	create?: AccessRule
	update?: AccessRule
}

/** A collection's `access` block. */
export interface CollectionAccessInput {
	read?: AccessRule
	/** Shorthand for `create`, `update` and `delete`. */
	write?: AccessRule
	create?: AccessRule
	update?: AccessRule
	delete?: AccessRule
	fields?: Readonly<Record<string, FieldAccessInput>>
}

/** A field's resolved write rules (null: no client may set it). */
export interface FieldAccess {
	readonly create: AccessRule | null
	readonly update: AccessRule | null
}

/** A collection's resolved rules. A null rule denies every client. */
export interface CollectionAccess {
	readonly read: AccessRule | null
	readonly create: AccessRule | null
	readonly update: AccessRule | null
	readonly delete: AccessRule | null
	readonly fields: Readonly<Record<string, FieldAccess>>
	/**
	 * Fields some `owner()`, `member()` or `memberOfKey()` rule keys on (plus a group
	 * collection's owner field and the memberships' `userId` and `group`). Clients may
	 * set them on insert and never change them: moving a record between owners or groups
	 * is a server write, so no write can keep access through another branch of `or()`.
	 */
	readonly accessFields: readonly string[]
	/** Fields the server sets to the writing user on insert (`t.string().stamp('userId')`). */
	readonly stampedFields: readonly string[]
}

/** The resolved access model of a schema. */
export interface AccessDefinition {
	/** The memberships collection, or null when no rule uses memberships. */
	readonly memberships: string | null
	readonly roles: readonly string[]
	readonly groups: Readonly<Record<string, { readonly owner: string; readonly role: string }>>
	/** Collections that declare `access`. Others keep their provider grant. */
	readonly collections: Readonly<Record<string, CollectionAccess>>
}

/** Largest number of roles. */
export const MAX_ACCESS_ROLES = 32

const WRITE_TYPES = ['create', 'update', 'delete'] as const

/**
 * Build the access definition of a schema.
 *
 * @returns The definition, or undefined when the schema declares no access at all
 * @throws {SchemaValidationError} on any invalid declaration
 */
export function buildAccessDefinition(
	config: AccessConfigInput | undefined,
	collectionAccess: Readonly<Record<string, CollectionAccessInput | undefined>>,
	collections: Readonly<Record<string, CollectionDefinition>>,
	relations: Readonly<Record<string, RelationDefinition>>,
): AccessDefinition | undefined {
	const declared = Object.entries(collectionAccess).filter(
		(entry): entry is [string, CollectionAccessInput] => entry[1] !== undefined,
	)
	const stampedAnywhere = Object.entries(collections).some(([, c]) =>
		Object.values(c.fields).some((f) => f.stamp),
	)
	if (!config && declared.length === 0) {
		if (stampedAnywhere) {
			throw new SchemaValidationError(
				'A field uses stamp(), which only takes effect on collections with `access` rules. Add `access` to its collection or remove stamp().',
			)
		}
		return undefined
	}

	const roles = validateRoles(config?.roles)
	const memberships = validateMemberships(config?.memberships, collections)
	if (memberships !== null && roles.length === 0) {
		// Every membership row carries a role; with no roles declared, none would count.
		throw new SchemaValidationError(
			"access.memberships needs access.roles, lowest to highest (e.g. ['view', 'edit', 'manage']): a membership whose role is not declared grants nothing.",
		)
	}
	const groups = validateGroups(config?.groups, collections, roles)

	const ctx: RuleContext = { collections, relations, roles, memberships }
	const resolved: Record<string, CollectionAccess> = {}
	for (const [name, input] of declared) {
		const collection = collections[name]
		if (!collection) continue
		if (collection.scope.length > 0) {
			throw new SchemaValidationError(
				`Collection "${name}" declares both \`access\` and a sync scope (\`scope\` or \`sync.where\`). Use one: access rules replace scopes for this collection.`,
				{ collection: name },
			)
		}
		resolved[name] = resolveCollection(name, input, collection, ctx)
	}

	for (const [name, collection] of Object.entries(collections)) {
		for (const [field, descriptor] of Object.entries(collection.fields)) {
			if (descriptor.stamp && !resolved[name]) {
				throw new SchemaValidationError(
					`Field "${name}.${field}" uses stamp('userId'), which only takes effect on collections with \`access\` rules. Add \`access\` to "${name}" or remove stamp().`,
					{ collection: name, field },
				)
			}
		}
	}

	if (memberships !== null) {
		// The memberships collection is written by the server only (`server.access.*`).
		const own = resolved[memberships]
		if (own && (own.create || own.update || own.delete || Object.keys(own.fields).length > 0)) {
			throw new SchemaValidationError(
				`The memberships collection "${memberships}" may declare only a \`read\` rule: memberships are written by the server (server.access.grant/revoke).`,
				{ collection: memberships },
			)
		}
		resolved[memberships] = {
			read: own?.read ?? null,
			create: null,
			update: null,
			delete: null,
			fields: {},
			accessFields: sortedUnique([...(own?.accessFields ?? []), 'userId', 'group']),
			stampedFields: [],
		}
	}

	for (const [name, group] of Object.entries(groups)) {
		const access = resolved[name]
		if (!access) {
			throw new SchemaValidationError(
				`Group collection "${name}" (access.groups) must declare its own \`access\` rules.`,
				{ collection: name },
			)
		}
		resolved[name] = {
			...access,
			accessFields: sortedUnique([...access.accessFields, group.owner]),
		}
	}

	return Object.freeze({
		memberships,
		roles,
		groups,
		collections: Object.freeze(resolved),
	})
}

interface RuleContext {
	collections: Readonly<Record<string, CollectionDefinition>>
	relations: Readonly<Record<string, RelationDefinition>>
	roles: readonly string[]
	memberships: string | null
}

function validateRoles(roles: readonly string[] | undefined): readonly string[] {
	if (roles === undefined) return Object.freeze([])
	if (!Array.isArray(roles) || roles.length === 0 || roles.length > MAX_ACCESS_ROLES) {
		throw new SchemaValidationError(
			`access.roles must list 1 to ${MAX_ACCESS_ROLES} roles, lowest to highest (e.g. ['view', 'edit', 'manage']).`,
		)
	}
	const seen = new Set<string>()
	for (const role of roles) {
		if (typeof role !== 'string' || role.length === 0) {
			throw new SchemaValidationError('access.roles must contain non-empty strings.')
		}
		if (seen.has(role)) {
			throw new SchemaValidationError(`access.roles lists "${role}" twice.`, { role })
		}
		seen.add(role)
	}
	return Object.freeze([...roles])
}

function validateMemberships(
	name: string | undefined,
	collections: Readonly<Record<string, CollectionDefinition>>,
): string | null {
	if (name === undefined) return null
	const collection = collections[name]
	if (!collection) {
		throw new SchemaValidationError(
			`access.memberships names "${name}", which is not a collection. Available collections: ${Object.keys(collections).join(', ')}`,
			{ collection: name },
		)
	}
	const expect = (field: string, kinds: readonly string[], required: boolean): void => {
		const descriptor = collection.fields[field]
		if (!descriptor) {
			if (!required) return
			throw new SchemaValidationError(
				`The memberships collection "${name}" needs a "${field}" field (${kinds.join(' or ')}).`,
				{ collection: name, field },
			)
		}
		if (!kinds.includes(descriptor.kind)) {
			throw new SchemaValidationError(
				`Field "${name}.${field}" must be ${kinds.join(' or ')} to hold memberships; it is ${descriptor.kind}.`,
				{ collection: name, field },
			)
		}
	}
	expect('userId', ['string'], true)
	expect('group', ['string'], true)
	expect('role', ['string', 'enum'], true)
	expect('expiresAt', ['timestamp'], false)
	return name
}

function validateGroups(
	groups: AccessConfigInput['groups'],
	collections: Readonly<Record<string, CollectionDefinition>>,
	roles: readonly string[],
): Readonly<Record<string, { owner: string; role: string }>> {
	const out: Record<string, { owner: string; role: string }> = {}
	for (const [name, group] of Object.entries(groups ?? {})) {
		const collection = collections[name]
		if (!collection) {
			throw new SchemaValidationError(`access.groups names "${name}", which is not a collection.`, {
				collection: name,
			})
		}
		const ownerField = collection.fields[group.owner]
		if (!ownerField || ownerField.kind !== 'string') {
			throw new SchemaValidationError(
				`access.groups.${name}.owner must name a string field of "${name}" (it names "${group.owner}").`,
				{ collection: name, field: group.owner },
			)
		}
		if (!roles.includes(group.role)) {
			throw new SchemaValidationError(
				`access.groups.${name}.role "${group.role}" is not in access.roles (${roles.join(', ') || 'none declared'}).`,
				{ collection: name, role: group.role },
			)
		}
		out[name] = Object.freeze({ owner: group.owner, role: group.role })
	}
	return Object.freeze(out)
}

function resolveCollection(
	name: string,
	input: CollectionAccessInput,
	collection: CollectionDefinition,
	ctx: RuleContext,
): CollectionAccess {
	for (const type of WRITE_TYPES) {
		if (input.write !== undefined && input[type] !== undefined) {
			throw new SchemaValidationError(
				`Collection "${name}" declares both \`write\` and \`${type}\`. Use \`write\` for all three, or \`create\`, \`update\` and \`delete\` separately.`,
				{ collection: name },
			)
		}
	}
	const keyed = new Set<string>()
	const resolve = (rule: AccessRule | undefined, where: string, isRead: boolean) =>
		rule === undefined ? null : resolveRule(rule, name, collection, ctx, where, isRead, keyed)

	const read = resolve(input.read, 'read', true)
	const create = resolve(input.create ?? input.write, 'create', false)
	const update = resolve(input.update ?? input.write, 'update', false)
	const del = resolve(input.delete ?? input.write, 'delete', false)

	const fields: Record<string, FieldAccess> = {}
	for (const [field, fieldInput] of Object.entries(input.fields ?? {})) {
		if (!(field in collection.fields)) {
			throw new SchemaValidationError(
				`access.fields of "${name}" names "${field}", which is not a field of the collection.`,
				{ collection: name, field },
			)
		}
		for (const type of ['create', 'update'] as const) {
			if (fieldInput.write !== undefined && fieldInput[type] !== undefined) {
				throw new SchemaValidationError(
					`access.fields.${field} of "${name}" declares both \`write\` and \`${type}\`.`,
					{ collection: name, field },
				)
			}
		}
		fields[field] = Object.freeze({
			create: resolve(fieldInput.create ?? fieldInput.write, `fields.${field}.create`, false),
			update: resolve(fieldInput.update ?? fieldInput.write, `fields.${field}.update`, false),
		})
	}

	const stampedFields: string[] = []
	for (const [field, descriptor] of Object.entries(collection.fields)) {
		if (descriptor.stamp) stampedFields.push(field)
	}
	// A record's id never changes, so it needs no immutability check.
	keyed.delete('id')

	return Object.freeze({
		read,
		create,
		update,
		delete: del,
		fields: Object.freeze(fields),
		accessFields: sortedUnique([...keyed]),
		stampedFields: sortedUnique(stampedFields),
	})
}

/**
 * Validate one rule tree and resolve `member()` group defaults. Fields that owner,
 * member and memberOfKey rules key on are added to `keyed`.
 */
function resolveRule(
	rule: AccessRule,
	collectionName: string,
	collection: CollectionDefinition,
	ctx: RuleContext,
	location: string,
	isRead: boolean,
	keyed: Set<string>,
): AccessRule {
	const at = `access.${location} of "${collectionName}"`
	const fail = (message: string, context: Record<string, unknown> = {}): never => {
		throw new SchemaValidationError(`${at}: ${message}`, {
			collection: collectionName,
			rule: location,
			...context,
		})
	}
	const fieldOf = (field: string, kinds: readonly FieldDescriptor['kind'][]): void => {
		if (field === 'id') return
		const descriptor = collection.fields[field]
		if (!descriptor) fail(`"${field}" is not a field of the collection.`, { field })
		else if (!kinds.includes(descriptor.kind)) {
			fail(`"${field}" must be ${kinds.join(' or ')}; it is ${descriptor.kind}.`, { field })
		}
	}
	const roleOf = (role: string | null): void => {
		if (role === null) return
		if (!ctx.roles.includes(role)) {
			fail(`role "${role}" is not in access.roles (${ctx.roles.join(', ') || 'none declared'}).`, {
				role,
			})
		}
	}
	const needsMemberships = (): void => {
		if (ctx.memberships === null) {
			fail(
				'member() and memberOfKey() need a memberships collection: declare access.memberships in the schema.',
			)
		}
		if (ctx.roles.length === 0) {
			fail(
				"member() and memberOfKey() need roles: declare access.roles, lowest to highest (e.g. ['view', 'edit', 'manage']).",
			)
		}
	}

	const visit = (node: unknown, depth: number): AccessRule => {
		if (depth > 16) fail('rules are nested too deeply.')
		if (!isAccessRule(node)) {
			return fail(
				'expected a rule built with owner(), member(), memberOfKey(), where(), anyone(), serverOnly(), or(), and() or custom().',
			)
		}
		switch (node.kind) {
			case 'owner':
				fieldOf(node.field, ['string'])
				keyed.add(node.field)
				return node
			case 'member': {
				needsMemberships()
				fieldOf(node.field, ['string'])
				roleOf(node.minRole)
				const group = node.group ?? defaultGroup(node.field)
				if (!(group in ctx.collections)) {
					fail(`member() group "${group}" is not a collection.`, { group })
				}
				keyed.add(node.field)
				return Object.freeze({ ...node, group })
			}
			case 'memberOfKey':
				needsMemberships()
				fieldOf(node.field, ['string'])
				roleOf(node.minRole)
				keyed.add(node.field)
				return node
			case 'where': {
				const entries = Object.entries(node.equals)
				if (entries.length === 0) fail('where() needs at least one field.')
				for (const [field, value] of entries) {
					fieldOf(field, ['string', 'number', 'boolean', 'enum', 'timestamp'])
					if (
						!(typeof value === 'string' || typeof value === 'boolean') &&
						!(typeof value === 'number' && Number.isFinite(value))
					) {
						fail(`where() value of "${field}" must be a string, finite number or boolean.`, {
							field,
						})
					}
				}
				return node
			}
			case 'anyone':
				if (!isRead && !node.writes) {
					fail(
						'anyone() opens writes to every client, signed in or not. Write anyone({ writes: true }) if that is intended.',
					)
				}
				return node
			case 'serverOnly':
				return node
			case 'or':
			case 'and': {
				if (node.rules.length === 0) fail(`${node.kind}() needs at least one rule.`)
				const rules = Object.freeze(node.rules.map((child) => visit(child, depth + 1)))
				return Object.freeze({ kind: node.kind, rules })
			}
			case 'custom':
				if (isRead) {
					fail(
						'custom() is allowed in write rules only: a read rule must compile to a predicate the download stream can evaluate. Express it with owner(), member(), where(), or() and and().',
					)
				}
				if (typeof node.check !== 'function') fail('custom() needs a function.')
				return node
		}
	}

	const defaultGroup = (field: string): string => {
		if (field === 'id') return collectionName
		const matches = Object.values(ctx.relations).filter(
			(relation) => relation.from === collectionName && relation.field === field,
		)
		const targets = [...new Set(matches.map((relation) => relation.to))]
		if (targets.length !== 1 || targets[0] === undefined) {
			return fail(
				`member('${field}') cannot tell which collection's groups "${field}" names. Pass it: member('${field}', role, { group: '<collection>' }).`,
				{ field },
			)
		}
		return targets[0]
	}

	const resolved = visit(rule, 0)
	if (isRead && compiledBranchCount(resolved) > MAX_SCOPE_BRANCHES) {
		fail(
			`the read rule expands to more than ${MAX_SCOPE_BRANCHES} alternatives. Simplify the or()/and() nesting.`,
		)
	}
	return resolved
}

/**
 * Upper bound of the branches a read rule compiles to: `or` adds, `and` multiplies.
 * Checked at definition time, so a valid schema never produces an oversized grant.
 */
export function compiledBranchCount(rule: AccessRule): number {
	switch (rule.kind) {
		case 'or':
			return rule.rules.reduce((sum, child) => sum + compiledBranchCount(child), 0)
		case 'and':
			return rule.rules.reduce((product, child) => product * compiledBranchCount(child), 1)
		default:
			return 1
	}
}

function sortedUnique(values: readonly string[]): readonly string[] {
	return Object.freeze([...new Set(values)].sort())
}
