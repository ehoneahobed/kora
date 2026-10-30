import type {
	CollectionDefinition,
	FieldDescriptor,
	FoldState,
	Operation,
	SchemaDefinition,
} from '@korajs/core'
import { createFoldState, isAtomicOp, materialize, mergeOp } from '@korajs/core'
import { predictLocalUpdate } from '@korajs/core/internal'
import { mergeYjsUpdates } from '../fold/record-folder'
import type { RecordFolder } from '../fold/record-folder'
import type { WriteEnv } from '../mutations/write-context'
import {
	type PreparedInsert,
	insertOperationData,
	patchForUpdate,
	tombstone,
} from '../mutations/write-shapes'
import { deserializeRecord, serializeRecord } from '../serialization/serializer'
import { validateUpdateStateMachine } from '../state-machine/state-validator'
import type { CollectionRecord, RawCollectionRow } from '../types'

/*
 * The overlay predictor (instant-UI stage S2, docs/design/instant-ui-updates.md 5.2 and 5.3).
 *
 * Given the SAME validated input the write path is about to write, compute the record
 * the committed row will read back as. Pure: no storage, no clock (the caller passes the
 * wall time to predict), no registration. Anything the predictor cannot prove it gets
 * exactly right is a miss with a reason (an allowlist, invariant I7), and a miss means
 * the write runs exactly as it does today.
 *
 * The predicted record is produced by the read-side functions, `serializeRecord` then
 * `deserializeRecord` (5.3b), so its shape (absent optionals are `null`, booleans are
 * booleans, ...) is the shape a `SELECT` row has, not the shape `insert()` returns.
 */

/** Why a write was not predicted. Stable strings: they are reported to DevTools. */
export type MissReason =
	| 'secret-field'
	| 'richtext-field'
	| 'unsupported-field-kind'
	| 'atomic-op'
	| 'merge-strategy'
	| 'custom-resolver'
	| 'state-machine'
	| 'cascade-target'
	| 'no-base'
	| 'base-timeout'
	/** An array is written and the record's fold state could not be had (read refused or empty). */
	| 'no-fold-state'
	/** An earlier unsettled write of the record carries no fold state to build the array write on. */
	| 'array-chain'
	/** The fold state read does not describe the base record (a change landed between the two). */
	| 'fold-state-stale'
	| 'no-change'
	| 'write-gate'
	| 'writes-refused'
	| 'pending-cap'
	| 'bytes-cap'
	| 'records-cap'
	| 'unsupported-write'
	| 'predictor-error'
	/** The write passed `{ durable: true }`: shown at commit, as with instant updates off. */
	| 'durable-option'
	/** The circuit breaker opened for the collection after repeated divergences (I10). */
	| 'collection-disabled'

/** The kind of a local write. */
export type PredictedWriteKind = 'insert' | 'update' | 'delete'

/** What a write is predicted to do to one record. */
export interface PredictedChange {
	readonly predicted: true
	readonly kind: PredictedWriteKind
	readonly collection: string
	readonly recordId: string
	/**
	 * Read-shaped field values the write sets: every field of the record for an insert,
	 * the written fields plus `updatedAt` for an update, null for a delete (a tombstone).
	 */
	readonly patch: Readonly<Record<string, unknown>> | null
	/**
	 * For an update: the values the patched fields (and `updatedAt`) had before the write,
	 * from the same base the prediction used. Lets the patcher tell a row that enters a
	 * query (it did not match before) from one that vanished (it did) without reading it.
	 * Null for an insert and a delete.
	 */
	readonly previous?: Readonly<Record<string, unknown>> | null
	/**
	 * The record as it stands after the write (the full record for an insert and update).
	 * For a delete: the record as it stood when it was tombstoned.
	 */
	readonly record: CollectionRecord
	/**
	 * The record's fold state after the write, when the prediction was made on a real fold
	 * state (a fresh insert, or an update of an array). The next write of the record builds
	 * on it while this one is unsettled.
	 */
	readonly foldState?: FoldState
	/**
	 * Predict the same write again from the values the transaction actually read as its
	 * base (`operation.previousData`), for the commit-time check when the base moved. Not
	 * stored in the registry.
	 */
	readonly replay?: (
		previous: Readonly<Record<string, unknown>>,
		priorState?: FoldState | null,
	) => Prediction
}

