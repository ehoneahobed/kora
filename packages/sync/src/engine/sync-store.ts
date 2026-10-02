import type { ApplyFailureReason, ApplyResult, Operation, VersionVector } from '@korajs/core'

export type { ApplyFailureReason, ApplyResult } from '@korajs/core'

/**
 * Interface that the local store must implement for sync.
 * This decouples @korajs/sync from @korajs/store — the store satisfies this interface.
 *
 * @korajs/store's Store class already implements these methods:
 * - getVersionVector() — returns the current version vector
 * - getNodeId() — returns this instance's nodeId
 * - applyRemoteOperation(op) — applies a remote op with dedup and merge
 * - getOperationRange(nodeId, fromSeq, toSeq) — fetches operations from the log
 */
export interface SyncStore {
	/** Get the current version vector for this store */
	getVersionVector(): VersionVector

	/** Get the node ID for this store instance */
	getNodeId(): string

	/**
	 * Apply a remote operation to the local store.
	 * Must handle deduplication (content-addressed) and merge resolution.
	 * @returns 'applied' if the operation was new, 'duplicate' if already seen, 'skipped' if filtered
	 */
	applyRemoteOperation(op: Operation): Promise<ApplyResult>

	/**
	 * Get operations from a specific node within a sequence range.
	 * Used for computing deltas during sync.
	 * @param nodeId - The originating node
	 * @param fromSeq - Start sequence number (inclusive)
	 * @param toSeq - End sequence number (inclusive)
	 */
	getOperationRange(nodeId: string, fromSeq: number, toSeq: number): Promise<Operation[]>

	/**
	 * Optional: re-stamp never-acknowledged local operations after a fast device
	 * clock was corrected (timestamp rebase). Optional so hand-rolled SyncStore
	 * implementations keep working; when absent the engine simply skips the
	 * rebase and falls back to the clock-block behavior.
	 *
	 * @param ids - Operation ids that are candidates for re-stamping
	 * @param correctedNowMs - Trusted "now" (server time at handshake) in ms
	 */
	/**
	 * Optional: move the device to a fresh node id, re-authoring the given unsynced
	 * operations under it (RT-21). Called after the server refused the node id
	 * (`NODE_ID_CLAIMED`). Returns the new node id and the rewritten operations.
	 */
	rotateNodeId?(ids: string[]): Promise<{ nodeId: string; operations: Operation[] }>

	/**
	 * Optional: move the device back to a node id this database authored under before
	 * (RT-38), without rewriting anything. Used after the server refused the current node
	 * (another principal owns it) to try a node the signed-in principal owns.
	 */
	switchNodeId?(nodeId: string): Promise<void>

	/**
	 * Optional: bind local writes to the signed-in user (RT-42). Moves the store to the
	 * user's own node (or a fresh one) when the current node belongs to another user.
	 * `conflict`: the node id is pinned and belongs to another user.
	 */
	bindPrincipal?(principal: string): Promise<{
		nodeId: string
		previousNodeId: string
		switched: boolean
		conflict: boolean
	}>

	/**
	 * Optional durability barrier (RT-35): resolve once every write committed so far is
	 * durable on this device; reject when it cannot be made durable. The engine awaits it
	 * before any operation leaves the device, so the server never holds an operation the
	 * device could lose on reload.
	 */
	ensureDurable?(): Promise<void>

	/**
	 * Optional: raise a local node's sequence counter to at least `floor`, in a
	 * transaction (RT-35: the server holds operations of this node the device lost).
	 * @returns Whether the counter moved
	 */
	raiseSequenceFloor?(nodeId: string, floor: number): Promise<boolean>

	/**
	 * Optional: give a local operation a fresh sequence number above `floor`, keeping its
	 * id (RT-35: the server refused it with `SEQUENCE_CONFLICT` because it holds another
	 * operation of this node, lost locally, under that number).
	 * @returns The renumbered operation, or null when it is not in the log
	 */
	resequenceOperation?(
		operationId: string,
		nodeId: string,
		floor: number,
	): Promise<Operation | null>

	/**
	 * Optional: take over another local node id's unsynced writes (RT-40). Resolves to a
	 * release function when no live tab uses it, or null when one does.
	 */
	claimLocalNode?(nodeId: string): Promise<(() => void) | null>

	rebaseUnsyncedOperations?(
		ids: string[],
		correctedNowMs: number,
	): Promise<{ operations: Operation[]; idMapping: Record<string, string>; rebasedCount: number }>

	/**
	 * Optional: read a record's current materialized field values, used to backfill
	 * scope / query-subset fields that a partial update (or a delete) does not carry
	 * in its own data. Without it, such an operation would be judged out of scope by
	 * its changed fields alone and wrongly dropped from sync. Optional so hand-rolled
	 * SyncStore implementations keep working; when absent, the engine falls back to
	 * judging visibility from the operation's own data.
	 *
	 * @returns the record's fields, or null when it cannot be read.
	 */
	readRecordFields?(collection: string, recordId: string): Promise<Record<string, unknown> | null>

	/**
	 * Optional: whether the local schema defines this collection. Lets the engine tell a
	 * merge-decided `'skipped'` (the record is settled, nothing to keep) from a skip
	 * because the collection is unknown (the operation must be quarantined and replayed
	 * after a schema upgrade). Without it every `'skipped'` result is quarantined.
	 */
	hasCollection?(collection: string): boolean

	/**
	 * Remove a record from this client's materialized authorization view without
	 * writing a domain delete to the replicated operation log.
	 */
	applyScopeRetraction?(collection: string, recordId: string): Promise<void>
	/** Retract every currently materialized row outside a newly accepted scope. */
	applyScopeNarrowing?(
		scopes: Record<string, Record<string, unknown>>,
	): Promise<Array<{ collection: string; recordId: string }>>
}
