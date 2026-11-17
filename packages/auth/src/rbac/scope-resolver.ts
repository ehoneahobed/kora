import type { OrgStore } from '../org/org-store'
import type { RbacEngine } from './rbac-engine'
import type { CollectionScopeResolver, Permission, ScopeContext, SyncGrant } from './rbac-types'
import { buildSyncGrant } from './rbac-types'

// ============================================================================
// OrgScopeResolver
// ============================================================================

/**
 * Resolves sync scopes for org-aware data filtering.
 *
 * Given a user, an organization, and a set of collections, this resolver determines what
 * the user may download and upload during sync, per collection, from its role's
 * permissions (`<collection>:read` / `<collection>:write`, wildcards included). With the
 * built-in roles:
 *
 * - **Owner/Admin/Member**: download and upload all org data
 * - **Viewer**: download all org data, upload nothing
 * - **Billing**: neither
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
 * const grant = await resolver.resolve('user-1', 'org-1', ['todos', 'projects'])
 * // For a member:
 * // {
 * //   downlinkScopes: { todos: { orgId: 'org-1', userId: 'user-1' }, projects: { orgId: 'org-1' } },
 * //   uplinkScopes: { todos: { orgId: 'org-1', userId: 'user-1' }, projects: { orgId: 'org-1' } },
 * // }
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
	 * Resolve the directional sync grant of a user for the given collections: per collection,
	 * what the user may download (read permission) and upload (write permission).
	 *
	 * @returns The grant, or null when the user is not a member of the organization (a role
	 *   with no data permissions, such as billing, gets an empty grant)
	 */
	async resolve(userId: string, orgId: string, collections: string[]): Promise<SyncGrant | null> {
		const membership = await this.orgStore.getMembership(orgId, userId)
		if (!membership) return null
		const ctx: ScopeContext = {
			userId,
			orgId,
			role: membership.role,
			permissions: this.rbac.getRolePermissions(membership.role),
		}
		return buildSyncGrant(ctx, collections, (c) => this.collectionScopes.get(c))
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
}
