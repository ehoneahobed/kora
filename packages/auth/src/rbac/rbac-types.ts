import { KoraError } from '@korajs/core'

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
 * A sync scope filter for a single collection.
 * The keys are field names and values are the required values.
 * A special `__readonly` key can be set to restrict to read-only access.
 *
 * @example
 * ```typescript
 * // Only sync todos belonging to the user within the org
 * const scope: ScopeFilter = { orgId: 'org-123', userId: 'user-456' }
 *
 * // Read-only scope for viewers
 * const readOnlyScope: ScopeFilter = { orgId: 'org-123', __readonly: true }
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
