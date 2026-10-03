/**
 * One deterministic fold (W7, design D3a revised).
 *
 * A record's state is a per-field CRDT. `mergeOp(state, op)` is a join, so the
 * result depends only on the SET of operations merged: not their order, not
 * duplicates, not batching, and not whether the replica is a client, a server
 * store, a restored backup or a compaction snapshot.
 *
 * Total order: every "later wins" below compares stamps = (HLC, op id).
 *
 * Writes. An insert writes every field it carries. An update writes a field only
 * when its value differs from its own previousData (or it carries an atomic op);
 * restating a field unchanged is not a write.
 *
 * Per kind (see `planField` for how the schema selects one):
 * - Scalars ('reg'): LWW register. With atomic ops, the chain since the newest
 *   plain write is kept: a same-type atomic chain composes (increments sum, max of
 *   maxes), any other write takes its resolved value.
 * - Arrays ('set'): occurrence-indexed LWW element multiset. Element identity =
 *   (canonical JSON with sorted keys, occurrence k): the k-th copy of a value.
 *   adds = data − previousData and removes = previousData − data as multisets
 *   (an insert only adds). Present iff newest add > newest remove and > newest
 *   non-array write. Order: first add (stamp, then index in that write). Atomic
 *   append / remove are the same multiset difference against the writer's base
 *   (without an array base: the value's first occurrence). `merge('append-only')`
 *   ignores removals.
 * - `merge('server-authoritative')` ('reg'): a register whose writes by server
 *   nodes carry class 1 and beat every class-0 write regardless of HLC. Order:
 *   (class, HLC, op id). A server node is any node id in the reserved
 *   `kora:server:` namespace, plus `FoldOptions.authoritativeNodeIds` (legacy
 *   random server node ids the server keeps advertising).
 * - Objects / json ('map'): per-top-level-key LWW with removal markers; nested
 *   values are whole-value LWW per key. A non-object write (null, scalar, json
 *   array) replaces the whole value and clears keys written before it.
 * - `merge('counter')` ('ctr'): base (insert / non-numeric write) + every delta
 *   (data − previousData, or the increment) written after it.
 * - `merge('max' | 'min')`: the extremum of every numeric write.
 * - Custom resolvers ('res', tier 3): the field's whole write log folded in stamp
 *   order, `value = resolve(local = merged value so far, remote = write, base =
 *   write's previousData)`; the first write initializes. A throwing resolver falls
 *   back to the write's value (reported on the trace and the state).
 * - Richtext ('rt'): a set of opaque Yjs updates merged by the caller-supplied
 *   merger; a plain-string write is a reset that hides updates written before it.
 *   With `richtextSubsumes`, only maximal updates are kept (an update another one
 *   contains, with a stamp not later, is dropped): same materializations, bounded state.
 * - Record: exists once an insert is merged; live iff newest insert/update >
 *   newest delete. Insert onto an existing row merges per field.
 *
 * Semantic changes versus beta.12/13 (all deliberate; each was non-convergent):
 * 1. Arrays are multisets of elements merged per occurrence (pairwise
 *    add-wins-set gone): duplicates are kept; order is first-add order, not the
 *    writer's order; a removal beats an unchanged copy; for the same occurrence the
 *    later edit wins; two writers that add the same value from the same base add
 *    the same occurrence (one copy, not two); objects inside arrays compare by
 *    canonical JSON (key order ignored).
 * 2. Objects merge per top-level key only; nested objects / arrays inside a key
 *    are whole-value LWW (the pairwise engine recursed and set-merged them).
 * 3. An update that restates a field unchanged no longer wins LWW for it (applies
 *    to scalars too, not only arrays: NEW-MERGE-1's rule made uniform).
 * 4. Custom resolvers see `local` = the merged value so far, in HLC order, rather
 *    than a device's local row; they are called once per write, not once per
 *    concurrent pair. Their output need not be commutative.
 * 5. Insert onto an existing row (or after a delete) merges per field; it no
 *    longer resets fields the insert does not carry (server replay used to).
 * 6. `merge('server-authoritative')`: a write by an authoritative node (the
 *    server, `authoritativeNodeIds` from the handshake) beats any client write of
 *    that field, even a later one; client writes among themselves, and server
 *    writes among themselves, are LWW. With no authoritative node known it is LWW.
 * 7. `merge('counter' | 'max' | 'min' | 'append-only')` are folded over every
 *    write (they were pairwise formulas against one base).
 * 8. Atomic `append` / `remove` on arrays are multiset differences against the
 *    writer's base: appending a value already present adds a copy; `remove`
 *    removes every copy the writer saw.
 * 9. An update to a record with no merged insert does not materialize a row (the
 *    client already behaved this way; the server replay materialized it).
 * 10. A server scope-entry insert that carries the record's fold state
 *    (`op.foldState`) is joined into the local state instead of merged as one
 *    insert, so richtext, counters, resolvers and element sets enter with their
 *    merge state (RT-29). Without it (older servers) `fieldVersions` still apply.
 * 11. Schema transforms run at fold time (RT-84): an operation of another schema
 *    version is merged as its `operationSchemaView` (`FoldOptions.transforms`), and
 *    is stored and synced exactly as written. A transform never rewrites a stored
 *    operation, so its id stays the hash of its content on every replica.
 * Delete vs update is unchanged: the later of the newest delete and the newest
 * write decides; a revived record shows every field's merged value.
 */
