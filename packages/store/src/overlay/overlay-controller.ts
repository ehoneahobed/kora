import type { KoraEvent } from '@korajs/core'
import { OverlayDivergedError } from '../errors'
import { lookupOperation } from '../mutations/commit-outcome'
import type { InstantUpdatesOptions, StorageAdapter } from '../types'
import {
	type OverlayEvent,
	type PendingEntry,
	PendingWrites,
	type PendingWritesOptions,
} from './pending-writes'
import type { WriteOverlay } from './write-overlay'

/*
 * One per store built with `instantUpdates` (instant-UI stage S4,
 * docs/design/instant-ui-updates.md 4.2, 6, 7, 10, 11). It owns the registry and decides
 * everything the registry deliberately does not: which of its events become public
 * events, when a collection stops being predicted (the circuit breaker, I10), how a write
 * whose commit answer was lost is decided later (M2), when pending entries expire, and
 * when the overlay is cleared (I12). Tab-local, never serialized (I11).
 */

/** Divergences of one collection that switch prediction off for it for the session (I10). */
export const DIVERGENCE_LIMIT = 3

/** Hooks for tests and benchmarks. Internal: free to change. */
export interface OverlayControllerInternals {
	/** Wall clock for predicted timestamps; default `Date.now`. */
	readonly wallClock?: () => number
	/** Reads a record for an update's base; default a `SELECT` on the store's adapter. */
	readonly readRecord?: WriteOverlay['readRecord']
	/** Longest base read, in ms. */
	readonly baseReadTimeoutMs?: number
	/** Monotonic milliseconds for the registry. Default `performance.now`. */
	readonly now?: () => number
	/** Settle window and pending TTL, in ms (registry options). */
	readonly settleMs?: number
	readonly pendingTtlMs?: number
	readonly rowCacheSize?: number
	/** Report a divergence loudly; default throws from a microtask in test builds only. */
	readonly raise?: (error: Error) => void
	/** Raise on divergence. Default: true when `NODE_ENV` is `test`. */
	readonly strict?: boolean
	/** Divergences before the breaker opens. Default {@link DIVERGENCE_LIMIT}. */
	readonly divergenceLimit?: number
	/** Schedule the expiry sweep. Default `setTimeout` (unref'd where the runtime has it). */
	readonly schedule?: (callback: () => void, delayMs: number) => unknown
	readonly cancel?: (handle: unknown) => void
}

/** What the store gives its controller. */
export interface OverlayControllerOptions {
	readonly options: InstantUpdatesOptions
	readonly adapter: StorageAdapter
	readonly emit: (event: KoraEvent) => void
	/** True while the adapter refuses writes (the durability-lost state). */
	readonly writesRefused: () => boolean
	/** Re-run the live queries of a collection (after an unknown outcome was decided). */
	readonly refresh: (collection: string) => void
	readonly internals?: OverlayControllerInternals
}

/** A rolled-back write, as `onRollback` listeners get it. */
export interface RollbackInfo {
	readonly writeId: string
	readonly collection: string
	readonly recordIds: readonly string[]
	readonly error: unknown
}

/** Whether this process is a test run (Vitest, Jest and most runners set `NODE_ENV=test`). */
function isTestBuild(): boolean {
	const scope = globalThis as { process?: { env?: Record<string, string | undefined> } }
	return scope.process?.env?.NODE_ENV === 'test'
}

/** Fail loudly without breaking the data path: from a microtask, so it is never swallowed by a write's own handling. */
function raiseFromMicrotask(error: Error): void {
	queueMicrotask(() => {
		throw error
	})
}

/** The overlay of one store. */
export class OverlayController {
	readonly registry: PendingWrites
	readonly overlay: WriteOverlay
	private readonly emit: (event: KoraEvent) => void
	private readonly adapter: StorageAdapter
	private readonly refresh: (collection: string) => void
	private readonly strict: boolean
	private readonly raise: (error: Error) => void
	private readonly divergenceLimit: number
	private readonly divergences = new Map<string, number>()
	private readonly disabled = new Set<string>()
	private readonly reported = new Set<string>()
	private readonly rollbackListeners = new Set<(info: RollbackInfo) => void>()
	private readonly deciding = new Set<string>()
	private readonly schedule: (callback: () => void, delayMs: number) => unknown
	private readonly cancel: (handle: unknown) => void
	private sweepHandle: unknown = null
	private sweepEveryMs: number
	private stopped = false
	private unsubscribeRegistry: () => void

