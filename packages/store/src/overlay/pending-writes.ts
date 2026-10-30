import type { CollectionRecord } from '../types'
import type { MissReason, PredictedChange, PredictedWriteKind } from './predict'

/*
 * The PendingWrites registry (instant-UI stage S2, docs/design/instant-ui-updates.md
 * 4.2, 5.5, 5.6, 11).
 *
 * A plain data structure: entries, a monotonic epoch, caps, lifecycle, a dependency
 * chain and a committed-row cache. It reads no storage, schedules no timers and never
 * touches a subscription; the clock is injected, so every behavior is deterministic in
 * tests. It is tab-local state: nothing here is serialized or broadcast (I11), and the
 * write path never reads it (I1).
 */

/** Where an entry is in its life. */
export type EntryState =
	/** Predicted; its transaction has not answered. */
	| 'pending'
	/** Its transaction did not answer in time (or the commit outcome is unknown): kept shown. */
	| 'unknown'
	/** Its transaction committed; kept (settling) until subscriptions have re-read. */
	| 'committed'

/** The outcome of a write, as reported in `store:write-settled`. */
export type SettleOutcome = 'committed' | 'rolled-back' | 'unknown'

/** One pending write, as the registry hands it out. Never mutated in place. */
export interface PendingEntry {
	readonly writeId: string
	readonly kind: PredictedWriteKind
	readonly collection: string
	readonly recordId: string
	/** See {@link PredictedChange.patch}. */
	readonly patch: Readonly<Record<string, unknown>> | null
	/** See {@link PredictedChange.previous}. */
	readonly previous: Readonly<Record<string, unknown>> | null
	/**
	 * The record after this write (for a delete: the record as it was). Replaced by the
	 * committed record once the transaction commits.
	 */
	readonly record: CollectionRecord
	/** The write this one was derived from (an earlier pending write of the same record). */
	readonly dependsOn: string | null
	readonly state: EntryState
	/** Epoch assigned at commit; null while the write is not committed. */
	readonly retiredAt: number | null
	/** Registry clock reading when the entry was added. */
	readonly registeredAtMs: number
	/** Registry clock reading at commit, or null. */
	readonly retiredAtMs: number | null
	/** Estimated size of the entry, in bytes. */
	readonly bytes: number
	/** Ids of the operations the write created; empty until it commits. */
	readonly operationIds: readonly string[]
}

/**
 * A change to the registry that can alter what a subscription displays (S3). Reported to
 * {@link PendingWrites.onChange} listeners synchronously, after the change is made.
 *
 * - `added`, `rolled-back`, `cleared`: the set of entries that apply changed.
 * - `committed`, `unknown`: the entry is still shown, nothing to recompute (reported so a
 *   listener can track settling).
 */
export interface RegistryChange {
	readonly kind: 'added' | 'committed' | 'rolled-back' | 'unknown' | 'cleared'
	/** Collections whose entries changed. */
	readonly collections: readonly string[]
}

/** Listener for {@link RegistryChange}s. */
export type RegistryListener = (change: RegistryChange) => void

/** Events the registry reports (names match docs/design 9.4). */
export type OverlayEvent =
	| {
			readonly type: 'store:write-pending'
			readonly writeId: string
			readonly collection: string
			readonly recordIds: readonly string[]
			readonly kind: PredictedWriteKind
			readonly predicted: true
	  }
	| {
			readonly type: 'store:write-pending'
			readonly writeId: string
			readonly collection: string
			readonly recordIds: readonly string[]
			readonly kind: PredictedWriteKind
			readonly predicted: false
			readonly reason: MissReason
	  }
	| {
			readonly type: 'store:write-settled'
			readonly writeId: string
			readonly collection: string
			readonly outcome: SettleOutcome
			readonly operationIds?: readonly string[]
			readonly pendingMs: number
	  }
	| {
			readonly type: 'store:overlay-diverged'
			readonly writeId: string
			readonly collection: string
			readonly fields: readonly string[]
	  }

