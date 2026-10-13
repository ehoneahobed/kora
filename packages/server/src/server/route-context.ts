import { AsyncLocalStorage } from 'node:async_hooks'
import {
	type AtomicOp,
	type HybridLogicalClock,
	KoraError,
	type Operation,
	createOperation,
	generateUUIDv7,
	isAtomicOp,
	resolveAtomicOp,
	toAtomicOp,
} from '@korajs/core'
import { groupKey, parseGroupKey } from '@korajs/core/internal'
import type { SideEffectOp } from '@korajs/merge'
import { effectiveGroupRole } from '../access/access-authorizer'
import {
	RESTRICTED_REJECTION_CODE,
	completeTransactionOperations,
	judgeTransactionOperation,
} from '../apply/apply-server-operation'
import { validateIngestedOperation } from '../apply/ingest-validation'
import { isRetriableRejection } from '../apply/rejection-taxonomy'
import { type RoutePredicate, evaluateRoutePredicate } from '../apply/route-predicate'
import { nextServerSequenceNumber, serverClock } from '../apply/server-side-effect-operation'
import { authorizeOperationReferences } from '../scopes/reference-authorization'
import type { ScopeMap, UplinkAuthorizationResult } from '../scopes/server-scope-filter'
import {
	authorizeUplinkWrite,
	recordMatchesScopes,
	splitScopeForQuery,
} from '../scopes/server-scope-filter'
import type {
	CollectionQueryOptions,
	ConditionalApplyInput,
	ConditionalApplyResult,
	MaterializedRecord,
	ServerStore,
	StoreTransactionResult,
} from '../store/server-store'
import type { KoraSyncServer } from './kora-sync-server'

/**
 * A mutation a custom HTTP route asks the server to apply on the data plane.
 *
 * `recordId` is optional for inserts (a UUID v7 is generated when omitted) and
 * required for updates and deletes. For updates, `data` holds only the changed
 * fields; the server reads the current record to capture the previous values so
 * the change three-way merges correctly with concurrent client edits.
 */
export interface RouteMutation {
	collection: string
	type: 'insert' | 'update' | 'delete'
	recordId?: string
	data?: Record<string, unknown> | null
}

/**
 * Scope the route derived from the request's authenticated actor. When present,
 * it is enforced exactly like a sync session's scope: `apply()` rejects a
 * mutation whose resulting record falls outside the scope, and `query()` /
 * `findById()` only return records inside it. Omit it for genuinely public
 * routes (for example a signup endpoint) where no per-actor isolation applies.
 */
export interface RouteScopeOptions {
	scope?: ScopeMap
}

/** Result of {@link ProductionHttpRouteContext.apply}. */
export type RouteApplyResult =
	| { ok: true; operation: Operation; record: MaterializedRecord | null }
	| { ok: false; code: string; message: string; retriable: boolean }

/**
 * A conditional, multi-collection admission gate applied atomically per instance.
 *
 * The gate reads the current state of the target record (`collection` + `id`),
 * checks the `if` predicate against it, and only then applies the `update` to the
 * target plus every mutation in `also` as one set. If the predicate fails it
 * applies nothing and returns the structured `reject`. `idempotencyKey` names a
 * record whose prior existence proves the set already committed, so a retry
 * returns the earlier outcome instead of applying the set (and its non-idempotent
 * counter increments) again.
 *
 * Atomicity note: within one server instance the check and the writes do not
 * interleave with other route mutations. Cross-instance, race-free admission and
 * all-or-nothing across a mid-set crash require the store-level conditional
 * transaction (a Postgres `WHERE ... < cap` commit), which is the next increment.
 */
export interface RouteConditionalApply {
	/** Collection of the record the predicate reads and the `update` targets. */
	collection: string
	/** Id of the target record. */
	id: string
	/** Admission predicate evaluated against the target's current state. */
	if?: RoutePredicate
	/** Partial update applied to the target record when the predicate holds. */
	update?: Record<string, unknown> | null
	/** Additional mutations committed atomically with the target update. */
	also?: RouteMutation[]
	/** Structured rejection returned when the predicate does not hold. */
	reject?: { code: string; message: string }
	/**
	 * Names a record whose existence means this set already committed. When it is
	 * present the set is skipped and the prior outcome returned. Use a stable,
	 * client-generated id (for example the accepted record's own id).
	 */
	idempotencyKey?: { collection: string; id: string }
}

/** Result of {@link ProductionHttpRouteContext.applyConditional}. */
export type RouteConditionalResult =
	| {
			ok: true
			/** True when the set was already committed and this call was a no-op. */
			idempotent: boolean
			operations: Operation[]
			records: (MaterializedRecord | null)[]
	  }
	| { ok: false; code: string; message: string; retriable: boolean }

