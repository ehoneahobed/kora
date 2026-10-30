import type { FoldState } from '@korajs/core'
import type { CollectionRecord } from '../types'
import type { MissReason, PredictedChange, PredictedWriteKind } from './predict'
import { WriteOrder } from './write-order'

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
	/**
	 * Every write this one was derived from, nearest first (bounded): `dependsOn` and its own
	 * ancestors. The chain survives the retirement of the links in between, so the commit
	 * verification can tell that a write rests on one that has not reported (or was rolled back).
	 */
	readonly ancestors: readonly string[]
	/**
	 * The transaction this entry belongs to (stage S6a), or null for a single write. Members
	 * of a group share their fate: they are registered, committed, marked unknown and rolled
	 * back together, and a subscription applies all of them or none (design, "S6a design").
	 */
	readonly groupId: string | null
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
	/**
	 * Changes to the collection this registry did not make (a remote apply, a cross-tab
	 * change, a write that was not predicted) seen when the entry was added. The settle
	 * check only judges an entry when the count is unchanged: otherwise the database may
	 * legitimately differ from the prediction.
	 */
	readonly foreignAtAdd: number
	/**
	 * The registry's foreign-change sequence when the entry was added (see
	 * {@link PendingWrites.invalidate}). A remote apply or another tab's change to this
	 * record after that point makes the entry's `record` older than the database, so it is no
	 * longer a base for the next write of the record.
	 */
	readonly foreignSeqAtAdd: number
	/** The collection's remote-apply activity when the entry was added (see {@link PendingWrites.foreignSince}). */
	readonly foreignActivityAtAdd: number
	/**
	 * When the commit's answer was lost: the content-addressed id of the write's primary
	 * operation, which decides whether it landed (M2). Null otherwise.
	 */
	readonly lookupOperationId: string | null
	/**
	 * The record's fold state after this write, when the prediction was made on one (a
	 * fresh insert, an update of an array). The next array write of the record builds on it
	 * while this entry is unsettled; absent for a write predicted from values alone.
	 */
	readonly foldState: FoldState | null
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

/** What a `store:write-pending` describes: one write, or a transaction (an entry group). */
export type WriteEventKind = PredictedWriteKind | 'transaction'