/** Registry limits (design section 11) and its clock. */
export interface PendingWritesOptions {
	/** Pending (uncommitted) entries per tab. Default 256. */
	readonly maxPendingWrites?: number
	/** Estimated bytes of pending and settling entries. Default 8 MiB. */
	readonly maxPendingBytes?: number
	/** Records one write may touch. Default 100. */
	readonly maxRecordsPerWrite?: number
	/** How long a committed entry may wait for subscriptions to re-read. Default 2,000 ms. */
	readonly settleMs?: number
	/** How long an entry may stay pending before it becomes `unknown`. Default 60,000 ms. */
	readonly pendingTtlMs?: number
	/** Rows in the committed-row cache (LRU). Default 512. */
	readonly rowCacheSize?: number
	/** Milliseconds, monotonic. Default `performance.now`. Injected by tests. */
	readonly now?: () => number
	/** Receives {@link OverlayEvent}s. A throwing listener never affects the registry. */
	readonly onEvent?: (event: OverlayEvent) => void
}

/** Defaults of {@link PendingWritesOptions}. */
export const DEFAULT_PENDING_WRITES_OPTIONS = {
	maxPendingWrites: 256,
	maxPendingBytes: 8 * 1024 * 1024,
	maxRecordsPerWrite: 100,
	settleMs: 2_000,
	pendingTtlMs: 60_000,
	rowCacheSize: 512,
} as const

/** Result of {@link PendingWrites.add}. */
export type AddResult =
	| { readonly ok: true; readonly entry: PendingEntry }
	| { readonly ok: false; readonly reason: MissReason }

/** What the registry knows of a record's current values (5.6). */
export type BaseLookup =
	/** The newest pending or settling write, or the cache, holds the record. */
	| {
			readonly found: 'record'
			readonly record: CollectionRecord
			readonly source: 'pending' | 'cache'
	  }
	/** The newest pending or settling write deleted the record. */
	| { readonly found: 'deleted' }
	/** Nothing is known: the caller must read. */
	| { readonly found: 'none' }

/** Committed facts of a write, reported by {@link PendingWrites.commit}. */
export interface CommitInfo {
	/** The record as stored (`WriteResult.record`); absent for a no-op update. */
	readonly record?: CollectionRecord
	/** Ids of the operations the write created. */
	readonly operationIds?: readonly string[]
}

/** Result of {@link PendingWrites.sweep}. */
export interface SweepResult {
	/** Entries that stayed pending past the TTL and are now `unknown`. */
	readonly expired: readonly PendingEntry[]
	/** Committed entries older than the settle window: the caller forces a re-read, then drops them. */
	readonly lagging: readonly PendingEntry[]
}

/** Estimated size of a value, in bytes (JSON length; a rough upper bound). */
export function estimateBytes(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0
	} catch {
		return 1_024
	}
}

const cacheKey = (collection: string, id: string): string => `${collection}\u0000${id}`

/**
 * Registry of the writes this tab has predicted but not yet seen settle.
 *
 * Lifecycle of an entry: {@link add} (`pending`) then either {@link commit}
 * (`committed`, kept until {@link settleCollection} or {@link drop}), {@link rollback}
 * (removed together with the entries derived from it), or {@link markUnknown} / the TTL
 * in {@link sweep} (`unknown`, kept shown until decided).
 */
export class PendingWrites {
	private readonly options: Required<Omit<PendingWritesOptions, 'now' | 'onEvent'>>
	private readonly now: () => number
	private readonly onEvent: ((event: OverlayEvent) => void) | undefined
	/** Insertion order is registration order. */
	private readonly entries = new Map<string, PendingEntry>()
	private readonly cache = new Map<string, CollectionRecord>()
	private writeCounter = 0
	private epochCounter = 0
	private totalBytes = 0
	private floorWallTime = 0
	private readonly missCounts = new Map<MissReason, number>()
	private readonly changeListeners = new Set<RegistryListener>()