/** A group: its key (`forms:<id>`) or `[collection, id]`. */
export type RouteGroupRef = string | readonly [string, string]

/** A user's role in a group, read inside a transaction ({@link RouteTransaction.roleOf}). */
export interface RouteGroupRole {
	/** The highest role the user holds in the group. */
	role: string
	/** A memberships-collection row, or the group record's owner field. */
	source: 'membership' | 'owner'
	/**
	 * Changes whenever that role changes, ends or is granted again (a delivery sequence).
	 * Store it to prove later that the role held throughout.
	 */
	since: number
}

/** A refusal returned from a transaction's decision ({@link RouteTransaction.reject}). */
export class RouteTransactionRejection {
	constructor(
		readonly code: string,
		readonly message: string,
	) {}
}

/**
 * Reads available inside {@link ProductionHttpRouteContext.transaction}. They see the
 * current state, and no other write commits until the transaction's own writes do.
 */
export interface RouteTransaction {
	/** A live record, or null (deleted or never written). */
	findById(collection: string, id: string): Promise<MaterializedRecord | null>
	/** Live records, as `kora.query`. */
	query(collection: string, options?: CollectionQueryOptions): Promise<MaterializedRecord[]>
	/** The role `userId` holds in `group` now (access rules), or null. */
	roleOf(userId: string, group: RouteGroupRef): Promise<RouteGroupRole | null>
	/** Refuse: return it from the decision and nothing is written. */
	reject(code: string, message: string): RouteTransactionRejection
}

/** What a transaction's decision returns: the writes to commit, or a refusal. */
export type RouteTransactionDecision = RouteMutation[] | RouteTransactionRejection

/** Result of {@link ProductionHttpRouteContext.transaction}. */
export type RouteTransactionResult =
	| { ok: true; operations: Operation[]; records: (MaterializedRecord | null)[] }
	| { ok: false; code: string; message: string; retriable: boolean }

/**
 * Scoped, validated data-plane access handed to custom HTTP route handlers.
 *
 * Every mutation goes through the same pipeline as sync (Tier 2 constraints,
 * referential integrity, materialization, and fan-out to connected clients), so
 * REST endpoints cannot accidentally bypass validation, constraints, or tenant
 * isolation the way hand-rolled store writes can.
 */
export interface ProductionHttpRouteContext {
	/**
	 * Apply a mutation through the validated server pipeline and relay the
	 * resulting operation(s) to connected clients.
	 */
	apply(mutation: RouteMutation, options?: RouteScopeOptions): Promise<RouteApplyResult>
	/**
	 * Conditionally apply a multi-collection mutation set as one admission gate:
	 * read the target, check the predicate, and commit the update plus every `also`
	 * mutation only if it holds, with at-most-once semantics via `idempotencyKey`.
	 */
	applyConditional(
		spec: RouteConditionalApply,
		options?: RouteScopeOptions,
	): Promise<RouteConditionalResult>
	/**
	 * Read, decide and write as one step. `decide` reads through `tx` and returns the
	 * mutations to commit (or `tx.reject(...)`); no other write, from any route, device or
	 * server instance, commits between those reads and the commit, and the mutations
	 * commit all together or not at all. Keep `decide` short: other writes wait for it.
	 * It may run more than once (SQLite decides again when another process committed
	 * meanwhile), so it must have no effect besides its result, and must not call
	 * `kora.apply` (that would wait for itself).
	 *
	 * Each mutation is judged like any other write (schema, constraints, references,
	 * scope), against the state the whole transaction leaves.
	 *
	 * @example
	 * ```typescript
	 * const result = await kora.transaction(async (tx) => {
	 *   const seat = await tx.findById('seats', seatId)
	 *   if (!seat || seat.takenBy) return tx.reject('TAKEN', 'This seat is taken.')
	 *   return [{ collection: 'seats', type: 'update', recordId: seatId, data: { takenBy: userId } }]
	 * })
	 * ```
	 */
	transaction(
		decide: (tx: RouteTransaction) => Promise<RouteTransactionDecision>,
		options?: RouteScopeOptions,
	): Promise<RouteTransactionResult>
	/** Read materialized records from a collection, optionally scoped. */
	query(
		collection: string,
		options?: CollectionQueryOptions & RouteScopeOptions,
	): Promise<MaterializedRecord[]>
	/** Read a single materialized record by id, optionally scoped. */
	findById(
		collection: string,
		id: string,
		options?: RouteScopeOptions,
	): Promise<MaterializedRecord | null>
}

/**
 * Returns true when a materialized record satisfies the scope declared for its
 * collection. A collection absent from the scope map is treated as out of scope
 * (hidden). Uses the same predicate matcher as the sync path, so `$in` works here too.
 */
function recordMatchesScope(
	collection: string,
	record: MaterializedRecord,
	scope: ScopeMap,
): boolean {
	return recordMatchesScopes(collection, record, scope)
}

