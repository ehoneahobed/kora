import { HybridLogicalClock } from '@korajs/core'
import type { HLCTimestamp, Operation } from '@korajs/core'

/**
 * Live views of a record: a compact summary, kept per record, of every version the
 * record was live with, projected onto the fields download scopes read (the "view
 * fields" sessions register for its collection). A session decides whether its view
 * held the record before an operation with one point read of this summary, instead of
 * reading the record's history: delivery of an operation after which the record is
 * deleted is decided by what the view held (see `ClientSession.tombstoneDelivery`).
 *
 * The summary is exact or unknown, never wrong. It is built from the record's log
 * (background backfill) or created with the record's first operation, then maintained
 * in each write's transaction. Which operations it accounts for is recorded on the
 * record's fold-state row (`lv_through`, the id of the newest operation the summary
 * accounts for, written in the same statement as the fold state): the summary is
 * current only while `lv_through` equals the fold state's `covered_op_id` (the record's
 * newest operation). A write by any writer that does not maintain the summary (an older
 * instance during a rolling deploy, a refold) moves `covered_op_id` without
 * `lv_through`, so the summary reads as unknown from then on, and a maintaining write
 * advances a summary only when `lv_through` names the record's previous newest
 * operation: a summary that missed a write is never made current again by a later one.
 * Only a rebuild from the log (which sets both under a guard) restores it.
 *
 * A write that changes neither the record's liveness nor a tracked value, and is not a
 * delete, does not touch the summary row: the current version's range is open-ended.
 * Unknown always means the previous behavior (an operation is judged on its own values),
 * never "held".
 */

/** One distinct projection of the record's live values, with the ranges it was live. */
export interface LiveViewVersion {
	/** The record's values for the summary's `fields` (absent fields left out). */
	values: Record<string, unknown>
	/**
	 * Delivery-sequence ranges `[start, end)` during which the record was live with these
	 * values: `start` is the operation that made it so, `end` the one that ended it (null
	 * while it still is).
	 */
	ranges: Array<[number, number | null]>
}

/** The live-view summary of one record (see the module comment). */
export interface RecordLiveViews {
	/** The projected fields, sorted. */
	fields: string[]
	/** Distinct live projections, in order of first appearance. */
	versions: LiveViewVersion[]
	/** The record's newest delete by HLC (then id), or null. */
	newestDelete: { id: string; t: HLCTimestamp } | null
	/** Delivery sequence of the last operation included. */
	throughSeq: number
	/** Id of that operation (a restore that renumbers the log never matches it). */
	throughId: string
	/** More versions or ranges than a summary keeps: it can no longer prove anything. */
	overflow: boolean
}

/** A stored summary with whether it accounts for every operation of the record. */
export interface RecordLiveViewsState {
	views: RecordLiveViews
	/** False when an operation of the record is not accounted for (unknown). */
	current: boolean
	/** Delivery sequence of the record's newest operation when it was read. */
	coveredSeq: number
}

/** The live-view columns of a record's fold-state row, as read by a write. */
export interface StoredLiveViewColumns {
	/** Id of the newest operation the summary accounts for; null when not tracked. */
	lvThrough: string | null
	/** The summary's fields (JSON), as registered when it was created or rebuilt. */
	lvFields: string | null
}

/** A write that does not touch any summary. */
export const NO_LIVE_VIEW_WRITE: LiveViewWrite = { tracking: null, columns: null, stale: false }

/** How a write maintains the record's summary (see {@link liveViewTrackingFor}). */
export interface LiveViewWrite {
	/** The record is tracked: maintain its summary with this write. */
	tracking: { fields: string[]; created: boolean } | null
	/** The live-view columns to write with the fold state; null: leave them as they are. */
	columns: { through: string; fields: string } | null
	/** The record's summary missed a write (rebuild it); it stays unknown meanwhile. */
	stale: boolean
}

/**
 * Decide how a write maintains a record's summary, from the live-view columns the write
 * read with the fold state (under its lock), the record's previous newest operation and
 * the fields a new record starts tracking with (this instance's registered fields, or
 * null). An existing summary is maintained whatever this instance has registered (it
 * carries its own fields); it advances only if it accounts for the previous newest
 * operation, else it stays unknown.
 *
 * @param stored - The fold-state row's live-view columns, or null when there is no row
 * @param previousNewestId - Id of the record's newest operation before this one, or null
 * @param opId - This operation's id
 * @param newRecordFields - Fields to track a brand-new record with, or null
 */
