import { KoraError } from '@korajs/core/lite'

// ============================================================================
// Permissions
// ============================================================================

/**
 * A permission is a `resource:action` string.
 *
 * Resources are typically collection names or system resources.
 * Actions are the operations allowed on that resource.
 *
 * @example
 * ```typescript
 * const permission: Permission = 'todos:write'
 * const adminPerm: Permission = 'org:manage-members'
 * const wildcard: Permission = 'todos:*'  // all actions on todos
 * const superAdmin: Permission = '*:*'     // all actions on all resources
 * ```
 */
export type Permission = `${string}:${string}`

/**
 * Parse a permission string into its resource and action parts.
 */
export function parsePermission(permission: Permission): { resource: string; action: string } {
	const colonIndex = permission.indexOf(':')
	if (colonIndex === -1) {
		throw new InvalidPermissionError(permission)
	}
	const resource = permission.slice(0, colonIndex)
	const action = permission.slice(colonIndex + 1)
	if (resource.length === 0 || action.length === 0) {
		throw new InvalidPermissionError(permission)
	}
	return { resource, action }
}

/**
 * Check if a granted permission covers a required permission.
 * Supports wildcards: `todos:*` covers `todos:read`, `*:*` covers everything.
 */
export function permissionCovers(granted: Permission, required: Permission): boolean {
	const g = parsePermission(granted)
	const r = parsePermission(required)

	const resourceMatch = g.resource === '*' || g.resource === r.resource
	const actionMatch = g.action === '*' || g.action === r.action
	return resourceMatch && actionMatch
}

// ============================================================================
// Role Definitions
// ============================================================================

/**
 * A role definition describes a named set of permissions with optional inheritance.
 *
 * Roles form a hierarchy via `inherits`. When evaluating permissions,
 * all inherited roles' permissions are included transitively.
 *
 * @example
 * ```typescript
 * const roles: RoleDefinition[] = [
 *   { name: 'viewer', permissions: ['todos:read', 'projects:read'] },
 *   { name: 'member', permissions: ['todos:write', 'projects:write'], inherits: ['viewer'] },
 *   { name: 'admin', permissions: ['org:manage-members'], inherits: ['member'] },
 * ]
 * ```
 */
export interface RoleDefinition {
	/** Unique name for this role */
	name: string
	/** Permissions directly granted to this role */
	permissions: Permission[]
	/** Roles this role inherits from (all their permissions are included) */
	inherits?: string[]
}

// ============================================================================
// Built-in Roles
// ============================================================================

/**
 * Default built-in roles for organizations.
 *
 * These can be overridden or extended using `defineRoles()`.
 */
export const BUILT_IN_ROLES: readonly RoleDefinition[] = [
	{
		name: 'viewer',
		permissions: ['*:read'],
	},
	{
		name: 'billing',
		permissions: ['org:billing'],
	},
	{
		name: 'member',
		permissions: ['*:write', '*:delete'],
		inherits: ['viewer'],
	},
	{
		name: 'admin',
		permissions: ['org:manage-members', 'org:manage-settings', 'org:manage-invitations'],
		inherits: ['member'],
	},
	{
		name: 'owner',
		permissions: ['*:*'],
	},
] as const

// ============================================================================
// RBAC Configuration
// ============================================================================

/**
 * Configuration for the RBAC engine.
 */
export interface RbacConfig {
	/** Role definitions. Defaults to BUILT_IN_ROLES if not provided. */
	roles?: RoleDefinition[]
}

// ============================================================================
// Scope Types
// ============================================================================

/**
 * A sync scope filter for a single collection: every key is a record field and its value the
 * value a record must hold. Read-only access is not a filter key: it is expressed by leaving
 * the collection out of {@link SyncGrant.uplinkScopes}.
 *
 * @example
 * ```typescript
 * // Only todos belonging to the user within the org
 * const scope: ScopeFilter = { orgId: 'org-123', userId: 'user-456' }
 * ```
 */
export interface ScopeFilter {
	[field: string]: unknown
}