import { operationSchemaView } from '../migration/operation-view'
import type { CollectionDefinition, HLCTimestamp, Operation, SchemaDefinition } from '../types'
import { isAuthoritativeNodeId } from './authority'
import { FoldConfigurationError, FoldStateError } from './errors'
import { type FieldPlan, planField } from './field-kind'
import {
	type FieldWrite,
	applyFieldWrite,
	emptyField,
	fieldStamp,
	joinFieldStates,
	materializeField,
} from './field-states'
import { deserializeFoldState, serializeFoldState } from './serialize'
import { compareStamps, isAfter, maxStamp, minStamp, stampOf, stampTimestamp } from './stamp'
import {
	FOLD_STATE_VERSION,
	type FieldState,
	type FoldFieldVersions,
	type FoldOptions,
	type FoldRecordResult,
	type FoldState,
	type FoldTrace,
	type MergeOpResult,
	type Stamp,
} from './types'
import { canonicalKey, normalizeValue } from './values'

/** `FoldTrace.field` of a record-level (delete vs write) decision. */
export const FOLD_RECORD_TRACE_FIELD = '*'

/** Written into traces in place of a secret field's value. */
const SECRET_REDACTED = '[secret]'

/**
 * An empty fold state for one record: no operation merged yet.
 *
 * @param collection - The record's collection
 * @param recordId - The record's id
 */
export function createFoldState(collection: string, recordId: string): FoldState {
	return {
		v: FOLD_STATE_VERSION,
		c: collection,
		r: recordId,
		cr: null,
		w: null,
		d: null,
		u: null,
		f: {},
	}
}

function isExcluded(op: Operation, exclude: FoldOptions['exclude']): boolean {
	if (exclude === undefined) return false
	return typeof exclude === 'function' ? exclude(op) : exclude.has(op.id)
}

function samePlanKind(state: FieldState, plan: FieldPlan): boolean {
	if (state.k !== plan.kind) return false
	return state.k !== 'set' || state.ao === plan.appendOnly
}

function fieldPlanFor(
	collection: CollectionDefinition | undefined,
	field: string,
	existing: FieldState | undefined,
	state: FoldState,
): FieldPlan {
	const plan = planField(collection, field)
	if (existing !== undefined && !samePlanKind(existing, plan)) {
		throw new FoldStateError(
			`Field "${field}" of ${state.c}/${state.r} is stored as fold kind "${existing.k}" but the schema now folds it as "${plan.kind}".`,
			{ collection: state.c, recordId: state.r, field, stored: existing.k, expected: plan.kind },
		)
	}
	return plan
}

