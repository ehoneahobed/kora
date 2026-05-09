import type { OrgStore } from '../org/org-store'
import type { OrgRole } from '../org/org-types'
import type { RbacEngine } from './rbac-engine'
import type {
	CollectionScopeResolver,
	Permission,
	ScopeContext,
	ScopeFilter,
	SyncScopes,
} from './rbac-types'
import { permissionCovers } from './rbac-types'

// ============================================================================
// OrgScopeResolver
// ============================================================================

/**
 * Resolves sync scopes for org-aware data filtering.
 *
 * Given a user, an organization, and a set of collections, this resolver
 * determines what data the user should receive during sync:
 *
 * - **Owner/Admin**: All data in the org (no field-level filtering)
 * - **Member**: All org data with read/write access
 * - **Viewer**: All org data with read-only flag
 * - **Billing**: No data access (empty scopes)
 *
 * Developers can register per-collection scope resolvers for fine-grained control.
 *
 * @example
 * ```typescript
 * const resolver = new OrgScopeResolver(orgStore, rbacEngine)
 *
 * // Custom scope: members only see their own todos
 * resolver.registerCollectionScope('todos', (ctx) => {
 *   if (ctx.role === 'member') {
 *     return { orgId: ctx.orgId, userId: ctx.userId }
 *   }
 *   return { orgId: ctx.orgId }  // admins/owners see all
 * })
 *
 * const scopes = await resolver.resolve('user-1', 'org-1', ['todos', 'projects'])
 * // { todos: { orgId: 'org-1', userId: 'user-1' }, projects: { orgId: 'org-1' } }
 * ```
 */
export class OrgScopeResolver {
	private readonly orgStore: OrgStore
	private readonly rbac: RbacEngine
	private readonly collectionScopes = new Map<string, CollectionScopeResolver>()

	constructor(orgStore: OrgStore, rbac: RbacEngine) {
		this.orgStore = orgStore
		this.rbac = rbac
	}

	/**
	 * Register a custom scope resolver for a collection.
	 * This overrides the default orgId-based filtering for that collection.
	 */
	registerCollectionScope(collection: string, resolver: CollectionScopeResolver): void {
		this.collectionScopes.set(collection, resolver)
	}

	/**
	 * Resolve sync scopes for all specified collections.
	 *
	 * Returns null if the user is not a member of the organization.
	 * Returns an empty object if the user has no data access (e.g., billing role).
	 */
	async resolve(userId: string, orgId: string, collections: string[]): Promise<SyncScopes | null> {
		const membership = await this.orgStore.getMembership(orgId, userId)
		if (!membership) return null

		const permissions = this.rbac.getRolePermissions(membership.role)
		const ctx: ScopeContext = {
			userId,
			orgId,
			role: membership.role,
			permissions,
		}

		const scopes: SyncScopes = {}

		for (const collection of collections) {
			const scope = this.resolveCollectionScope(ctx, collection)
			if (scope) {
				scopes[collection] = scope
			}
		}

		return scopes
	}

	/**
	 * Check if a user can write to a specific collection in an org.
	 */
	async canWrite(userId: string, orgId: string, collection: string): Promise<boolean> {
		return this.rbac.hasPermission(userId, orgId, `${collection}:write` as Permission)
	}

	/**
	 * Check if a user can read from a specific collection in an org.
	 */
	async canRead(userId: string, orgId: string, collection: string): Promise<boolean> {
		return this.rbac.hasPermission(userId, orgId, `${collection}:read` as Permission)
	}

	// --- Private ---

	private resolveCollectionScope(ctx: ScopeContext, collection: string): ScopeFilter | null {
		// Check if user has read permission for this collection
		const canRead = ctx.permissions.some(
			(p) =>
				permissionCovers(p, `${collection}:read` as Permission) ||
				permissionCovers(p, '*:read' as Permission),
		)
		if (!canRead) return null

		// Check custom resolver
		const customResolver = this.collectionScopes.get(collection)
		if (customResolver) {
			return customResolver(ctx)
		}

		// Default scope: filter by orgId
		const scope: ScopeFilter = { orgId: ctx.orgId }

		// Check if write access is available
		const canWrite = ctx.permissions.some(
			(p) =>
				permissionCovers(p, `${collection}:write` as Permission) ||
				permissionCovers(p, '*:write' as Permission),
		)
		if (!canWrite) {
			scope.__readonly = true
		}

		return scope
	}
}
