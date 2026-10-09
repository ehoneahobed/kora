import { createHash } from 'node:crypto'
import type { AccessDefinition, SchemaDefinition } from '@korajs/core'
import { KoraError } from '@korajs/core'
import { groupKey, parseGroupKey } from '@korajs/core/internal'
import type { ProductionHttpRouteContext, RouteApplyResult } from '../server/route-context'
import type { ServerStore } from '../store/server-store'

/**
 * `server.access`: the server's API for changing who belongs to which group. Every
 * change is an ordinary server write to the memberships collection (or a group
 * record's owner field), so it is in the log, synced, and moves the membership index
 * in its own transaction. Authorization reads the index at decision time, so a
 * revoke refuses the removed user's next write at once.
 */
export interface AccessApi {
	/**
	 * Make `userId` a member of `group` with `role` (or change the role or expiry of an
	 * existing membership).
	 *
	 * @example
	 * ```typescript
	 * await server.access.grant({ userId, group: ['documents', docId], role: 'edit' })
	 * ```
	 */
	grant(input: GrantInput): Promise<RouteApplyResult>
	/** End `userId`'s membership of `group`. Revoking a membership that does not exist is a no-op. */
	revoke(input: { userId: string; group: GroupRef }): Promise<RouteApplyResult | null>
	/**
	 * Give a group record to another user: its owner field becomes `toUserId`, which
	 * ends the previous owner's ownership and starts the new owner's in one write.
	 */
	transfer(input: { group: readonly [string, string]; toUserId: string }): Promise<RouteApplyResult>
	/**
	 * End every membership whose `expiresAt` has passed with a server write, so the
	 * expiry has a place in the log. Authorization already treats an expired membership
	 * as ended; the sweep makes delivery and other devices follow. Returns how many
	 * memberships were ended. The sync server runs it periodically.
	 */
	sweepExpired(now?: number): Promise<number>
}

/** A group: its key (`documents:<id>`) or `[collection, id]`. */
export type GroupRef = string | readonly [string, string]

/** Input of {@link AccessApi.grant}. */
export interface GrantInput {
	userId: string
	group: GroupRef
	role: string
	/** Milliseconds since the epoch; omitted or null: does not expire. */
	expiresAt?: number | null
}

/** Thrown when an access call names something the schema does not declare. */
export class AccessApiError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'ACCESS_API_ERROR', context)
		this.name = 'AccessApiError'
	}
}

/** Largest number of memberships one sweep ends. */
const SWEEP_BATCH = 500

/**
 * The id of the membership record of `userId` in `group`. Deterministic, so a grant
 * from any instance (or a retry) writes the same record instead of a duplicate.
 */
export function membershipRecordId(userId: string, group: string): string {
	return `mbr_${createHash('sha256').update(`${userId}\u0000${group}`).digest('hex').slice(0, 32)}`
}

/**
 * Create the access API over a server's data plane.
 *
 * @param context - The trusted route context (`server.kora`)
 * @param store - The server store (index reads)
 * @param getSchema - The current schema
 */
export function createAccessApi(
	context: ProductionHttpRouteContext,
	store: ServerStore,
	getSchema: () => SchemaDefinition | null,
): AccessApi {
	const accessOf = (): AccessDefinition & { memberships: string } => {
		const access = getSchema()?.access
		if (!access || access.memberships === null) {
			throw new AccessApiError(
				'server.access needs a schema with access rules and a memberships collection (access.memberships).',
			)
		}
		return access as AccessDefinition & { memberships: string }
	}
	const resolveGroup = (group: GroupRef): string => {
		const key = typeof group === 'string' ? group : groupKey(group[0], group[1])
		const parsed = parseGroupKey(key)
		const collections = getSchema()?.collections ?? {}
		if (!parsed || !Object.prototype.hasOwnProperty.call(collections, parsed.collection)) {
			throw new AccessApiError(
				`"${key}" is not a group: use [collection, id] with a collection of the schema.`,
				{ group: key },
			)
		}
		return key
	}
	const requireUser = (userId: string): void => {
		if (typeof userId !== 'string' || userId.length === 0) {
			throw new AccessApiError('A membership needs a non-empty userId.')
		}
	}

	return {
		async grant(input) {
			const access = accessOf()
			requireUser(input.userId)
			const group = resolveGroup(input.group)
			if (!access.roles.includes(input.role)) {
				throw new AccessApiError(
					`Role "${input.role}" is not in access.roles (${access.roles.join(', ')}).`,
					{ role: input.role },
				)
			}
			if (
				input.expiresAt !== undefined &&
				input.expiresAt !== null &&
				!(typeof input.expiresAt === 'number' && Number.isSafeInteger(input.expiresAt))
			) {
				throw new AccessApiError('expiresAt must be integer milliseconds since the epoch.')
			}
			const recordId = membershipRecordId(input.userId, group)
			const existing = await context.findById(access.memberships, recordId)
			const expiresAt = input.expiresAt ?? null
			return existing
				? context.apply({
						collection: access.memberships,
						type: 'update',
						recordId,
						data: { role: input.role, expiresAt },
					})
				: context.apply({
						collection: access.memberships,
						type: 'insert',
						recordId,
						data: { userId: input.userId, group, role: input.role, expiresAt },
					})
		},

		async revoke(input) {
			const access = accessOf()
			requireUser(input.userId)
			const recordId = membershipRecordId(input.userId, resolveGroup(input.group))
			if (!(await context.findById(access.memberships, recordId))) return null
			return context.apply({ collection: access.memberships, type: 'delete', recordId })
		},

		async transfer(input) {
			const access = accessOf()
			requireUser(input.toUserId)
			const [collection, id] = input.group
			const group = Object.prototype.hasOwnProperty.call(access.groups, collection)
				? access.groups[collection]
				: undefined
			if (!group) {
				throw new AccessApiError(`"${collection}" is not a group collection (access.groups).`, {
					collection,
				})
			}
			return context.apply({
				collection,
				type: 'update',
				recordId: id,
				data: { [group.owner]: input.toUserId },
			})
		},

		async sweepExpired(now = Date.now()) {
			const access = getSchema()?.access
			if (!access || access.memberships === null || !store.getExpiredMembershipIntervals) return 0
			let ended = 0
			for (const interval of await store.getExpiredMembershipIntervals(now, SWEEP_BATCH)) {
				const result = await context.apply({
					collection: access.memberships,
					type: 'delete',
					recordId: interval.recordId,
				})
				if (result.ok) ended += 1
			}
			return ended
		},
	}
}