/**
 * Read a record as stored, including a soft-deleted one, for authorization. Returns
 * null when it was never written (or the store cannot read the collection).
 */
async function readStoredRecord(
	store: ServerStore,
	collection: string,
	id: string,
): Promise<MaterializedRecord | null> {
	try {
		const rows = await store.queryCollection(collection, {
			where: { id },
			includeDeleted: true,
			limit: 1,
		})
		return rows[0] ?? null
	} catch {
		return null
	}
}

/** Picks only the given keys from a record (used to capture previousData). */
function pickFields(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
	const picked: Record<string, unknown> = {}
	for (const key of keys) {
		if (key in record) {
			picked[key] = record[key]
		}
	}
	return picked
}

/**
 * Build a server-originated operation for a route mutation, reading current
 * materialized state so updates and deletes carry accurate previous values.
 *
 * `currentOverride`, when provided, supplies that current state instead of reading
 * it from the store. The conditional apply passes the record it read under the
 * cross-instance lock, so an atomic-op update (for example `op.increment`) resolves
 * against the authoritative locked value rather than a stale read.
 *
 * `clockOverride`, when provided, stamps the operation instead of a fresh clock. The
 * cross-instance conditional apply passes a clock the store advanced past the target
 * record's latest write, so the operation sorts strictly after it and last-write-wins
 * materialization matches the serialized commit order.
 */
async function buildRouteOperation(
	store: ServerStore,
	mutation: RouteMutation,
	currentOverride?: { record: MaterializedRecord | null },
	clockOverride?: HybridLogicalClock,
): Promise<Operation> {
	const nodeId = store.getNodeId()
	// W7: the server node's one clock, advanced past the record's newest write, so this
	// write sorts after every write it read (the fold orders a record's writes by HLC).
	const clock =
		clockOverride ??
		serverClock(
			store,
			mutation.recordId
				? await store.getRecordLatestTimestamp?.(mutation.collection, mutation.recordId)
				: null,
		)
	const schemaVersion = store.getSchema()?.version ?? 1
	const sequenceNumber = nextServerSequenceNumber(store)

	if (mutation.type === 'insert') {
		return createOperation(
			{
				nodeId,
				type: 'insert',
				collection: mutation.collection,
				recordId: mutation.recordId ?? generateUUIDv7(),
				data: mutation.data ?? {},
				previousData: null,
				sequenceNumber,
				causalDeps: [],
				schemaVersion,
			},
			clock,
		)
	}

	if (!mutation.recordId) {
		throw new RouteMutationError(
			'MISSING_RECORD_ID',
			`A ${mutation.type} mutation on "${mutation.collection}" requires a recordId.`,
		)
	}

	const current = currentOverride
		? currentOverride.record
		: await store.findRecord(mutation.collection, mutation.recordId)

	if (mutation.type === 'update') {
		const rawData = mutation.data ?? {}
		// Resolve atomic-op sentinels (op.increment, op.max, ...) exactly as the
		// client's update path does: `data` carries the concrete resolved value for
		// materialization, and `atomicOps` carries the intent so concurrent atomic
		// writes compose in the merge engine instead of last-write-wins.
		const data: Record<string, unknown> = {}
		const atomicOps: Record<string, AtomicOp> = {}
		for (const key of Object.keys(rawData)) {
			const value = rawData[key]
			if (isAtomicOp(value)) {
				data[key] = resolveAtomicOp(current ? current[key] : undefined, value)
				atomicOps[key] = toAtomicOp(value)
			} else {
				data[key] = value
			}
		}
		return createOperation(
			{
				nodeId,
				type: 'update',
				collection: mutation.collection,
				recordId: mutation.recordId,
				data,
				previousData: current ? pickFields(current, Object.keys(rawData)) : {},
				sequenceNumber,
				causalDeps: [],
				schemaVersion,
				...(Object.keys(atomicOps).length > 0 ? { atomicOps } : {}),
			},
			clock,
		)
	}

	// delete
	return createOperation(
		{
			nodeId,
			type: 'delete',
			collection: mutation.collection,
			recordId: mutation.recordId,
			data: null,
			previousData: current ? { ...current } : null,
			sequenceNumber,
			causalDeps: [],
			schemaVersion,
		},
		clock,
	)
}

