import { applyAtomicOp } from '../operations/atomic-ops'
import { canonicalValue } from '../operations/canonical-body'
import { base64ToBytes, bytesToBase64, decodeBytesFromOpData } from '../operations/op-data-binary'
import type { AtomicOp } from '../types'
import { FoldConfigurationError } from './errors'
import type { FieldPlan } from './field-kind'
import { compareStamps, isAfter, maxStamp } from './stamp'
import type {
	CounterFieldState,
	ElementSetFieldState,
	ElementState,
	ExtremumFieldState,
	FieldLogEntry,
	FieldState,
	KeyMapFieldState,
	KeyState,
	RegisterFieldState,
	ResolverFieldState,
	RichtextFieldState,
	RichtextSubsumes,
	RichtextUpdateMerger,
	Stamp,
} from './types'
import { canonicalKey, isPlainObject } from './values'

/**
 * One operation's write to one field, already normalized. Built by the record
 * fold; an update whose value equals its own `previousData` is not a write (the
 * writer restated the field without changing it) and never reaches this layer.
 */
export interface FieldWrite {
	s: Stamp
	insert: boolean
	v: unknown
	/** The writer's base (`previousData[field]`), undefined when it has none. */
	prev: unknown
	hasPrev: boolean
	a?: AtomicOp
}

/** A fresh, empty state for a field folded by `plan`. */
export function emptyField(plan: FieldPlan): FieldState {
	switch (plan.kind) {
		case 'reg':
			return { k: 'reg', e: [], val: undefined }
		case 'res':
			return { k: 'res', e: [], val: undefined }
		case 'set':
			return { k: 'set', ao: plan.appendOnly, sh: null, clr: null, el: {} }
		case 'map':
			return { k: 'map', sh: null, clr: null, keys: {} }
		case 'ctr':
			return { k: 'ctr', base: null, d: [], val: undefined }
		case 'max':
		case 'min':
			return { k: plan.kind, best: null, reg: null }
		case 'rt':
			return { k: 'rt', reset: null, u: {} }
	}
}

/** Result of applying a write: the new state (a copy when changed) and whether it changed. */
export interface FieldApplyResult {
	state: FieldState
	changed: boolean
	/** Set when a custom resolver threw while producing the new value. */
	error?: string
}

// ---------------------------------------------------------------------------
// Register (scalars + atomic chain)
// ---------------------------------------------------------------------------

function entryKind(entry: FieldLogEntry): string {
	return entry.a ? entry.a.type : 'set'
}

/**
 * Fold a chain: a plain write takes its value; an atomic write composes onto the
 * running value only when the previous write was an atomic op of the same type
 * (concurrent increments sum, maxes take the max); otherwise it takes its own
 * resolved value. Same rule as the pre-W7 record replay.
 */
function chainFold(entries: readonly FieldLogEntry[]): unknown {
	let value: unknown
	let last: string | null = null
	for (const entry of entries) {
		value = entry.a && last === entry.a.type ? applyAtomicOp(value, entry.a) : entry.v
		last = entryKind(entry)
	}
	return value
}

/** Index at which `stamp` belongs in a stamp-sorted log, or -1 if already present. */
function insertionIndex(entries: readonly FieldLogEntry[], stamp: Stamp): number {
	let lo = 0
	let hi = entries.length
	while (lo < hi) {
		const mid = (lo + hi) >>> 1
		const entry = entries[mid] as FieldLogEntry
		const cmp = compareStamps(entry.s, stamp)
		if (cmp === 0) return -1
		if (cmp < 0) lo = mid + 1
		else hi = mid
	}
	return lo
}

/** Drop every entry older than the newest plain write (a plain write resets the field). */
function pruneChain(entries: FieldLogEntry[]): FieldLogEntry[] {
	for (let i = entries.length - 1; i > 0; i--) {
		if (!(entries[i] as FieldLogEntry).a) return entries.slice(i)
	}
	return entries
}

function toEntry(write: FieldWrite): FieldLogEntry {
	return write.a ? { s: write.s, v: write.v, a: write.a } : { s: write.s, v: write.v }
}