/**
 * The stamp of one field of an insert. A server-synthesized scope-entry insert
 * (RT-27) restates the record's current values, each produced at its own version
 * (`op.fieldVersions`): the field is stamped at exactly that version (tie-broken by
 * the entry's id), so it lands where its original writer did, never later. Raising
 * it to the entry's own timestamp (which a beta.12 server sets to the record's
 * newest write) would let the restated value beat a device's concurrent edit that
 * is newer than the field's real version (RT-67).
 *
 * A field the entry carries without a version (a column no write ever produced,
 * e.g. a later schema default) is as old as the record: it is stamped at the
 * oldest version the entry knows, the earlier of its own timestamp and its oldest
 * field version. An entry with no versions at all (a custom server store that
 * provides neither per-field versions nor a fold state) can only be stamped at its
 * own timestamp; built-in stores always send versions or a fold state.
 */
function fieldWriteStamp(op: Operation, field: string, opStamp: Stamp): Stamp {
	if (op.type !== 'insert' || op.fieldVersions === undefined) return opStamp
	const version: HLCTimestamp | undefined = op.fieldVersions[field]
	if (version !== undefined) return stampOf(version, op.id)
	let oldest = opStamp
	for (const candidate of Object.values(op.fieldVersions)) {
		const stamp = stampOf(candidate, op.id)
		if (compareStamps(stamp, oldest) < 0) oldest = stamp
	}
	return oldest
}

/**
 * A write to a `merge('server-authoritative')` field by an authoritative node (a
 * `kora:server:` node, or one of `FoldOptions.authoritativeNodeIds`) gets authority
 * class 1, which orders before the HLC (see {@link Stamp}).
 */
function classify(
	stamp: Stamp,
	op: Operation,
	field: string,
	plan: FieldPlan,
	options: FoldOptions,
): Stamp {
	if (!plan.authoritative) return stamp
	// A scope entry restates the value of the write that produced it: that write's
	// node (the version's node id) decides the class, not the entry's system node.
	const author = op.type === 'insert' ? (op.fieldVersions?.[field]?.nodeId ?? op.nodeId) : op.nodeId
	if (isAuthoritativeNodeId(author, options.authoritativeNodeIds)) {
		return { ...stamp, c: 1 }
	}
	return stamp
}

/**
 * Merge a server scope-entry operation that carries the record's serialized fold
 * state (`op.foldState`): a state-based join. Returns null when the carried state
 * cannot be read (another format version) or holds a field of another fold kind
 * than this replica's schema: the caller then merges the operation's data like any
 * insert (each field at its `fieldVersions` entry), as for an older server.
 */
function mergeCarriedState(
	state: FoldState,
	op: Operation,
	schema: SchemaDefinition,
	options: FoldOptions,
): MergeOpResult | null {
	let carried: FoldState
	try {
		carried = deserializeFoldState(op.foldState as string)
	} catch (error) {
		if (error instanceof FoldStateError) return null
		throw error
	}
	if (carried.c !== state.c || carried.r !== state.r) {
		throw new FoldStateError(
			`Operation ${op.id} carries the fold state of ${carried.c}/${carried.r} but targets ${state.c}/${state.r}.`,
			{ operationId: op.id, collection: op.collection, recordId: op.recordId },
		)
	}
	let joined: FoldState
	try {
		joined = joinStates(state, carried, schema)
	} catch (error) {
		// The server folded a field under another plan (its schema differs from this
		// replica's, e.g. mid-rollout of a merge-kind change): its state cannot be
		// joined field by field, so the entry merges by its data and versions instead,
		// like one from an older server (RT-63). A function of the op and the schema
		// only, so every replica decides the same.
		if (error instanceof FoldStateError) return null
		throw error
	}
	const changed = serializeFoldState(joined) !== serializeFoldState(state)
	const traces: FoldTrace[] = []
	if ((options.traces ?? 'conflicts') !== 'none') {
		// One trace per field where this replica's value and the server's differed:
		// the join's per-field decision, for DevTools (RT-29).
		const collection = schema.collections[state.c]
		for (const [field, incomingState] of Object.entries(carried.f)) {
			const mine = state.f[field]
			if (mine === undefined) continue
			const prior = safeMaterializeField(mine, field, options)
			const incoming = safeMaterializeField(incomingState, field, options)
			if (canonicalKey(prior) === canonicalKey(incoming)) continue
			const plan = planField(collection, field)
			const output = safeMaterializeField(joined.f[field], field, options)
			const redact = (value: unknown): unknown => (plan.secret ? SECRET_REDACTED : value)
			traces.push({
				field,
				strategy: `scope-entry-${plan.strategy}`,
				inputA: redact(prior),
				inputB: redact(incoming),
				base: null,
				output: redact(output),
				tier: plan.tier,
				constraintViolated: null,
				duration: 0,
				operation: plan.secret ? redactOperation(op, field) : op,
				priorOperationId: fieldStamp(mine)?.o ?? null,
				conflict: true,
			})
		}
	}
	return { state: changed ? joined : state, traces, changed }
}

