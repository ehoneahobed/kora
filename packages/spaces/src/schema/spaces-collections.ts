import type { AccessConfigInput, CollectionInput } from '@korajs/core'
import { KoraError, memberOfKey, serverOnly, t } from '@korajs/core'

/** The memberships collection the kit owns (`userId`, `group`, `role`, `invitedBy`). */
export const SPACE_MEMBERS = 'space_members'
/** Pending invitations, readable by the group's managers. */
export const SPACE_INVITATIONS = 'space_invitations'
/** Invitation token hashes and the inviter's authority. Never leaves the server. */
export const SPACE_INVITATION_SECRETS = 'space_invitation_secrets'

/** A group collection shared through the kit: which field of its records holds the owner. */
export interface SpacesGroupConfig {
	/** The owner field, usually `t.string().stamp('userId')`. */
	owner: string
}

/** Input of {@link spacesCollections}. */
export interface SpacesConfig<Role extends string = string, Group extends string = string> {
	/** Roles, lowest to highest. The owner role must be the highest. */
	roles: readonly Role[]
	/** The role a group's owner holds, through the group record's owner field only. */
	ownerRole: Role
	/** The lowest role that may invite, change roles and remove members. Below `ownerRole`. */
	manageRole: Role
	/** The collections whose records are shared spaces (a form, a document, a board). */
	groups: Readonly<Record<Group, SpacesGroupConfig>>
}

/** The kit's three collections, ready to spread into `defineSchema({ collections })`. */
export interface SpacesCollectionsInput {
	space_members: CollectionInput
	space_invitations: CollectionInput
	space_invitation_secrets: CollectionInput
}

/**
 * The result of {@link spacesCollections}: the schema parts, and the configuration the
 * server routes and React hooks read. Pass the same object to `spacesRoutes({ sharing })`.
 */
export interface Sharing<Role extends string = string, Group extends string = string> {
	readonly roles: readonly Role[]
	readonly ownerRole: Role
	readonly manageRole: Role
	readonly groups: Readonly<Record<Group, SpacesGroupConfig>>
	/** `defineSchema({ access })`. */
	readonly access: AccessConfigInput
	/** Spread into `defineSchema({ collections })`. */
	readonly collections: SpacesCollectionsInput
	/** The rank of `role` (0 = lowest), or -1 when it is not a role. */
	rank(role: string): number
}

/** Thrown when `spacesCollections` is given a configuration it cannot share safely. */
export class SpacesConfigError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'SPACES_CONFIG_INVALID', context)
		this.name = 'SpacesConfigError'
	}
}

/**
 * Declare sharing for one or more group collections: the access configuration (the
 * memberships collection, the roles, which collections are groups) and the kit's
 * collections (members, pending invitations, invitation secrets). Every membership and
 * invitation is written by the kit's server routes; clients read them as synced data.
 *
 * @param config - Roles (lowest to highest), the owner and manager roles, and the group collections
 * @returns The schema parts and the configuration to hand to `spacesRoutes`
 * @throws {SpacesConfigError} when the roles or groups cannot be shared safely
 *
 * @example
 * ```typescript
 * export const sharing = spacesCollections({
 *   roles: ['viewer', 'editor', 'admin', 'owner'],
 *   ownerRole: 'owner',
 *   manageRole: 'admin',
 *   groups: { forms: { owner: 'ownerId' } },
 * })
 *
 * export default defineSchema({
 *   version: 1,
 *   access: sharing.access,
 *   collections: { ...sharing.collections, forms: { ... } },
 * })
 * ```
 */
