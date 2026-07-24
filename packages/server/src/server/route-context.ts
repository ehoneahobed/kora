import {
	type AtomicOp,
	HybridLogicalClock,
	type Operation,
	createOperation,
	generateUUIDv7,
	isAtomicOp,
	resolveAtomicOp,
	toAtomicOp,
} from '@korajs/core'
import { isRetriableRejection } from '../apply/rejection-taxonomy'
import { type RoutePredicate, evaluateRoutePredicate } from '../apply/route-predicate'
import { nextServerSequenceNumber } from '../apply/server-side-effect-operation'
import type { ScopeMap } from '../scopes/server-scope-filter'
import { operationMatchesScopes } from '../scopes/server-scope-filter'
import type {
	CollectionQueryOptions,
	ConditionalApplyInput,
	ConditionalApplyResult,
	MaterializedRecord,
	ServerStore,
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
 * (hidden), mirroring `operationMatchesScopes` on the write path.
 */
function recordMatchesScope(
	collection: string,
	record: MaterializedRecord,
	scope: ScopeMap,
): boolean {
	const collectionScope = scope[collection]
	if (!collectionScope) {
		return false
	}
	for (const [field, expected] of Object.entries(collectionScope)) {
		if (record[field] !== expected) {
			return false
		}
	}
	return true
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
	const clock = clockOverride ?? new HybridLogicalClock(nodeId)
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
	// Promise chain that serializes apply() so sequence allocation + apply is
	// atomic per mutation, even under concurrent in-flight requests.
	let mutationTail: Promise<unknown> = Promise.resolve()

	function serialize<T>(work: () => Promise<T>): Promise<T> {
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
	): Promise<PreparedMutation> {
		let op: Operation
		try {
			op = await buildRouteOperation(store, mutation)
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

		if (scope && !operationMatchesScopes(op, scope)) {
			return {
				ok: false,
				rejection: {
					ok: false,
					code: 'SCOPE_VIOLATION',
					message: `Mutation on "${mutation.collection}" is outside the provided scope.`,
					retriable: isRetriableRejection('SCOPE_VIOLATION'),
				},
			}
		}

		return { ok: true, op }
	}

	// Apply a prepared operation and read back the resulting record.
	async function commitOperation(op: Operation, collection: string): Promise<RouteApplyResult> {
		const result = await server.applyLocalOperation(op)
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
		return commitOperation(prepared.op, mutation.collection)
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
						// Validate scope inside the locked transaction. Throwing here rolls
						// the transaction back, so a violation in any mutation applies nothing.
						if (scope && !operationMatchesScopes(op, scope)) {
							throw new RouteMutationError(
								'SCOPE_VIOLATION',
								`Mutation on "${mutation.collection}" is outside the provided scope.`,
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

	return {
		apply(mutation, options): Promise<RouteApplyResult> {
			return serialize(() => rawApply(mutation, options?.scope))
		},

		applyConditional(spec, options): Promise<RouteConditionalResult> {
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
					const result = await commitOperation(op, collection)
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

		async query(collection, options): Promise<MaterializedRecord[]> {
			const { scope, ...queryOptions } = options ?? {}
			const records = await store.queryCollection(collection, queryOptions)
			if (!scope) {
				return records
			}
			return records.filter((record) => recordMatchesScope(collection, record, scope))
		},

		async findById(collection, id, options): Promise<MaterializedRecord | null> {
			const record = await store.findRecord(collection, id)
			if (!record) {
				return null
			}
			if (options?.scope && !recordMatchesScope(collection, record, options.scope)) {
				return null
			}
			return record
		},
	}
}