export function liveViewTrackingFor(
	stored: StoredLiveViewColumns | null,
	previousNewestId: string | null,
	opId: string,
	newRecordFields: readonly string[] | null,
): LiveViewWrite {
	if (stored?.lvThrough != null) {
		const fields = parseLiveViewFields(stored.lvFields)
		if (fields.length === 0 || stored.lvThrough !== (previousNewestId ?? '')) {
			return { tracking: null, columns: null, stale: true }
		}
		return {
			tracking: { fields, created: false },
			columns: { through: opId, fields: liveViewFieldsKey(fields) },
			stale: false,
		}
	}
	if (
		stored === null &&
		previousNewestId === null &&
		newRecordFields &&
		newRecordFields.length > 0
	) {
		const fields = normalizeFields(newRecordFields)
		return {
			tracking: { fields, created: true },
			columns: { through: opId, fields: liveViewFieldsKey(fields) },
			stale: false,
		}
	}
	return { tracking: null, columns: null, stale: false }
}

/**
 * True when a write must update the record's summary row: a new summary, a delete (the
 * newest delete is kept), a change of liveness, or a change of a tracked value. Any
 * other write leaves the open range as it is.
 */
export function liveViewChangeNeeded(
	tracking: { fields: string[]; created: boolean },
	op: Operation,
	snapshot: {
		pre: Record<string, unknown> | null
		post: Record<string, unknown> | null
		deleted?: boolean
	},
): boolean {
	if (tracking.created || op.type === 'delete') return true
	const livePre = snapshot.pre !== null
	const livePost = snapshot.post !== null && snapshot.deleted === false
	if (livePre !== livePost) return true
	if (!livePre || !snapshot.pre || !snapshot.post) return false
	return !sameProjection(
		project(snapshot.pre, tracking.fields),
		project(snapshot.post, tracking.fields),
	)
}

/**
 * Whether a write may need to update the record's summary, judged before its result is
 * read (so a store can fetch the summary in a round trip it makes anyway): anything but
 * an update, an update of a record that was not live (a revival), or an update that
 * writes a tracked field. A false "no" only costs a separate read; it never skips one.
 */
export function liveViewMayChange(
	tracking: { fields: string[]; created: boolean },
	op: Operation,
	pre: Record<string, unknown> | null,
): boolean {
	if (tracking.created || op.type !== 'update' || pre === null) return true
	const data = op.data ?? {}
	return tracking.fields.some((field) => Object.prototype.hasOwnProperty.call(data, field))
}

/**
 * Whether a stored summary accounts for every operation of its record: the fold state's
 * `lv_through` names its `covered_op_id`, which is the record's newest operation.
 */
export function liveViewsAccountFor(
	lvThrough: string | null | undefined,
	coveredOpId: string | null | undefined,
	newestId: string | null | undefined,
): boolean {
	return (
		typeof lvThrough === 'string' &&
		lvThrough.length > 0 &&
		lvThrough === coveredOpId &&
		coveredOpId === newestId
	)
}

/** Most distinct projections a summary keeps before it overflows. */
export const MAX_LIVE_VIEW_VERSIONS = 64
/** Most ranges (over all projections) a summary keeps before it overflows. */
export const MAX_LIVE_VIEW_RANGES = 256
/** Most fields a collection's view fields may hold (more are not registered). */
export const MAX_LIVE_VIEW_FIELDS = 32

/** `kora_server_meta` key prefix of a collection's registered view fields (JSON array). */
export const LIVE_VIEW_FIELDS_KEY_PREFIX = 'live_view_fields:'
/**
 * `kora_server_meta` key of the live-view epoch: bumped by a replace-mode restore and a
 * scope-snapshot wipe, in their transaction. A rebuild reads it before reading the log and
 * writes its summary only if it is unchanged, so a replay of a log that was replaced
 * meanwhile is never stored.
 */
export const LIVE_VIEW_EPOCH_KEY = 'live_view_epoch'

/** `kora_server_meta` key prefix of a collection's backfill cursor (JSON). */
export const LIVE_VIEW_CURSOR_KEY_PREFIX = 'live_view_cursor:'

