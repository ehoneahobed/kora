import type {
	KoraEvent,
	KoraEventByType,
	KoraEventEmitter,
	KoraEventListener,
	KoraEventType,
	OfflineCompletion,
	Operation,
} from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { saveDeliveryWatermarkInTx } from '../sync/sync-state'
import type { StorageAdapter } from '../types'
import { type StagingMergeHost, type StagingMergeResult, mergeStagingInto } from './staging-merge'

/** Most events of the replica's applies kept for replay after the merge (memory bound). */
const MAX_BUFFERED_EVENTS = 100_000
/** Events replayed to the live listeners before yielding to the event loop. */
const REPLAY_SLICE = 500

/**
 * The events of a replica's applies (operation applied, merge traces, constraint reports).
 * The replica's operations are not in the live database yet, so nothing is published about
 * them: the events are kept and replayed in order to the live listeners once the merge has
 * committed ("events after commit only"), in slices so replaying cannot stall the page.
 * `query:*` events are not kept (nothing subscribes to the replica; the merge invalidates the
 * live queries itself) and a storage failure of the replica is reported at once.
 */
export class ReplicaEventBuffer implements KoraEventEmitter {
	private readonly inner = new SimpleEventEmitter()
	private events: KoraEvent[] = []
	private dropped = 0

	constructor(private readonly live: KoraEventEmitter | null) {}

	on<T extends KoraEventType>(type: T, listener: KoraEventListener<T>): () => void {
		return this.inner.on(type, listener)
	}

	off<T extends KoraEventType>(type: T, listener: KoraEventListener<T>): void {
		this.inner.off(type, listener)
	}

	emit<T extends KoraEventType>(event: KoraEventByType<T>): void {
		this.inner.emit(event)
		if (event.type === 'store:persistence-error') {
			this.live?.emit(event)
		} else if (event.type.startsWith('query:')) {
			return
		} else if (this.events.length < MAX_BUFFERED_EVENTS) {
			this.events.push(event)
		} else {
			this.dropped += 1
		}
	}

	/** Replay the kept events to `live` in order; returns how many were dropped at the cap. */
	async flush(): Promise<number> {
		const events = this.events
		this.events = []
		if (this.live) {
			for (let start = 0; start < events.length; start += REPLAY_SLICE) {
				for (const event of events.slice(start, start + REPLAY_SLICE)) this.live.emit(event)
				if (start + REPLAY_SLICE < events.length) {
					await new Promise<void>((resolve) => setTimeout(resolve, 0))
				}
			}
		}
		return this.dropped
	}

	/** Forget everything kept (the replica was discarded). */
	clear(): void {
		this.events = []
	}
}

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
		private readonly events: ReplicaEventBuffer,
	) {}

	/** The replica's event buffer: hand it to the replica's merge-aware store as its emitter. */
	get emitter(): KoraEventEmitter {
		return this.events
	}

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
			const result = await mergeStagingInto(host, this.staging, {
				writeProgress: (tx) =>
					saveDeliveryWatermarkInTx(
						tx,
						progress.signature,
						progress.watermark,
						progress.completion,
					),
			})
			if (result.kind !== 'merged') return result
			// Committed: now the events of the replica's applies are the live listeners' to see.
			const eventsDropped = await this.events.flush()
			return eventsDropped > 0 ? { ...result, eventsDropped } : result
		} finally {
			this.merging = false
			await this.discard()
		}
	}

	/** Drop the replica and everything in it. Safe to call more than once. */
	async discard(): Promise<void> {
		if (this.closed) return
		this.closed = true
		this.events.clear()
		this.release()
		try {
			await this.store.close()
		} catch {
			// A scratch database that will not close is terminated with its worker or page.
		}
	}
}