	constructor(options: PendingWritesOptions = {}) {
		const { now, onEvent, ...limits } = options
		this.options = { ...DEFAULT_PENDING_WRITES_OPTIONS, ...stripUndefined(limits) }
		this.now = now ?? (() => performance.now())
		this.onEvent = onEvent
	}

	/** Monotonic counter, bumped at every commit. A read's `issuedAt` is the epoch when it was issued. */
	get epoch(): number {
		return this.epochCounter
	}

	/** Writes shown but not yet committed (`pending` and `unknown`). */
	get pendingCount(): number {
		let count = 0
		for (const entry of this.entries.values()) if (entry.state !== 'committed') count++
		return count
	}

	/** Committed entries still waiting for subscriptions to re-read. */
	get settlingCount(): number {
		return this.entries.size - this.pendingCount
	}

	/** Estimated bytes held by pending and settling entries. */
	get bytes(): number {
		return this.totalBytes
	}

	/** Rows in the committed-row cache. */
	get cachedRows(): number {
		return this.cache.size
	}

	/** Counted misses by reason (writes that were not predicted). */
	get misses(): ReadonlyMap<MissReason, number> {
		return this.missCounts
	}

	/** The configured limits. */
	get limits(): Readonly<Required<Omit<PendingWritesOptions, 'now' | 'onEvent'>>> {
		return this.options
	}

	/**
	 * Highest `createdAt` or `updatedAt` this registry has seen committed. A predicted
	 * wall time is `max(Date.now(), wallTimeFloor())`, so a predicted record sorts where
	 * the committed one will land (5.3d) even when the device clock is behind its HLC.
	 */
	wallTimeFloor(): number {
		return this.floorWallTime
	}

	/** Allocate a write id. */
	nextWriteId(): string {
		this.writeCounter += 1
		return `w${this.writeCounter}`
	}

	/**
	 * Register a predicted write.
	 *
	 * Refused (never thrown) when a cap would be exceeded: the write then runs as it does
	 * today and the miss is counted (I8). Nothing already registered is ever dropped to
	 * make room.
	 *
	 * @param change - The predictor's answer for the write
	 * @param options - `dependsOn`: the pending write this one was derived from;
	 *   `recordCount`: records the write touches (default 1); `writeId`: pre-allocated id
	 */
	add(
		change: PredictedChange,
		options: { dependsOn?: string | null; recordCount?: number; writeId?: string } = {},
	): AddResult {
		const recordCount = options.recordCount ?? 1
		if (recordCount > this.options.maxRecordsPerWrite) return this.refuse(change, 'records-cap')
		if (this.pendingCount >= this.options.maxPendingWrites) {
			return this.refuse(change, 'pending-cap')
		}
		const bytes = estimateBytes(change.patch) + estimateBytes(change.record)
		if (this.totalBytes + bytes > this.options.maxPendingBytes) {
			return this.refuse(change, 'bytes-cap')
		}
		const entry: PendingEntry = {
			writeId: options.writeId ?? this.nextWriteId(),
			kind: change.kind,
			collection: change.collection,
			recordId: change.recordId,
			patch: change.patch,
			previous: change.previous ?? null,
			record: change.record,
			dependsOn: options.dependsOn ?? null,
			state: 'pending',
			retiredAt: null,
			registeredAtMs: this.now(),
			retiredAtMs: null,
			bytes,
			operationIds: [],
		}
		this.entries.set(entry.writeId, entry)
		this.totalBytes += bytes
		this.emit({
			type: 'store:write-pending',
			writeId: entry.writeId,
			collection: entry.collection,
			recordIds: [entry.recordId],
			kind: entry.kind,
			predicted: true,
		})
		this.changed('added', [entry.collection])
		return { ok: true, entry }
	}

	/**
	 * Report a write that was not predicted (a counted miss, with its reason), so
	 * DevTools can show why. Allocates a write id for the event.
	 */
	noteMiss(
		kind: PredictedWriteKind,
		collection: string,
		recordIds: readonly string[],
		reason: MissReason,
	): void {
		this.missCounts.set(reason, (this.missCounts.get(reason) ?? 0) + 1)
		this.emit({
			type: 'store:write-pending',
			writeId: this.nextWriteId(),
			collection,
			recordIds,
			kind,
			predicted: false,
			reason,
		})
	}