/**
 * A complete set of sync scopes, keyed by collection name.
 *
 * @example
 * ```typescript
 * const scopes: SyncScopes = {
 *   todos: { orgId: 'org-123' },
 *   projects: { orgId: 'org-123' },
 * }
 * ```
 */
export type SyncScopes = Record<string, ScopeFilter>

/**
 * A directional sync grant: the records a member may download and the records it may upload,
 * per collection. Pass it to the sync server as `downlinkScopes` / `uplinkScopes` (a
 * `resolveScopes` option of `createKoraAuthServer` or `ExternalJwtProvider` may return it as
 * is). A collection the member may read but not write is in `downlinkScopes` only.
 *
 * @example
 * ```typescript
 * // A viewer: reads todos and projects of its org, writes nothing
 * const grant: SyncGrant = {
 *   downlinkScopes: { todos: { orgId: 'org-1' }, projects: { orgId: 'org-1' } },
 *   uplinkScopes: {},
 * }
 * ```
 */
export interface SyncGrant {
	/** Records the member may download (it holds `<collection>:read`). */
	downlinkScopes: SyncScopes
	/** Records the member may upload (it holds `<collection>:write`). */
	uplinkScopes: SyncScopes
}

/**
 * Whether a set of permissions allows an action on a collection, wildcards included
 * (`todos:read`, `todos:*`, `*:read` and `*:*` all allow reading todos).
 */
export function permissionsAllow(
	permissions: readonly Permission[],
	action: string,
	collection: string,
): boolean {
	const required = `${collection}:${action}` as Permission
	return permissions.some((granted) => permissionCovers(granted, required))
}

/**
 * Build the directional grant for a member: each collection's scope (the custom resolver's,
 * or the org filter) goes to the directions the member's permissions allow.
 *
 * @param ctx - The member's context
 * @param collections - Collections to resolve
 * @param customScope - The custom resolver for a collection, if any
 * @returns The grant; a collection the member can neither read nor write is in neither map
 */
export function buildSyncGrant(
	ctx: ScopeContext,
	collections: readonly string[],
	customScope: (collection: string) => CollectionScopeResolver | undefined,
): SyncGrant {
	const grant: SyncGrant = { downlinkScopes: {}, uplinkScopes: {} }
	for (const collection of collections) {
		const canRead = permissionsAllow(ctx.permissions, 'read', collection)
		const canWrite = permissionsAllow(ctx.permissions, 'write', collection)
		if (!canRead && !canWrite) continue
		const resolver = customScope(collection)
		const scope = resolver ? resolver(ctx) : { orgId: ctx.orgId }
		if (!scope) continue
		if (canRead) grant.downlinkScopes[collection] = { ...scope }
		if (canWrite) grant.uplinkScopes[collection] = { ...scope }
	}
	return grant
}

/**
 * Custom scope resolver for a specific collection.
 * Given the user context, returns the scope filter for that collection.
 */
export type CollectionScopeResolver = (ctx: ScopeContext) => ScopeFilter | null

/**
 * Context passed to scope resolvers.
 */
export interface ScopeContext {
	userId: string
	orgId: string
	role: string
	permissions: Permission[]
}

// ============================================================================
// Errors
// ============================================================================

export class RbacError extends KoraError {
	constructor(message: string, code: string, context?: Record<string, unknown>) {
		super(message, code, context)
		this.name = 'RbacError'
	}
}

export class InvalidPermissionError extends RbacError {
	constructor(permission: string) {
		super(
			`Invalid permission format: "${permission}". Expected "resource:action".`,
			'INVALID_PERMISSION',
			{ permission },
		)
	}
}

export class RoleNotFoundError extends RbacError {
	constructor(role: string) {
		super(`Role "${role}" is not defined.`, 'ROLE_NOT_FOUND', { role })
	}
}

export class CircularInheritanceError extends RbacError {
	constructor(chain: string[]) {
		super(`Circular role inheritance detected: ${chain.join(' → ')}.`, 'CIRCULAR_INHERITANCE', {
			chain,
		})
	}
}
