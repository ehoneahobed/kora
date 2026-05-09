import type { OrgStore } from '../org/org-store'
import type {
	CollectionScopeResolver,
	Permission,
	RbacConfig,
	RoleDefinition,
	ScopeContext,
	ScopeFilter,
	SyncScopes,
} from './rbac-types'
import {
	BUILT_IN_ROLES,
	CircularInheritanceError,
	RoleNotFoundError,
	permissionCovers,
} from './rbac-types'

// ============================================================================
// RbacEngine
// ============================================================================

/**
 * Permission evaluation engine for role-based access control.
 *
 * The engine resolves permissions through role inheritance, supports
 * wildcard matching, and integrates with the OrgStore for membership lookups.
 *
 * @example
 * ```typescript
 * const rbac = new RbacEngine({ orgStore })
 *
 * // Check a permission
 * const canWrite = await rbac.hasPermission('user-1', 'org-1', 'todos:write')
 *
 * // Get all permissions for a user in an org
 * const perms = await rbac.getUserPermissions('user-1', 'org-1')
 *
 * // Resolve sync scopes
 * const scopes = await rbac.resolveScopes('user-1', 'org-1')
 * ```
 */
export class RbacEngine {
	private readonly orgStore: OrgStore
	private readonly roleMap: Map<string, RoleDefinition>
	private readonly resolvedPermissions = new Map<string, Permission[]>()
	private readonly collectionResolvers = new Map<string, CollectionScopeResolver>()

	constructor(orgStore: OrgStore, config?: RbacConfig) {
		this.orgStore = orgStore

		const roles = config?.roles ?? [...BUILT_IN_ROLES]
		this.roleMap = new Map()
		for (const role of roles) {
			this.roleMap.set(role.name, role)
		}

		// Validate and pre-resolve all role permissions
		this.validateRoles()
	}

	// --- Permission Checks ---

	/**
	 * Check if a user has a specific permission in an organization.
	 *
	 * Resolves the user's role from the org membership, then evaluates
	 * the role's permissions (including inherited ones) against the required permission.
	 *
	 * Returns false (not an error) if the user is not a member.
	 */
	async hasPermission(userId: string, orgId: string, permission: Permission): Promise<boolean> {
		const membership = await this.orgStore.getMembership(orgId, userId)
		if (!membership) return false

		const rolePerms = this.getRolePermissions(membership.role)
		return rolePerms.some((granted) => permissionCovers(granted, permission))
	}

	/**
	 * Get all effective permissions for a user in an organization.
	 *
	 * Returns an empty array if the user is not a member.
	 */
	async getUserPermissions(userId: string, orgId: string): Promise<Permission[]> {
		const membership = await this.orgStore.getMembership(orgId, userId)
		if (!membership) return []

		return this.getRolePermissions(membership.role)
	}

	/**
	 * Get all effective permissions for a role name.
	 * Includes permissions from inherited roles.
	 *
	 * @throws {RoleNotFoundError} if the role is not defined
	 */
	getRolePermissions(roleName: string): Permission[] {
		const cached = this.resolvedPermissions.get(roleName)
		if (cached) return cached

		if (!this.roleMap.has(roleName)) {
			throw new RoleNotFoundError(roleName)
		}

		const perms = this.resolvePermissionsForRole(roleName, new Set())
		this.resolvedPermissions.set(roleName, perms)
		return perms
	}

	/**
	 * Check if a role has a specific permission.
	 */
	roleHasPermission(roleName: string, permission: Permission): boolean {
		const perms = this.getRolePermissions(roleName)
		return perms.some((granted) => permissionCovers(granted, permission))
	}

	// --- Scope Resolution ---

	/**
	 * Register a custom scope resolver for a collection.
	 *
	 * Custom resolvers override the default scope logic for that collection.
	 */
	registerScopeResolver(collection: string, resolver: CollectionScopeResolver): void {
		this.collectionResolvers.set(collection, resolver)
	}