/** Records the background backfill takes per cursor step. */
export const LIVE_VIEW_BACKFILL_BATCH = 50
/** Operations a rebuild reads and replays between yields (and snapshots per update). */
export const LIVE_VIEW_REPLAY_PAGE = 100
/** Most record rebuilds sessions may have queued at once (more are dropped: unknown). */
export const MAX_PENDING_LIVE_VIEW_REBUILDS = 10_000
/** How long an instance trusts its copy of the registered fields before re-reading. */
export const LIVE_VIEW_FIELDS_TTL_MS = 5_000

/** A collection's backfill cursor: the field set it runs for, and the last record done. */
export interface LiveViewCursor {
	fields: string
	/** Last record id handled; null once the collection is done. */
	after: string | null
}

/** Parse a persisted backfill cursor; null when absent or malformed. */
export function parseLiveViewCursor(raw: unknown): LiveViewCursor | null {
	if (typeof raw !== 'string') return null
	try {
		const parsed = JSON.parse(raw) as Partial<LiveViewCursor>
		if (typeof parsed.fields !== 'string') return null
		if (parsed.after !== null && typeof parsed.after !== 'string') return null
		return { fields: parsed.fields, after: parsed.after }
	} catch {
		return null
	}
}

/** How long the background backfill waits after it is asked to run. */
export const LIVE_VIEW_BACKFILL_DELAY_MS = 250

/** Resolve after `ms` (an unref'd timer: it never keeps a process alive). */
export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms)
		;(timer as { unref?: () => void }).unref?.()
	})
}

/** Let other work run between backfill transactions. */
export function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve))
}

/** An empty summary over `fields` (a record with no operation yet). */
export function emptyLiveViews(fields: readonly string[]): RecordLiveViews {
	return {
		fields: normalizeFields(fields),
		versions: [],
		newestDelete: null,
		throughSeq: 0,
		throughId: '',
		overflow: false,
	}
}

/** Sorted, deduplicated field names. */
export function normalizeFields(fields: readonly string[]): string[] {
	return [...new Set(fields)].sort()
}

/** Canonical key of a field set. */
export function liveViewFieldsKey(fields: readonly string[]): string {
	return JSON.stringify(normalizeFields(fields))
}

/** True when `have` contains every field of `need`. */
export function liveViewFieldsCover(have: readonly string[], need: readonly string[]): boolean {
	const set = new Set(have)
	return need.every((field) => set.has(field))
}

function project(
	values: Record<string, unknown>,
	fields: readonly string[],
): Record<string, unknown> {
	const projected: Record<string, unknown> = {}
	for (const field of fields) {
		if (Object.prototype.hasOwnProperty.call(values, field)) projected[field] = values[field]
	}
	return projected
}

function sameProjection(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
	const keys = Object.keys(a)
	if (keys.length !== Object.keys(b).length) return false
	return keys.every(
		(key) => Object.prototype.hasOwnProperty.call(b, key) && Object.is(a[key], b[key]),
	)
}

function rangeCount(views: RecordLiveViews): number {
	return views.versions.reduce((total, version) => total + version.ranges.length, 0)
}

/**
 * The summary after one more operation of the record (a new object; `views` is not
 * changed). An operation at or below `throughSeq` is already included and changes
 * nothing, so advancing is idempotent.
 *
 * @param views - The summary so far
 * @param step.seq - The operation's delivery sequence
 * @param step.op - The operation
 * @param step.live - Whether the record is live after it (the fold's decision)
 * @param step.values - The record's scope values after it (null when unknown)
 */
