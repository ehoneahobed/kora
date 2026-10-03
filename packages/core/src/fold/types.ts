import type { MergeTrace } from '../events/events'
import type { AtomicOp, HLCTimestamp, Operation } from '../types'

/**
 * Version of the serialized fold-state format ({@link FoldState}). Bumped on any
 * change to the on-disk shape. A reader that sees a different version must refuse
 * the state and re-fold the record from its operation log.
 */
export const FOLD_STATE_VERSION = 2

/**
 * A write's position in the record's total order: the operation's HLC timestamp
 * (serialized, so it compares as a plain string exactly like
 * `HybridLogicalClock.compare`), then the operation id as a tie-breaker. Two
 * distinct operations never share a stamp, even when a buggy or forged node reuses
 * an HLC, so every "latest wins" comparison in the fold is a strict total order.
 *
 * A write to a `merge('server-authoritative')` field by an authoritative node
 * ({@link FoldOptions.authoritativeNodeIds}) carries class `c: 1`, which orders
 * before the HLC: the order is lexicographic on (class, HLC, op id).
 */
export interface Stamp {
	/** `HybridLogicalClock.serialize(timestamp)` of the writing operation (or field version). */
	t: string
	/** Id of the writing operation. */
	o: string
	/** Authority class (1 = authoritative write). Absent means 0. */
	c?: 1
}

/**
 * One write in a field's embedded log ({@link RegisterFieldState},
 * {@link ResolverFieldState}).
 */
export interface FieldLogEntry {
	/** Position of the write in the total order. */
	s: Stamp
	/** The written value (for atomic writes, the author's resolved value). */
	v: unknown
	/** Atomic intent, when the write was `op.increment()`, `op.max()`, ... */
	a?: AtomicOp
	/** For resolver fields: the writer's base (`previousData[field]`), null for inserts. */
	b?: unknown
	/**
	 * Resolver fields only: a snapshot entry ({@link createSnapshotState}). It resets
	 * the value without calling the resolver, and every older entry is pruned.
	 */
	z?: 1
}

/**
 * Scalar fields (string, number, boolean, enum, timestamp, blob, secret, and any
 * field declared `merge('lww')` or `merge('server-authoritative')`): a last-write-
 * wins register generalized to the atomic-op chain.
 *
 * `e` holds the writes since (and including) the newest plain write, sorted by
 * stamp. A plain write resets the field unconditionally, so everything older is
 * irrelevant and is pruned. With no atomic writes `e` has exactly one entry: an
 * LWW register. With atomic writes `e` is the chain the value is folded from (a
 * same-type atomic chain composes; any other write takes its resolved value).
 */
export interface RegisterFieldState {
	k: 'reg'
	e: FieldLogEntry[]
	/** Cached `chainFold(e)`. Always equal to it; stored so materialization is O(1). */
	val: unknown
}

/** One element occurrence of an {@link ElementSetFieldState}. */
export interface ElementState {
	/** The element value (canonical JSON parsed back, so key order is normalized). */
	v: unknown
	/** Occurrence number: this is the n-th copy (from 0) of the value in the array. */
	n: number
	/** Newest add. */
	a: Stamp | null
	/** Oldest add plus the element's index in that write (its position in the array). */
	f: { s: Stamp; i: number } | null
	/** Newest removal. */
	r: Stamp | null
}

/**
 * Array fields: an LWW element set. Each element (identified by its canonical JSON)
 * carries its newest add and newest removal; it is present iff its newest add is
 * later than its newest removal and later than the newest write that replaced the
 * whole array with a non-array (`clr`). Order is by first add.
 */
export interface ElementSetFieldState {
	k: 'set'
	/** Append-only (`merge('append-only')`): removals are ignored. */
	ao: boolean
	/** Whole-value shape register: is the field an array, or a non-array value (e.g. null)? */
	sh: { s: Stamp; arr: boolean; v?: unknown } | null
	/** Newest write that set the field to a non-array value: elements added before it are cleared. */
	clr: Stamp | null
	/** Elements keyed by canonical JSON. */
	el: Record<string, ElementState>
}

/** One top-level key of a {@link KeyMapFieldState}. */
export interface KeyState {
	s: Stamp
	/** true = removal marker. */
	del: boolean
	v?: unknown
}

/**
 * Object and json fields: per-top-level-key LWW registers with removal markers.
 * Nested values are whole-value LWW per top-level key. A write that replaces the
 * whole value with a non-object (null, a scalar, a json array) is a shape write;
 * keys written before the newest such write are cleared.
 */
export interface KeyMapFieldState {
	k: 'map'
	sh: { s: Stamp; obj: boolean; v?: unknown } | null
	clr: Stamp | null
	keys: Record<string, KeyState>
}

/**
 * `merge('counter')` fields: a base register (inserts and non-numeric writes) plus
 * the deltas written after it. Value = base + sum of deltas in stamp order.
 */
export interface CounterFieldState {
	k: 'ctr'
	base: { s: Stamp; v: unknown } | null
	/** Deltas written after `base`, sorted by stamp (older ones are pruned). */
	d: Array<{ s: Stamp; n: number }>
	/** Cached base + deltas, summed left to right in stamp order. */
	val: unknown
}

/** `merge('max')` / `merge('min')` fields: the extremum of every numeric write. */
export interface ExtremumFieldState {
	k: 'max' | 'min'
	best: { s: Stamp; v: number } | null
	/** LWW register over non-numeric writes, used only while no numeric write exists. */
	reg: { s: Stamp; v: unknown } | null
}

/**
 * Fields with a custom resolver (tier 3): the full write log in stamp order and
 * the value folded through the resolver (`local` = the merged value so far).
 */
