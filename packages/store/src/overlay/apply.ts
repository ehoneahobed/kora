import { structurallyEqual } from '../subscription/result-equality'
import type { CollectionRecord, QueryDescriptor } from '../types'
import type { PendingEntry } from './pending-writes'
import { compare, matches } from './query-eval'

/*
 * applyOverlay (instant-UI stage S3, docs/design/instant-ui-updates.md 5.4 patch rules,
 * 5.5): the pure function `displayed = f(base, entries)`.
 *
 * `base` is a subscription's last SQL result; `entries` are the pending writes that apply
 * to it (the caller selected them with `PendingWrites.applicable`), in registration order.
 * The result is recomputed from scratch on every call, never mutated incrementally, so a
 * rollback is "call it again with fewer entries" (F10, I6). Only call it for a descriptor
 * `isPatchable` accepted: `matches` and `compare` are proven equal to SQLite for that
 * allowlist only.
 *
 * Structural sharing: the input array is returned as is when nothing changed, and rows the
 * entries did not touch keep their object identity, so the subscriber's equality check is
 * a reference scan and bindings can skip re-rendering unchanged rows.
 *
 * A change the evaluator cannot place exactly is SKIPPED, never guessed (5.4): the row is
 * left as the base has it and the SQL settle decides. Once a record has had a change
 * skipped, every later entry for the same record is skipped too, so the display never
 * shows a value built on a step it did not take.
 */

/** Why an entry was not applied to a result. */
export type SkipReason =
	/** A row would leave a full `limit` page: the row that takes its place is not in memory. */
	| 'page-removal'
	/** A row would move within a full `limit` page and could land where an unseen row belongs. */
	| 'page-move'
	/** The changed row's sort key equals another row's: SQLite's tie order is not known. */
	| 'tie'
	/** Without an `orderBy` the rowid position of a row entering by update is not known. */
	| 'unordered-entry'
	/** An update of a row that matched before but is not in the list (deleted or changed remotely). */
	| 'absent-member'
	/** An earlier entry for the same record was skipped. */
	| 'after-skip'

/** One skipped entry. */
export interface SkippedEntry {
	readonly writeId: string
	readonly recordId: string
	readonly reason: SkipReason
}

/** The displayed rows and what could not be applied. */
export interface OverlayResult {
	readonly rows: CollectionRecord[]
	readonly skipped: readonly SkippedEntry[]
}

/**
 * Whether a row inserted without an `orderBy` can be appended: SQLite returns rowid
 * order only when the `WHERE` leaves the planner no index to choose (no conditions, or
 * only equality and inequality; a range or `IN` over an indexed column returns index
 * order, so appending would be wrong). A freshly inserted row has the largest rowid.
 */
const APPEND_CACHE = new WeakMap<object, boolean>()

function appendAllowed(descriptor: QueryDescriptor): boolean {
	const cached = APPEND_CACHE.get(descriptor.where)
	if (cached !== undefined) return cached
	let allowed = true
	for (const value of Object.values(descriptor.where)) {
		if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
			for (const op of Object.keys(value)) {
				if (op !== '$eq' && op !== '$ne') allowed = false
			}
		}
	}
	APPEND_CACHE.set(descriptor.where, allowed)
	return allowed
}

/**
 * Apply pending writes to a base result.
 *
 * @param base - The subscription's last SQL result
 * @param entries - The entries that apply to it, in registration order
 * @param descriptor - A patchable query descriptor
 * @returns The displayed rows (`base` itself when unchanged)
 */
export function applyOverlay(
	base: readonly CollectionRecord[],
	entries: readonly PendingEntry[],
	descriptor: QueryDescriptor,
): CollectionRecord[] {
	return applyOverlayReport(base, entries, descriptor).rows
}

/**
 * {@link applyOverlay} plus the entries it had to skip (for statistics and tests).
 *
 * @param base - The subscription's last SQL result
 * @param entries - The entries that apply to it, in registration order
 * @param descriptor - A patchable query descriptor
 */
export function applyOverlayReport(
	base: readonly CollectionRecord[],
	entries: readonly PendingEntry[],
	descriptor: QueryDescriptor,
): OverlayResult {
	if (entries.length === 0) return { rows: base as CollectionRecord[], skipped: [] }
	const state = new Working(base, descriptor)
	for (const entry of entries) state.apply(entry)
	return { rows: state.result(), skipped: state.skipped }
}

/** Copy-on-write list of rows. */
class Working {
	private rows: CollectionRecord[]
	private copied = false
	private poisoned: Set<string> | null = null
	readonly skipped: SkippedEntry[] = []
	private readonly limit: number | undefined
	private readonly ordered: boolean

	constructor(
		private readonly base: readonly CollectionRecord[],
		private readonly descriptor: QueryDescriptor,
	) {
		this.rows = base as CollectionRecord[]
		this.limit = descriptor.limit
		this.ordered = descriptor.orderBy.length > 0
	}

	result(): CollectionRecord[] {
		return this.copied ? this.rows : (this.base as CollectionRecord[])
	}

	apply(entry: PendingEntry): void {
		// LIMIT 0 is always empty: nothing can ever enter.
		if (this.limit === 0) return
		if (this.poisoned?.has(entry.recordId)) {
			this.skipped.push({
				writeId: entry.writeId,
				recordId: entry.recordId,
				reason: 'after-skip',
			})
			return
		}
		const index = this.indexOf(entry.recordId)
		if (entry.kind === 'delete') {
			this.applyDelete(entry, index)
			return
		}
		const current = index >= 0 ? (this.rows[index] as CollectionRecord) : null
		// An insert is a full record, an update a field patch over the row in the list. An
		// update of a row that is not in the list uses the full predicted record (5.6).
		const patch = entry.kind === 'insert' || current === null ? entry.record : entry.patch
		const next = current === null ? entry.record : mergePatch(current, patch)
		if (current === null) this.applyEntering(entry, next)
		else this.applyPresent(entry, index, current, next)
	}

