import type { KoraEventEmitter, Operation, VersionVector } from '@korajs/core'
import type { MergeEngine, MergeInput } from '@korajs/merge'
import type { Store } from '@korajs/store'
import type { ApplyResult, SyncStore } from '@korajs/sync'

/**
 * Wraps a Store to interpose merge resolution before applying remote operations.
 *
 * For inserts and deletes, delegates directly to the underlying Store.
 * For updates, checks whether the remote operation's previousData conflicts
 * with the current local state. If so, runs MergeEngine to resolve and
 * applies the merged result instead.
 *
 * This keeps MergeEngine integration out of Store and SyncEngine internals.
 */
export class MergeAwareSyncStore implements SyncStore {
	constructor(
		private readonly store: Store,
		private readonly mergeEngine: MergeEngine,
		private readonly emitter: KoraEventEmitter | null,
	) {}

	getVersionVector(): VersionVector {
		return this.store.getVersionVector()
	}

	getNodeId(): string {
		return this.store.getNodeId()
	}

	async getOperationRange(nodeId: string, fromSeq: number, toSeq: number): Promise<Operation[]> {
		return this.store.getOperationRange(nodeId, fromSeq, toSeq)
	}

	async applyRemoteOperation(op: Operation): Promise<ApplyResult> {
		// Only intercept updates that have previousData (needed for 3-way merge)
		if (op.type !== 'update' || !op.data || !op.previousData) {
			return this.store.applyRemoteOperation(op)
		}

		// Look up current local record to detect conflicts
		const schema = this.store.getSchema()
		const collectionDef = schema.collections[op.collection]
		if (!collectionDef) {
			return this.store.applyRemoteOperation(op)
		}

		const accessor = this.store.collection(op.collection)
		const currentRecord = await accessor.findById(op.recordId)

		// If record doesn't exist locally, delegate directly
		if (!currentRecord) {
			return this.store.applyRemoteOperation(op)
		}

		// Check for conflicts: do any of the remote op's changed fields differ
		// from what the remote op expected them to be (previousData)?
		let hasConflict = false
		for (const field of Object.keys(op.data)) {
			const expectedBase = op.previousData[field]
			const currentLocal = currentRecord[field]

			// If the local state doesn't match what the remote expected,
			// it means the local side also changed this field — conflict.
			if (!deepEqual(expectedBase, currentLocal)) {
				hasConflict = true
				break
			}
		}

		// No conflict: safe to apply directly
		if (!hasConflict) {
			return this.store.applyRemoteOperation(op)
		}

		// Conflict detected — run merge engine
		// Build a synthetic "local operation" representing the current local state changes
		// relative to the same base the remote operation used.
		this.emitter?.emit({
			type: 'merge:started',
			operationA: op,
			operationB: op,
		})

		const baseState: Record<string, unknown> = { ...op.previousData }
		const localOp: Operation = {
			...op,
			// The "local" operation's data is the diff between base and current local state
			data: buildLocalDiff(op.previousData, currentRecord, Object.keys(op.data)),
			previousData: op.previousData,
			nodeId: this.store.getNodeId(),
		}

		const input: MergeInput = {
			local: localOp,
			remote: op,
			baseState,
			collectionDef,
		}

		const result = this.mergeEngine.mergeFields(input)

		// Emit merge traces
		for (const trace of result.traces) {
			this.emitter?.emit({ type: 'merge:conflict', trace })
		}
		const firstTrace = result.traces[0]
		if (firstTrace) {
			this.emitter?.emit({ type: 'merge:completed', trace: firstTrace })
		}

		// Create a modified operation with the merged data to apply
		const mergedOp: Operation = {
			...op,
			data: result.mergedData,
		}

		return this.store.applyRemoteOperation(mergedOp)
	}
}

/**
 * Build the local diff: for each field the remote op changed,
 * extract the current local value (which may differ from both base and remote).
 */
function buildLocalDiff(
	baseState: Record<string, unknown>,
	currentRecord: Record<string, unknown>,
	fields: string[],
): Record<string, unknown> {
	const diff: Record<string, unknown> = {}
	for (const field of fields) {
		diff[field] = currentRecord[field]
	}
	return diff
}

/**
 * Simple deep equality check for comparing field values.
 * Handles primitives, arrays, and plain objects.
 */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true
	if (a === null || b === null) return false
	if (a === undefined || b === undefined) return false
	if (typeof a !== typeof b) return false

	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false
		return a.every((val, i) => deepEqual(val, b[i]))
	}

	if (typeof a === 'object' && typeof b === 'object') {
		const keysA = Object.keys(a as Record<string, unknown>)
		const keysB = Object.keys(b as Record<string, unknown>)
		if (keysA.length !== keysB.length) return false
		return keysA.every((key) =>
			deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
		)
	}

	return false
}