/** Deterministic key for a scope map (sorted keys at every level). */
function stableScopeKey(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableScopeKey).join(',')}]`
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableScopeKey(record[key])}`)
			.join(',')}}`
	}
	return JSON.stringify(value) ?? 'undefined'
}

/**
 * Thrown when a write (`kora.apply`, `kora.transaction`, `server.access.grant`, ...) is
 * started from inside a transaction's decision: it would wait for the transaction.
 */
export class RouteTransactionReentryError extends KoraError {
	constructor() {
		super(
			'A write was started inside kora.transaction(): return mutations from the decision instead (server.access.prepareGrant(tx, ...) and prepareRevoke(tx, ...) build membership changes).',
			'ROUTE_TRANSACTION_REENTRY',
		)
		this.name = 'RouteTransactionReentryError'
	}
}

/** The transaction decision a call runs in, by route context. */
const insideDecision = new AsyncLocalStorage<symbol>()

/** Internal error carrying a stable code for route-context failures. */
class RouteMutationError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message)
		this.name = 'RouteMutationError'
	}
}

/**
 * Create the scoped, validated data-plane context handed to custom HTTP route
 * handlers as `request.kora`.
 *
 * Mutations are serialized so concurrent requests cannot race on server
 * sequence-number allocation: each `apply()` builds and applies its operation
 * before the next begins.
 */
export function createRouteContext(
	server: KoraSyncServer,
	store: ServerStore,
): ProductionHttpRouteContext {
	// Reference authorization for a scoped route write (RT-11, RT-13). The route's
	// scope is both what it may write and what it may read; blob claims are keyed by
	// the scope, since a route has no device or session of its own.
	function authorizeRouteReferences(
		op: Operation,
		stored: MaterializedRecord | null,
		scope: ScopeMap | undefined,
		readRow: (collection: string, id: string) => Promise<MaterializedRecord | null>,
		source: ServerStore = store,
	): Promise<UplinkAuthorizationResult> {
		if (!scope) return Promise.resolve({ allowed: true })
		return authorizeOperationReferences(op, stored, {
			schema: source.getSchema(),
			downlinkScopes: scope,
			readRow,
			// Blob checks read through the same store as the rest (inside a transaction,
			// its connection).
			blobs: server.getBlobAccessIndex().withStore(source),
			blobOwner: `kora:route:${stableScopeKey(scope)}`,
		})
	}

	// Identifies this context's decisions (see serialize).
	const contextId = Symbol('kora-route-context')

	// Promise chain that serializes apply() so sequence allocation + apply is
	// atomic per mutation, even under concurrent in-flight requests.
	let mutationTail: Promise<unknown> = Promise.resolve()

	function serialize<T>(work: () => Promise<T>): Promise<T> {
		// A write started from inside a transaction's decision would wait for the
		// transaction, which waits for the decision.
		if (insideDecision.getStore() === contextId) {
			return Promise.reject(new RouteTransactionReentryError())
		}
		const run = mutationTail.then(work, work)
		// Keep the tail from rejecting so one failed mutation does not poison the
		// chain for subsequent ones.
		mutationTail = run.then(
			() => undefined,
			() => undefined,
		)
		return run
	}

	// Build a route operation and check scope, WITHOUT applying it. Splitting
	// preparation from commit lets applyConditional validate an entire mutation set
	// before committing any of it, so a scope violation or malformed mutation in
	// `also` cannot leave the target update (for example a counter increment)
	// committed while the rest is rejected.
	type RouteRejection = { ok: false; code: string; message: string; retriable: boolean }
	type PreparedMutation = { ok: true; op: Operation } | { ok: false; rejection: RouteRejection }
	async function prepareMutation(
		mutation: RouteMutation,
		scope: ScopeMap | undefined,
		source: ServerStore = store,
	): Promise<PreparedMutation> {
		let op: Operation
		try {
			op = await buildRouteOperation(source, mutation)
		} catch (error) {
			if (error instanceof RouteMutationError) {
				return {
					ok: false,
					rejection: {
						ok: false,
						code: error.code,
						message: error.message,
						retriable: isRetriableRejection(error.code),
					},
				}
			}
			throw error
		}

		// The same rule as sync uploads: the stored row (including a soft-deleted one)
		// must be in scope, and so must the record after the write. A scoped route
		// therefore cannot edit, delete, take over or same-id-overwrite a record that
		// belongs to someone else.
		const stored = scope ? await readStoredRecord(source, op.collection, op.recordId) : null
		let decision = authorizeUplinkWrite(op, stored, scope)
		// A scoped route may only point at parents and blob content inside its scope
		// (RT-11, RT-13), exactly like a sync session.
		if (decision.allowed) {
			decision = await authorizeRouteReferences(
				op,
				stored,
				scope,
				(collection, id) => readStoredRecord(source, collection, id),
				source,
			)
		}
		if (!decision.allowed) {
			return {
				ok: false,
				rejection: {
					ok: false,
					code: decision.code,
					message:
						decision.code === 'SCOPE_VIOLATION'
							? `Mutation on "${mutation.collection}" is outside the provided scope. ${decision.message}`
							: decision.message,
					retriable: isRetriableRejection(decision.code),
				},
			}
		}

		return { ok: true, op }
	}

	// Apply a prepared operation and read back the resulting record.
	async function commitOperation(
		op: Operation,
		collection: string,
		scope: ScopeMap | undefined,
	): Promise<RouteApplyResult> {
		// Scoped writes are re-authorized by the store inside its apply critical section,
		// against the row as it is at commit time.
		const result = await server.applyLocalOperation(
			op,
			scope
				? {
						authorize: (stored) => authorizeUplinkWrite(op, stored, scope),
						// A scoped route's delete may only cascade inside its scope (RT-10).
						authorizeSideEffect: (effect, stored) => authorizeUplinkWrite(effect, stored, scope),
					}
				: {},
		)
		if (result.result !== 'applied') {
			const code = result.rejection?.code ?? 'NOT_APPLIED'
			return {
				ok: false,
				code,
				message:
					result.rejection?.message ??
					`Operation on "${collection}" was not applied (${result.result}).`,
				// Prefer the pipeline's own classification when present; fall back
				// to classifying the code so this stays correct if new codes appear.
				retriable: result.rejection?.retriable ?? isRetriableRejection(code),
			}
		}

		const record = await store.findRecord(collection, op.recordId)
		return { ok: true, operation: op, record }
	}

	// The un-serialized core of a single mutation. Both apply() and
	// applyConditional() call this inside a serialized block, so it must NOT
	// serialize itself (that would deadlock the promise-chain tail).
	async function rawApply(
		mutation: RouteMutation,
		scope: ScopeMap | undefined,
	): Promise<RouteApplyResult> {
		const prepared = await prepareMutation(mutation, scope)
		if (!prepared.ok) {
			return prepared.rejection
		}
		return commitOperation(prepared.op, mutation.collection, scope)
	}

	// Cross-instance conditional apply, delegating admission and atomicity to the
	// store (the Postgres advisory-lock transaction). The store owns the
	// read-decide-write cycle so a cap check is race-free across instances; this
	// bridge translates the route spec into the store's callback shape, validates
	// scope on each built operation while still inside the locked transaction (so a
	// violation rolls everything back), then relays the committed set to clients.
	async function runConditionalViaStore(
		storeApplyConditional: (input: ConditionalApplyInput) => Promise<ConditionalApplyResult>,
		spec: RouteConditionalApply,
		options: RouteScopeOptions | undefined,
	): Promise<RouteConditionalResult> {
		const scope = options?.scope

		// Assemble the set: the target update (when given) first, then every `also`.
		const mutations: RouteMutation[] = []
		const hasTargetUpdate = spec.update !== undefined && spec.update !== null
		if (hasTargetUpdate) {
			mutations.push({
				collection: spec.collection,
				type: 'update',
				recordId: spec.id,
				data: spec.update,
			})
		}
		if (spec.also) {
			mutations.push(...spec.also)
		}

		let result: ConditionalApplyResult
		try {
			result = await storeApplyConditional({
				target: { collection: spec.collection, id: spec.id },
				...(spec.idempotencyKey ? { idempotencyKey: spec.idempotencyKey } : {}),
				admit: (current) =>
					spec.if && Object.keys(spec.if).length > 0
						? evaluateRoutePredicate(current, spec.if)
						: true,
				buildOperations: async (current, context) => {
					const ops: Operation[] = []
					for (let i = 0; i < mutations.length; i++) {
						const mutation = mutations[i] as RouteMutation
						// The target update (index 0 when present) resolves its atomic ops
						// against the locked `current`; `also` mutations address distinct
						// records and read their own current state from the store. Every op
						// is stamped with the store-provided clock so the set sorts strictly
						// after the target's latest committed write.
						const useLockedCurrent = i === 0 && hasTargetUpdate
						const op = await buildRouteOperation(
							store,
							mutation,
							useLockedCurrent ? { record: current } : undefined,
							context.clock,
						)
						// The store-provided clock was advanced past the target's latest write;
						// if that write is far-future (a log from a server with a wrong clock),
						// so is this one. Refuse it rather than spread it (SYNC-7).
						const ingest = validateIngestedOperation(op)
						if (!ingest.valid) {
							throw new RouteMutationError(ingest.code, ingest.message)
						}
						// Validate inside the locked transaction against the stored row read
						// through the store's transaction when it offers one. Throwing here
						// rolls the transaction back, so a violation applies nothing.
						const stored = scope
							? context.readStoredRow
								? await context.readStoredRow(op.collection, op.recordId)
								: await readStoredRecord(store, op.collection, op.recordId)
							: null
						let decision = authorizeUplinkWrite(op, stored, scope)
						if (decision.allowed) {
							decision = await authorizeRouteReferences(op, stored, scope, (collection, id) =>
								context.readStoredRow
									? context.readStoredRow(collection, id)
									: readStoredRecord(store, collection, id),
							)
						}
						if (!decision.allowed) {
							throw new RouteMutationError(
								decision.code,
								decision.code === 'SCOPE_VIOLATION'
									? `Mutation on "${mutation.collection}" is outside the provided scope. ${decision.message}`
									: decision.message,
							)
						}
						ops.push(op)
					}
					return ops
				},
			})
		} catch (error) {
			// A malformed mutation or scope violation surfaced from inside the locked
			// transaction (which rolled back) becomes a structured rejection, not a 500.
			if (error instanceof RouteMutationError) {
				return {
					ok: false,
					code: error.code,
					message: error.message,
					retriable: isRetriableRejection(error.code),
				}
			}
			throw error
		}

		// Predicate failed under the lock: nothing was applied.
		if (!result.admitted) {
			return {
				ok: false,
				code: spec.reject?.code ?? 'CONDITION_NOT_MET',
				message:
					spec.reject?.message ??
					`Admission condition not met on "${spec.collection}" record "${spec.id}".`,
				retriable: false,
			}
		}

		// Idempotent hit: the set committed on an earlier attempt. Return the anchor's
		// committed state without re-applying (so counter increments run at most once).
		if (result.idempotent) {
			const records: (MaterializedRecord | null)[] = spec.idempotencyKey
				? [await store.findRecord(spec.idempotencyKey.collection, spec.idempotencyKey.id)]
				: []
			return { ok: true, idempotent: true, operations: [], records }
		}

		// Admitted and committed. Fan the operations out to connected clients (each
		// session re-applies its own scope filter), then read back each record.
		server.relayServerOperations(result.applied)
		const records: (MaterializedRecord | null)[] = []
		for (const op of result.applied) {
			records.push(await store.findRecord(op.collection, op.recordId))
		}
		return { ok: true, idempotent: false, operations: result.applied, records }
	}

	async function queryRecords(
		collection: string,
		options?: CollectionQueryOptions & RouteScopeOptions,
		source: ServerStore = store,
	): Promise<MaterializedRecord[]> {
		const { scope, ...queryOptions } = options ?? {}
		if (!scope) {
			return source.queryCollection(collection, queryOptions)
		}
		const collectionScope = scope[collection]
		if (!collectionScope) {
			return []
		}
		// Push equality scope predicates into the store query so limit/offset apply
		// to in-scope records only. A caller filter that contradicts the scope can
		// match nothing.
		const { equality, hasNonEquality } = splitScopeForQuery(collectionScope)
		const callerWhere = queryOptions.where ?? {}
		for (const [field, value] of Object.entries(equality)) {
			if (field in callerWhere && !Object.is(callerWhere[field], value)) {
				return []
			}
		}
		const where = { ...callerWhere, ...equality }
		const scopedWhere = Object.keys(where).length > 0 ? { where } : {}
		if (!hasNonEquality) {
			const records = await source.queryCollection(collection, {
				...queryOptions,
				...scopedWhere,
			})
			return records.filter((record) => recordMatchesScope(collection, record, scope))
		}
		// `$in` predicates cannot be pushed into the store's exact-match filter: fetch
		// without pagination, filter by the full scope, then apply offset and limit.
		const { limit, offset, ...unpaged } = queryOptions
		const records = await source.queryCollection(collection, { ...unpaged, ...scopedWhere })
		const inScope = records.filter((record) => recordMatchesScope(collection, record, scope))
		const start = offset ?? 0
		return limit === undefined ? inScope.slice(start) : inScope.slice(start, start + limit)
	}

	async function findRecordById(
		collection: string,
		id: string,
		options?: RouteScopeOptions,
		source: ServerStore = store,
	): Promise<MaterializedRecord | null> {
		const record = await source.findRecord(collection, id)
		if (!record) {
			return null
		}
		if (options?.scope && !recordMatchesScope(collection, record, options.scope)) {
			return null
		}
		return record
	}

	/** The role a user holds in a group now, from the store's membership index. */
	async function roleOf(
		userId: string,
		group: RouteGroupRef,
		source: ServerStore = store,
	): Promise<RouteGroupRole | null> {
		const access = source.getSchema()?.access
		if (!access || !source.getMembershipIntervals) return null
		const key = typeof group === 'string' ? group : groupKey(group[0], group[1])
		const intervals = await source.getMembershipIntervals(userId)
		return effectiveGroupRole(intervals, userId, key, access.roles, Date.now())
	}

	// A read-decide-write transaction through the store's `transact`: the decision and
	// every check of its mutations read through the store bound to the transaction (on
	// Postgres, its connection) while the store admits no other write, and the mutations
	// commit in one database transaction. Called inside serialize().
	async function runTransaction(
		decide: (tx: RouteTransaction, source: ServerStore) => Promise<RouteTransactionDecision>,
		scope: ScopeMap | undefined,
	): Promise<RouteTransactionResult> {
		const transact = store.transact
		if (!transact) return runTransactionWithoutIsolation(decide, scope)
		let rejection: RouteTransactionRejection | null = null
		let result: StoreTransactionResult
		try {
			result = await transact.call(store, (bound) =>
				insideDecision.run(contextId, async () => {
					rejection = null
					const decision = await decide(transactionReads(scope, bound), bound)
					if (decision instanceof RouteTransactionRejection) {
						rejection = decision
						return null
					}
					const ops: Operation[] = []
					for (const mutation of decision) {
						const prepared = await prepareMutation(mutation, scope, bound)
						if (!prepared.ok) {
							throw new RouteMutationError(prepared.rejection.code, prepared.rejection.message)
						}
						ops.push(prepared.op)
					}
					// Each judged with the whole batch in view (relations of a delete read the
					// state the batch leaves).
					for (const op of ops) {
						const judgement = await judgeTransactionOperation(
							bound,
							op,
							scope ? (effect, stored) => authorizeUplinkWrite(effect, stored, scope) : undefined,
							ops,
						)
						if (!judgement.ok) {
							throw new RouteMutationError(judgement.rejection.code, judgement.rejection.message)
						}
					}
					return ops
				}),
			)
		} catch (error) {
			// A refused mutation rolled the transaction back: nothing was written.
			if (error instanceof RouteMutationError) {
				return {
					ok: false,
					code: error.code,
					message: error.message,
					retriable: isRetriableRejection(error.code),
				}
			}
			throw error
		}
		if (!result.committed) {
			const refused = rejection as RouteTransactionRejection | null
			return {
				ok: false,
				code: refused?.code ?? 'REJECTED',
				message: refused?.message ?? 'The transaction was refused.',
				retriable: false,
			}
		}
		server.relayServerOperations(result.applied)
		// Referential side effects of deletes and cross-record corrections, as for any
		// other write.
		server.relayServerOperations(
			await completeTransactionOperations(
				store,
				result.applied,
				scope ? (effect, stored) => authorizeUplinkWrite(effect, stored, scope) : undefined,
			),
		)
		const records: (MaterializedRecord | null)[] = []
		for (const op of result.applied) {
			records.push(await store.findRecord(op.collection, op.recordId))
		}
		return { ok: true, operations: result.applied, records }
	}

	/** The reads a decision makes, through `source` (the store bound to the transaction). */
	function transactionReads(scope: ScopeMap | undefined, source: ServerStore): RouteTransaction {
		const scoped = scope ? { scope } : undefined
		return {
			findById: (collection, id) => findRecordById(collection, id, scoped, source),
			query: (collection, options) =>
				queryRecords(collection, { ...options, ...(scoped ?? {}) }, source),
			// A scoped transaction learns roles only in groups whose record its scope reads.
			roleOf: async (userId, group) => {
				if (scope) {
					const key = typeof group === 'string' ? group : groupKey(group[0], group[1])
					const parsed = parseGroupKey(key)
					if (!parsed || !(await findRecordById(parsed.collection, parsed.id, scoped, source))) {
						return null
					}
				}
				return roleOf(userId, group, source)
			},
			reject: (code, message) => new RouteTransactionRejection(code, message),
		}
	}

	// A custom store without `transact`: the decision and the writes run one after the
	// other within this instance, with no isolation from device uploads or other
	// instances and no all-or-nothing commit (the behaviour before transactions).
	async function runTransactionWithoutIsolation(
		decide: (tx: RouteTransaction, source: ServerStore) => Promise<RouteTransactionDecision>,
		scope: ScopeMap | undefined,
	): Promise<RouteTransactionResult> {
		const decision = await insideDecision.run(contextId, () =>
			decide(transactionReads(scope, store), store),
		)
		if (decision instanceof RouteTransactionRejection) {
			return { ok: false, code: decision.code, message: decision.message, retriable: false }
		}
		const operations: Operation[] = []
		const records: (MaterializedRecord | null)[] = []
		for (const mutation of decision) {
			const applied = await rawApply(mutation, scope)
			if (!applied.ok) return applied
			operations.push(applied.operation)
			records.push(applied.record)
		}
		return { ok: true, operations, records }
	}

	// applyConditional over a store transaction: idempotency, the admission predicate and
	// the set are decided and committed as one step.
	async function runConditionalAsTransaction(
		spec: RouteConditionalApply,
		scope: ScopeMap | undefined,
	): Promise<RouteConditionalResult> {
		let idempotentRecord: MaterializedRecord | null = null
		const result = await runTransaction(async (tx, source) => {
			// A decision can run more than once (SQLite decides again after another
			// connection's commit): nothing from an earlier attempt may carry over.
			idempotentRecord = null
			if (spec.idempotencyKey) {
				const existing = await source.findRecord(
					spec.idempotencyKey.collection,
					spec.idempotencyKey.id,
				)
				if (existing) {
					idempotentRecord = existing
					return []
				}
			}
			if (spec.if && Object.keys(spec.if).length > 0) {
				const target = await source.findRecord(spec.collection, spec.id)
				if (!evaluateRoutePredicate(target, spec.if)) {
					return tx.reject(
						spec.reject?.code ?? 'CONDITION_NOT_MET',
						spec.reject?.message ??
							`Admission condition not met on "${spec.collection}" record "${spec.id}".`,
					)
				}
			}
			const mutations: RouteMutation[] = []
			if (spec.update !== undefined && spec.update !== null) {
				mutations.push({
					collection: spec.collection,
					type: 'update',
					recordId: spec.id,
					data: spec.update,
				})
			}
			if (spec.also) mutations.push(...spec.also)
			return mutations
		}, scope)
		if (!result.ok) return result
		if (idempotentRecord) {
			return { ok: true, idempotent: true, operations: [], records: [idempotentRecord] }
		}
		return { ok: true, idempotent: false, operations: result.operations, records: result.records }
	}

	return {
		apply(mutation, options): Promise<RouteApplyResult> {
			return serialize(() => rawApply(mutation, options?.scope))
		},

		applyConditional(spec, options): Promise<RouteConditionalResult> {
			// Every built-in store runs transactions: the gate then commits the whole set or
			// none of it, decided on current state, on every store.
			if (store.transact) {
				return serialize(() => runConditionalAsTransaction(spec, options?.scope))
			}
			// Prefer the store's cross-instance conditional apply when available (the
			// Postgres store): it serializes the admission on the target across every
			// server instance via an advisory lock, so a cap check is race-free even
			// under concurrent admissions on different instances. Stores without it
			// (single-process SQLite / in-memory) use the per-instance serialized path
			// below, which is correct because there is only one instance.
			const storeApplyConditional = store.applyConditional
			if (storeApplyConditional) {
				return runConditionalViaStore(storeApplyConditional.bind(store), spec, options)
			}
			return serialize(async () => {
				// Idempotency: if the anchor record already exists, this set was
				// committed by an earlier attempt. Return the prior outcome without
				// re-applying (so counter increments run at most once).
				if (spec.idempotencyKey) {
					const existing = await store.findRecord(
						spec.idempotencyKey.collection,
						spec.idempotencyKey.id,
					)
					if (existing) {
						return { ok: true, idempotent: true, operations: [], records: [existing] }
					}
				}

				// Admission predicate against the target's current materialized state.
				if (spec.if && Object.keys(spec.if).length > 0) {
					const target = await store.findRecord(spec.collection, spec.id)
					if (!evaluateRoutePredicate(target, spec.if)) {
						const code = spec.reject?.code ?? 'CONDITION_NOT_MET'
						return {
							ok: false,
							code,
							message:
								spec.reject?.message ??
								`Admission condition not met on "${spec.collection}" record "${spec.id}".`,
							retriable: false,
						}
					}
				}

				// Build the atomic set: the target update (when given) then every
				// `also` mutation. Mutations in one set should address distinct records;
				// a mutation's previous-value capture reads the pre-set state.
				const mutations: RouteMutation[] = []
				if (spec.update !== undefined && spec.update !== null) {
					mutations.push({
						collection: spec.collection,
						type: 'update',
						recordId: spec.id,
						data: spec.update,
					})
				}
				if (spec.also) {
					mutations.push(...spec.also)
				}

				// Pre-build and scope-validate the WHOLE set before committing any of
				// it, so a validation failure applies nothing.
				const prepared: { op: Operation; collection: string }[] = []
				for (const mutation of mutations) {
					const p = await prepareMutation(mutation, options?.scope)
					if (!p.ok) {
						return p.rejection
					}
					prepared.push({ op: p.op, collection: mutation.collection })
				}

				const operations: Operation[] = []
				const records: (MaterializedRecord | null)[] = []
				for (const { op, collection } of prepared) {
					const result = await commitOperation(op, collection, options?.scope)
					if (!result.ok) {
						return {
							ok: false,
							code: result.code,
							message: result.message,
							retriable: result.retriable,
						}
					}
					operations.push(result.operation)
					records.push(result.record)
				}

				return { ok: true, idempotent: false, operations, records }
			})
		},

		query(collection, options): Promise<MaterializedRecord[]> {
			return queryRecords(collection, options)
		},

		findById(collection, id, options): Promise<MaterializedRecord | null> {
			return findRecordById(collection, id, options)
		},

		transaction(decide, options): Promise<RouteTransactionResult> {
			return serialize(() => runTransaction(decide, options?.scope))
		},
	}
}