	/**
	 * The write's transaction committed. The entry gets `retiredAt = ++epoch` and stays
	 * (its display must not flicker between commit and the SQL re-read, F3); the
	 * committed record replaces the prediction as the base for later updates, and fills
	 * the row cache.
	 *
	 * @returns The retired entry, or null when it was already removed
	 */
	commit(writeId: string, info: CommitInfo = {}): PendingEntry | null {
		const entry = this.entries.get(writeId)
		if (!entry || entry.state === 'committed') return null
		this.epochCounter += 1
		const retired: PendingEntry = {
			...entry,
			state: 'committed',
			retiredAt: this.epochCounter,
			retiredAtMs: this.now(),
			record: info.record ?? entry.record,
			operationIds: info.operationIds ?? [],
		}
		this.entries.set(writeId, retired)
		this.recordCommitted(retired, info.record)
		this.emit({
			type: 'store:write-settled',
			writeId,
			collection: entry.collection,
			outcome: 'committed',
			...(info.operationIds ? { operationIds: info.operationIds } : {}),
			pendingMs: this.now() - entry.registeredAtMs,
		})
		this.changed('committed', [entry.collection])
		return retired
	}

	/**
	 * The write failed (nothing was committed). The entry is removed together with every
	 * entry derived from it, transitively and not yet committed (5.6): a dependent cannot
	 * succeed, so it is not left showing until its own transaction fails. The caller
	 * recomputes each affected display from its base (F10).
	 *
	 * @returns The removed entries, the rolled-back one first
	 */
	rollback(writeId: string): PendingEntry[] {
		const root = this.entries.get(writeId)
		if (!root || root.state === 'committed') return []
		const removed: PendingEntry[] = [root]
		const doomed = new Set<string>([writeId])
		// Registration order puts a dependent after the entry it derives from, so one
		// forward pass finds the whole chain.
		for (const entry of this.entries.values()) {
			if (
				entry.state !== 'committed' &&
				entry.dependsOn !== null &&
				doomed.has(entry.dependsOn) &&
				!doomed.has(entry.writeId)
			) {
				doomed.add(entry.writeId)
				removed.push(entry)
			}
		}
		for (const entry of removed) {
			this.remove(entry)
			this.emit({
				type: 'store:write-settled',
				writeId: entry.writeId,
				collection: entry.collection,
				outcome: 'rolled-back',
				pendingMs: this.now() - entry.registeredAtMs,
			})
		}
		this.changed('rolled-back', [...new Set(removed.map((entry) => entry.collection))])
		return removed
	}

	/**
	 * The outcome is not known (the commit answer was lost, or the transaction did not
	 * settle): the entry stays shown and is decided later, never silently rolled back.
	 */
	markUnknown(writeId: string): PendingEntry | null {
		const entry = this.entries.get(writeId)
		if (!entry || entry.state !== 'pending') return null
		const unknown: PendingEntry = { ...entry, state: 'unknown' }
		this.entries.set(writeId, unknown)
		this.emit({
			type: 'store:write-settled',
			writeId,
			collection: entry.collection,
			outcome: 'unknown',
			pendingMs: this.now() - entry.registeredAtMs,
		})
		this.changed('unknown', [entry.collection])
		return unknown
	}

	/**
	 * Apply the time limits: pending entries older than `pendingTtlMs` become `unknown`;
	 * committed entries older than `settleMs` are reported as lagging (the caller forces a
	 * re-run of their collections, then {@link drop}s them).
	 */
	sweep(): SweepResult {
		const at = this.now()
		const expired: PendingEntry[] = []
		const lagging: PendingEntry[] = []
		for (const entry of [...this.entries.values()]) {
			if (entry.state === 'pending' && at - entry.registeredAtMs >= this.options.pendingTtlMs) {
				const unknown = this.markUnknown(entry.writeId)
				if (unknown) expired.push(unknown)
			} else if (
				entry.state === 'committed' &&
				entry.retiredAtMs !== null &&
				at - entry.retiredAtMs >= this.options.settleMs
			) {
				lagging.push(entry)
			}
		}
		return { expired, lagging }
	}