/**
 * Build the field write an operation makes, or null when it makes none: the field
 * is absent/undefined, or an update restated it unchanged (its value equals its
 * own `previousData`). An unchanged restatement is not a write: it never overrides
 * a concurrent change, never re-adds a removed element and never resets an atomic
 * chain.
 */
function buildWrite(op: Operation, field: string, raw: unknown, stamp: Stamp): FieldWrite | null {
	if (raw === undefined) return null
	const insert = op.type === 'insert'
	const v = normalizeValue(raw)
	const atomic = op.atomicOps?.[field]
	const a = atomic ? { type: atomic.type, value: normalizeValue(atomic.value) } : undefined
	const prevRaw = insert ? undefined : op.previousData?.[field]
	const hasPrev =
		!insert && op.previousData !== null && field in op.previousData && prevRaw !== undefined
	const prev = hasPrev ? normalizeValue(prevRaw) : undefined
	if (!insert && a === undefined && hasPrev && canonicalKey(prev) === canonicalKey(v)) return null
	return a ? { s: stamp, insert, v, prev, hasPrev, a } : { s: stamp, insert, v, prev, hasPrev }
}

function safeMaterializeField(
	state: FieldState | undefined,
	field: string,
	options: FoldOptions,
): unknown {
	if (state === undefined) return undefined
	try {
		return materializeField(state, field, options.richtext)
	} catch (error) {
		if (error instanceof FoldConfigurationError) return undefined
		throw error
	}
}

function redactOperation(op: Operation, field: string): Operation {
	const redact = (data: Record<string, unknown> | null): Record<string, unknown> | null =>
		data !== null && field in data ? { ...data, [field]: SECRET_REDACTED } : data
	return { ...op, data: redact(op.data), previousData: redact(op.previousData) }
}

function fieldTrace(
	op: Operation,
	field: string,
	plan: FieldPlan,
	write: FieldWrite,
	prior: unknown,
	priorStamp: Stamp | null,
	output: unknown,
	newest: Stamp | null,
	error: string | undefined,
): FoldTrace {
	const lost = newest !== null && compareStamps(newest, write.s) > 0
	const baseMismatch =
		prior !== undefined && !write.insert && canonicalKey(prior) !== canonicalKey(write.prev)
	const insertOnto = write.insert && prior !== undefined
	const strategy = plan.kind === 'reg' && write.a ? `atomic-${write.a.type}` : plan.strategy
	const trace: FoldTrace = {
		field,
		strategy,
		inputA: plan.secret ? SECRET_REDACTED : prior,
		inputB: plan.secret ? SECRET_REDACTED : write.v,
		base: write.hasPrev ? (plan.secret ? SECRET_REDACTED : write.prev) : null,
		output: plan.secret ? SECRET_REDACTED : output,
		tier: plan.tier,
		constraintViolated: null,
		// The fold is pure: callers time the whole mergeOp if they need a duration.
		duration: 0,
		operation: plan.secret ? redactOperation(op, field) : op,
		priorOperationId: priorStamp?.o ?? null,
		conflict: lost || baseMismatch || insertOnto,
	}
	if (error !== undefined) trace.error = error
	return trace
}