export interface ResolverFieldState {
	k: 'res'
	e: FieldLogEntry[]
	val: unknown
	/** Message of the newest resolver exception (the fold fell back to LWW there), if any. */
	err?: string
}

/**
 * Richtext fields: a set of opaque Yjs updates (base64) plus a reset register for
 * plain-string (whole-value) writes. Updates written before the newest reset are
 * hidden.
 */
export interface RichtextFieldState {
	k: 'rt'
	reset: { s: Stamp; v: unknown } | null
	/** base64 Yjs update -> newest stamp that wrote it. */
	u: Record<string, Stamp>
}

/** Per-field merge state. Every variant is a state-based CRDT (join-semilattice). */
export type FieldState =
	| RegisterFieldState
	| ElementSetFieldState
	| KeyMapFieldState
	| CounterFieldState
	| ExtremumFieldState
	| ResolverFieldState
	| RichtextFieldState

/** The kind tag of a {@link FieldState}. */
export type FoldFieldKind = FieldState['k']

/**
 * The merge state of one record: the snapshot every replica (client store, server
 * stores, backup restore, compaction) persists. It is a pure function of the set of
 * operations merged into it, so two replicas holding the same operations hold an
 * identical state, whatever order they arrived in.
 *
 * Serialized with {@link serializeFoldState}; see that function for the on-disk
 * format.
 */
export interface FoldState {
	/** Format version, {@link FOLD_STATE_VERSION}. */
	v: number
	/** Collection of the record. */
	c: string
	/** Record id. */
	r: string
	/** Oldest insert (the record's creation). null until an insert is merged. */
	cr: Stamp | null
	/** Newest insert or update (any write keeps the record alive). */
	w: Stamp | null
	/** Newest delete (the tombstone register). */
	d: Stamp | null
	/** Newest operation of any type. */
	u: Stamp | null
	/** Per-field states. */
	f: Record<string, FieldState>
}

/** Merges the opaque Yjs updates of a richtext field into one update. */
export type RichtextUpdateMerger = (updates: Uint8Array[]) => Uint8Array

/** True when update `a`'s content is contained in update `b`'s (a adds nothing to b). */
export type RichtextSubsumes = (a: Uint8Array, b: Uint8Array) => boolean

/** Which merge traces {@link mergeOp} emits. */
export type FoldTraceMode = 'conflicts' | 'all' | 'none'

/** Options shared by the fold entry points. */
export interface FoldOptions {
	/**
	 * Operations to leave out: the server terminally rejected them (or they are
	 * otherwise known never to have been stored). Ids, or a predicate.
	 */
	exclude?: ReadonlySet<string> | ((op: Operation) => boolean)
	/**
	 * Merges richtext Yjs updates. Required to materialize a richtext field with
	 * more than one live update (pass `mergeRichtextUpdates` from `@korajs/merge`).
	 * Core has no Yjs dependency, so it cannot supply one itself.
	 */
	richtext?: RichtextUpdateMerger
	/**
	 * Optional richtext space bound: when given, an update whose content another
	 * update of the field contains, and whose stamp is not later, is dropped (it can
	 * never change a materialization). Devices persist a full Yjs snapshot per edit,
	 * so without it a field's state keeps every snapshot. Materializations are the
	 * same with or without it; every replica of one database must use the same setting
	 * for its serialized states to be byte-identical.
	 */
	richtextSubsumes?: RichtextSubsumes
	/** Which traces to emit. Default `'conflicts'`. */
	traces?: FoldTraceMode
	/**
	 * Additional node ids whose writes are authoritative for
	 * `merge('server-authoritative')` fields: legacy (randomly generated) server node
	 * ids the server keeps advertising at the handshake. Every node id in the reserved
	 * `kora:server:` namespace is authoritative without being listed. Authoritative
	 * writes beat every non-authoritative write of such a field regardless of HLC;
	 * within a class the later write wins. Every replica must fold with the same set.
	 */
	authoritativeNodeIds?: ReadonlySet<string>
}

/**
 * A per-field merge decision made by {@link mergeOp}. It carries every
 * {@link MergeTrace} field except `operationA`: the fold state keeps only the id of
 * the operation that produced the prior value (`priorOperationId`), so the caller,
 * which owns the operation log, turns it into a `MergeTrace` with
 * {@link toMergeTrace}.
 */
export interface FoldTrace extends Omit<MergeTrace, 'operationA' | 'operationB'> {
	/** The operation being merged (`MergeTrace.operationB`). */
	operation: Operation
	/** Id of the operation that last wrote the field before this merge, or null. */
	priorOperationId: string | null
	/**
	 * True when the incoming write was concurrent with the field's prior value (the
	 * writer's base differs from it, or the write lost to a newer one).
	 */
	conflict: boolean
	/** Set when a custom resolver threw: the fold fell back to last-write-wins. */
	error?: string
}

/** The result of merging one operation. */
export interface MergeOpResult {
	state: FoldState
	traces: FoldTrace[]
	/** False when the operation changed nothing (a duplicate, an excluded op, a no-op write). */
	changed: boolean
}

/** The result of folding a set of operations from scratch. */
export interface FoldRecordResult {
	/** null when no (non-excluded) operation was given. */
	state: FoldState | null
	traces: FoldTrace[]
}

/** Per-field versions of a live record, the fold's equivalent of `_field_versions`. */
export interface FoldFieldVersions {
	/** Field name -> HLC of the newest write that affected the field. */
	fields: Record<string, HLCTimestamp>
	/** HLC of the record's creation (oldest insert). */
	created: HLCTimestamp
	/** HLC of the newest operation of any type. */
	latest: HLCTimestamp
}