	/**
	 * Every subscription of `collection` has delivered a SQL result issued at or after
	 * `issuedAt`: committed entries retired at or before it are contained in those
	 * results and are dropped.
	 *
	 * @returns The dropped entries
	 */
	settleCollection(collection: string, issuedAt: number): PendingEntry[] {
		const dropped: PendingEntry[] = []
		for (const entry of [...this.entries.values()]) {
			if (
				entry.collection === collection &&
				entry.state === 'committed' &&
				entry.retiredAt !== null &&
				entry.retiredAt <= issuedAt
			) {
				this.remove(entry)
				dropped.push(entry)
			}
		}
		return dropped
	}

	/** Remove committed entries (after a forced re-run). Unknown ids and uncommitted entries are ignored. */
	drop(entries: readonly PendingEntry[]): void {
		for (const entry of entries) {
			const current = this.entries.get(entry.writeId)
			if (current && current.state === 'committed') this.remove(current)
		}
	}

	/**
	 * The entries that apply to a read of `collection` issued when the epoch was
	 * `issuedAt`, in registration order (5.5):
	 * `retiredAt === null || retiredAt > issuedAt`. A read issued before an entry's
	 * commit may not contain it; one issued after contains it.
	 */
	applicable(collection: string, issuedAt: number): PendingEntry[] {
		const out: PendingEntry[] = []
		for (const entry of this.entries.values()) {
			if (entry.collection !== collection) continue
			if (entry.retiredAt === null || entry.retiredAt > issuedAt) out.push(entry)
		}
		return out
	}

	/** Whether any committed entry of `collection` still waits for subscriptions to re-read. */
	hasSettling(collection: string): boolean {
		for (const entry of this.entries.values()) {
			if (entry.collection === collection && entry.state === 'committed') return true
		}
		return false
	}

	/** One entry by id. */
	get(writeId: string): PendingEntry | undefined {
		return this.entries.get(writeId)
	}

	/** All entries, in registration order. */
	list(): PendingEntry[] {
		return [...this.entries.values()]
	}

	/** Collections that have at least one entry. */
	collections(): Set<string> {
		const out = new Set<string>()
		for (const entry of this.entries.values()) out.add(entry.collection)
		return out
	}

	/**
	 * What the registry knows of a record's current values, for predicting the next write
	 * to it (5.6): the newest entry for the record (pending chains, and settling commits
	 * the SQL has not yet been read back for), else the committed-row cache.
	 */
	baseFor(collection: string, id: string): BaseLookup {
		let newest: PendingEntry | undefined
		for (const entry of this.entries.values()) {
			if (entry.collection === collection && entry.recordId === id) newest = entry
		}
		if (newest) {
			return newest.kind === 'delete'
				? { found: 'deleted' }
				: { found: 'record', record: newest.record, source: 'pending' }
		}
		const key = cacheKey(collection, id)
		const cached = this.cache.get(key)
		if (cached) {
			// LRU: a hit is the most recently used.
			this.cache.delete(key)
			this.cache.set(key, cached)
			return { found: 'record', record: cached, source: 'cache' }
		}
		return { found: 'none' }
	}

	/** The newest not-committed entry for a record: what a new update would derive from. */
	pendingFor(collection: string, id: string): PendingEntry | undefined {
		let newest: PendingEntry | undefined
		for (const entry of this.entries.values()) {
			if (entry.collection === collection && entry.recordId === id && entry.state !== 'committed') {
				newest = entry
			}
		}
		return newest
	}

	/** Put a row the store itself read into the cache. */
	cacheRecord(collection: string, record: CollectionRecord): void {
		this.putCache(collection, record)
	}