/** A write the predictor declined. */
export interface PredictionMiss {
	readonly predicted: false
	readonly reason: MissReason
}

/** The predictor's answer. */
export type Prediction = PredictedChange | PredictionMiss

/** The part of the write environment the predictor reads. */
export type PredictEnv = Pick<WriteEnv, 'schema' | 'nodeId' | 'fold'>

/** Field kinds an update may write under prediction (5.2). */
const SCALAR_UPDATE_KINDS: ReadonlySet<string> = new Set([
	'string',
	'number',
	'boolean',
	'enum',
	'timestamp',
])

/** `onDelete` actions whose enforcement writes or refuses in the transaction (5.2, F4). */
const ENFORCED_DELETE_ACTIONS: ReadonlySet<string> = new Set(['cascade', 'set-null', 'restrict'])

const miss = (reason: MissReason): PredictionMiss => ({ predicted: false, reason })

/** True when any field of the collection is a secret (stored hashed or encrypted). */
function hasSecretField(definition: CollectionDefinition): boolean {
	return Object.values(definition.fields).some(
		(field) => field.kind === 'secret' || field.secretMode != null,
	)
}

/**
 * Whether a delete of a record of `collection` is free of in-transaction side effects:
 * no relation with an enforced `onDelete` points at the collection. Static per schema.
 */
export function isDeletePredictable(schema: SchemaDefinition, collection: string): boolean {
	for (const relation of Object.values(schema.relations ?? {})) {
		if (relation.to === collection && ENFORCED_DELETE_ACTIONS.has(relation.onDelete)) return false
	}
	return true
}

/** Build the read-shaped record of a row, through the same functions every read uses. */
function readShape(
	definition: CollectionDefinition,
	id: string,
	values: Record<string, unknown>,
	createdAt: number,
	updatedAt: number,
): CollectionRecord {
	const row: RawCollectionRow = {
		...serializeRecord(values, definition.fields),
		id,
		_created_at: createdAt,
		_updated_at: updatedAt,
		_deleted: 0,
	}
	return deserializeRecord(row, definition.fields)
}

/**
 * A record the write path returned, in the shape a `SELECT` row reads back as (an
 * optional field that was not given is `null`, not absent). Used to compare a committed
 * `WriteResult.record` with a prediction (5.3e) and to seed the committed-row cache.
 */
export function toReadShape(
	definition: CollectionDefinition,
	record: CollectionRecord,
): CollectionRecord {
	return readShape(
		definition,
		record.id,
		fieldValues(definition, record),
		record.createdAt,
		record.updatedAt,
	)
}

/**
 * The provisional operation the fold merges for a fresh local insert. Its id, sequence
 * number and causal parents are placeholders: the materialized values of a
 * single-operation state do not depend on them. It is never hashed, stored or published.
 */
function provisionalInsertOperation(
	env: PredictEnv,
	insert: PreparedInsert,
	definition: CollectionDefinition,
	wallTime: number,
): Operation {
	return {
		id: 'overlay-prediction',
		nodeId: env.nodeId,
		type: 'insert',
		collection: insert.collection,
		recordId: insert.recordId,
		data: insertOperationData(insert, definition),
		previousData: null,
		timestamp: { wallTime, logical: 0, nodeId: env.nodeId },
		sequenceNumber: 0,
		causalDeps: [],
		schemaVersion: env.schema.version,
	}
}

/**
 * The row values a fresh insert materializes to under the W7 fold: the same pure
 * functions `RecordFolder.applyInTx` runs for a fresh local insert (`mergeOp` on a
 * `createFoldState`, then `materialize`), keeping only the fields the fold state holds
 * as `materializeRow` does.
 */
function foldedInsertValues(
	env: PredictEnv,
	fold: RecordFolder,
	insert: PreparedInsert,
	definition: CollectionDefinition,
	wallTime: number,
): { values: Record<string, unknown>; state: FoldState } {
	const op = provisionalInsertOperation(env, insert, definition, wallTime)
	const { state } = mergeOp(
		createFoldState(insert.collection, insert.recordId),
		op,
		env.schema,
		fold.options(),
	)
	const values = materialize({ ...state, d: null }, { richtext: mergeYjsUpdates }) ?? {}
	const out: Record<string, unknown> = {}
	for (const field of Object.keys(definition.fields)) {
		if (field in state.f) out[field] = values[field] ?? null
	}
	return { values: out, state }
}