function isAlive(state: FoldState): boolean {
	return state.cr !== null && isAfter(state.w, state.d)
}

/**
 * Merge one operation into a record's fold state.
 *
 * The merge is a join on a per-field CRDT, so it is commutative, associative and
 * idempotent: any replica that has merged the same set of operations, in any
 * order, any number of times, holds an identical state. Cost is O(fields the
 * operation touches) except for the out-of-order cases documented per kind (a late
 * write into an atomic or resolver chain refolds that field's chain).
 *
 * Record-level semantics:
 * - The record exists once an insert has been merged.
 * - Delete vs write is last-write-wins on the record: the record is live iff its
 *   newest insert/update is later (HLC, then op id) than its newest delete. A
 *   delete keeps the field states; a later write revives the record with every
 *   field's merged value (the same visible result as the pre-W7 replay for an
 *   update after a delete).
 * - An insert onto an existing row merges per field; it is not a reset.
 *
 * @param state - The record's current state (not mutated)
 * @param op - The operation (must belong to the same collection and record)
 * @param schema - The schema; resolvers and merge strategies come from it
 * @param options - Exclusion, richtext merger (traces only), trace mode, schema
 *   transforms (the operation is merged as `operationSchemaView` reads it for
 *   `schema.version`)
 * @returns The new state, the merge traces, and whether anything changed
 */
export function mergeOp(
	state: FoldState,
	input: Operation,
	schema: SchemaDefinition,
	options: FoldOptions = {},
): MergeOpResult {
	if (isExcluded(input, options.exclude)) return { state, traces: [], changed: false }
	// Transforms at fold time (RT-84, RT-85): the operation is stored exactly as its
	// author wrote it, and folded as the schema reads it. A transform that drops the
	// operation leaves it out of the fold, like an excluded one.
	// The beta.12 clear rule is NOT applied here: a genuine beta.12 body is made
	// canonical once, where its provenance is known (server ingest, a device's own
	// log at the upgrade), so a body a transform or anything else rewrote is never
	// mistaken for one (RT-85).
	const op = operationSchemaView(input, schema.version, options.transforms)
	if (op === null) return { state, traces: [], changed: false }
	if (op.collection !== state.c || op.recordId !== state.r) {
		throw new FoldStateError(
			`Operation ${op.id} targets ${op.collection}/${op.recordId} but the fold state is for ${state.c}/${state.r}.`,
			{ operationId: op.id, collection: op.collection, recordId: op.recordId },
		)
	}
	if (op.foldState !== undefined && op.type === 'insert') {
		const carried = mergeCarriedState(state, op, schema, options)
		if (carried !== null) return carried
	}
	const mode = options.traces ?? 'conflicts'
	const traces: FoldTrace[] = []
	const stamp = stampOf(op.timestamp, op.id)
	const next: FoldState = { ...state }
	let changed = false
	const setRecordStamp = (key: 'cr' | 'w' | 'd' | 'u', value: Stamp | null): void => {
		if (value !== next[key]) {
			next[key] = value
			changed = true
		}
	}

	setRecordStamp('u', maxStamp(state.u, stamp))
	if (op.type === 'delete') {
		setRecordStamp('d', maxStamp(state.d, stamp))
		if (mode !== 'none' && state.cr !== null && isAfter(state.w, stamp)) {
			traces.push(recordTrace(op, true, true))
		}
		return { state: changed ? next : state, traces, changed }
	}
	if (op.data === null) {
		// An envelope operation (protocol v2) whose every field is sealed: the server
		// cannot read its values, but the write happened. It creates the record (an
		// insert) and counts as a write against deletes, so the server's record
		// existence agrees with the devices' (which fold the decrypted operation).
		if (op.encrypted !== undefined) {
			if (op.type === 'insert') setRecordStamp('cr', minStamp(state.cr, stamp))
			setRecordStamp('w', maxStamp(state.w, stamp))
		}
		return { state: changed ? next : state, traces, changed }
	}

	if (op.type === 'insert') setRecordStamp('cr', minStamp(state.cr, stamp))
	setRecordStamp('w', maxStamp(state.w, stamp))
	if (mode !== 'none' && isAfter(state.d, stamp)) traces.push(recordTrace(op, false, false))

	const collection = schema.collections[op.collection]
	let fields = state.f
	for (const [field, raw] of Object.entries(op.data)) {
		if (raw === undefined) continue
		const existing = fields[field]
		const plan = fieldPlanFor(collection, field, existing, state)
		const write = buildWrite(
			op,
			field,
			raw,
			classify(fieldWriteStamp(op, field, stamp), op, field, plan, options),
		)
		if (write === null) continue
		const tracing = mode !== 'none'
		const prior = tracing ? safeMaterializeField(existing, field, options) : undefined
		const priorStamp = existing ? fieldStamp(existing) : null
		const result = applyFieldWrite(
			existing ?? emptyField(plan),
			write,
			plan,
			options.richtextSubsumes,
		)
		if (result.changed) {
			if (fields === state.f) fields = { ...state.f }
			fields[field] = result.state
			changed = true
		}
		// A write that changed nothing can still be a conflict: it lost to a newer one.
		if (tracing) {
			const trace = fieldTrace(
				op,
				field,
				plan,
				write,
				prior,
				priorStamp,
				safeMaterializeField(result.state, field, options),
				fieldStamp(result.state),
				result.error,
			)
			if (mode === 'all' || trace.conflict || trace.error !== undefined) traces.push(trace)
		}
	}
	next.f = fields
	return { state: changed ? next : state, traces, changed }
}

