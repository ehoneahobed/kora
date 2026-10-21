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
 * The summary is exact or absent. It is built from the record's log (background
 * backfill) or created with the record's first operation, then advanced in each
 * write's transaction. `throughSeq` is the delivery sequence of the last operation it
 * includes: a summary behind the record's newest operation (written by an instance
 * that does not maintain it, such as an older version during a rolling deploy) is
 * stale and reads as unknown until it is rebuilt. Unknown always means the previous
 * behavior (an operation is judged on its own values), never "held".
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

/**
 * Whether a summary includes the record's newest operation (delivery sequence and id,
 * as the store reads them now).
 */
export function liveViewsCurrent(
	views: RecordLiveViews,
	latest: { seq: number; id: string } | null,
): boolean {
	return latest !== null && views.throughSeq === latest.seq && views.throughId === latest.id
}

/** A stored summary with whether it includes the record's newest operation. */
export interface RecordLiveViewsState {
	views: RecordLiveViews
	/** False when an operation of the record is not included (the summary is stale). */
	current: boolean
}

/** Most distinct projections a summary keeps before it overflows. */
export const MAX_LIVE_VIEW_VERSIONS = 64
/** Most ranges (over all projections) a summary keeps before it overflows. */
export const MAX_LIVE_VIEW_RANGES = 256
/** Most fields a collection's view fields may hold (more are not registered). */
export const MAX_LIVE_VIEW_FIELDS = 32

/** `kora_server_meta` key prefix of a collection's registered view fields (JSON array). */
export const LIVE_VIEW_FIELDS_KEY_PREFIX = 'live_view_fields:'
/** `kora_server_meta` key prefix of a collection's backfill cursor (JSON). */
export const LIVE_VIEW_CURSOR_KEY_PREFIX = 'live_view_cursor:'

/** Records the background backfill handles per transaction. */
export const LIVE_VIEW_BACKFILL_BATCH = 50
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
