import { createHash } from 'node:crypto'
import type { AccessDefinition, SchemaDefinition } from '@korajs/core'
import { KoraError, validateRecord } from '@korajs/core'
import { groupKey, parseGroupKey } from '@korajs/core/internal'
import type {
	ProductionHttpRouteContext,
	RouteApplyResult,
	RouteMutation,
	RouteTransaction,
	RouteTransactionResult,
} from '../server/route-context'
import type { MaterializedRecord, ServerStore } from '../store/server-store'
import { type GroupRole, effectiveGroupRole } from './access-authorizer'

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
	 * The writes that make `input` hold, decided inside `kora.transaction` with the
	 * transaction's reads: return them from the decision with the transaction's other
	 * mutations, so a membership commits together with them (an invitation accepted and
	 * its membership granted as one step). Refuses (throws) like `grant`; an unchanged
	 * membership gives no writes. Use an unscoped transaction.
	 *
	 * @example
	 * ```typescript
	 * await server.kora.transaction(async (tx) => [
	 *   ...(await server.access.prepareGrant(tx, { userId, group: ['forms', formId], role: 'editor' })),
	 *   { collection: 'invitations', type: 'delete', recordId: invitationId },
	 * ])
	 * ```
	 */
	prepareGrant(tx: RouteTransaction, input: GrantInput): Promise<RouteMutation[]>
	/** The writes that end `input`'s membership, inside `kora.transaction` (see `prepareGrant`). */
	prepareRevoke(
		tx: RouteTransaction,
		input: { userId: string; group: GroupRef },
	): Promise<RouteMutation[]>
	/**
	 * The role `userId` holds in `group` now: the highest of the group record's owner
	 * field and their live memberships, or null. `since` changes whenever that role
	 * changes, ends or is granted again, so it can be stored as proof (for example with
	 * an invitation) and compared later inside `kora.transaction` (`tx.roleOf`).
	 */
	roleOf(userId: string, group: GroupRef): Promise<GroupRole | null>
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