function recordTrace(op: Operation, isDelete: boolean, lost: boolean): FoldTrace {
	return {
		field: FOLD_RECORD_TRACE_FIELD,
		strategy: 'delete-tombstone-lww',
		inputA: isDelete ? 'live' : 'deleted',
		inputB: isDelete ? 'deleted' : 'live',
		base: null,
		// A delete that lost keeps the record live; a write older than the newest
		// delete stays hidden.
		output: isDelete ? (lost ? 'live' : 'deleted') : 'deleted',
		tier: 1,
		constraintViolated: null,
		duration: 0,
		operation: op,
		priorOperationId: null,
		conflict: true,
	}
}

/**
 * Fold a record's operations from scratch: the reference definition of the
 * record's state. Equal to merging the operations one by one with
 * {@link mergeOp} in any order.
 *
 * @param ops - The record's operations, in any order, duplicates allowed
 * @param schema - The schema
 * @param options - `exclude` leaves out ops the server terminally rejected; traces
 *   default to `'none'` here (pass `traces` to get them)
 * @returns The state (null if no op remains after exclusion) and the traces
 */
export function foldRecord(
	ops: readonly Operation[],
	schema: SchemaDefinition,
	options: FoldOptions = {},
): FoldRecordResult {
	const kept = ops.filter((op) => !isExcluded(op, options.exclude))
	const first = kept[0]
	if (first === undefined) return { state: null, traces: [] }
	// Merging in stamp order makes every register write an O(1) append.
	const ordered = kept
		.map((op) => ({ op, stamp: stampOf(op.timestamp, op.id) }))
		.sort((a, b) => compareStamps(a.stamp, b.stamp))
	let state = createFoldState(first.collection, first.recordId)
	const traces: FoldTrace[] = []
	// A from-scratch fold (re-materialization, rejection re-merge) is not a new merge
	// decision, so it emits no traces unless asked to.
	const mergeOptions: FoldOptions = {
		...options,
		exclude: undefined,
		traces: options.traces ?? 'none',
	}
	for (const { op } of ordered) {
		const result = mergeOp(state, op, schema, mergeOptions)
		state = result.state
		traces.push(...result.traces)
	}
	return { state, traces }
}