	constructor(config: OverlayControllerOptions) {
		const internals = config.internals ?? {}
		this.emit = config.emit
		this.adapter = config.adapter
		this.refresh = config.refresh
		this.strict = internals.strict ?? isTestBuild()
		this.raise = internals.raise ?? raiseFromMicrotask
		this.divergenceLimit = internals.divergenceLimit ?? DIVERGENCE_LIMIT
		this.schedule =
			internals.schedule ??
			((callback, delayMs) => {
				const handle = setTimeout(callback, delayMs)
				// A pending sweep must never keep a Node process alive.
				;(handle as { unref?: () => void }).unref?.()
				return handle
			})
		this.cancel = internals.cancel ?? ((handle) => clearTimeout(handle as never))
		const registryOptions: PendingWritesOptions = {
			...(config.options.maxPendingWrites !== undefined
				? { maxPendingWrites: config.options.maxPendingWrites }
				: {}),
			...(config.options.maxPendingBytes !== undefined
				? { maxPendingBytes: config.options.maxPendingBytes }
				: {}),
			...(config.options.maxRecordsPerWrite !== undefined
				? { maxRecordsPerWrite: config.options.maxRecordsPerWrite }
				: {}),
			...(internals.settleMs !== undefined ? { settleMs: internals.settleMs } : {}),
			...(internals.pendingTtlMs !== undefined ? { pendingTtlMs: internals.pendingTtlMs } : {}),
			...(internals.rowCacheSize !== undefined ? { rowCacheSize: internals.rowCacheSize } : {}),
			...(internals.now ? { now: internals.now } : {}),
			onEvent: (event) => this.onRegistryEvent(event),
		}
		this.registry = new PendingWrites(registryOptions)
		this.sweepEveryMs = Math.max(250, Math.floor(this.registry.limits.pendingTtlMs / 4))
		this.overlay = {
			registry: this.registry,
			writesRefused: config.writesRefused,
			isCollectionDisabled: (collection) => this.disabled.has(collection),
			onRolledBack: (entries, error) => this.onRolledBack(entries, error),
			...(internals.wallClock ? { wallClock: internals.wallClock } : {}),
			...(internals.readRecord ? { readRecord: internals.readRecord } : {}),
			...(internals.baseReadTimeoutMs !== undefined
				? { baseReadTimeoutMs: internals.baseReadTimeoutMs }
				: {}),
		}
		// A pending entry needs a deadline: arm the expiry sweep while any exist.
		this.unsubscribeRegistry = this.registry.onChange((change) => {
			if (change.kind === 'added') this.armSweep()
		})
	}

	/** Writes shown but not yet committed (pending, or committed with an unknown outcome). */
	get pending(): number {
		return this.registry.pendingCount
	}

	/** Whether prediction is switched off for a collection (the breaker is open). */
	isDisabled(collection: string): boolean {
		return this.disabled.has(collection)
	}

	/** Listen to rolled-back writes. Returns an unsubscribe function. */
	onRollback(listener: (info: RollbackInfo) => void): () => void {
		this.rollbackListeners.add(listener)
		return () => {
			this.rollbackListeners.delete(listener)
		}
	}

	/**
	 * Forget every pending write (I12): the data they described is gone or no longer this
	 * user's. Runs BEFORE the live queries re-run, so nothing pending is applied over the
	 * new state. Nothing is emitted for the entries: they are not outcomes.
	 */
	clear(): void {
		this.registry.clear()
		this.deciding.clear()
		this.reported.clear()
		this.cancelSweep()
	}

	/** Clear, and never schedule again (store close). */
	dispose(): void {
		this.stopped = true
		this.clear()
		this.unsubscribeRegistry()
		this.rollbackListeners.clear()
	}