/** Page size when reading the rows of one membership (duplicates are a migration leftover). */
const MEMBERSHIP_PAGE = 100

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
	const exists = async (
		read: Pick<RouteTransaction, 'query'>,
		collection: string,
		id: string,
	): Promise<boolean> =>
		(await read.query(collection, { where: { id }, includeDeleted: true, limit: 1 })).length > 0
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
		// The values must fit the memberships collection's fields (an expiry past the
		// timestamp range, a role the field's enum does not allow): checked now, so a
		// backfill refuses bad input before writing anything.
		const definition = getSchema()?.collections[access.memberships]
		if (definition) {
			try {
				validateRecord(
					access.memberships,
					definition,
					{
						userId: input.userId,
						group,
						role: input.role,
						...(hasExpiry ? { expiresAt: input.expiresAt ?? null } : {}),
					},
					'update',
				)
			} catch (error) {
				throw new AccessApiError(
					`The membership does not fit "${access.memberships}": ${error instanceof Error ? error.message : String(error)}`,
					{ userId: input.userId, group },
				)
			}
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
	const groupExists = async (
		read: Pick<RouteTransaction, 'query'>,
		group: string,
	): Promise<boolean> => {
		const parsed = parseGroupKey(group)
		const access = accessOf()
		if (!parsed || !Object.prototype.hasOwnProperty.call(access.groups, parsed.collection)) {
			return true
		}
		return exists(read, parsed.collection, parsed.id)
	}
	/**
	 * Every live row holding `userId`'s membership of `group`. Usually one, under the
	 * derived id; rows written before `server.access` existed (a pre-populated memberships
	 * collection) may use other ids, and authorization reads them all.
	 */
	/**
	 * Every live row holding `userId`'s membership of `group`, read inside a transaction
	 * (no write commits meanwhile, so paging cannot skip a row). Usually one, under the
	 * derived id; rows written before `server.access` existed (a pre-populated
	 * memberships collection) may use other ids, and authorization reads them all. The
	 * derived row comes first: it is the one kept.
	 */
	const membershipRows = async (
		tx: RouteTransaction,
		userId: string,
		group: string,
	): Promise<MaterializedRecord[]> => {
		const rows: MaterializedRecord[] = []
		for (;;) {
			const page = await tx.query(accessOf().memberships, {
				where: { userId, group },
				orderBy: 'id',
				limit: MEMBERSHIP_PAGE,
				offset: rows.length,
			})
			rows.push(...page)
			if (page.length < MEMBERSHIP_PAGE) break
		}
		const derived = membershipRecordId(userId, group)
		return [...rows].sort((a, b) => Number(b.id === derived) - Number(a.id === derived))
	}
	/**
	 * The writes that make `rows` hold exactly the grant: the first row is updated (or the
	 * derived row inserted) and any other row deleted, so a leftover row can never keep a
	 * role the grant changed.
	 */
	const grantMutations = (
		grant: PreparedGrant,
		rows: readonly MaterializedRecord[],
	): RouteMutation[] => {
		const memberships = accessOf().memberships
		const expiry = grant.hasExpiry ? { expiresAt: grant.expiresAt } : {}
		const [primary, ...extra] = rows
		return [
			primary
				? {
						collection: memberships,
						type: 'update',
						recordId: String(primary.id),
						data: { role: grant.role, ...expiry },
					}
				: {
						collection: memberships,
						type: 'insert',
						recordId: grant.recordId,
						data: { userId: grant.userId, group: grant.group, role: grant.role, ...expiry },
					},
			...extra.map(
				(row): RouteMutation => ({
					collection: memberships,
					type: 'delete',
					recordId: String(row.id),
				}),
			),
		]
	}
	/** True when `rows` already hold exactly the grant (one row, same role and expiry). */
	const holdsGrant = (grant: PreparedGrant, rows: readonly MaterializedRecord[]): boolean => {
		const [only] = rows
		return (
			rows.length === 1 &&
			only !== undefined &&
			only.role === grant.role &&
			(!grant.hasExpiry || (only.expiresAt ?? null) === grant.expiresAt)
		)
	}
	/** True when the record exists and is not deleted. */
	const liveExists = async (
		tx: RouteTransaction,
		collection: string,
		id: string,
	): Promise<boolean> => (await tx.findById(collection, id)) !== null
	/** A transaction result as the single-write result `grant`, `revoke` and `transfer` return. */
	const asApplyResult = (result: RouteTransactionResult): RouteApplyResult | null => {
		if (!result.ok) return result
		const [operation] = result.operations
		if (!operation) return null
		return { ok: true, operation, record: result.records[0] ?? null }
	}

	return {
		async grant(input) {
			const prepared = prepareGrant(input)
			// Group check, current rows and the writes decided as one step: no other write
			// (another grant, a revoke, a transfer) commits in between.
			let missing = false
			const result = await context.transaction(async (tx) => {
				if (!(await groupExists(tx, prepared.group))) {
					missing = true
					return tx.reject('GROUP_NOT_FOUND', 'The group does not exist.')
				}
				return grantMutations(prepared, await membershipRows(tx, prepared.userId, prepared.group))
			})
			if (missing) {
				throw new AccessApiError(
					`Group "${prepared.group}" does not exist yet: create its "${parseGroupKey(prepared.group)?.collection}" record before granting memberships of it.`,
					{ group: prepared.group },
				)
			}
			const applied = asApplyResult(result)
			if (applied === null) {
				throw new AccessApiError('The grant wrote nothing.', { group: prepared.group })
			}
			return applied
		},

		async backfill(memberships) {
			// Validate everything first: a programming error writes nothing.
			const prepared = [...memberships].map((input) => ({ input, grant: prepareGrant(input) }))
			const result: BackfillResult = { granted: 0, unchanged: 0, missingGroups: [], failed: [] }
			for (const { input, grant } of prepared) {
				let outcome = 'granted' as 'missing' | 'unchanged' | 'granted'
				const written = await context.transaction(async (tx) => {
					// The group's record must be live: a membership of a deleted form (or any
					// deleted record a member() rule names) is reported, not granted.
					const parsed = parseGroupKey(grant.group)
					if (!parsed || !(await liveExists(tx, parsed.collection, parsed.id))) {
						outcome = 'missing'
						return []
					}
					const rows = await membershipRows(tx, grant.userId, grant.group)
					if (holdsGrant(grant, rows)) {
						outcome = 'unchanged'
						return []
					}
					return grantMutations(grant, rows)
				})
				if (!written.ok) {
					result.failed.push({ membership: input, code: written.code, message: written.message })
				} else if (outcome === 'missing') {
					result.missingGroups.push(input)
				} else if (outcome === 'unchanged') {
					result.unchanged += 1
				} else {
					result.granted += 1
				}
			}
			return result
		},

		async revoke(input) {
			const access = accessOf()
			requireUser(input.userId)
			const group = resolveGroup(input.group)
			// Every row holding the membership, not only the derived one: a leftover row
			// would keep the user in the group.
			const result = await context.transaction(async (tx) =>
				(await membershipRows(tx, input.userId, group)).map(
					(row): RouteMutation => ({
						collection: access.memberships,
						type: 'delete',
						recordId: String(row.id),
					}),
				),
			)
			return asApplyResult(result)
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
			const result = await context.transaction(async (tx) => {
				if (!(await exists(tx, collection, id))) {
					return tx.reject(
						'NOT_FOUND',
						`"${collection}" record "${id}" does not exist; only an existing group can be transferred.`,
					)
				}
				return [
					{ collection, type: 'update', recordId: id, data: { [group.owner]: input.toUserId } },
				]
			})
			const applied = asApplyResult(result)
			if (applied === null) {
				throw new AccessApiError('The transfer wrote nothing.', { group: groupKey(collection, id) })
			}
			return applied
		},

		async prepareGrant(tx, input) {
			const prepared = prepareGrant(input)
			if (!(await groupExists(tx, prepared.group))) {
				throw new AccessApiError(
					`Group "${prepared.group}" does not exist yet: create its "${parseGroupKey(prepared.group)?.collection}" record before granting memberships of it.`,
					{ group: prepared.group },
				)
			}
			const rows = await membershipRows(tx, prepared.userId, prepared.group)
			return holdsGrant(prepared, rows) ? [] : grantMutations(prepared, rows)
		},

		async prepareRevoke(tx, input) {
			const access = accessOf()
			requireUser(input.userId)
			return (await membershipRows(tx, input.userId, resolveGroup(input.group))).map(
				(row): RouteMutation => ({
					collection: access.memberships,
					type: 'delete',
					recordId: String(row.id),
				}),
			)
		},

		async roleOf(userId, group) {
			const access = getSchema()?.access
			if (!access || !store.getMembershipIntervals) return null
			const key = resolveGroup(group)
			return effectiveGroupRole(
				await store.getMembershipIntervals(userId),
				userId,
				key,
				access.roles,
				Date.now(),
			)
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
