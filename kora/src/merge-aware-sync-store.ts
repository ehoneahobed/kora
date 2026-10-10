import type { KoraEventEmitter, Operation, VersionVector } from '@korajs/core'
import type { MergeEngine } from '@korajs/merge'
import type { ResequenceResult, Store } from '@korajs/store'
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

	/** Whether the local schema defines this collection (unknown ones are quarantined). */
	hasCollection(collection: string): boolean {
		return this.store.getSchema().collections[collection] !== undefined
	}

	async applyRemoteOperation(op: Operation): Promise<ApplyResult> {
		return this.pipeline.applyRemote(op)
	}

	/** W7: the server's authoritative node ids (handshake), persisted by the store. */
	async settleAfterCatchUp(options?: { provisionalOnly?: boolean }): Promise<number> {
		return this.store.settleAfterCatchUp(options)
	}

	async setAuthoritativeNodeIds(
		nodeIds: readonly string[],
		revokedNodeIds: readonly string[] = [],
	): Promise<void> {
		await this.store.setAuthoritativeNodeIds(nodeIds, revokedNodeIds)
	}

	async applyScopeRetraction(collection: string, recordId: string): Promise<void> {
		return this.store.applyScopeRetraction(collection, recordId)
	}

	async applyCollectionNarrowing(
		collection: string,
		scope: Record<string, unknown> | null,
		keep: ReadonlySet<string>,
	): Promise<string[]> {
		return this.store.applyCollectionNarrowing(collection, scope, keep)
	}

	async recheckAccessNarrowing(
		pending: (collection: string) => ReadonlySet<string>,
		options?: { retractedOnly?: boolean },
	): Promise<Array<{ collection: string; recordId: string }>> {
		return this.store.recheckAccessNarrowing(pending, options)
	}

	async deferScopeRetraction(collection: string, recordId: string): Promise<boolean> {
		return this.store.deferScopeRetraction(collection, recordId)
	}

	async applyScopeNarrowing(
		scopes: Record<string, Record<string, unknown>>,
	): Promise<Array<{ collection: string; recordId: string }>> {
		return this.store.applyScopeNarrowing(scopes)
	}

	/**
	 * Delegates node-id rotation to the store (RT-21): the server refused this
	 * device's node id, so unsynced writes move to a fresh one.
	 */
	async rotateNodeId(ids: string[]): Promise<{ nodeId: string; operations: Operation[] }> {
		return this.store.rotateNodeId(ids)
	}

	/** Delegates the pinned-node write guard to the store (F9). */
	setPinnedNodeOwnedElsewhere(owned: boolean): void {
		this.store.setPinnedNodeOwnedElsewhere(owned)
	}

	/** Delegates re-authoring a refused adopted node's writes to the store. */
	async reauthorLocalNode(
		fromNodeId: string,
		ids: string[],
		principal: string,
	): Promise<{ nodeId: string; operations: Operation[] }> {
		return this.store.reauthorLocalNode(fromNodeId, ids, principal)
	}

	/** Move back to a node id this database used before (RT-38). */
	clearSignedInUser(): void {
		this.store.clearSignedInUser()
	}

	bindPrincipal(principal: string): ReturnType<Store['bindPrincipal']> {
		return this.store.bindPrincipal(principal)
	}

	async switchNodeId(nodeId: string): Promise<void> {
		await this.store.switchNodeId(nodeId)
	}

	/** Durability barrier before an upload (RT-35). */
	async ensureDurable(): Promise<void> {
		await this.store.ensureDurable()
	}

	/** Raise a local node's sequence counter past numbers the server holds (RT-35). */
	raiseSequenceFloor(nodeId: string, floor: number): Promise<boolean> {
		return this.store.raiseSequenceFloor(nodeId, floor)
	}

	/** Renumber an operation refused with SEQUENCE_CONFLICT (RT-35); a version-2 op is re-hashed. */
	resequenceOperation(
		operationId: string,
		nodeId: string,
		floor: number,
		rewritableDependents?: readonly string[],
	): Promise<ResequenceResult | null> {
		return this.store.resequenceOperation(operationId, nodeId, floor, rewritableDependents)
	}

	/** Take over a closed tab's node id (RT-40). */
	claimLocalNode(nodeId: string): Promise<(() => void) | null> {
		return this.store.claimLocalNode(nodeId)
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