/**
 * Predict an insert from the prepared insert the transaction will write (prepare once,
 * share: invariant I4).
 *
 * @param env - Schema, node id and the record fold (absent under `legacyMerge`)
 * @param insert - The object `writeInsertInTx` will write
 * @param wallTime - The wall time to give `createdAt` and `updatedAt`
 */
export function predictInsert(
	env: PredictEnv,
	insert: PreparedInsert,
	wallTime: number,
): Prediction {
	const definition = env.schema.collections[insert.collection]
	if (!definition) return miss('unsupported-write')
	if (hasSecretField(definition)) return miss('secret-field')
	for (const name of Object.keys(insert.data)) {
		if (definition.fields[name]?.kind === 'richtext') return miss('richtext-field')
	}
	try {
		const folded = env.fold ? foldedInsertValues(env, env.fold, insert, definition, wallTime) : null
		const record = readShape(
			definition,
			insert.recordId,
			folded ? folded.values : insert.data,
			wallTime,
			wallTime,
		)
		return {
			predicted: true,
			kind: 'insert',
			collection: insert.collection,
			recordId: insert.recordId,
			patch: fieldsOf(record),
			record,
			// Only an array write builds on a fold state, so only collections with an array
			// field keep it (the entry's bytes and the registry's memory otherwise).
			...(folded && hasArrayField(definition) ? { foldState: folded.state } : {}),
		}
	} catch {
		return miss('predictor-error')
	}
}

/** The schema fields of a record plus `updatedAt` (what an insert's patch carries). */
function fieldsOf(record: CollectionRecord): Record<string, unknown> {
	const { id: _id, createdAt: _createdAt, ...rest } = record
	return rest
}

/** How a written field takes part in an update prediction. */
interface FieldClass {
	/** Why the field forbids predicting the update, or null. */
	readonly block: MissReason | null
	/**
	 * Null for a plain last-write-wins scalar (the written value is the materialized value).
	 * Otherwise the reason to give when the record fold is unavailable (`legacyMerge`): the
	 * field's value comes from the fold itself (an atomic op, a merge strategy, an array).
	 */
	readonly folded: MissReason | null
}

const PLAIN_FIELD: FieldClass = { block: null, folded: null }

const blocked = (reason: MissReason): FieldClass => ({ block: reason, folded: null })

const NUMERIC_ATOMIC_TYPES: ReadonlySet<string> = new Set(['increment', 'max', 'min'])
const ARRAY_ATOMIC_TYPES: ReadonlySet<string> = new Set(['append', 'remove'])

/** True for a kind whose values are numbers (counter, max and min fold numbers). */
const isNumericKind = (kind: string): boolean => kind === 'number' || kind === 'timestamp'

/** Classify one written field of an update (5.2, S6b). */
function classifyUpdateField(
	definition: CollectionDefinition,
	field: string,
	descriptor: FieldDescriptor | undefined,
	value: unknown,
): FieldClass {
	if (descriptor === undefined) return blocked('unsupported-field-kind')
	if (descriptor.kind === 'richtext') return blocked('richtext-field')
	if (definition.resolvers[field] !== undefined) return blocked('custom-resolver')
	const isArray = descriptor.kind === 'array'
	if (!isArray && !SCALAR_UPDATE_KINDS.has(descriptor.kind)) {
		return blocked('unsupported-field-kind')
	}
	let folded: MissReason | null = isArray ? 'unsupported-field-kind' : null
	const strategy = descriptor.mergeStrategy
	if (strategy === 'server-authoritative') return blocked('merge-strategy')
	if (strategy === 'counter' || strategy === 'max' || strategy === 'min') {
		// The three fold numbers; on any other kind the schema is not one this predictor knows.
		if (!isNumericKind(descriptor.kind)) return blocked('merge-strategy')
		folded = 'merge-strategy'
	} else if (strategy === 'append-only' && !isArray) {
		return blocked('merge-strategy')
	}
	if (isAtomicOp(value)) {
		const fits =
			(NUMERIC_ATOMIC_TYPES.has(value.type) && isNumericKind(descriptor.kind)) ||
			(ARRAY_ATOMIC_TYPES.has(value.type) && isArray)
		if (!fits) return blocked('atomic-op')
		folded = 'atomic-op'
	}
	return folded === null ? PLAIN_FIELD : { block: null, folded }
}