export function advanceLiveViews(
	views: RecordLiveViews,
	step: { seq: number; op: Operation; live: boolean; values: Record<string, unknown> | null },
): RecordLiveViews {
	if (step.seq <= views.throughSeq) return views
	const next: RecordLiveViews = {
		fields: views.fields,
		versions: views.versions.map((version) => ({
			values: version.values,
			ranges: version.ranges.map((range) => [range[0], range[1]] as [number, number | null]),
		})),
		newestDelete: views.newestDelete,
		throughSeq: step.seq,
		throughId: step.op.id,
		overflow: views.overflow,
	}
	if (step.op.type === 'delete') {
		const current = next.newestDelete
		const newer =
			current === null ||
			HybridLogicalClock.compare(step.op.timestamp, current.t) > 0 ||
			(HybridLogicalClock.compare(step.op.timestamp, current.t) === 0 && step.op.id > current.id)
		if (newer) next.newestDelete = { id: step.op.id, t: step.op.timestamp }
	}
	if (next.overflow) return next
	let open: { version: LiveViewVersion; range: [number, number | null] } | null = null
	for (const version of next.versions) {
		for (const range of version.ranges) if (range[1] === null) open = { version, range }
	}
	if (!step.live || step.values === null) {
		// A live record whose values are unknown cannot be placed: the summary overflows
		// (nothing is proven from it any more) rather than guess.
		if (step.live) next.overflow = true
		if (open) open.range[1] = step.seq
		return next
	}
	const values = project(step.values, next.fields)
	if (open && sameProjection(open.version.values, values)) return next
	if (open) open.range[1] = step.seq
	let version = next.versions.find((candidate) => sameProjection(candidate.values, values))
	if (!version) {
		if (next.versions.length >= MAX_LIVE_VIEW_VERSIONS) {
			next.overflow = true
			return next
		}
		version = { values, ranges: [] }
		next.versions.push(version)
	}
	if (rangeCount(next) >= MAX_LIVE_VIEW_RANGES) {
		next.overflow = true
		return next
	}
	version.ranges.push([step.seq, null])
	return next
}

/**
 * True when the record was live, before delivery sequence `before`, with values a
 * view admits. `admits(values, lastSeq)` is asked once per projection and live range
 * that began before `before`, with the last sequence of that range before `before`
 * (for a history gate: a membership opened by then admits it). Cost is bounded by the
 * summary's caps, never by the record's history.
 */
export function liveViewsHeldBefore(
	views: RecordLiveViews,
	before: number,
	admits: (values: Record<string, unknown>, lastSeq: number) => boolean,
): boolean {
	for (const version of views.versions) {
		let lastSeq = Number.NEGATIVE_INFINITY
		for (const [start, end] of version.ranges) {
			if (start >= before) continue
			const until = Math.min(end ?? Number.POSITIVE_INFINITY, before)
			if (until > start) lastSeq = Math.max(lastSeq, until - 1)
		}
		if (lastSeq !== Number.NEGATIVE_INFINITY && admits(version.values, lastSeq)) return true
	}
	return false
}

/** JSON form of a summary. */
export function serializeLiveViews(views: RecordLiveViews): string {
	return JSON.stringify(views)
}

/** Parse a stored summary; null for a malformed one (treated as absent: unknown). */
export function parseLiveViews(raw: unknown): RecordLiveViews | null {
	if (typeof raw !== 'string' || raw.length === 0) return null
	try {
		const parsed = JSON.parse(raw) as Partial<RecordLiveViews>
		if (
			!Array.isArray(parsed.fields) ||
			!parsed.fields.every((field) => typeof field === 'string') ||
			!Array.isArray(parsed.versions) ||
			typeof parsed.throughSeq !== 'number' ||
			typeof parsed.throughId !== 'string' ||
			typeof parsed.overflow !== 'boolean'
		) {
			return null
		}
		for (const version of parsed.versions) {
			if (
				!version ||
				typeof version.values !== 'object' ||
				version.values === null ||
				!Array.isArray(version.ranges) ||
				!version.ranges.every(
					(range) =>
						Array.isArray(range) &&
						typeof range[0] === 'number' &&
						(range[1] === null || typeof range[1] === 'number'),
				)
			) {
				return null
			}
		}
		const newestDelete = parsed.newestDelete ?? null
		if (
			newestDelete !== null &&
			(typeof newestDelete.id !== 'string' || typeof newestDelete.t !== 'object')
		) {
			return null
		}
		return {
			fields: parsed.fields,
			versions: parsed.versions,
			newestDelete,
			throughSeq: parsed.throughSeq,
			throughId: parsed.throughId,
			overflow: parsed.overflow,
		}
	} catch {
		return null
	}
}

/** Parse a registered field list from `kora_server_meta`; empty when malformed. */
export function parseLiveViewFields(raw: unknown): string[] {
	if (typeof raw !== 'string') return []
	try {
		const parsed: unknown = JSON.parse(raw)
		return Array.isArray(parsed) && parsed.every((field) => typeof field === 'string')
			? normalizeFields(parsed)
			: []
	} catch {
		return []
	}
}
