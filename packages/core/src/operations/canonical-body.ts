import { KoraError } from '../errors/errors'
import type { AtomicOp, Operation, OperationInput } from '../types'
import { bytesToBase64 } from './op-data-binary'

/**
 * Thrown when an operation (or a record value) holds a value that has no canonical
 * JSON form: the op log and the wire are JSON, so such a value would be stored and
 * synced as something other than what was written and hashed.
 */
export class NonCanonicalValueError extends KoraError {
	constructor(
		message: string,
		public readonly path: string,
		public readonly receivedType: string,
	) {
		super(message, 'NON_CANONICAL_VALUE', { path, receivedType })
		this.name = 'NonCanonicalValueError'
	}
}

/**
 * The one canonical form of an operation body (RT-72 family: RT-79, RT-80, RT-83).
 *
 * The op log, the wire (JSON and protobuf, whose data is JSON) and every store hold an
 * operation as JSON. An operation's id is a hash of its body. So the body is put in its
 * canonical form ONCE, when the operation is created (and when a legacy operation is
 * ingested or rebuilt), and the canonical body is what is hashed, stored, sent and
 * folded: the four can never disagree, by construction.
 *
 * | Value                                   | Canonical form                                  |
 * |-----------------------------------------|-------------------------------------------------|
 * | `undefined` member of an insert's data  | absent                                          |
 * | `undefined` member of an update's data  | `null`: the field is CLEARED (beta.13 meaning)  |
 * | `undefined` member of an update's `previousData` | `null` (the field held no value)       |
 * | `undefined` member inside an object value | absent (as JSON drops it); a `t.json()` field refuses it at validation |
 * | `undefined` array element               | `null` (as JSON writes it)                      |
 * | `undefined` atomic op                   | absent                                          |
 * | `-0`                                    | `0` (JSON writes `0`)                           |
 * | valid `Date`                            | its ISO 8601 string (`toISOString()`), as JSON  |
 * | `Uint8Array` / `ArrayBuffer`            | `{ $koraBytes: <base64> }` (the op-log binary form) |
 * | plain object (`Object.prototype` or `null` prototype) | plain object, members canonical   |
 * | array (dense)                           | array, elements canonical                       |
 * | string, finite number, boolean, `null`  | itself                                          |
 * | invalid `Date`, `NaN`, `±Infinity`, `BigInt`, function, symbol, `Map`, `Set`, `WeakMap`, `RegExp`, `Promise`, any other class instance, an object with a `toJSON` method, a circular reference | refused: {@link NonCanonicalValueError} naming the path and the fix |
 *
 * Canonicalization is idempotent: a canonical body is returned unchanged (same
 * references where nothing changed).
 *
 * @param input - The operation body (as given to `createOperation`, or a stored operation)
 * @returns The body with `data`, `previousData` and `atomicOps` canonical
 * @throws {NonCanonicalValueError} For a value with no canonical form
 */
export function canonicalizeOperationBody<T extends CanonicalizableBody>(input: T): T {
	const isUpdate = input.type === 'update'
	const where = `${input.collection}/${input.recordId}`
	const data = canonicalTopLevel(input.data, isUpdate, 'data', where)
	const previousData = canonicalTopLevel(input.previousData, isUpdate, 'previousData', where)
	let atomicOps = input.atomicOps
	if (atomicOps !== undefined) {
		const canonical = canonicalTopLevel(
			atomicOps as Record<string, unknown>,
			false,
			'atomicOps',
			where,
		) as Record<string, AtomicOp> | null
		atomicOps = canonical ?? undefined
	}
	if (data === input.data && previousData === input.previousData && atomicOps === input.atomicOps) {
		return input
	}
	return {
		...input,
		data,
		previousData,
		...(atomicOps !== undefined ? { atomicOps } : {}),
	}
}

/** The members of an operation body that {@link canonicalizeOperationBody} reads. */
export interface CanonicalizableBody {
	type: OperationInput['type']
	collection: string
	recordId: string
	data: Record<string, unknown> | null
	previousData: Record<string, unknown> | null
	atomicOps?: Record<string, AtomicOp>
}

/**
 * The canonical form of one value inside an operation body or a record field (see
 * {@link canonicalizeOperationBody} for the table). Exported so schema validation
 * produces exactly the values an operation will carry.
 *
 * @param value - Any value
 * @param path - Where the value is, for the error message (e.g. `notes.extra.when`)
 * @returns The canonical value (the same reference when it already is)
 * @throws {NonCanonicalValueError} For a value with no canonical form
 */
export function canonicalValue(value: unknown, path: string): unknown {
	return canonical(value, path, new Set())
}

function canonicalTopLevel(
	record: Record<string, unknown> | null,
	undefinedIsNull: boolean,
	label: string,
	where: string,
): Record<string, unknown> | null {
	if (record === null || record === undefined) return null
	if (!isPlainObject(record)) {
		throw new NonCanonicalValueError(
			`Operation ${label} of ${where} must be a plain object, got ${describe(record)}.`,
			label,
			describe(record),
		)
	}
	let changed = false
	const out: Record<string, unknown> = {}
	for (const [key, member] of Object.entries(record)) {
		if (member === undefined) {
			changed = true
			// In an update, `field: undefined` is a clear (as beta.13 applied it); the
			// canonical form says so explicitly. Elsewhere it is simply absent.
			if (undefinedIsNull) out[key] = null
			continue
		}
		const next = canonical(member, `${where}.${key}`, new Set())
		if (!Object.is(next, member)) changed = true
		out[key] = next
	}
	if (Object.getPrototypeOf(record) !== Object.prototype) changed = true
	return changed ? out : record
}