export function spacesCollections<const Role extends string, const Group extends string>(
	config: SpacesConfig<Role, Group>,
): Sharing<Role, Group> {
	const roles = [...config.roles]
	if (roles.length < 2) {
		throw new SpacesConfigError(
			'spacesCollections needs at least two roles (a member role and the owner role).',
			{
				roles,
			},
		)
	}
	const seen = new Set<string>()
	for (const role of roles) {
		if (typeof role !== 'string' || role.length === 0) {
			throw new SpacesConfigError('Every role must be a non-empty string.', { roles })
		}
		if (seen.has(role)) throw new SpacesConfigError(`Role "${role}" is listed twice.`, { roles })
		seen.add(role)
	}
	const ownerRank = roles.indexOf(config.ownerRole)
	const manageRank = roles.indexOf(config.manageRole)
	if (ownerRank === -1) {
		throw new SpacesConfigError(`ownerRole "${config.ownerRole}" is not one of the roles.`, {
			roles,
		})
	}
	if (manageRank === -1) {
		throw new SpacesConfigError(`manageRole "${config.manageRole}" is not one of the roles.`, {
			roles,
		})
	}
	// Nobody may outrank the owner: the owner can act on every member, and the owner role is
	// held only through the group record's owner field (it moves only by transfer).
	if (ownerRank !== roles.length - 1) {
		throw new SpacesConfigError(
			`ownerRole "${config.ownerRole}" must be the highest role (last in roles). Add an owner role above "${roles[roles.length - 1]}".`,
			{ roles, ownerRole: config.ownerRole },
		)
	}
	if (manageRank >= ownerRank) {
		throw new SpacesConfigError(
			'manageRole must be below ownerRole: managers invite and manage members, and only the owner owns the space.',
			{ roles, ownerRole: config.ownerRole, manageRole: config.manageRole },
		)
	}
	const groupEntries = Object.entries(config.groups) as Array<[Group, SpacesGroupConfig]>
	if (groupEntries.length === 0) {
		throw new SpacesConfigError('spacesCollections needs at least one group collection.')
	}
	const groups = {} as Record<Group, SpacesGroupConfig>
	const accessGroups: Record<string, { owner: string; role: string }> = {}
	for (const [collection, group] of groupEntries) {
		if (typeof group?.owner !== 'string' || group.owner.length === 0) {
			throw new SpacesConfigError(`Group collection "${collection}" needs its owner field.`, {
				collection,
			})
		}
		if (
			collection === SPACE_MEMBERS ||
			collection === SPACE_INVITATIONS ||
			collection === SPACE_INVITATION_SECRETS
		) {
			throw new SpacesConfigError(`"${collection}" is one of the kit's own collections.`, {
				collection,
			})
		}
		groups[collection] = Object.freeze({ owner: group.owner })
		accessGroups[collection] = { owner: group.owner, role: config.ownerRole }
	}

	const collections: SpacesCollectionsInput = {
		space_members: {
			fields: {
				userId: t.string(),
				group: t.string(),
				role: t.string(),
				invitedBy: t.string().optional(),
				expiresAt: t.timestamp().optional(),
			},
			indexes: ['group', 'userId'],
			// Members see who else is in their spaces. Only the server writes (no write rule).
			access: { read: memberOfKey('group') },
		},
		space_invitations: {
			fields: {
				group: t.string(),
				email: t.string(),
				role: t.string(),
				invitedBy: t.string(),
				expiresAt: t.timestamp(),
				createdAt: t.timestamp(),
				tokenVersion: t.number(),
			},
			indexes: ['group'],
			// Invitee emails are visible to the space's managers only.
			access: { read: memberOfKey('group', config.manageRole) },
		},
		space_invitation_secrets: {
			fields: {
				invitationId: t.string(),
				group: t.string(),
				tokenHash: t.string(),
				tokenVersion: t.number(),
				inviterId: t.string(),
				authority: t.string(),
				ownerVersion: t.string(),
			},
			indexes: ['group', 'inviterId'],
			access: { read: serverOnly() },
		},
	}

	const frozenRoles = Object.freeze(roles) as readonly Role[]
	return Object.freeze({
		roles: frozenRoles,
		ownerRole: config.ownerRole,
		manageRole: config.manageRole,
		groups: Object.freeze(groups),
		access: Object.freeze({
			memberships: SPACE_MEMBERS,
			roles: frozenRoles,
			groups: accessGroups,
		}),
		collections,
		rank: (role: string): number => frozenRoles.indexOf(role as Role),
	})
}