	/**
	 * Forget cached rows of a collection (or one record). Called when a remote apply or a
	 * cross-tab change names it: a cached row may then be stale (F21).
	 */
	invalidate(collection: string, ids: readonly string[] | null = null): void {
		if (ids === null) {
			const prefix = `${collection}\u0000`
			for (const key of [...this.cache.keys()]) if (key.startsWith(prefix)) this.cache.delete(key)
			return
		}
		for (const id of ids) this.cache.delete(cacheKey(collection, id))
	}

	/**
	 * Drop everything (store close, user switch, restore, `reloadFromDisk`, full resync:
	 * invariant I12). No events are emitted: the data the entries described is gone.
	 *
	 * @returns The entries that were dropped
	 */
	clear(): PendingEntry[] {
		const dropped = this.list()
		this.entries.clear()
		this.cache.clear()
		this.totalBytes = 0
		if (dropped.length > 0) {
			this.changed('cleared', [...new Set(dropped.map((entry) => entry.collection))])
		}
		return dropped
	}

	/**
	 * Listen to changes that can alter what a subscription displays (S3). The listener runs
	 * synchronously inside the call that changed the registry (a write's `add`), so it must
	 * only schedule work. A throwing listener never affects the registry.
	 *
	 * @returns An unsubscribe function
	 */
	onChange(listener: RegistryListener): () => void {
		this.changeListeners.add(listener)
		return () => {
			this.changeListeners.delete(listener)
		}
	}

	/**
	 * Whether `operationId` was created by a write this registry committed and still holds.
	 * The subscription manager uses it to tell the post-commit publication of a predicted
	 * local write (the cache already holds its committed row) from every other change
	 * (which invalidates cached rows, F21).
	 */
	ownsOperation(operationId: string): boolean {
		for (const entry of this.entries.values()) {
			if (entry.operationIds.includes(operationId)) return true
		}
		return false
	}

	/**
	 * Compare a committed record with the prediction the entry carried (5.3e) and report
	 * `store:overlay-diverged` on a difference outside `createdAt` and `updatedAt`.
	 */
	reportDivergence(entry: PendingEntry, fields: readonly string[]): void {
		if (fields.length === 0) return
		this.emit({
			type: 'store:overlay-diverged',
			writeId: entry.writeId,
			collection: entry.collection,
			fields,
		})
	}

	private refuse(change: PredictedChange, reason: MissReason): AddResult {
		this.noteMiss(change.kind, change.collection, [change.recordId], reason)
		return { ok: false, reason }
	}

	private remove(entry: PendingEntry): void {
		if (this.entries.delete(entry.writeId)) this.totalBytes -= entry.bytes
	}

	private recordCommitted(entry: PendingEntry, record: CollectionRecord | undefined): void {
		if (record) {
			this.floorWallTime = Math.max(this.floorWallTime, record.createdAt, record.updatedAt)
		}
		if (entry.kind === 'delete') {
			this.cache.delete(cacheKey(entry.collection, entry.recordId))
			return
		}
		if (record) this.putCache(entry.collection, record)
	}

	private putCache(collection: string, record: CollectionRecord): void {
		const key = cacheKey(collection, record.id)
		this.cache.delete(key)
		this.cache.set(key, record)
		while (this.cache.size > this.options.rowCacheSize) {
			const oldest = this.cache.keys().next()
			if (oldest.done) break
			this.cache.delete(oldest.value)
		}
	}

	private changed(kind: RegistryChange['kind'], collections: readonly string[]): void {
		for (const listener of this.changeListeners) {
			try {
				listener({ kind, collections })
			} catch (error) {
				console.error('[kora] overlay registry listener failed', error)
			}
		}
	}

	private emit(event: OverlayEvent): void {
		if (!this.onEvent) return
		try {
			this.onEvent(event)
		} catch (error) {
			// A failing listener must not affect the registry or the write.
			console.error('[kora] overlay event listener failed', error)
		}
	}
}

function stripUndefined<T extends object>(value: T): Partial<T> {
	const out: Partial<T> = {}
	for (const key of Object.keys(value) as Array<keyof T>) {
		if (value[key] !== undefined) out[key] = value[key]
	}
	return out
}