	/**
	 * Resolve sync scopes for a user in an organization.
	 *
	 * The scopes determine what data the user can see and modify during sync.
	 * - Owner/Admin: all org data
	 * - Member: all org data (read + write)
	 * - Viewer: all org data (read-only)
	 * - Billing: no data scopes (billing-only access)
	 *
	 * Custom collection resolvers can override the defaults.
	 *
	 * @param collections - List of collection names to resolve scopes for.
	 *                      If not provided, only custom-registered collections are included.
	 */
	async resolveScopes(
		userId: string,
		orgId: string,
		collections?: string[],
	): Promise<SyncScopes | null> {
		const membership = await this.orgStore.getMembership(orgId, userId)
		if (!membership) return null

		const permissions = this.getRolePermissions(membership.role)
		const ctx: ScopeContext = {
			userId,
			orgId,
			role: membership.role,
			permissions,
		}

		const scopes: SyncScopes = {}

		// Check if user has any data permissions at all
		const hasAnyRead = permissions.some((p) => permissionCovers(p, '*:read' as Permission))
		if (!hasAnyRead) {
			// No data access (e.g., billing-only role)
			return scopes
		}

		const isReadOnly = !permissions.some((p) => permissionCovers(p, '*:write' as Permission))

		const collectionsToResolve = collections ?? [...this.collectionResolvers.keys()]

		for (const collection of collectionsToResolve) {
			// Check custom resolver first
			const customResolver = this.collectionResolvers.get(collection)
			if (customResolver) {
				const customScope = customResolver(ctx)
				if (customScope) {
					scopes[collection] = customScope
				}
				continue
			}

			// Default scope: filter by orgId
			const scope: ScopeFilter = { orgId }
			if (isReadOnly) {
				scope.__readonly = true
			}
			scopes[collection] = scope
		}

		return scopes
	}

	// --- Role Management ---

	/**
	 * Get all defined role names.
	 */
	getRoleNames(): string[] {
		return [...this.roleMap.keys()]
	}

	/**
	 * Get a role definition by name.
	 */
	getRoleDefinition(roleName: string): RoleDefinition | null {
		return this.roleMap.get(roleName) ?? null
	}

	// --- Private ---

	/**
	 * Validate all role definitions for circular inheritance and unknown references.
	 */
	private validateRoles(): void {
		for (const role of this.roleMap.values()) {
			if (role.inherits) {
				for (const parent of role.inherits) {
					if (!this.roleMap.has(parent)) {
						throw new RoleNotFoundError(parent)
					}
				}
			}
		}

		// Check for circular inheritance
		for (const role of this.roleMap.values()) {
			this.detectCircularInheritance(role.name, new Set())
		}
	}

	/**
	 * Detect circular inheritance in role hierarchy.
	 */
	private detectCircularInheritance(roleName: string, visited: Set<string>): void {
		if (visited.has(roleName)) {
			throw new CircularInheritanceError([...visited, roleName])
		}
		visited.add(roleName)

		const role = this.roleMap.get(roleName)
		if (role?.inherits) {
			for (const parent of role.inherits) {
				this.detectCircularInheritance(parent, new Set(visited))
			}
		}
	}

	/**
	 * Recursively resolve all permissions for a role, including inherited permissions.
	 */
	private resolvePermissionsForRole(roleName: string, visited: Set<string>): Permission[] {
		if (visited.has(roleName)) return []
		visited.add(roleName)

		const role = this.roleMap.get(roleName)
		if (!role) return []

		const perms = new Set<Permission>(role.permissions)

		if (role.inherits) {
			for (const parent of role.inherits) {
				const parentPerms = this.resolvePermissionsForRole(parent, visited)
				for (const p of parentPerms) {
					perms.add(p)
				}
			}
		}

		return [...perms]
	}
}

// ============================================================================
// defineRoles builder
// ============================================================================

/**
 * Builder for defining custom roles.
 *
 * @example
 * ```typescript
 * const roles = defineRoles()
 *   .role('viewer', ['*:read'])
 *   .role('editor', ['*:write'], { inherits: ['viewer'] })
 *   .role('admin', ['org:manage-members'], { inherits: ['editor'] })
 *   .build()
 * ```
 */
export function defineRoles(): RoleBuilder {
	return new RoleBuilder()
}

class RoleBuilder {
	private roles: RoleDefinition[] = []

	/**
	 * Add a role definition.
	 */
	role(name: string, permissions: Permission[], options?: { inherits?: string[] }): RoleBuilder {
		this.roles.push({
			name,
			permissions,
			inherits: options?.inherits,
		})
		return this
	}

	/**
	 * Include the built-in roles as a base.
	 */
	withBuiltInRoles(): RoleBuilder {
		this.roles = [...BUILT_IN_ROLES, ...this.roles]
		return this
	}

	/**
	 * Build and return the role definitions array.
	 */
	build(): RoleDefinition[] {
		return [...this.roles]
	}
}