/** Whether the collection has an array field (the only kind whose writes need a fold state). */
function hasArrayField(definition: CollectionDefinition): boolean {
	return Object.values(definition.fields).some((field) => field.kind === 'array')
}

/**
 * Whether predicting an update of `data` needs the record's fold state: an array is
 * written (which copy of a value is present is the element's identity, kept only in the
 * fold state). False under `legacyMerge` (no fold). Looked at before the base is read.
 */
export function updateNeedsFoldState(
	env: Pick<PredictEnv, 'schema' | 'fold'>,
	collection: string,
	data: Record<string, unknown>,
): boolean {
	if (!env.fold) return false
	const definition = env.schema.collections[collection]
	if (!definition) return false
	return Object.keys(data).some((field) => definition.fields[field]?.kind === 'array')
}

/**
 * Predict an update of a record whose current values are `base`.
 *
 * A plain last-write-wins scalar is predicted as the written value: the local operation is
 * the newest writer of every field it touches (the HLC is past everything this device has
 * received), so that is what the fold materializes (5.3c). A field whose value comes from
 * the fold itself (an atomic op such as `op.increment`, a `counter`, `max`, `min` or
 * `append-only` merge strategy, an array) is predicted by running the fold on the update:
 * from the record's values (`@korajs/core`'s `predictLocalUpdate`), or from `baseState`, the
 * record's real fold state, which an array needs (S6b).
 *
 * @param env - Schema, node id and the record fold
 * @param collection - The collection
 * @param id - The record id
 * @param data - The schema-validated values being written (may hold atomic op descriptors)
 * @param base - The record's current values (pending chain or committed row)
 * @param wallTime - The wall time to give `updatedAt`
 * @param baseState - The record's fold state as of `base`, when known
 */
export function predictUpdate(
	env: PredictEnv,
	collection: string,
	id: string,
	data: Record<string, unknown>,
	base: CollectionRecord,
	wallTime: number,
	baseState: FoldState | null = null,
): Prediction {
	const definition = env.schema.collections[collection]
	if (!definition) return miss('unsupported-write')
	if (hasSecretField(definition)) return miss('secret-field')
	let folded: MissReason | null = null
	for (const [field, value] of Object.entries(data)) {
		const one = classifyUpdateField(definition, field, definition.fields[field], value)
		if (one.block !== null) return miss(one.block)
		// The first folded field decides the reason a store without the fold gives.
		if (one.folded !== null && folded === null) folded = one.folded
	}
	// Without the record fold (`legacyMerge`) the pairwise engine decides these values.
	if (folded !== null && !env.fold) return miss(folded)
	let allowed: Record<string, unknown>
	try {
		// The same function the write path runs, on the same current record.
		allowed = validateUpdateStateMachine(collection, id, definition, base, data)
	} catch {
		return miss('state-machine')
	}
	if (Object.keys(allowed).length === 0) return miss('no-change')
	try {
		const { previousData, resolved, atomicOps } = patchForUpdate(
			collection,
			definition,
			base,
			allowed,
		)
		let materialized: Record<string, unknown> = resolved
		let foldState: FoldState | undefined
		if (folded !== null && env.fold) {
			const operation: Operation = {
				id: 'overlay-prediction',
				nodeId: env.nodeId,
				type: 'update',
				collection,
				recordId: id,
				data: resolved,
				previousData,
				timestamp: { wallTime, logical: 0, nodeId: env.nodeId },
				sequenceNumber: 0,
				causalDeps: [],
				schemaVersion: env.schema.version,
				...(Object.keys(atomicOps).length > 0 ? { atomicOps } : {}),
			}
			const prediction = predictLocalUpdate({
				schema: env.schema,
				op: operation,
				current: fieldValues(definition, base),
				baseState,
				options: env.fold.options(),
			})
			if ('declined' in prediction) {
				return miss(
					prediction.declined === 'array-needs-state'
						? 'no-fold-state'
						: prediction.declined === 'state-mismatch'
							? 'fold-state-stale'
							: 'merge-strategy',
				)
			}
			materialized = prediction.values
			if (prediction.state !== null) foldState = prediction.state
		}
		const values: Record<string, unknown> = {}
		for (const field of Object.keys(definition.fields)) {
			values[field] = field in materialized ? materialized[field] : base[field]
		}
		const record = readShape(definition, id, values, base.createdAt, wallTime)
		const patch: Record<string, unknown> = { updatedAt: wallTime }
		const previous: Record<string, unknown> = { updatedAt: base.updatedAt }
		for (const field of Object.keys(resolved)) {
			patch[field] = record[field]
			previous[field] = base[field]
		}
		return {
			predicted: true,
			kind: 'update',
			collection,
			recordId: id,
			patch,
			previous,
			record,
			...(foldState ? { foldState } : {}),
			// Predict again from what the transaction really read: its values and, for an
			// array write, the fold state the commit merged into (`priorState`).
			replay: (actual, priorState = null) =>
				predictUpdate(env, collection, id, data, { ...base, ...actual }, wallTime, priorState),
		}
	} catch {
		return miss('predictor-error')
	}
}

