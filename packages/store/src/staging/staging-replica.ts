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

/**
 * Most `operation:applied` events kept for replay (memory bound: each holds its operation).
 * Beyond it they are counted, and the count is reported with the merge, never lost silently.
 */
const MAX_APPLIED_EVENTS = 20_000
/**
 * Most merge, constraint and other events kept. They are what DevTools and the app's conflict
 * handling rely on, so they have their own, larger budget and are never displaced by applies.
 */
const MAX_OTHER_EVENTS = 50_000
/** Events replayed to the live listeners before yielding to the event loop. */
const REPLAY_SLICE = 500
/** How long `discard()` waits for a running merge chunk to end before closing under it. */
const MERGE_CANCEL_WAIT_MS = 10_000

/** `collection\0recordId` of the record an event is about, or null (connection-level events). */
function recordKeyOf(event: KoraEvent): string | null {
	const candidate = event as unknown as {
		operation?: { collection?: string; recordId?: string }
		operationA?: { collection?: string; recordId?: string }
		trace?: { operationA?: { collection?: string; recordId?: string } }
	}
	const operation = candidate.operation ?? candidate.operationA ?? candidate.trace?.operationA
	if (!operation?.collection || !operation.recordId) return null
	return `${operation.collection}\u0000${operation.recordId}`
}

/** What replaying a buffer did. */
export interface ReplicaEventFlush {
	/** Events not kept at the caps, by event type (reported, never silently dropped). */
	summarized: Record<string, number>
	/** Listener exceptions caught while replaying (a listener must not undo a committed merge). */
	listenerErrors: number
}

/**
 * The events of a replica's applies (operation applied, merge traces, constraint reports).
 * The replica's operations are not in the live database yet, so nothing is published about
 * them: the events are kept and replayed in order to the live listeners once the merge has
 * committed ("events after commit only"), in slices so replaying cannot stall the page.
 * Applies and the rarer, more important merge/constraint events have separate budgets;
 * what exceeds a budget is counted by type and reported with the merge. `query:*` events are
 * not kept (nothing subscribes to the replica; the merge invalidates the live queries itself)
 * and a storage failure of the replica is reported at once.
 */
