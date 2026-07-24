import type { KoraEventEmitter, Operation, VersionVector } from '@korajs/core'
import type { MergeEngine } from '@korajs/merge'
import type { Store } from '@korajs/store'
import type { ApplyResult, SyncStore } from '@korajs/sync'
import { ApplyPipeline } from './apply-pipeline'

export interface MergeAwareSyncStoreOptions {
	/** Increments SyncEngine conflict counter when merge runs on a conflicting update. */
	onMergeConflict?: () => void
}

/**
 * Wraps a Store to route remote sync operations through {@link ApplyPipeline}.
 *
 * Ensures remote deletes honor referential integrity (cascade, set-null, restrict)
 * and remote updates use the full three-tier merge engine with constraint context.
 */
export class MergeAwareSyncStore implements SyncStore {
	private readonly pipeline: ApplyPipeline

	constructor(
		private readonly store: Store,
		mergeEngine: MergeEngine,
		emitter: KoraEventEmitter | null,
		options?: MergeAwareSyncStoreOptions,
	) {
		this.pipeline = new ApplyPipeline({
			store,
			mergeEngine,
			emitter,
			onMergeConflict: options?.onMergeConflict,
		})
	}

	getVersionVector(): VersionVector {
		return this.store.getVersionVector()
	}

	getNodeId(): string {
		return this.store.getNodeId()
	}

	async getOperationRange(nodeId: string, fromSeq: number, toSeq: number): Promise<Operation[]> {
		return this.store.getOperationRange(nodeId, fromSeq, toSeq)
	}

	/**
	 * Read a record's current field values (including a soft-deleted row) so the sync
	 * engine can backfill scope / query-subset fields a partial update or delete does
	 * not restate, and thus never wrongly drop an in-scope edit from sync.
	 */
	async readRecordFields(
		collection: string,
		recordId: string,
	): Promise<Record<string, unknown> | null> {
		const snapshot = await this.store.findMaterializedRow(collection, recordId)
		return snapshot ? snapshot.record : null
	}

	async applyRemoteOperation(op: Operation): Promise<ApplyResult> {
		return this.pipeline.applyRemote(op)
	}

	/**
	 * Delegates timestamp rebase to the store so the sync engine can re-stamp
	 * never-acknowledged operations after a fast device clock is corrected.
	 */
	async rebaseUnsyncedOperations(
		ids: string[],
		correctedNowMs: number,
	): Promise<{ operations: Operation[]; idMapping: Record<string, string>; rebasedCount: number }> {
		return this.store.rebaseUnsyncedOperations(ids, correctedNowMs)
	}
}