function applyRegister(state: RegisterFieldState, write: FieldWrite): FieldApplyResult {
	const entries = state.e
	const index = insertionIndex(entries, write.s)
	if (index === -1) return { state, changed: false }
	const first = entries[0]
	// Older than the newest plain write: it cannot affect the value.
	if (index === 0 && first !== undefined && !first.a) return { state, changed: false }
	const entry = toEntry(write)
	if (index === entries.length) {
		if (!entry.a) return { state: { k: 'reg', e: [entry], val: entry.v }, changed: true }
		const last = entries[entries.length - 1]
		const val =
			last !== undefined && entryKind(last) === entry.a.type
				? applyAtomicOp(state.val, entry.a)
				: entry.v
		return { state: { k: 'reg', e: [...entries, entry], val }, changed: true }
	}
	const next = pruneChain([...entries.slice(0, index), entry, ...entries.slice(index)])
	return { state: { k: 'reg', e: next, val: chainFold(next) }, changed: true }
}

function mergeLogs(a: readonly FieldLogEntry[], b: readonly FieldLogEntry[]): FieldLogEntry[] {
	const out: FieldLogEntry[] = []
	let i = 0
	let j = 0
	while (i < a.length || j < b.length) {
		const x = a[i]
		const y = b[j]
		if (y === undefined || (x !== undefined && compareStamps(x.s, y.s) < 0)) {
			out.push(x as FieldLogEntry)
			i++
		} else if (x === undefined || compareStamps(x.s, y.s) > 0) {
			out.push(y)
			j++
		} else {
			out.push(x)
			i++
			j++
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Resolver log
// ---------------------------------------------------------------------------

function resolveStep(
	plan: FieldPlan,
	current: unknown,
	entry: FieldLogEntry,
): { value: unknown; error?: string } {
	try {
		// A resolver's output enters the state in its canonical form (core canonical-body),
		// the form it has after the persisted state's JSON round trip: undefined is null,
		// -0 is 0, a Date is its ISO string, bytes are tagged. So the in-memory state and
		// the persisted one are identical on every replica. An output with no JSON form
		// (NaN, Infinity, a Map, a cycle) is handled like a throwing resolver.
		return { value: canonicalValue(plan.resolver?.(current, entry.v, entry.b), 'resolver') }
	} catch (error) {
		// A throwing resolver must not wedge the record on every replica. The fold
		// falls back to the incoming (later) value, deterministically, and reports
		// the exception on the field state and in the merge trace.
		return { value: entry.v, error: error instanceof Error ? error.message : String(error) }
	}
}

function resolverFold(
	plan: FieldPlan,
	entries: readonly FieldLogEntry[],
): { value: unknown; error?: string } {
	let value: unknown
	let error: string | undefined
	entries.forEach((entry, index) => {
		if (index === 0) {
			value = entry.v
			return
		}
		const step = resolveStep(plan, value, entry)
		value = step.value
		if (step.error !== undefined) error = step.error
	})
	return error === undefined ? { value } : { value, error }
}

/**
 * Drop every entry older than the newest snapshot entry (`z`): a snapshot stands
 * for the whole history before it, so the log always starts at the newest one.
 */
export function pruneResolverLog(entries: FieldLogEntry[]): FieldLogEntry[] {
	for (let i = entries.length - 1; i > 0; i--) {
		if ((entries[i] as FieldLogEntry).z === 1) return entries.slice(i)
	}
	return entries
}

function resolverState(
	entries: FieldLogEntry[],
	result: { value: unknown; error?: string },
): ResolverFieldState {
	return result.error === undefined
		? { k: 'res', e: entries, val: result.value }
		: { k: 'res', e: entries, val: result.value, err: result.error }
}

function applyResolver(
	state: ResolverFieldState,
	write: FieldWrite,
	plan: FieldPlan,
): FieldApplyResult {
	const index = insertionIndex(state.e, write.s)
	if (index === -1) return { state, changed: false }
	// Older than a snapshot entry: the snapshot already reflects it.
	if (index === 0 && state.e[0]?.z === 1) return { state, changed: false }
	const entry: FieldLogEntry = { s: write.s, v: write.v }
	if (write.insert) entry.b = null
	else if (write.hasPrev) entry.b = write.prev
	if (index === state.e.length) {
		const entries = [...state.e, entry]
		if (state.e.length === 0)
			return { state: resolverState(entries, { value: entry.v }), changed: true }
		const step = resolveStep(plan, state.val, entry)
		const next: ResolverFieldState =
			step.error !== undefined
				? { k: 'res', e: entries, val: step.value, err: step.error }
				: state.err !== undefined
					? { k: 'res', e: entries, val: step.value, err: state.err }
					: { k: 'res', e: entries, val: step.value }
		return {
			state: next,
			changed: true,
			...(step.error !== undefined ? { error: step.error } : {}),
		}
	}
	const entries = [...state.e.slice(0, index), entry, ...state.e.slice(index)]
	const result = resolverFold(plan, entries)
	return { state: resolverState(entries, result), changed: true }
}

// ---------------------------------------------------------------------------
// Element set (arrays)
// ---------------------------------------------------------------------------

function laterShape<T extends { s: Stamp }>(current: T | null, next: T): T | null {
	return current === null || compareStamps(next.s, current.s) > 0 ? next : null
}

function firstAddBefore(a: { s: Stamp; i: number } | null, b: { s: Stamp; i: number }): boolean {
	if (a === null) return true
	const cmp = compareStamps(b.s, a.s)
	return cmp < 0 || (cmp === 0 && b.i < a.i)
}

interface ElementWriter {
	/** Add occurrence `occurrence` of `value`; `index` is its position in the written array. */
	add(value: unknown, occurrence: number, stamp: Stamp, index: number): void
	remove(value: unknown, occurrence: number, stamp: Stamp): void
	/** The (copy-on-write) element map and whether any element changed. */
	result(): { el: Record<string, ElementState>; changed: boolean }
}

/**
 * Identity of one occurrence of an array element: the canonical JSON of the value
 * plus its occurrence number (the k-th copy of that value, from 0). Canonical JSON
 * never ends in `#<digits>`, so the key is unambiguous.
 */
export function elementKey(canonicalValue: string, occurrence: number): string {
	return `${canonicalValue}#${occurrence}`
}

function elementWriter(base: Record<string, ElementState>): ElementWriter {
	let el = base
	let changed = false
	const read = (value: unknown, occurrence: number): [string, ElementState] => {
		const canonical = canonicalKey(value)
		const key = elementKey(canonical, occurrence)
		const existing = el[key]
		return [
			key,
			existing
				? { ...existing }
				: { v: JSON.parse(canonical) as unknown, n: occurrence, a: null, f: null, r: null },
		]
	}
	const store = (key: string, element: ElementState): void => {
		if (el === base) el = { ...base }
		el[key] = element
		changed = true
	}
	return {
		add(value, occurrence, stamp, index) {
			const [key, element] = read(value, occurrence)
			let touched = false
			if (isAfter(stamp, element.a)) {
				element.a = stamp
				touched = true
			}
			const first = { s: stamp, i: index }
			if (firstAddBefore(element.f, first)) {
				element.f = first
				touched = true
			}
			if (touched) store(key, element)
		},
		remove(value, occurrence, stamp) {
			const [key, element] = read(value, occurrence)
			if (isAfter(stamp, element.r)) {
				element.r = stamp
				store(key, element)
			}
		},
		result: () => ({ el, changed }),
	}
}

/** Canonical value -> number of copies in `items`, and each item's occurrence number. */
function countOccurrences(items: readonly unknown[]): {
	counts: Map<string, number>
	occurrences: Array<{ item: unknown; canonical: string; k: number }>
} {
	const counts = new Map<string, number>()
	const occurrences = items.map((item) => {
		const canonical = canonicalKey(item)
		const k = counts.get(canonical) ?? 0
		counts.set(canonical, k + 1)
		return { item, canonical, k }
	})
	return { counts, occurrences }
}

function applyElementSet(state: ElementSetFieldState, write: FieldWrite): FieldApplyResult {
	const writer = elementWriter(state.el)
	let sh = state.sh
	let clr = state.clr
	let changed = false
	const setShape = (arr: boolean, value?: unknown): void => {
		const next = arr ? { s: write.s, arr } : { s: write.s, arr, v: value }
		const later = laterShape(sh, next)
		if (later) {
			sh = later
			changed = true
		}
	}
	const atomic = write.a
	const prev = !write.insert && Array.isArray(write.prev) ? (write.prev as unknown[]) : null
	const atomicElement =
		atomic !== undefined && (atomic.type === 'append' || atomic.type === 'remove')
	if (atomicElement && (prev === null || !Array.isArray(write.v))) {
		// An atomic element op without the writer's array base: append adds (and
		// remove removes) the value's first occurrence.
		setShape(true)
		if (atomic.type === 'append') writer.add(atomic.value, 0, write.s, 0)
		else if (!state.ao) writer.remove(atomic.value, 0, write.s)
	} else if (!Array.isArray(write.v)) {
		setShape(false, write.v)
		const nextClr = maxStamp(clr, write.s)
		if (nextClr !== clr) {
			clr = nextClr
			changed = true
		}
	} else {
		// A multiset difference: the k-th copy of a value is added when the written
		// array holds more than k copies and the writer's base held at most k, and
		// removed in the opposite case. Duplicates are kept.
		setShape(true)
		const next = countOccurrences(write.v)
		const before = prev ? countOccurrences(prev) : null
		next.occurrences.forEach(({ item, canonical, k }, index) => {
			if (k >= (before?.counts.get(canonical) ?? 0)) writer.add(item, k, write.s, index)
		})
		if (before && !state.ao) {
			for (const { item, canonical, k } of before.occurrences) {
				if (k >= (next.counts.get(canonical) ?? 0)) writer.remove(item, k, write.s)
			}
		}
	}
	const elements = writer.result()
	if (!changed && !elements.changed) return { state, changed: false }
	return { state: { k: 'set', ao: state.ao, sh, clr, el: elements.el }, changed: true }
}

function isElementPresent(element: ElementState, state: ElementSetFieldState): boolean {
	if (element.a === null || element.f === null) return false
	if (state.ao) return true
	return isAfter(element.a, element.r) && isAfter(element.a, state.clr)
}

function materializeElementSet(state: ElementSetFieldState): unknown {
	if (state.sh === null) return undefined
	if (!state.sh.arr) return state.sh.v
	const present = Object.entries(state.el).filter(([, element]) => isElementPresent(element, state))
	present.sort(([ka, a], [kb, b]) => {
		const fa = a.f as { s: Stamp; i: number }
		const fb = b.f as { s: Stamp; i: number }
		return compareStamps(fa.s, fb.s) || fa.i - fb.i || (ka < kb ? -1 : ka > kb ? 1 : 0)
	})
	return present.map(([, element]) => element.v)
}

// ---------------------------------------------------------------------------
// Key map (objects, json)
// ---------------------------------------------------------------------------

function applyKeyMap(state: KeyMapFieldState, write: FieldWrite): FieldApplyResult {
	let sh = state.sh
	let clr = state.clr
	let keys = state.keys
	let changed = false
	const setKey = (key: string, next: KeyState): void => {
		const current = keys[key]
		if (current === undefined || compareStamps(next.s, current.s) > 0) {
			if (keys === state.keys) keys = { ...state.keys }
			keys[key] = next
			changed = true
		}
	}
	if (!isPlainObject(write.v)) {
		const later = laterShape(sh, { s: write.s, obj: false, v: write.v })
		if (later) {
			sh = later
			changed = true
		}
		const nextClr = maxStamp(clr, write.s)
		if (nextClr !== clr) {
			clr = nextClr
			changed = true
		}
	} else {
		const later = laterShape(sh, { s: write.s, obj: true })
		if (later) {
			sh = later
			changed = true
		}
		const prev = !write.insert && isPlainObject(write.prev) ? write.prev : null
		for (const [key, value] of Object.entries(write.v)) {
			if (prev && key in prev && canonicalKey(prev[key]) === canonicalKey(value)) continue
			setKey(key, { s: write.s, del: false, v: value })
		}
		if (prev) {
			for (const key of Object.keys(prev)) {
				if (!(key in write.v)) setKey(key, { s: write.s, del: true })
			}
		}
	}
	if (!changed) return { state, changed: false }
	return { state: { k: 'map', sh, clr, keys }, changed: true }
}

function materializeKeyMap(state: KeyMapFieldState): unknown {
	if (state.sh === null) return undefined
	if (!state.sh.obj) return state.sh.v
	const out: Record<string, unknown> = {}
	for (const key of Object.keys(state.keys).sort()) {
		const entry = state.keys[key] as KeyState
		if (entry.del || !isAfter(entry.s, state.clr)) continue
		out[key] = entry.v
	}
	return out
}

// ---------------------------------------------------------------------------
// Counter
// ---------------------------------------------------------------------------

function counterDelta(write: FieldWrite): number | null {
	if (write.a?.type === 'increment' && typeof write.a.value === 'number') return write.a.value
	if (!write.insert && !write.a && typeof write.v === 'number' && typeof write.prev === 'number') {
		return write.v - write.prev
	}
	return null
}

interface Delta {
	s: Stamp
	n: number
}

/** Index of `stamp` in a stamp-sorted delta list, or -1 when already present. */
function deltaIndex(deltas: readonly Delta[], stamp: Stamp): number {
	let lo = 0
	let hi = deltas.length
	while (lo < hi) {
		const mid = (lo + hi) >>> 1
		const cmp = compareStamps((deltas[mid] as Delta).s, stamp)
		if (cmp === 0) return -1
		if (cmp < 0) lo = mid + 1
		else hi = mid
	}
	return lo
}

/**
 * base + deltas, added left to right in stamp order. Floating-point addition is
 * not associative, so every replica must add the same deltas in the same order to
 * get identical bits; the cached `val` is always exactly this sum.
 */
function counterValue(base: { v: unknown } | null, deltas: readonly Delta[]): unknown {
	if (deltas.length === 0) return base?.v
	let sum = typeof base?.v === 'number' ? base.v : 0
	for (const delta of deltas) sum += delta.n
	return sum
}

function counterState(base: CounterFieldState['base'], d: Delta[]): CounterFieldState {
	return { k: 'ctr', base, d, val: counterValue(base, d) }
}

/** Keep only the deltas written after `base` (a base write resets the counter). */
function pruneDeltas(d: readonly Delta[], base: { s: Stamp } | null): Delta[] {
	if (base === null) return [...d]
	return d.filter((delta) => compareStamps(delta.s, base.s) > 0)
}

function applyCounter(state: CounterFieldState, write: FieldWrite): FieldApplyResult {
	const n = counterDelta(write)
	if (n !== null) {
		if (state.base !== null && compareStamps(write.s, state.base.s) < 0) {
			return { state, changed: false }
		}
		const index = deltaIndex(state.d, write.s)
		if (index === -1) return { state, changed: false }
		const delta = { s: write.s, n }
		if (index === state.d.length) {
			const val =
				state.d.length === 0 ? counterValue(state.base, [delta]) : (state.val as number) + n
			return { state: { k: 'ctr', base: state.base, d: [...state.d, delta], val }, changed: true }
		}
		const d = [...state.d.slice(0, index), delta, ...state.d.slice(index)]
		return { state: counterState(state.base, d), changed: true }
	}
	if (state.base !== null && compareStamps(write.s, state.base.s) <= 0) {
		return { state, changed: false }
	}
	const base = { s: write.s, v: write.v }
	return { state: counterState(base, pruneDeltas(state.d, base)), changed: true }
}

function mergeDeltas(a: readonly Delta[], b: readonly Delta[]): Delta[] {
	const out: Delta[] = []
	let i = 0
	let j = 0
	while (i < a.length || j < b.length) {
		const x = a[i]
		const y = b[j]
		if (y === undefined || (x !== undefined && compareStamps(x.s, y.s) < 0)) {
			out.push(x as Delta)
			i++
		} else if (x === undefined || compareStamps(x.s, y.s) > 0) {
			out.push(y)
			j++
		} else {
			out.push(x)
			i++
			j++
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Extremum (max / min)
// ---------------------------------------------------------------------------

function betterExtremum(
	kind: 'max' | 'min',
	current: { s: Stamp; v: number } | null,
	next: { s: Stamp; v: number },
): boolean {
	if (current === null) return true
	if (next.v !== current.v) return kind === 'max' ? next.v > current.v : next.v < current.v
	return compareStamps(next.s, current.s) > 0
}

function applyExtremum(state: ExtremumFieldState, write: FieldWrite): FieldApplyResult {
	if (typeof write.v === 'number' && !Number.isNaN(write.v)) {
		const next = { s: write.s, v: write.v }
		if (!betterExtremum(state.k, state.best, next)) return { state, changed: false }
		return { state: { k: state.k, best: next, reg: state.reg }, changed: true }
	}
	if (state.reg !== null && compareStamps(write.s, state.reg.s) <= 0) {
		return { state, changed: false }
	}
	return { state: { k: state.k, best: state.best, reg: { s: write.s, v: write.v } }, changed: true }
}

// ---------------------------------------------------------------------------
// Richtext
// ---------------------------------------------------------------------------

function decodeRichtext(value: unknown): { reset: unknown } | { update: string } {
	if (value === null || value === undefined) return { reset: null }
	try {
		const decoded = decodeBytesFromOpData(value)
		if (typeof decoded === 'string') return { reset: decoded }
		return { update: bytesToBase64(decoded) }
	} catch {
		// Not a richtext value at all: keep it as a whole-value (reset) write so it
		// is never silently dropped.
		return { reset: value }
	}
}

function applyRichtext(
	state: RichtextFieldState,
	write: FieldWrite,
	subsumes: RichtextSubsumes | undefined,
): FieldApplyResult {
	const decoded = decodeRichtext(write.v)
	if ('reset' in decoded) {
		if (state.reset !== null && compareStamps(write.s, state.reset.s) <= 0) {
			return { state, changed: false }
		}
		return {
			state: { k: 'rt', reset: { s: write.s, v: decoded.reset }, u: state.u },
			changed: true,
		}
	}
	const current = state.u[decoded.update]
	if (current !== undefined && compareStamps(write.s, current) <= 0) {
		return { state, changed: false }
	}
	if (subsumes === undefined) {
		return {
			state: { k: 'rt', reset: state.reset, u: { ...state.u, [decoded.update]: write.s } },
			changed: true,
		}
	}
	// Keep only maximal updates: one whose content another update contains AND whose
	// stamp is not later is redundant (every materialization, before or after any
	// reset, is unchanged without it). The maximal elements of this partial order are
	// a function of the update set, so pruning commutes with merging.
	const incoming = base64ToBytes(decoded.update)
	const u: Record<string, Stamp> = {}
	for (const [update, stamp] of Object.entries(state.u)) {
		if (update === decoded.update) continue
		const bytes = base64ToBytes(update)
		if (compareStamps(write.s, stamp) <= 0 && subsumes(incoming, bytes)) {
			return { state, changed: false }
		}
		if (compareStamps(stamp, write.s) <= 0 && subsumes(bytes, incoming)) continue
		u[update] = stamp
	}
	u[decoded.update] = write.s
	return { state: { k: 'rt', reset: state.reset, u }, changed: true }
}

function materializeRichtext(
	state: RichtextFieldState,
	merger: RichtextUpdateMerger | undefined,
	field: string,
): unknown {
	const live = Object.entries(state.u)
		.filter(([, stamp]) => isAfter(stamp, state.reset?.s ?? null))
		.map(([update]) => update)
		.sort()
	if (live.length === 0) return state.reset ? state.reset.v : undefined
	if (live.length === 1) return { $koraBytes: live[0] }
	if (!merger) {
		throw new FoldConfigurationError(
			`Richtext field "${field}" has ${live.length} concurrent Yjs updates and no richtext merger was given.`,
			{
				field,
				updates: live.length,
				fix: 'Pass { richtext: mergeRichtextUpdates } (from @korajs/merge) in the fold options.',
			},
		)
	}
	return { $koraBytes: bytesToBase64(merger(live.map((update) => base64ToBytes(update)))) }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Apply one write to a field state. Commutative, associative and idempotent per
 * kind: the resulting state depends only on the set of writes applied.
 *
 * @param subsumes - Richtext only: prunes updates another update contains
 *   ({@link FoldOptions.richtextSubsumes})
 */
export function applyFieldWrite(
	state: FieldState,
	write: FieldWrite,
	plan: FieldPlan,
	subsumes?: RichtextSubsumes,
): FieldApplyResult {
	switch (state.k) {
		case 'reg':
			return applyRegister(state, write)
		case 'res':
			return applyResolver(state, write, plan)
		case 'set':
			return applyElementSet(state, write)
		case 'map':
			return applyKeyMap(state, write)
		case 'ctr':
			return applyCounter(state, write)
		case 'max':
		case 'min':
			return applyExtremum(state, write)
		case 'rt':
			return applyRichtext(state, write, subsumes)
	}
}

/**
 * The field's materialized value, or undefined when it has never been written.
 *
 * @param merger - Required only for a richtext field with several live updates
 */
export function materializeField(
	state: FieldState,
	field: string,
	merger?: RichtextUpdateMerger,
): unknown {
	switch (state.k) {
		case 'reg':
		case 'res':
			return state.e.length === 0 ? undefined : state.val
		case 'set':
			return materializeElementSet(state)
		case 'map':
			return materializeKeyMap(state)
		case 'ctr':
			return state.val
		case 'max':
		case 'min':
			return state.best !== null ? state.best.v : state.reg?.v
		case 'rt':
			return materializeRichtext(state, merger, field)
	}
}

/** Newest write that affected the field (its `_field_versions` entry), or null. */
export function fieldStamp(state: FieldState): Stamp | null {
	switch (state.k) {
		case 'reg':
		case 'res':
			return state.e[state.e.length - 1]?.s ?? null
		case 'set': {
			let newest = maxStamp(state.sh?.s ?? null, state.clr)
			for (const element of Object.values(state.el)) {
				newest = maxStamp(maxStamp(newest, element.a), element.r)
			}
			return newest
		}
		case 'map': {
			let newest = maxStamp(state.sh?.s ?? null, state.clr)
			for (const entry of Object.values(state.keys)) newest = maxStamp(newest, entry.s)
			return newest
		}
		case 'ctr': {
			return maxStamp(state.base?.s ?? null, state.d[state.d.length - 1]?.s ?? null)
		}
		case 'max':
		case 'min':
			return maxStamp(state.best?.s ?? null, state.reg?.s ?? null)
		case 'rt': {
			let newest = state.reset?.s ?? null
			for (const stamp of Object.values(state.u)) newest = maxStamp(newest, stamp)
			return newest
		}
	}
}

// ---------------------------------------------------------------------------
// Join (state-based merge of two replicas' states)
// ---------------------------------------------------------------------------

function laterOf<T extends { s: Stamp }>(a: T | null, b: T | null): T | null {
	if (a === null) return b
	if (b === null) return a
	return compareStamps(a.s, b.s) >= 0 ? a : b
}

function joinElements(
	a: Record<string, ElementState>,
	b: Record<string, ElementState>,
): Record<string, ElementState> {
	const out: Record<string, ElementState> = { ...a }
	for (const [key, y] of Object.entries(b)) {
		const x = out[key]
		if (x === undefined) {
			out[key] = y
			continue
		}
		out[key] = {
			v: x.v,
			n: x.n,
			a: maxStamp(x.a, y.a),
			f: y.f !== null && firstAddBefore(x.f, y.f) ? y.f : x.f,
			r: maxStamp(x.r, y.r),
		}
	}
	return out
}

/**
 * Join two states of the same field (the least upper bound of the two). For every
 * kind, `join(fold(A), fold(B)) = fold(A ∪ B)`.
 */
export function joinFieldStates(a: FieldState, b: FieldState, plan: FieldPlan): FieldState {
	if (a.k !== b.k) return a
	switch (a.k) {
		case 'reg': {
			const entries = pruneChain(mergeLogs(a.e, (b as RegisterFieldState).e))
			return { k: 'reg', e: entries, val: chainFold(entries) }
		}
		case 'res': {
			const entries = pruneResolverLog(mergeLogs(a.e, (b as ResolverFieldState).e))
			return resolverState(entries, resolverFold(plan, entries))
		}
		case 'set': {
			const other = b as ElementSetFieldState
			return {
				k: 'set',
				ao: a.ao,
				sh: laterOf(a.sh, other.sh),
				clr: maxStamp(a.clr, other.clr),
				el: joinElements(a.el, other.el),
			}
		}
		case 'map': {
			const other = b as KeyMapFieldState
			const keys: Record<string, KeyState> = { ...a.keys }
			for (const [key, entry] of Object.entries(other.keys)) {
				const current = keys[key]
				if (current === undefined || compareStamps(entry.s, current.s) > 0) keys[key] = entry
			}
			return { k: 'map', sh: laterOf(a.sh, other.sh), clr: maxStamp(a.clr, other.clr), keys }
		}
		case 'ctr': {
			const other = b as CounterFieldState
			const base = laterOf(a.base, other.base)
			return counterState(base, pruneDeltas(mergeDeltas(a.d, other.d), base))
		}
		case 'max':
		case 'min': {
			const other = b as ExtremumFieldState
			let best = a.best
			if (other.best !== null && betterExtremum(a.k, best, other.best)) best = other.best
			return { k: a.k, best, reg: laterOf(a.reg, other.reg) }
		}
		case 'rt': {
			const other = b as RichtextFieldState
			const u: Record<string, Stamp> = { ...a.u }
			for (const [update, stamp] of Object.entries(other.u)) {
				u[update] = maxStamp(u[update] ?? null, stamp) as Stamp
			}
			return { k: 'rt', reset: laterOf(a.reset, other.reset), u }
		}
	}
}