/**
 * Predict a delete of a record whose current values are `base`: a tombstone.
 *
 * @param env - Schema, node id and the record fold
 * @param collection - The collection
 * @param id - The record id
 * @param base - The record's current values
 */
export function predictDelete(
	env: PredictEnv,
	collection: string,
	id: string,
	base: CollectionRecord,
): Prediction {
	const definition = env.schema.collections[collection]
	if (!definition) return miss('unsupported-write')
	if (!isDeletePredictable(env.schema, collection)) return miss('cascade-target')
	try {
		// A delete reports the record as it stood: build the row the write path read and
		// shape it with the one function (`tombstone`) the write path shapes it with.
		const row: RawCollectionRow = {
			...serializeRecord(fieldValues(definition, base), definition.fields),
			id,
			_created_at: base.createdAt,
			_updated_at: base.updatedAt,
			_deleted: 0,
		}
		return {
			predicted: true,
			kind: 'delete',
			collection,
			recordId: id,
			patch: null,
			record: tombstone(definition, row),
		}
	} catch {
		return miss('predictor-error')
	}
}

function fieldValues(
	definition: CollectionDefinition,
	record: CollectionRecord,
): Record<string, unknown> {
	const values: Record<string, unknown> = {}
	for (const field of Object.keys(definition.fields)) values[field] = record[field]
	return values
}

/** Record fields that may legitimately differ between prediction and commit (5.3d). */
const METADATA_FIELDS: ReadonlySet<string> = new Set(['createdAt', 'updatedAt'])

/**
 * Names of the fields on which two records differ, ignoring `createdAt` and
 * `updatedAt` (the only expected, benign difference). Compared structurally, so a
 * `null` and an absent field differ and arrays compare by element.
 */
export function divergentFields(
	predicted: CollectionRecord,
	committed: CollectionRecord,
): string[] {
	const names = new Set([...Object.keys(predicted), ...Object.keys(committed)])
	const out: string[] = []
	for (const name of names) {
		if (METADATA_FIELDS.has(name)) continue
		if (!sameValue(predicted[name], committed[name])) out.push(name)
	}
	return out.sort()
}

/** Structural equality of two field values (arrays by element, `null` and absent differ). */
export function sameValue(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true
	if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
	if (a instanceof Uint8Array || b instanceof Uint8Array) {
		if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) {
			return false
		}
		return a.every((byte, index) => byte === b[index])
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
		return a.every((item, index) => sameValue(item, b[index]))
	}
	const left = a as Record<string, unknown>
	const right = b as Record<string, unknown>
	const keys = new Set([...Object.keys(left), ...Object.keys(right)])
	for (const key of keys) if (!sameValue(left[key], right[key])) return false
	return true
}