	/**
	 * Decide writes whose commit answer was lost (M2) with a lookup, now that a SQL read of
	 * their collection succeeded: the adapter is answering again. Found: committed. Not
	 * found: rolled back. Still unreadable: they stay shown. Never throws.
	 *
	 * @param collection - Only entries of this collection; all when omitted
	 */
	async resolveUnknown(collection?: string): Promise<void> {
		const entries = this.registry.unknownEntries(collection)
		for (const entry of entries) {
			if (entry.lookupOperationId === null || this.deciding.has(entry.writeId)) continue
			this.deciding.add(entry.writeId)
			try {
				const lookup = await lookupOperation(
					this.adapter,
					entry.collection,
					entry.lookupOperationId,
				)
				const current = this.registry.get(entry.writeId)
				if (!current || current.state !== 'unknown') continue
				if (lookup.outcome === 'committed') {
					this.registry.commit(entry.writeId, { operationIds: [entry.lookupOperationId] })
					this.refresh(entry.collection)
				} else if (lookup.outcome === 'absent') {
					const removed = this.registry.rollback(entry.writeId)
					this.onRolledBack(
						removed,
						new Error(`The write's commit was not found in the operation log (${entry.writeId}).`),
					)
					this.refresh(entry.collection)
				}
			} finally {
				this.deciding.delete(entry.writeId)
			}
		}
	}

	private onRolledBack(entries: readonly PendingEntry[], error: unknown): void {
		for (const entry of entries) {
			const info: RollbackInfo = {
				writeId: entry.writeId,
				collection: entry.collection,
				recordIds: [entry.recordId],
				error,
			}
			for (const listener of this.rollbackListeners) {
				try {
					listener(info)
				} catch (failure) {
					console.error('[kora] a storage.writes.onRollback listener failed', failure)
				}
			}
		}
	}

	/** Public events, one for one with the registry's (names and fields match section 9.4). */
	private onRegistryEvent(event: OverlayEvent): void {
		switch (event.type) {
			case 'store:write-pending':
				this.emit({
					type: 'store:write-pending',
					writeId: event.writeId,
					collection: event.collection,
					recordIds: [...event.recordIds],
					kind: event.kind,
					predicted: event.predicted,
					...(event.predicted ? {} : { reason: event.reason }),
				})
				return
			case 'store:write-settled':
				this.emit({
					type: 'store:write-settled',
					writeId: event.writeId,
					collection: event.collection,
					outcome: event.outcome,
					...(event.operationIds ? { operationIds: [...event.operationIds] } : {}),
					pendingMs: event.pendingMs,
				})
				return
			case 'store:overlay-diverged':
				this.onDiverged(event.writeId, event.collection, event.fields)
				return
		}
	}

	/** A prediction the database contradicted: report it, count it, maybe open the breaker (I10). */
	private onDiverged(writeId: string, collection: string, fields: readonly string[]): void {
		// One divergence is seen by every subscription that settles it: report it once.
		const key = `${writeId}\u0000${fields.join(',')}`
		if (this.reported.has(key)) return
		if (this.reported.size >= 1_024) this.reported.clear()
		this.reported.add(key)
		this.emit({ type: 'store:overlay-diverged', writeId, collection, fields: [...fields] })
		const count = (this.divergences.get(collection) ?? 0) + 1
		this.divergences.set(collection, count)
		if (count >= this.divergenceLimit && !this.disabled.has(collection)) {
			this.disabled.add(collection)
			this.emit({ type: 'store:overlay-disabled', collection, divergences: count })
		}
		if (this.strict) this.raise(new OverlayDivergedError(collection, fields))
	}

	private armSweep(): void {
		if (this.stopped || this.sweepHandle !== null) return
		this.sweepHandle = this.schedule(() => {
			this.sweepHandle = null
			this.sweep()
		}, this.sweepEveryMs)
	}

	private cancelSweep(): void {
		if (this.sweepHandle === null) return
		this.cancel(this.sweepHandle)
		this.sweepHandle = null
	}

	/** Expire pending entries past their TTL into `unknown`; keep sweeping while any are pending. */
	sweep(): void {
		if (this.stopped) return
		this.registry.sweep()
		if (this.registry.pendingCount > 0) this.armSweep()
	}

	/** Rows of the committed-row cache, for diagnostics. */
	get cachedRows(): number {
		return this.registry.cachedRows
	}
}
