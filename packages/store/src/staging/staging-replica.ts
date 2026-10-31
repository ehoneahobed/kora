import type { OfflineCompletion, Operation } from '@korajs/core'
import { saveDeliveryWatermarkInTx } from '../sync/sync-state'
import type { StorageAdapter } from '../types'
import { type StagingMergeHost, type StagingMergeResult, mergeStagingInto } from './staging-merge'

/** Where the merged replica's delivery progress lands in the live database. */
export interface StagingProgress {
	/** The delivery view (its signature) the staged stream belonged to. */
	signature: string
	/** The delivery watermark the staged stream reached: every in-scope operation up to it is staged. */
	watermark: number
	/** The completion mark of a final batch, written in the same transaction as the watermark. */
	completion?: OfflineCompletion
}

/** What {@link StagingReplica.merge} may do beyond copying. */
export interface StagingMergeOptions {
	/**
	 * Apply one staged operation the live database already has history for, exactly as the
	 * sync engine would (default: `Store.applyRemoteOperation`). `MergeAwareSyncStore` passes
	 * its pipeline, so referential cascades and constraint reports are the ordinary ones.
	 */
	replay?: (operation: Operation) => Promise<void>
}

/**
 * A scratch replica of the live database that a large first sync is applied into before it
 * is merged (`docs/design/first-visit-parity.md` 5.7).
 *
 * `store` is an ordinary {@link import('../store/store').Store} over an in-memory database of
 * the same engine, so `applyRemoteBatch`, the batch prefetch and the fold run unmodified; its
 * delivery watermark, version vector and quarantine rows are its own. Nothing reads it but the
 * merge, and nothing about it survives the page: a crash, a reload or a replaced worker loses
 * it, and replication simply starts again from the live database's watermark (decision D10).
 * Because it is in memory it has no rollback journal to write, which is where the first sync's
 * cost went (docs/design/first-visit-parity.md, "S3 result").
 */
export class StagingReplica {
	private closed = false
	private merging = false

	/** @internal Created by `Store.beginStaging`. */
	constructor(
		/** The staging store the engine applies delivery batches into. */
		readonly store: import('../store/store').Store,
		private readonly staging: StorageAdapter,
		private readonly host: StagingMergeHost,
		private readonly authoritiesUnchanged: () => boolean,
		private readonly release: () => void,
	) {}

	/** Whether the replica was discarded or merged away. */
	isClosed(): boolean {
		return this.closed
	}

	/**
	 * Merge everything staged into the live database and write `progress` in the last
	 * transaction. On `merged` the replica is closed. On `unmergeable` it is closed too: the
	 * caller replicates again from the live watermark (nothing wrong stays behind: the chunks
	 * that committed hold whole records).
	 */
	async merge(
		progress: StagingProgress,
		options: StagingMergeOptions = {},
	): Promise<StagingMergeResult> {
		if (this.closed) return { kind: 'unmergeable', reason: 'the staging replica is closed' }
		if (this.merging) return { kind: 'unmergeable', reason: 'a merge is already running' }
		this.merging = true
		try {
			if (!this.authoritiesUnchanged()) {
				return {
					kind: 'unmergeable',
					reason: "the server's authoritative node ids changed while the replica was staged",
				}
			}
			const host: StagingMergeHost = options.replay
				? { ...this.host, replay: options.replay }
				: this.host
			return await mergeStagingInto(host, this.staging, {
				writeProgress: (tx) =>
					saveDeliveryWatermarkInTx(
						tx,
						progress.signature,
						progress.watermark,
						progress.completion,
					),
			})
		} finally {
			this.merging = false
			await this.discard()
		}
	}

	/** Drop the replica and everything in it. Safe to call more than once. */
	async discard(): Promise<void> {
		if (this.closed) return
		this.closed = true
		this.release()
		try {
			await this.store.close()
		} catch {
			// A scratch database that will not close is terminated with its worker or page.
		}
	}
}
