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
	rebaseUnsyncedOperations?(
		ids: string[],
		correctedNowMs: number,
	): Promise<{ operations: Operation[]; idMapping: Record<string, string>; rebasedCount: number }>
}