/** Events the registry reports (names match docs/design 9.4). */
export type OverlayEvent =
	| {
			readonly type: 'store:write-pending'
			readonly writeId: string
			readonly collection: string
			/** Every collection of a transaction; absent for a single write. */
			readonly collections?: readonly string[]
			readonly recordIds: readonly string[]
			readonly kind: WriteEventKind
			readonly predicted: true
	  }
	| {
			readonly type: 'store:write-pending'
			readonly writeId: string
			readonly collection: string
			readonly collections?: readonly string[]
			readonly recordIds: readonly string[]
			readonly kind: WriteEventKind
			readonly predicted: false
			readonly reason: MissReason
	  }
	| {
			readonly type: 'store:write-settled'
			readonly writeId: string
			readonly collection: string
			readonly collections?: readonly string[]
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

/** One write of a transaction, for {@link PendingWrites.addGroup}. */
export interface GroupChange {
	readonly change: PredictedChange
	/** A pending write OUTSIDE the group this write was derived from, or null. */
	readonly dependsOn: string | null
}

/** Result of {@link PendingWrites.addGroup}. */
export type AddGroupResult =
	| { readonly ok: true; readonly groupId: string; readonly entries: readonly PendingEntry[] }
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

/** What the registry knows of a record's fold state (S6b), for an array write. */
export type FoldStateLookup =
	/** The newest unsettled write of the record carries its predicted fold state. */
	| { readonly found: 'state'; readonly state: FoldState }
	/**
	 * The newest unsettled write was predicted from values alone: the state after it is
	 * not known, and the database does not hold it yet either.
	 */
	| { readonly found: 'unknown' }
	/** No unsettled write: the caller reads the committed state. */
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
 * Ancestors an entry remembers. A chain longer than this forgets its oldest links; the
 * commit check then misses an unsettled or rolled-back write that far back, which costs a
 * reported divergence at worst (the circuit breaker's input), never a wrong display. 32
 * writes of one record in flight at once does not happen in practice (the pending cap is
 * 256 across all records).
 */
const MAX_ANCESTORS = 32

/** Rolled-back write ids remembered for the verification of writes derived from them. */
const MAX_ROLLED_BACK_IDS = 1_024

/** Records with a foreign-change mark kept (older marks fold into a floor). */
const MAX_RECORD_MARKS = 4_096

/** Estimated bytes an entry holds: its patch, its record and the fold state it carries. */
function entryBytes(change: PredictedChange): number {
	return (
		estimateBytes(change.patch) +
		estimateBytes(change.record) +
		(change.foldState ? estimateBytes(change.foldState) : 0)
	)
}

/**
 * Registry of the writes this tab has predicted but not yet seen settle.
 *
 * Lifecycle of an entry: {@link add} (`pending`) then either {@link commit}
 * (`committed`, kept until {@link settleCollection} or {@link drop}), {@link rollback}
 * (removed together with the entries derived from it), or {@link markUnknown} / the TTL
 * in {@link sweep} (`unknown`, kept shown until decided).
 */
/** Why a commit check judged fewer fields than the whole record. */
export type UnverifiedReason =
	/** A remote apply in the collection overlapped the write. */
	| 'concurrent-remote'
	/** A write this one was derived from had not reported, or was rolled back. */
	| 'unsettled-base'
	/** A field whose base moved could not be predicted again. */
	| 'replay-declined'

/** Handle of a remote apply in progress, see {@link PendingWrites.beginForeign}. */
export interface ForeignApply {
	/** The apply touches this collection from now until `end`. */
	touch(collection: string): void
	/** The apply has published its changes (or failed). */
	end(): void
}

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
	/** Start order of the writes that have to read before they are predicted (S6b). */
	readonly order = new WriteOrder()
	private readonly missCounts = new Map<MissReason, number>()
	private readonly changeListeners = new Set<RegistryListener>()
	private readonly foreignCounts = new Map<string, number>()
	/** Bumped by every {@link invalidate}; entries remember the value they were added at. */
	private foreignSeq = 0
	/** Ids of writes that were rolled back, newest last: a retired write may still name one as its base. */
	private readonly unverifiedCounts = new Map<UnverifiedReason, number>()
	private readonly rolledBackIds = new Set<string>()
	/** Remote applies that have begun and not yet published their change, by collection. */
	private readonly foreignInFlight = new Map<string, number>()
	/** Begin and end events of remote applies, by collection. */
	private readonly foreignActivity = new Map<string, number>()
	/** Foreign sequence of the last change to a record / a whole collection, by key. */
	private readonly recordMarks = new Map<string, number>()
	private readonly collectionMarks = new Map<string, number>()
	/** Marks dropped for size: an entry older than this is treated as changed. */
	private markFloor = 0
	/** Commits of this registry's own writes, by collection (see {@link seedStamp}). */
	private readonly commitCounts = new Map<string, number>()
	/** Bumped by {@link clear}: a read issued before it must not seed anything. */
	private generation = 0
	private seeded = 0
	/** Records with a running write that was not predicted, by cache key. */
	private readonly unpredicted = new Map<string, number>()

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

	/** Rows put in the cache from subscription results over the registry's life (diagnostics). */
	get seededRows(): number {
		return this.seeded
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
		const bytes = entryBytes(change)
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
			ancestors: this.ancestorsOf(options.dependsOn ?? null),
			groupId: null,
			state: 'pending',
			retiredAt: null,
			registeredAtMs: this.now(),
			retiredAtMs: null,
			bytes,
			operationIds: [],
			foreignAtAdd: this.foreignCount(change.collection),
			foreignSeqAtAdd: this.foreignSeq,
			foreignActivityAtAdd: this.activityOf(change.collection),
			lookupOperationId: null,
			foldState: change.foldState ?? null,
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
	 * Register the entries of one multi-record write (`insertMany`) together or not at all:
	 * a cap that the whole group would exceed refuses all of it (I8), so a group never
	 * shows half of its records. One change notification covers the group.
	 */
	addMany(
		changes: readonly PredictedChange[],
	):
		| { readonly ok: true; readonly entries: PendingEntry[] }
		| { readonly ok: false; readonly reason: MissReason } {
		const first = changes[0]
		if (!first) return { ok: true, entries: [] }
		let reason: MissReason | null = null
		let bytes = 0
		const sizes = changes.map(entryBytes)
		for (const size of sizes) bytes += size
		if (changes.length > this.options.maxRecordsPerWrite) reason = 'records-cap'
		else if (this.pendingCount + changes.length > this.options.maxPendingWrites) {
			reason = 'pending-cap'
		} else if (this.totalBytes + bytes > this.options.maxPendingBytes) reason = 'bytes-cap'
		if (reason) {
			this.missCounts.set(reason, (this.missCounts.get(reason) ?? 0) + 1)
			this.emit({
				type: 'store:write-pending',
				writeId: this.nextWriteId(),
				collection: first.collection,
				recordIds: changes.map((change) => change.recordId),
				kind: first.kind,
				predicted: false,
				reason,
			})
			return { ok: false, reason }
		}
		const entries: PendingEntry[] = []
		changes.forEach((change, index) => {
			const entry: PendingEntry = {
				writeId: this.nextWriteId(),
				kind: change.kind,
				collection: change.collection,
				recordId: change.recordId,
				patch: change.patch,
				previous: change.previous ?? null,
				record: change.record,
				dependsOn: null,
				ancestors: [],
				groupId: null,
				state: 'pending',
				retiredAt: null,
				registeredAtMs: this.now(),
				retiredAtMs: null,
				bytes: sizes[index] ?? 0,
				operationIds: [],
				foreignAtAdd: this.foreignCount(change.collection),
				foreignSeqAtAdd: this.foreignSeq,
				foreignActivityAtAdd: this.activityOf(change.collection),
				lookupOperationId: null,
				foldState: change.foldState ?? null,
			}
			this.entries.set(entry.writeId, entry)
			this.totalBytes += entry.bytes
			entries.push(entry)
		})
		for (const entry of entries) {
			this.emit({
				type: 'store:write-pending',
				writeId: entry.writeId,
				collection: entry.collection,
				recordIds: [entry.recordId],
				kind: entry.kind,
				predicted: true,
			})
		}
		this.changed('added', [...new Set(entries.map((entry) => entry.collection))])
		return { ok: true, entries }
	}

	/**
	 * Register the writes of one transaction as ONE entry group (stage S6a), all of them or
	 * none: the pending, byte and record caps are checked for the whole group before any
	 * entry exists (T1), so a group is never partially registered. The entries keep the
	 * transaction's write order (the order its storage transaction writes them in). One
	 * `store:write-pending` (`kind: 'transaction'`, `writeId` the group id) and one change
	 * notification cover the group, so a single patch pass shows all of it.
	 *
	 * @param changes - Every write of the transaction, in buffer order, each with the
	 *   pending write outside the group it was derived from
	 */
	addGroup(changes: readonly GroupChange[]): AddGroupResult {
		const first = changes[0]
		if (!first) return { ok: false, reason: 'unsupported-write' }
		const collections = [...new Set(changes.map(({ change }) => change.collection))]
		const recordIds = changes.map(({ change }) => change.recordId)
		const sizes = changes.map(({ change }) => entryBytes(change))
		let bytes = 0
		for (const size of sizes) bytes += size
		let reason: MissReason | null = null
		if (changes.length > this.options.maxRecordsPerWrite) reason = 'records-cap'
		else if (this.pendingCount + changes.length > this.options.maxPendingWrites) {
			reason = 'pending-cap'
		} else if (this.totalBytes + bytes > this.options.maxPendingBytes) reason = 'bytes-cap'
		if (reason) {
			this.noteGroupMiss(collections, recordIds, reason)
			return { ok: false, reason }
		}
		const groupId = this.nextWriteId()
		const registeredAtMs = this.now()
		const entries: PendingEntry[] = []
		for (const [index, { change, dependsOn }] of changes.entries()) {
			// A later write of a record the group already wrote derives from that member, so it
			// rests on whatever the member rests on.
			const earlier = [...entries]
				.reverse()
				.find((one) => one.collection === change.collection && one.recordId === change.recordId)
			entries.push({
				writeId: this.nextWriteId(),
				kind: change.kind,
				collection: change.collection,
				recordId: change.recordId,
				patch: change.patch,
				previous: change.previous ?? null,
				record: change.record,
				dependsOn,
				ancestors: earlier ? earlier.ancestors : this.ancestorsOf(dependsOn),
				groupId,
				state: 'pending',
				retiredAt: null,
				registeredAtMs,
				retiredAtMs: null,
				bytes: sizes[index] ?? 0,
				operationIds: [],
				foreignAtAdd: this.foreignCount(change.collection),
				foreignSeqAtAdd: this.foreignSeq,
				foreignActivityAtAdd: this.activityOf(change.collection),
				lookupOperationId: null,
				foldState: change.foldState ?? null,
			})
		}
		for (const entry of entries) {
			this.entries.set(entry.writeId, entry)
			this.totalBytes += entry.bytes
		}
		this.emit({
			type: 'store:write-pending',
			writeId: groupId,
			collection: first.change.collection,
			collections,
			recordIds,
			kind: 'transaction',
			predicted: true,
		})
		this.changed('added', collections)
		return { ok: true, groupId, entries }
	}

	/**
	 * Report a transaction that is not predicted (one counted miss for the whole group).
	 * Allocates a write id for the event.
	 */
	noteGroupMiss(
		collections: readonly string[],
		recordIds: readonly string[],
		reason: MissReason,
	): void {
		this.missCounts.set(reason, (this.missCounts.get(reason) ?? 0) + 1)
		this.emit({
			type: 'store:write-pending',
			writeId: this.nextWriteId(),
			collection: collections[0] ?? '',
			collections: [...collections],
			recordIds,
			kind: 'transaction',
			predicted: false,
			reason,
		})
	}

	/** The members of a group still in the registry, in registration order. */
	groupMembers(groupId: string): PendingEntry[] {
		const out: PendingEntry[] = []
		for (const entry of this.entries.values()) if (entry.groupId === groupId) out.push(entry)
		return out
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
		if (entry.groupId !== null) {
			// A member never commits alone (T2): the whole group retires, this member with
			// the facts given, the others with what they hold.
			const retired = this.commitGroup(entry.groupId, new Map([[writeId, info]]))
			return retired.find((one) => one.writeId === writeId) ?? null
		}
		this.epochCounter += 1
		this.commitCounts.set(entry.collection, (this.commitCounts.get(entry.collection) ?? 0) + 1)
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
	 * A transaction committed: every member of the group retires with ONE epoch value, so a
	 * SQL read either contains the whole group or none of it (design "S6a design", step 5).
	 * Members are retired in registration order (the order the transaction wrote them), so
	 * the committed-row cache ends with each record's last write. One
	 * `store:write-settled committed` carries every operation id of the group.
	 *
	 * @param groupId - The group, from {@link addGroup}
	 * @param infos - Committed facts per member write id; a member without one keeps its
	 *   prediction as its record (an outcome decided later by lookup)
	 * @returns The retired members (empty when the group is gone or already committed)
	 */
	commitGroup(groupId: string, infos: ReadonlyMap<string, CommitInfo> = new Map()): PendingEntry[] {
		const members = this.groupMembers(groupId).filter((entry) => entry.state !== 'committed')
		const first = members[0]
		if (!first) return []
		this.epochCounter += 1
		const retiredAtMs = this.now()
		const retired: PendingEntry[] = []
		const operationIds: string[] = []
		const collections: string[] = []
		for (const entry of members) {
			const info = infos.get(entry.writeId) ?? {}
			this.commitCounts.set(entry.collection, (this.commitCounts.get(entry.collection) ?? 0) + 1)
			const next: PendingEntry = {
				...entry,
				state: 'committed',
				retiredAt: this.epochCounter,
				retiredAtMs,
				record: info.record ?? entry.record,
				operationIds: info.operationIds ?? [],
			}
			this.entries.set(entry.writeId, next)
			this.recordCommitted(next, info.record)
			retired.push(next)
			operationIds.push(...(info.operationIds ?? []))
			if (!collections.includes(entry.collection)) collections.push(entry.collection)
		}
		this.emit({
			type: 'store:write-settled',
			writeId: groupId,
			collection: first.collection,
			collections,
			outcome: 'committed',
			operationIds,
			pendingMs: retiredAtMs - first.registeredAtMs,
		})
		this.changed('committed', collections)
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
		const doomed = new Set<string>([writeId])
		const doomedGroups = new Set<string>()
		if (root.groupId !== null) doomedGroups.add(root.groupId)
		// The closure (T4): entries derived from a doomed entry, and every member of a group
		// that has a doomed member (a group never stays half shown). Registration order puts
		// a dependent after the entry it derives from, but a group can be pulled in by its
		// last member, so iterate to a fixed point.
		let grew = true
		while (grew) {
			grew = false
			for (const entry of this.entries.values()) {
				if (entry.state === 'committed' || doomed.has(entry.writeId)) continue
				const derived = entry.dependsOn !== null && doomed.has(entry.dependsOn)
				const grouped = entry.groupId !== null && doomedGroups.has(entry.groupId)
				if (!derived && !grouped) continue
				doomed.add(entry.writeId)
				if (entry.groupId !== null) doomedGroups.add(entry.groupId)
				grew = true
			}
		}
		// The rolled-back entry first, then the rest in registration order.
		const removed: PendingEntry[] = [root]
		for (const entry of this.entries.values()) {
			if (entry.writeId !== writeId && doomed.has(entry.writeId)) removed.push(entry)
		}
		const reportedGroups = new Set<string>()
		const at = this.now()
		for (const entry of removed) {
			this.remove(entry)
			this.rolledBackIds.add(entry.writeId)
			if (this.rolledBackIds.size > MAX_ROLLED_BACK_IDS) {
				const oldest = this.rolledBackIds.values().next()
				if (!oldest.done) this.rolledBackIds.delete(oldest.value)
			}
			if (entry.groupId === null) {
				this.emit({
					type: 'store:write-settled',
					writeId: entry.writeId,
					collection: entry.collection,
					outcome: 'rolled-back',
					pendingMs: at - entry.registeredAtMs,
				})
				continue
			}
			// One event per group (T7).
			if (reportedGroups.has(entry.groupId)) continue
			reportedGroups.add(entry.groupId)
			const members = removed.filter((one) => one.groupId === entry.groupId)
			this.emit({
				type: 'store:write-settled',
				writeId: entry.groupId,
				collection: entry.collection,
				collections: [...new Set(members.map((one) => one.collection))],
				outcome: 'rolled-back',
				pendingMs: at - entry.registeredAtMs,
			})
		}
		this.changed('rolled-back', [...new Set(removed.map((entry) => entry.collection))])
		return removed
	}

	/**
	 * The outcome is not known (the commit answer was lost, or the transaction did not
	 * settle): the entry stays shown and is decided later, never silently rolled back.
	 */
	markUnknown(writeId: string, lookupOperationId: string | null = null): PendingEntry | null {
		const entry = this.entries.get(writeId)
		if (!entry || entry.state !== 'pending') return null
		if (entry.groupId !== null) return this.markGroupUnknown(entry, lookupOperationId)
		const unknown: PendingEntry = { ...entry, state: 'unknown', lookupOperationId }
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

	/** {@link markUnknown} for a member: the whole group becomes unknown, with one event (T2, T7). */
	private markGroupUnknown(
		member: PendingEntry,
		lookupOperationId: string | null,
	): PendingEntry | null {
		const groupId = member.groupId ?? ''
		const members = this.groupMembers(groupId).filter((entry) => entry.state === 'pending')
		const first = members[0]
		if (!first) return null
		const collections: string[] = []
		let result: PendingEntry | null = null
		for (const entry of members) {
			const unknown: PendingEntry = { ...entry, state: 'unknown', lookupOperationId }
			this.entries.set(entry.writeId, unknown)
			if (entry.writeId === member.writeId) result = unknown
			if (!collections.includes(entry.collection)) collections.push(entry.collection)
		}
		this.emit({
			type: 'store:write-settled',
			writeId: groupId,
			collection: first.collection,
			collections,
			outcome: 'unknown',
			pendingMs: this.now() - first.registeredAtMs,
		})
		this.changed('unknown', collections)
		return result
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

	/** Entries whose outcome is unknown, optionally of one collection, in registration order. */
	unknownEntries(collection?: string): PendingEntry[] {
		const out: PendingEntry[] = []
		for (const entry of this.entries.values()) {
			if (entry.state !== 'unknown') continue
			if (collection === undefined || entry.collection === collection) out.push(entry)
		}
		return out
	}

	/**
	 * Committed entries of `collection` that a SQL read issued at epoch `to` contains but
	 * one issued at epoch `from` did not (`from < retiredAt <= to`): the writes whose
	 * prediction the settle check compares with the database.
	 */
	crossed(collection: string, from: number, to: number): PendingEntry[] {
		const out: PendingEntry[] = []
		for (const entry of this.entries.values()) {
			if (entry.collection !== collection || entry.retiredAt === null) continue
			if (entry.retiredAt > from && entry.retiredAt <= to) out.push(entry)
		}
		return out
	}

	/** Changes to `collection` that were not this registry's own predicted writes (see {@link PendingEntry.foreignAtAdd}). */
	foreignCount(collection: string): number {
		return this.foreignCounts.get(collection) ?? 0
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
		// A write the overlay did not predict is changing this record: neither a pending
		// entry nor a cached row describes it any more, so the next write reads it (F21).
		if ((this.unpredicted.get(cacheKey(collection, id)) ?? 0) > 0) return { found: 'none' }
		let newest: PendingEntry | undefined
		for (const entry of this.entries.values()) {
			if (entry.collection === collection && entry.recordId === id) newest = entry
		}
		if (newest && !this.isOutdated(newest)) {
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

	/**
	 * What the registry knows of a record's fold state (S6b): the newest entry for the
	 * record carries it (a pending chain, or a settling commit), or the state is unknown
	 * (the newest pending entry was predicted from values alone), or nothing is registered
	 * and the committed state has to be read. A committed entry that carries no state is
	 * `none`: its commit is in the database, so a read issued now contains it.
	 */
	foldStateFor(collection: string, id: string): FoldStateLookup {
		if ((this.unpredicted.get(cacheKey(collection, id)) ?? 0) > 0) return { found: 'none' }
		let newest: PendingEntry | undefined
		for (const entry of this.entries.values()) {
			if (entry.collection === collection && entry.recordId === id) newest = entry
		}
		if (!newest || this.isOutdated(newest)) return { found: 'none' }
		if (newest.foldState) return { found: 'state', state: newest.foldState }
		return newest.state === 'committed' ? { found: 'none' } : { found: 'unknown' }
	}

	/**
	 * A write to existing records that is NOT predicted (a miss) is about to run. Until it
	 * finishes, the registry cannot say what those records hold: their cached rows are
	 * dropped, later writes read the record instead of deriving it from an older entry,
	 * and the settle check skips the collection's pending entries (the record changes
	 * without a prediction).
	 *
	 * @returns Release function; call it once the write has committed, failed or become unknown
	 */
	holdUnpredicted(collection: string, ids: readonly string[]): () => void {
		const keys = ids.map((id) => cacheKey(collection, id))
		for (const key of keys) {
			this.cache.delete(key)
			this.unpredicted.set(key, (this.unpredicted.get(key) ?? 0) + 1)
		}
		this.foreignCounts.set(collection, this.foreignCount(collection) + 1)
		let released = false
		return () => {
			if (released) return
			released = true
			for (const key of keys) {
				const left = (this.unpredicted.get(key) ?? 0) - 1
				if (left > 0) this.unpredicted.set(key, left)
				else this.unpredicted.delete(key)
			}
		}
	}

	/** Whether a write the overlay did not predict is changing this record right now. */
	isHeld(collection: string, id: string): boolean {
		return (this.unpredicted.get(cacheKey(collection, id)) ?? 0) > 0
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
	 * A token for {@link seedFromRead}: take it before a read of `collection` is issued and
	 * hand it back with the result. It is the sum of three counters that only grow: changes
	 * to the collection that were not this registry's predicted writes (remote applies,
	 * cross-tab changes, unpredicted local writes: {@link invalidate}, {@link holdUnpredicted}),
	 * commits of this registry's own writes to it, and clears. Any of them between the read's
	 * issue and its delivery changes the token, because any of them can make the result
	 * older than what the registry already knows.
	 */
	seedStamp(collection: string): number {
		return (
			this.foreignCount(collection) + (this.commitCounts.get(collection) ?? 0) + this.generation
		)
	}

	/**
	 * Fill the committed-row cache from rows a subscription's SQL read delivered, so the
	 * common update or delete (of a row the user is looking at) finds its base without a
	 * read (S5 follow-up, design 5.6).
	 *
	 * A seeded row must never be staler than what the registry could have learned itself, so
	 * the call does nothing unless `stamp` (taken when the read was issued) still equals
	 * {@link seedStamp}: the result is then at least as new as every change the registry has
	 * been told about. Within an accepted result it skips a record that already has a cached
	 * row (the cache is kept exact by commits and invalidations, so it is never older than
	 * the result), one with a pending or settling entry (the entry is the base) and one with
	 * an unpredicted write in flight. Seeds are copies (a subscriber may hold or mutate the
	 * delivered objects), stop at the cache size, and go in with the first rows of the
	 * result most recently used.
	 *
	 * @param collection - The collection the query reads
	 * @param rows - The SQL result, in the read shape, from a query without relations
	 * @param stamp - {@link seedStamp} when the read was issued
	 * @returns How many rows were added
	 */
	seedFromRead(collection: string, rows: readonly CollectionRecord[], stamp: number): number {
		const capacity = this.options.rowCacheSize
		if (capacity <= 0 || rows.length === 0 || stamp !== this.seedStamp(collection)) return 0
		let busy: Set<string> | null = null
		for (const entry of this.entries.values()) {
			if (entry.collection !== collection) continue
			busy ??= new Set()
			busy.add(entry.recordId)
		}
		const fresh: CollectionRecord[] = []
		for (const row of rows) {
			if (fresh.length >= capacity) break
			const key = cacheKey(collection, row.id)
			if (this.cache.has(key) || busy?.has(row.id) || this.unpredicted.has(key)) continue
			fresh.push(row)
		}
		// Reverse: the top of the list ends up most recently used (evicted last).
		for (let i = fresh.length - 1; i >= 0; i--) {
			const row = fresh[i]
			if (row) this.putCache(collection, { ...row })
		}
		this.seeded += fresh.length
		return fresh.length
	}

	/**
	 * Forget cached rows of a collection (or one record). Called when a remote apply or a
	 * cross-tab change names it: a cached row may then be stale (F21).
	 */
	invalidate(collection: string, ids: readonly string[] | null = null): void {
		this.foreignCounts.set(collection, this.foreignCount(collection) + 1)
		this.foreignSeq += 1
		if (ids === null) this.collectionMarks.set(collection, this.foreignSeq)
		else {
			for (const id of ids) {
				// Re-inserting moves a hot record to the newest end, so eviction drops cold ones.
				const key = cacheKey(collection, id)
				this.recordMarks.delete(key)
				this.recordMarks.set(key, this.foreignSeq)
			}
		}
		this.boundMarks()
		if (ids === null) {
			const prefix = `${collection}\u0000`
			for (const key of [...this.cache.keys()]) if (key.startsWith(prefix)) this.cache.delete(key)
			return
		}
		for (const id of ids) this.cache.delete(cacheKey(collection, id))
	}

	/**
	 * A remote apply (or an inbound batch) is starting. Its rows can reach the database before
	 * its post-commit {@link invalidate} runs, so a local write that commits in between reads a
	 * record some unwritten field of which the prediction could not know. For the collections
	 * the apply touches, between `touch` and `end`, and for any write that overlapped it,
	 * verification is limited to the fields the write sets ({@link PendingWrites.foreignSince}).
	 * Applies in other collections do not weaken the check.
	 *
	 * @param collection - The collection of a single operation; omit for a batch and `touch`
	 *   each collection as its operations are applied
	 * @returns `touch` marks a collection as being applied (idempotent); call `end` once when
	 *   the apply has published (or failed)
	 */
	beginForeign(collection?: string): ForeignApply {
		const touched = new Set<string>()
		const touch = (name: string): void => {
			if (touched.has(name)) return
			touched.add(name)
			this.foreignInFlight.set(name, (this.foreignInFlight.get(name) ?? 0) + 1)
			this.foreignActivity.set(name, this.activityOf(name) + 1)
		}
		if (collection !== undefined) touch(collection)
		let ended = false
		return {
			touch,
			end: () => {
				if (ended) return
				ended = true
				for (const name of touched) {
					const left = (this.foreignInFlight.get(name) ?? 1) - 1
					if (left <= 0) this.foreignInFlight.delete(name)
					else this.foreignInFlight.set(name, left)
					this.foreignActivity.set(name, this.activityOf(name) + 1)
				}
			},
		}
	}

	private activityOf(collection: string): number {
		return this.foreignActivity.get(collection) ?? 0
	}

	private ancestorsOf(dependsOn: string | null): readonly string[] {
		if (dependsOn === null) return []
		const base = this.entries.get(dependsOn)
		return [dependsOn, ...(base?.ancestors ?? [])].slice(0, MAX_ANCESTORS)
	}

	/** Whether a write was rolled back (recent ones only: the record is bounded). */
	wasRolledBack(writeId: string): boolean {
		return this.rolledBackIds.has(writeId)
	}

	/** Whether a remote apply in the entry's collection overlapped it, or is in flight now. */
	foreignSince(entry: PendingEntry): boolean {
		return (
			this.foreignInFlight.has(entry.collection) ||
			this.activityOf(entry.collection) !== entry.foreignActivityAtAdd
		)
	}

	/**
	 * Count a commit check that could not judge every field (the write overlapped a remote
	 * apply, rested on an unsettled write, or could not be re-predicted). Not an error: the
	 * fields the write sets are still judged. Lets a test or DevTools see how often the check
	 * ran at reduced strength instead of the reduction being silent.
	 */
	noteUnverified(reason: UnverifiedReason): void {
		this.unverifiedCounts.set(reason, (this.unverifiedCounts.get(reason) ?? 0) + 1)
	}

	/** Reduced-strength commit checks by reason since the registry was created. */
	get unverified(): ReadonlyMap<UnverifiedReason, number> {
		return this.unverifiedCounts
	}

	/** Keep the per-record marks bounded; a dropped mark makes older entries count as changed. */
	private boundMarks(): void {
		while (this.recordMarks.size > MAX_RECORD_MARKS) {
			const oldest = this.recordMarks.entries().next()
			if (oldest.done) break
			this.markFloor = Math.max(this.markFloor, oldest.value[1])
			this.recordMarks.delete(oldest.value[0])
		}
	}

	/**
	 * Whether a foreign change (a remote apply, another tab) touched the entry's record after
	 * the entry was added: its `record` is then older than the database on fields it did not
	 * write, so it must not be the base of the next write. The next write reads the record.
	 */
	private isOutdated(entry: PendingEntry): boolean {
		const since = entry.foreignSeqAtAdd
		if (this.markFloor > since) return true
		if ((this.collectionMarks.get(entry.collection) ?? 0) > since) return true
		return (this.recordMarks.get(cacheKey(entry.collection, entry.recordId)) ?? 0) > since
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
		this.rolledBackIds.clear()
		this.generation += 1
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
		// A commit that did not report its row (an outcome decided later by lookup) leaves
		// the cached row, if any, older than the database: forget it.
		if (record) this.putCache(entry.collection, record)
		else this.cache.delete(cacheKey(entry.collection, entry.recordId))
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