export class ReplicaEventBuffer implements KoraEventEmitter {
	private readonly inner = new SimpleEventEmitter()
	private events: KoraEvent[] = []
	private appliedKept = 0
	private otherKept = 0
	private summarized: Record<string, number> = {}

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
			return
		}
		if (event.type.startsWith('query:')) return
		const applied = event.type === 'operation:applied'
		if (applied ? this.appliedKept < MAX_APPLIED_EVENTS : this.otherKept < MAX_OTHER_EVENTS) {
			this.events.push(event)
			if (applied) this.appliedKept += 1
			else this.otherKept += 1
		} else {
			this.summarized[event.type] = (this.summarized[event.type] ?? 0) + 1
		}
	}

	/**
	 * Replay the kept events to `live` in order. `only` limits the replay to events about
	 * records it accepts (the records an unfinished merge already made live); events about no
	 * record are kept only with `keepKeyless`.
	 */
	async flush(
		only?: (recordKey: string) => boolean,
		keepKeyless = false,
	): Promise<ReplicaEventFlush> {
		const events = this.events
		const summarized = this.summarized
		this.events = []
		this.summarized = {}
		this.appliedKept = 0
		this.otherKept = 0
		let listenerErrors = 0
		if (this.live) {
			let sinceYield = 0
			for (const event of events) {
				if (only) {
					const key = recordKeyOf(event)
					if (key === null ? !keepKeyless : !only(key)) continue
				}
				try {
					this.live.emit(event)
				} catch {
					// A throwing listener must not turn a committed merge into a failed one.
					listenerErrors += 1
				}
				sinceYield += 1
				if (sinceYield >= REPLAY_SLICE) {
					sinceYield = 0
					await new Promise<void>((resolve) => setTimeout(resolve, 0))
				}
			}
		}
		return { summarized, listenerErrors }
	}

	/** Forget everything kept (the replica was discarded). */
	clear(): void {
		this.events = []
		this.summarized = {}
		this.appliedKept = 0
		this.otherKept = 0
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
	private cancelled = false
	private merging = false
	private mergeRun: Promise<unknown> | null = null
	/** Records (`collection\0id`) a merge that has not finished already copied whole into the live database. */
	private readonly copiedRecords = new Set<string>()
	/** Records (`collection\0id`) the live database already knew, merged through the ordinary apply path. */
	private readonly contestedRecords = new Set<string>()

	/** @internal Created by `Store.beginStaging`. */
	constructor(
		/** The staging store the engine applies delivery batches into. */
		readonly store: import('../store/store').Store,
		private readonly staging: StorageAdapter,
		private readonly host: StagingMergeHost,
		private readonly authoritiesUnchanged: () => boolean,
		private readonly release: () => void,
		private readonly events: ReplicaEventBuffer,
		/** How long `discard()` waits for a running chunk (injectable for tests). */
		private readonly cancelWaitMs: number = MERGE_CANCEL_WAIT_MS,
	) {}

	/** The replica's event buffer: hand it to the replica's merge-aware store as its emitter. */
	get emitter(): KoraEventEmitter {
		return this.events
	}

	/** Whether the replica was discarded, cancelled or merged away (a running merge stops between chunks). */
	isClosed(): boolean {
		return this.closed || this.cancelled
	}

	/** Bytes the replica's database holds (pages in use times page size). */
	async sizeBytes(): Promise<number> {
		const pages = await this.staging.query<{ page_count: number }>('PRAGMA page_count')
		const size = await this.staging.query<{ page_size: number }>('PRAGMA page_size')
		return (pages[0]?.page_count ?? 0) * (size[0]?.page_size ?? 0)
	}

	/**
	 * Merge everything staged into the live database and write `progress` in the last
	 * transaction. On `merged` the replica is closed. On `unmergeable` it is closed too: the
	 * caller replicates again from the live watermark (nothing wrong stays behind: the chunks
	 * that committed hold whole records, and the events of their records are replayed).
	 */
	async merge(
		progress: StagingProgress,
		options: StagingMergeOptions = {},
	): Promise<StagingMergeResult> {
		if (this.isClosed()) return { kind: 'unmergeable', reason: 'the staging replica is closed' }
		if (this.merging) return { kind: 'unmergeable', reason: 'a merge is already running' }
		this.merging = true
		const run = this.runMerge(progress, options)
		this.mergeRun = run
		try {
			return await run
		} finally {
			this.merging = false
			this.mergeRun = null
			await this.finish()
		}
	}

	private async runMerge(
		progress: StagingProgress,
		options: StagingMergeOptions,
	): Promise<StagingMergeResult> {
		if (!this.authoritiesUnchanged()) {
			return {
				kind: 'unmergeable',
				reason: "the server's authoritative node ids changed while the replica was staged",
			}
		}
		const host: StagingMergeHost = {
			...this.host,
			...(options.replay ? { replay: options.replay } : {}),
			noteChunk: (collection, copied, contested) => {
				for (const id of copied) this.copiedRecords.add(`${collection}\u0000${id}`)
				for (const id of contested) this.contestedRecords.add(`${collection}\u0000${id}`)
			},
		}
		let result: StagingMergeResult
		try {
			result = await mergeStagingInto(host, this.staging, {
				writeProgress: (tx) =>
					saveDeliveryWatermarkInTx(
						tx,
						progress.signature,
						progress.watermark,
						progress.completion,
					),
			})
		} catch (error) {
			await this.events.flush((key) => this.copiedRecords.has(key))
			throw error
		}
		if (result.kind !== 'merged') {
			// Chunks that committed made their records live: their operations were applied.
			await this.events.flush((key) => this.copiedRecords.has(key))
			return result
		}
		// Committed: now the events of the replica's applies are the live listeners' to see.
		// Not the contested records': those operations went through the live pipeline, which
		// reported what it applied and stayed silent about what the live log already held (a
		// retry after a failed merge replays records an earlier attempt copied).
		const flushed = await this.events.flush((key) => !this.contestedRecords.has(key), true)
		const eventsDropped = Object.values(flushed.summarized).reduce((a, b) => a + b, 0)
		return {
			...result,
			...(eventsDropped > 0 ? { eventsDropped, eventCounts: flushed.summarized } : {}),
			...(flushed.listenerErrors > 0 ? { listenerErrors: flushed.listenerErrors } : {}),
		}
	}

	/**
	 * Drop the replica and everything in it. A merge in flight is cancelled and awaited (a
	 * bounded wait), so no chunk commits after this resolves and the live database's overlay
	 * guard is not released under a running write. Safe to call more than once.
	 */
	async discard(): Promise<void> {
		if (this.closed) return
		this.cancelled = true
		const run = this.mergeRun
		if (run) {
			let settled = false
			let timer: ReturnType<typeof setTimeout> | undefined
			await Promise.race([
				run.then(
					() => {
						settled = true
					},
					() => {
						settled = true
					},
				),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, this.cancelWaitMs)
				}),
			])
			clearTimeout(timer)
			// A chunk that outlives the wait may still be writing: the overlay guard and the
			// scratch database stay up until the merge itself ends (its `finally` finishes the
			// replica), so nothing is released under a running write.
			if (!settled) return
		}
		await this.finish()
	}

	private async finish(): Promise<void> {
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