function canonical(value: unknown, path: string, ancestors: Set<object>): unknown {
	switch (typeof value) {
		case 'string':
		case 'boolean':
			return value
		case 'number':
			if (!Number.isFinite(value)) {
				throw refusal(path, String(value), 'Use a finite number, or null for "no value".')
			}
			return Object.is(value, -0) ? 0 : value
		case 'undefined':
			// Only reachable for array elements and the top level (members are handled by
			// the caller): JSON writes an undefined array element as null.
			return null
		case 'bigint':
			throw refusal(path, 'bigint', 'Convert it to a number or a string.')
		case 'function':
			throw refusal(path, 'function', 'Store data only, not functions.')
		case 'symbol':
			throw refusal(path, 'symbol', 'Use a string instead.')
	}
	if (value === null) return null
	const object = value as object
	if (object instanceof Uint8Array) return { $koraBytes: bytesToBase64(object) }
	if (object instanceof ArrayBuffer) return { $koraBytes: bytesToBase64(new Uint8Array(object)) }
	if (object instanceof Date) {
		const time = object.getTime()
		if (Number.isNaN(time)) {
			throw refusal(path, 'invalid Date', 'Pass a valid Date, or null.')
		}
		return object.toISOString()
	}
	if (ancestors.has(object)) {
		throw refusal(path, 'circular reference', 'Remove the cycle: JSON cannot hold it.')
	}
	if (Array.isArray(object)) {
		ancestors.add(object)
		let changed = false
		const out: unknown[] = []
		for (let index = 0; index < object.length; index++) {
			if (!(index in object)) {
				ancestors.delete(object)
				throw refusal(
					`${path}[${String(index)}]`,
					'array hole',
					'Use a dense array (fill the gap with null).',
				)
			}
			const item = object[index]
			const next = canonical(item, `${path}[${String(index)}]`, ancestors)
			if (!Object.is(next, item)) changed = true
			out.push(next)
		}
		ancestors.delete(object)
		return changed ? out : object
	}
	if (!isPlainObject(object)) {
		const type = describe(object)
		throw refusal(
			path,
			type,
			type === 'Map'
				? 'Convert it with Object.fromEntries(map).'
				: type === 'Set'
					? 'Convert it with [...set].'
					: 'Convert it to a plain object (JSON data only).',
		)
	}
	if (typeof (object as { toJSON?: unknown }).toJSON === 'function') {
		throw refusal(path, 'object with toJSON', 'Store the value toJSON() returns instead.')
	}
	ancestors.add(object)
	let changed = Object.getPrototypeOf(object) !== Object.prototype
	const out: Record<string, unknown> = {}
	for (const [key, member] of Object.entries(object)) {
		if (member === undefined) {
			changed = true
			continue
		}
		const next = canonical(member, `${path}.${key}`, ancestors)
		if (!Object.is(next, member)) changed = true
		out[key] = next
	}
	ancestors.delete(object)
	return changed ? out : object
}

function refusal(path: string, receivedType: string, fix: string): NonCanonicalValueError {
	return new NonCanonicalValueError(
		`Value at "${path}" (${receivedType}) has no JSON form, so it cannot be stored or synced unchanged. ${fix}`,
		path,
		receivedType,
	)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
	const proto = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

function describe(value: unknown): string {
	if (value === null) return 'null'
	if (Array.isArray(value)) return 'array'
	if (typeof value !== 'object') return typeof value
	const ctor = (value as { constructor?: { name?: unknown } }).constructor
	return typeof ctor?.name === 'string' && ctor.name.length > 0 ? ctor.name : 'object'
}

/**
 * The canonical body of a legacy (version-1, beta.13) update (RT-71, RT-83): every
 * `previousData` key absent from `data` is a clear, restored as `null`. beta.13 wrote
 * `previousData[key]` for every key it validated, so such a key held `undefined` in
 * `data`: beta.13 hashed it as `null`, applied it as a cleared field, and its JSON log
 * and upload dropped it. `null` and `undefined` hash identically under version 1, so
 * the id is unchanged.
 *
 * Applied wherever an operation is folded (server and devices alike) and where a legacy
 * operation is ingested, so the server, peers and the upgraded writer agree. A no-op
 * for anything else (a declared version 2, an envelope, an insert or delete, an update
 * whose data covers its previousData). Idempotent.
 *
 * @param op - Any operation
 * @returns The operation with the restored data, or `op` itself
 */
export function canonicalizeLegacyOperation<T extends LegacyBody>(op: T): T {
	if (op.type !== 'update' || op.hashVersion === 2 || op.encrypted !== undefined) return op
	const previous = op.previousData
	if (previous === null || previous === undefined) return op
	const data = op.data ?? {}
	const missing = Object.keys(previous).filter((key) => !(key in data))
	if (missing.length === 0) return op
	const out: Record<string, unknown> = { ...data }
	for (const key of missing) out[key] = null
	return { ...op, data: out }
}

/** The members of an operation {@link canonicalizeLegacyOperation} reads. */
export interface LegacyBody {
	type: Operation['type']
	data: Record<string, unknown> | null
	previousData: Record<string, unknown> | null
	hashVersion?: Operation['hashVersion']
	encrypted?: Operation['encrypted']
}
