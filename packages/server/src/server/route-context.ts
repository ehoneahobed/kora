import { HybridLogicalClock, type Operation, createOperation, generateUUIDv7 } from '@korajs/core'
import { nextServerSequenceNumber } from '../apply/server-side-effect-operation'
import type { ScopeMap } from '../scopes/server-scope-filter'
import { operationMatchesScopes } from '../scopes/server-scope-filter'
import type { CollectionQueryOptions, MaterializedRecord, ServerStore } from '../store/server-store'
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
	| { ok: false; code: string; message: string }

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
 */
async function buildRouteOperation(
	store: ServerStore,
	mutation: RouteMutation,
): Promise<Operation> {
	const nodeId = store.getNodeId()
	const clock = new HybridLogicalClock(nodeId)
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

	const current = await store.findRecord(mutation.collection, mutation.recordId)

	if (mutation.type === 'update') {
		const data = mutation.data ?? {}
		return createOperation(
			{
				nodeId,
				type: 'update',
				collection: mutation.collection,
				recordId: mutation.recordId,
				data,
				previousData: current ? pickFields(current, Object.keys(data)) : {},
				sequenceNumber,
				causalDeps: [],
				schemaVersion,
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

	return {
		apply(mutation, options): Promise<RouteApplyResult> {
			return serialize(async () => {
				let op: Operation
				try {
					op = await buildRouteOperation(store, mutation)
				} catch (error) {
					if (error instanceof RouteMutationError) {
						return { ok: false, code: error.code, message: error.message }
					}
					throw error
				}

				if (options?.scope && !operationMatchesScopes(op, options.scope)) {
					return {
						ok: false,
						code: 'SCOPE_VIOLATION',
						message: `Mutation on "${mutation.collection}" is outside the provided scope.`,
					}
				}

				const result = await server.applyLocalOperation(op)
				if (result.result !== 'applied') {
					return {
						ok: false,
						code: result.rejection?.code ?? 'NOT_APPLIED',
						message:
							result.rejection?.message ??
							`Operation on "${mutation.collection}" was not applied (${result.result}).`,
					}
				}

				const record = await store.findRecord(mutation.collection, op.recordId)
				return { ok: true, operation: op, record }
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
