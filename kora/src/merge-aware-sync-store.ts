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

	async applyRemoteOperation(op: Operation): Promise<ApplyResult> {
		return this.pipeline.applyRemote(op)
	}
}
