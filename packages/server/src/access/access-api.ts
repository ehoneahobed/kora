import { createHash } from 'node:crypto'
import type { AccessDefinition, SchemaDefinition } from '@korajs/core'
import { KoraError } from '@korajs/core'
import { groupKey, parseGroupKey } from '@korajs/core/internal'
import type { ProductionHttpRouteContext, RouteApplyResult } from '../server/route-context'
import type { MaterializedRecord, ServerStore } from '../store/server-store'

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
	 * Bring many memberships in line with another source of truth (rows an app kept
	 * before it used access rules, such as its own collaborators table), idempotently:
	 * a membership that already holds the same role and expiry is left alone, so it can
	 * run at every startup without writing anything. Each membership is an ordinary
	 * grant (history from the grant on: the member's devices receive the group's state
	 * at that point, then its changes). Invalid input (an unknown role or group
	 * collection, an empty userId, a malformed expiry) throws before anything is
	 * written; a group whose record does not exist (for example a deleted form) is
	 * reported in `missingGroups` and skipped.
	 *
	 * @example
	 * ```typescript
	 * const rows = await server.kora.query('collaborators', { where: { status: 'accepted' } })
	 * await server.access.backfill(
	 *   rows.map((row) => ({ userId: row.userId, group: ['forms', row.formId], role: row.role })),
	 * )
	 * ```
	 */
	backfill(memberships: Iterable<GrantInput>): Promise<BackfillResult>
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

/** Outcome of {@link AccessApi.backfill}. */
export interface BackfillResult {
	/** Memberships created or changed. */
	granted: number
	/** Memberships that already held the same role and expiry (nothing written). */
	unchanged: number
	/** Memberships skipped because their group record does not exist. */
	missingGroups: GrantInput[]
	/** Memberships the server refused to write, with its reason. */
	failed: Array<{ membership: GrantInput; code: string; message: string }>
}

/** Thrown when an access call names something the schema does not declare. */
export class AccessApiError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'ACCESS_API_ERROR', context)
		this.name = 'AccessApiError'
	}
}

/** A grant validated against the schema, ready to write. */
interface PreparedGrant {
	userId: string
	group: string
	role: string
	recordId: string
	hasExpiry: boolean
	expiresAt: number | null
}

