import { canonicalize } from '../operations/content-hash'
import { FoldStateError } from './errors'
import { FOLD_STATE_VERSION, type FieldState, type FoldState } from './types'

const FIELD_KINDS = new Set(['reg', 'set', 'map', 'ctr', 'max', 'min', 'res', 'rt'])

/**
 * Serialize a record's fold state for storage (the client `_fold_state` column,
 * the server stores' fold-record rows, backups, compaction snapshots).
 *
 * The output is canonical JSON (sorted keys), so two replicas holding the same
 * operations write byte-identical strings. Format, version 2 (version 1, Stage A,
 * keyed array elements by value only and is refused: such a state is re-folded):
 *
 * ```
 * {
 *   "v": 2,                      // format version
 *   "c": "todos", "r": "<id>",   // collection, record id
 *   "cr": Stamp|null,            // oldest insert (creation)
 *   "w":  Stamp|null,            // newest insert/update
 *   "d":  Stamp|null,            // newest delete (tombstone register)
 *   "u":  Stamp|null,            // newest operation of any type
 *   "f": { "<field>": FieldState }
 * }
 * Stamp      = { "t": "<HLC serialized>", "o": "<op id>", "c"?: 1 }  // c: authority class
 * FieldState =
 *   { "k":"reg", "e":[{ "s":Stamp, "v":value, "a"?:AtomicOp }], "val":value }
 *   { "k":"set", "ao":bool, "sh":{ "s":Stamp, "arr":bool, "v"?:value }|null, "clr":Stamp|null,
 *     "el":{ "<canonical JSON>#<k>":{ "v":value, "n":k, "a":Stamp|null, "f":{ "s":Stamp, "i":n }|null, "r":Stamp|null } } }
 *   { "k":"map", "sh":{ "s":Stamp, "obj":bool, "v"?:value }|null, "clr":Stamp|null,
 *     "keys":{ "<key>":{ "s":Stamp, "del":bool, "v"?:value } } }
 *   { "k":"ctr", "base":{ "s":Stamp, "v":value }|null, "d":[{ "s":Stamp, "n":number }], "val":value }
 *   { "k":"max"|"min", "best":{ "s":Stamp, "v":number }|null, "reg":{ "s":Stamp, "v":value }|null }
 *   { "k":"res", "e":[{ "s":Stamp, "v":value, "b"?:value, "z"?:1 }], "val":value, "err"?:string }
 *   { "k":"rt", "reset":{ "s":Stamp, "v":value }|null, "u":{ "<base64 Yjs update>":Stamp } }
 * ```
 *
 * Values are JSON-safe (binary as `{ "$koraBytes": base64 }`). The state is
 * self-contained: kinds that need history embed exactly the history they need
 * ('reg' keeps the atomic chain since the newest plain write, 'res' its whole
 * write log, 'ctr' the deltas since its base), so a compactor may treat the state
 * as the record's snapshot and drop operations it covers.
 *
 * @param state - The fold state
 * @returns Canonical JSON
 */
export function serializeFoldState(state: FoldState): string {
	return canonicalize(state)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse a stored fold state. Throws {@link FoldStateError} for an unknown format
 * version or a malformed state; the caller then re-folds the record from its log.
 *
 * @param json - Output of {@link serializeFoldState}
 */
export function deserializeFoldState(json: string): FoldState {
	let parsed: unknown
	try {
		parsed = JSON.parse(json)
	} catch (error) {
		throw new FoldStateError('Stored fold state is not valid JSON.', {
			reason: error instanceof Error ? error.message : String(error),
		})
	}
	if (!isRecord(parsed)) throw new FoldStateError('Stored fold state is not an object.')
	if (parsed.v !== FOLD_STATE_VERSION) {
		throw new FoldStateError(
			`Stored fold state has format version ${String(parsed.v)}; this build reads version ${FOLD_STATE_VERSION}.`,
			{ found: parsed.v, expected: FOLD_STATE_VERSION },
		)
	}
	if (typeof parsed.c !== 'string' || typeof parsed.r !== 'string' || !isRecord(parsed.f)) {
		throw new FoldStateError('Stored fold state is missing its collection, record id or fields.')
	}
	for (const [field, state] of Object.entries(parsed.f)) {
		if (!isRecord(state) || typeof state.k !== 'string' || !FIELD_KINDS.has(state.k)) {
			throw new FoldStateError(`Stored fold state has an unknown kind for field "${field}".`, {
				field,
			})
		}
	}
	const state = parsed as unknown as FoldState
	// JSON has no undefined: a register's cached value of null round-trips as null,
	// which is what the in-memory state holds too (undefined never enters a state).
	for (const fieldState of Object.values(state.f) as FieldState[]) {
		if ((fieldState.k === 'reg' || fieldState.k === 'res') && fieldState.e.length === 0) {
			fieldState.val = undefined
		}
		if (fieldState.k === 'ctr' && fieldState.d.length === 0 && fieldState.base === null) {
			fieldState.val = undefined
		}
	}
	return state
}