/**
 * The record's materialized field values (without `id`), or null when it does not
 * exist (no insert merged) or is deleted. Keys are in sorted order.
 *
 * @param state - The record's fold state
 * @param options - `richtext` is required when a richtext field has concurrent updates
 */
export function materialize(
	state: FoldState,
	options: Pick<FoldOptions, 'richtext'> = {},
): Record<string, unknown> | null {
	if (!isAlive(state)) return null
	const record: Record<string, unknown> = {}
	for (const field of Object.keys(state.f).sort()) {
		const value = materializeField(state.f[field] as FieldState, field, options.richtext)
		if (value !== undefined) record[field] = value
	}
	return record
}

/** True when the record exists and its newest write is later than its newest delete. */
export function isFoldStateLive(state: FoldState): boolean {
	return isAlive(state)
}

/**
 * Join two replicas' states of the same record (state-based CRDT merge):
 * `joinStates(foldRecord(A).state, foldRecord(B).state) = foldRecord(A ∪ B).state`.
 * Commutative, associative and idempotent. Used to merge a restored backup or a
 * peer's snapshot without replaying its operations.
 *
 * @param a - One state
 * @param b - The other state (same collection and record)
 * @param schema - The schema (resolver fields refold through their resolver)
 */
export function joinStates(a: FoldState, b: FoldState, schema: SchemaDefinition): FoldState {
	if (a.c !== b.c || a.r !== b.r) {
		throw new FoldStateError(`Cannot join fold states of ${a.c}/${a.r} and ${b.c}/${b.r}.`, {
			left: `${a.c}/${a.r}`,
			right: `${b.c}/${b.r}`,
		})
	}
	const collection = schema.collections[a.c]
	const fields: Record<string, FieldState> = { ...a.f }
	for (const [field, other] of Object.entries(b.f)) {
		const mine = fields[field]
		if (mine === undefined) {
			fieldPlanFor(collection, field, other, b)
			fields[field] = other
			continue
		}
		const plan = fieldPlanFor(collection, field, mine, a)
		fieldPlanFor(collection, field, other, b)
		fields[field] = joinFieldStates(mine, other, plan)
	}
	return {
		v: FOLD_STATE_VERSION,
		c: a.c,
		r: a.r,
		cr: minStamp(a.cr, b.cr),
		w: maxStamp(a.w, b.w),
		d: maxStamp(a.d, b.d),
		u: maxStamp(a.u, b.u),
		f: fields,
	}
}

/**
 * Each field's newest affecting write as a serialized HLC (`HybridLogicalClock.
 * serialize`), regardless of liveness: the `_field_versions` column of a stored row,
 * without a deserialize/serialize round trip. Keys in sorted order.
 */
export function getFoldFieldVersionStrings(state: FoldState): Record<string, string> {
	const out: Record<string, string> = {}
	for (const field of Object.keys(state.f).sort()) {
		const stamp = fieldStamp(state.f[field] as FieldState)
		if (stamp !== null) out[field] = stamp.t
	}
	return out
}

/**
 * Per-field versions of a live record (the fold's `_field_versions`): each field's
 * newest affecting write, plus the record's creation and newest operation. null
 * when the record is not live.
 */
export function getFoldFieldVersions(state: FoldState): FoldFieldVersions | null {
	if (!isAlive(state) || state.cr === null || state.u === null) return null
	const fields: Record<string, HLCTimestamp> = {}
	for (const [field, fieldState] of Object.entries(state.f)) {
		const stamp = fieldStamp(fieldState)
		if (stamp !== null) fields[field] = stampTimestamp(stamp)
	}
	return { fields, created: stampTimestamp(state.cr), latest: stampTimestamp(state.u) }
}