	private applyDelete(entry: PendingEntry, index: number): void {
		if (index < 0) return
		if (this.isFull()) {
			this.skip(entry, 'page-removal')
			return
		}
		this.removeAt(index)
	}

	/** The row is not in the list: it enters if it now matches. */
	private applyEntering(entry: PendingEntry, next: CollectionRecord): void {
		if (!matches(this.descriptor, next)) return
		if (entry.kind === 'update' && !this.mayEnter(entry)) {
			this.skip(entry, 'absent-member')
			return
		}
		if (!this.ordered) {
			// Only a brand new row has the largest rowid; a row entering by update has an
			// unknown rowid position.
			if (entry.kind !== 'insert' || !appendAllowed(this.descriptor)) {
				this.skip(entry, 'unordered-entry')
				return
			}
			if (this.isFull()) return // appended past the page
			this.insertAt(this.rows.length, next)
			return
		}
		const position = this.position(next)
		if (position === null) {
			this.skip(entry, 'tie')
			return
		}
		// Into a full page: either inside the first `limit` rows or past them; both exact.
		if (this.limit !== undefined && position >= this.limit) return
		const wasFull = this.isFull()
		this.insertAt(position, next)
		if (wasFull) this.truncate()
	}

	/**
	 * Whether an update of a row that is not in the list may add it. A row that did not
	 * match before enters (a task marked done appears in the done list). One that did match
	 * is missing for a reason the entry cannot see: beyond a full `limit` page (it may
	 * enter, or stay out), or gone (deleted or changed by a remote operation: showing it
	 * would resurrect it, F21).
	 */
	private mayEnter(entry: PendingEntry): boolean {
		if (entry.previous === null) return false
		const before = { ...entry.record, ...entry.previous }
		return !matches(this.descriptor, before) || this.isFull()
	}

	/** The row is in the list: it stays, moves, or leaves. */
	private applyPresent(
		entry: PendingEntry,
		index: number,
		current: CollectionRecord,
		next: CollectionRecord,
	): void {
		if (!matches(this.descriptor, next)) {
			if (this.isFull()) {
				this.skip(entry, 'page-removal')
				return
			}
			this.removeAt(index)
			return
		}
		if (next === current) return
		if (!this.ordered || compare(this.descriptor, current, next) === 0) {
			this.replaceAt(index, next)
			return
		}
		// The sort key changed: take the row out, find its new place among the others.
		const full = this.isFull()
		const others = this.rows.slice(0, index).concat(this.rows.slice(index + 1))
		const position = positionIn(this.descriptor, others, next)
		if (position === null) {
			this.skip(entry, 'tie')
			return
		}
		// In a full page the row that follows the others is not in memory: landing after
		// every remaining row is ambiguous (it may belong behind the unseen row).
		if (full && position >= others.length) {
			this.skip(entry, 'page-move')
			return
		}
		others.splice(position, 0, next)
		this.rows = others
		this.copied = true
	}

	private skip(entry: PendingEntry, reason: SkipReason): void {
		if (this.poisoned === null) this.poisoned = new Set()
		this.poisoned.add(entry.recordId)
		this.skipped.push({ writeId: entry.writeId, recordId: entry.recordId, reason })
	}

	private isFull(): boolean {
		return this.limit !== undefined && this.rows.length >= this.limit
	}

	private indexOf(id: string): number {
		const rows = this.rows
		for (let i = 0; i < rows.length; i++) if ((rows[i] as CollectionRecord).id === id) return i
		return -1
	}

	/** Index to insert `record` at, or null when its sort key ties with a row in the list. */
	private position(record: CollectionRecord): number | null {
		return positionIn(this.descriptor, this.rows, record)
	}

	private own(): void {
		if (!this.copied) {
			this.rows = this.rows.slice()
			this.copied = true
		}
	}

	private insertAt(position: number, record: CollectionRecord): void {
		this.own()
		this.rows.splice(position, 0, record)
	}

	private removeAt(index: number): void {
		this.own()
		this.rows.splice(index, 1)
	}

	private replaceAt(index: number, record: CollectionRecord): void {
		this.own()
		this.rows[index] = record
	}

	private truncate(): void {
		if (this.limit !== undefined && this.rows.length > this.limit) this.rows.length = this.limit
	}
}

/**
 * Where a record sorts in an ordered list (binary search; the list is sorted by the
 * query's order, with ties adjacent). Null when it ties with a row already there.
 */
function positionIn(
	descriptor: QueryDescriptor,
	rows: readonly CollectionRecord[],
	record: CollectionRecord,
): number | null {
	let low = 0
	let high = rows.length
	while (low < high) {
		const mid = (low + high) >>> 1
		if (compare(descriptor, rows[mid] as CollectionRecord, record) < 0) low = mid + 1
		else high = mid
	}
	if (low < rows.length && compare(descriptor, rows[low] as CollectionRecord, record) === 0) {
		return null
	}
	return low
}

/**
 * The row with `patch` applied; the same object when every patched value is already
 * there (re-applying a committed write to a result that contains it changes nothing).
 */
function mergePatch(
	current: CollectionRecord,
	patch: Readonly<Record<string, unknown>> | null,
): CollectionRecord {
	if (patch === null) return current
	let merged: CollectionRecord | null = null
	for (const key of Object.keys(patch)) {
		if (key === 'id') continue
		if (structurallyEqual(current[key], patch[key])) continue
		if (merged === null) merged = { ...current }
		merged[key] = patch[key]
	}
	return merged ?? current
}
