import { HybridLogicalClock, deriveSideEffectOpId } from '@korajs/core'
import type { HLCTimestamp, Operation } from '@korajs/core'
import type { SideEffectOp } from '@korajs/merge'
import { SERVER_RULE_PREFIX, timestampAfter } from '../constraints/constraint-authority'
import type { ServerStore } from '../store/server-store'

/**
 * Converts a merge-package referential side effect (cascade delete, set-null) of
 * `parentOp` into a server-originated operation.
 *
 * Deterministic (W7 step 3): the id is `deriveSideEffectOpId(parent, rule, target)`
 * with rule `server/relation:<relation>:<policy>`, and the timestamp is the parent's
 * next HLC tick on the server's node, never the wall clock. Every server instance,
 * session or retry that generates the effect of the same parent on the same record
 * produces the same id, so the log stores it once. The `server/` rule namespace keeps
 * it distinct from a copy a client derives for its own cascade (different node,
 * clock and sequence): both are stored, and the fold makes them idempotent in effect
 * (two deletes of a record, two writes of null).
 *
 * The timestamp sits immediately after the parent's, so a write that is causally
 * later than the delete (for example re-pointing the child to another parent) still
 * wins over the server's copy, exactly as it wins over the client's.
 */
export async function createServerSideEffectOperation(
	store: ServerStore,
	parentOp: Operation,
	effect: SideEffectOp,
	schemaVersion: number,
	sequenceNumber: number,
): Promise<Operation> {
	const nodeId = store.getNodeId()
	const policy = effect.type === 'delete' ? 'cascade' : 'set-null'
	return {
		id: await deriveSideEffectOpId(
			parentOp.id,
			`${SERVER_RULE_PREFIX}relation:${effect.relationName}:${policy}`,
			effect.recordId,
		),
		nodeId,
		type: effect.type === 'delete' ? 'delete' : 'update',
		collection: effect.collection,
		recordId: effect.recordId,
		data: effect.data,
		previousData: effect.previousData,
		timestamp: timestampAfter(parentOp.timestamp, nodeId),
		sequenceNumber,
		causalDeps: [parentOp.id],
		schemaVersion,
		mutationName: `kora:side-effect:${policy}`,
	}
}

/**
 * Allocate the next sequence number for server-originated operations.
 */
export function nextServerSequenceNumber(store: ServerStore): number {
	// Prefer the store's atomic reservation when it serves writes concurrently (the
	// Postgres conditional path), so two in-flight server operations never collide on
	// a sequence number. Serialized stores fall back to the version vector, which is
	// safe because only one server operation is ever in flight at a time.
	if (store.reserveSequenceNumber) {
		return store.reserveSequenceNumber()
	}
	// Serialized stores: never hand out the same number twice, even when several
	// operations are built before any is applied (a conditional route set prepares all
	// of its mutations first). The store refuses a second operation under one sequence
	// number (SEQUENCE_CONFLICT), so the reservation must run ahead of the vector.
	const nodeId = store.getNodeId()
	const current = store.getVersionVector().get(nodeId) ?? 0
	const next = Math.max(current, reservedServerSequence.get(store) ?? 0) + 1
	reservedServerSequence.set(store, next)
	return next
}

/** Highest server sequence number handed out per store (serialized stores only). */
const reservedServerSequence = new WeakMap<ServerStore, number>()

/** The clock of each store's server node (see {@link serverClock}). */
const serverClocks = new WeakMap<ServerStore, HybridLogicalClock>()

/**
 * The one hybrid logical clock of a store's server node, for server-authored writes
 * (route mutations). One clock per store, never a fresh one per write: two writes in
 * the same millisecond must get increasing timestamps, because the fold orders a
 * record's writes by HLC (then op id), not by arrival. With `after`, the clock is first
 * advanced past that timestamp (the newest write the caller read), so the new write
 * sorts after every write it was based on.
 *
 * @param store - The server store whose node authors the write
 * @param after - The newest timestamp the write must follow, if any
 */
export function serverClock(store: ServerStore, after?: HLCTimestamp | null): HybridLogicalClock {
	let clock = serverClocks.get(store)
	if (!clock) {
		clock = new HybridLogicalClock(store.getNodeId())
		serverClocks.set(store, clock)
	}
	if (after) clock.advanceTo(after)
	return clock
}