/** Most rows one membership lookup reads (duplicates are a migration leftover). */
const MAX_MEMBERSHIP_ROWS = 100

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
	/** True when the record was ever created (a deleted one counts: it can be restored). */
	const exists = async (collection: string, id: string): Promise<boolean> =>
		(await context.query(collection, { where: { id }, includeDeleted: true, limit: 1 })).length > 0
	const requireUser = (userId: string): void => {
		if (typeof userId !== 'string' || userId.length === 0) {
			throw new AccessApiError('A membership needs a non-empty userId.')
		}
	}

	/** A grant checked against the schema (throws on input the schema cannot hold). */
	const prepareGrant = (input: GrantInput): PreparedGrant => {
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
		// The memberships collection may not declare `expiresAt`: then a membership
		// cannot expire, and asking for an expiry is an error rather than ignored.
		const hasExpiry = Object.prototype.hasOwnProperty.call(
			getSchema()?.collections[access.memberships]?.fields ?? {},
			'expiresAt',
		)
		if (!hasExpiry && input.expiresAt !== undefined && input.expiresAt !== null) {
			throw new AccessApiError(
				`The memberships collection "${access.memberships}" has no expiresAt field; add expiresAt: t.timestamp().optional() to grant expiring memberships.`,
			)
		}
		return {
			userId: input.userId,
			group,
			role: input.role,
			recordId: membershipRecordId(input.userId, group),
			hasExpiry,
			expiresAt: input.expiresAt ?? null,
		}
	}
	/**
	 * A group collection's group exists once its record does: granting before then
	 * would hand the membership to whoever creates that id first.
	 */
	const groupExists = async (group: string): Promise<boolean> => {
		const parsed = parseGroupKey(group)
		const access = accessOf()
		if (!parsed || !Object.prototype.hasOwnProperty.call(access.groups, parsed.collection)) {
			return true
		}
		return exists(parsed.collection, parsed.id)
	}
	/**
	 * Every live row holding `userId`'s membership of `group`. Usually one, under the
	 * derived id; rows written before `server.access` existed (a pre-populated memberships
	 * collection) may use other ids, and authorization reads them all.
	 */
	const membershipRows = async (userId: string, group: string): Promise<MaterializedRecord[]> => {
		const rows = await context.query(accessOf().memberships, {
			where: { userId, group },
			limit: MAX_MEMBERSHIP_ROWS,
		})
		const derived = membershipRecordId(userId, group)
		// The derived row first: it is the one kept.
		return [...rows].sort((a, b) => Number(b.id === derived) - Number(a.id === derived))
	}
	/**
	 * Make `rows` hold exactly the grant: the first row is updated (or the derived row
	 * inserted) and any other row is deleted, so a leftover row can never keep a role the
	 * grant changed.
	 */
	const writeGrant = async (
		grant: PreparedGrant,
		rows: readonly MaterializedRecord[],
	): Promise<RouteApplyResult> => {
		const memberships = accessOf().memberships
		const expiry = grant.hasExpiry ? { expiresAt: grant.expiresAt } : {}
		const [primary, ...extra] = rows
		const result = primary
			? await context.apply({
					collection: memberships,
					type: 'update',
					recordId: String(primary.id),
					data: { role: grant.role, ...expiry },
				})
			: await context.apply({
					collection: memberships,
					type: 'insert',
					recordId: grant.recordId,
					data: { userId: grant.userId, group: grant.group, role: grant.role, ...expiry },
				})
		if (!result.ok) return result
		for (const row of extra) {
			const removed = await context.apply({
				collection: memberships,
				type: 'delete',
				recordId: String(row.id),
			})
			if (!removed.ok) return removed
		}
		return result
	}
	/** True when the record exists and is not deleted. */
	const liveExists = async (collection: string, id: string): Promise<boolean> =>
		(await context.query(collection, { where: { id }, limit: 1 })).length > 0

	return {
		async grant(input) {
			const prepared = prepareGrant(input)
			if (!(await groupExists(prepared.group))) {
				throw new AccessApiError(
					`Group "${prepared.group}" does not exist yet: create its "${parseGroupKey(prepared.group)?.collection}" record before granting memberships of it.`,
					{ group: prepared.group },
				)
			}
			return writeGrant(prepared, await membershipRows(prepared.userId, prepared.group))
		},

		async backfill(memberships) {
			const access = accessOf()
			// Validate everything first: a programming error writes nothing.
			const prepared = [...memberships].map((input) => ({ input, grant: prepareGrant(input) }))
			const result: BackfillResult = { granted: 0, unchanged: 0, missingGroups: [], failed: [] }
			const groups = new Map<string, boolean>()
			for (const { input, grant } of prepared) {
				let exists = groups.get(grant.group)
				if (exists === undefined) {
					// The group's record must be live: a membership of a deleted form (or any
					// deleted record a member() rule names) is reported, not granted.
					const parsed = parseGroupKey(grant.group)
					exists = parsed ? await liveExists(parsed.collection, parsed.id) : false
					groups.set(grant.group, exists)
				}
				if (!exists) {
					result.missingGroups.push(input)
					continue
				}
				const rows = await membershipRows(grant.userId, grant.group)
				const [only] = rows
				if (
					rows.length === 1 &&
					only !== undefined &&
					only.role === input.role &&
					(!grant.hasExpiry || (only.expiresAt ?? null) === (input.expiresAt ?? null))
				) {
					result.unchanged += 1
					continue
				}
				const written = await writeGrant(grant, rows)
				if (written.ok) result.granted += 1
				else result.failed.push({ membership: input, code: written.code, message: written.message })
			}
			return result
		},

		async revoke(input) {
			const access = accessOf()
			requireUser(input.userId)
			const rows = await membershipRows(input.userId, resolveGroup(input.group))
			let last: RouteApplyResult | null = null
			// Every row holding the membership, not only the derived one: a leftover row
			// would keep the user in the group.
			for (const row of rows) {
				last = await context.apply({
					collection: access.memberships,
					type: 'delete',
					recordId: String(row.id),
				})
				if (!last.ok) return last
			}
			return last
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
			if (!(await exists(collection, id))) {
				return {
					ok: false,
					code: 'NOT_FOUND',
					message: `"${collection}" record "${id}" does not exist; only an existing group can be transferred.`,
					retriable: false,
				}
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
				// Ended only if it is still expired when the store decides: a grant that
				// extended it meanwhile makes the condition fail and the membership stays.
				const result = await context.applyConditional({
					collection: access.memberships,
					id: interval.recordId,
					if: { expiresAt: { $lte: now } },
					also: [{ collection: access.memberships, type: 'delete', recordId: interval.recordId }],
					reject: { code: 'NOT_EXPIRED', message: 'The membership was extended.' },
				})
				if (result.ok) ended += 1
			}
			return ended
		},
	}
}
