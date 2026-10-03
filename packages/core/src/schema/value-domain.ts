import { isBlobRef } from '../blob/blob-ref'
import { isKoraBytesValue } from '../operations/op-data-binary'
import type { FieldDescriptor, Operation } from '../types'

/**
 * One value domain (RT-86, RT-87): every value the local API accepts must be storable and
 * transmissible, unchanged, by every built-in store (client SQLite and IndexedDB; server
 * memory, SQLite and Postgres) and every transport (JSON and protobuf). The domain is
 * defined here once, enforced where values are written (`validateRecord`, after atomic
 * ops resolve) and re-checked by the server on ingest (`operationValueViolation`), so a
 * value outside it is refused with a clear error before anything stores it, never by a
 * database half-way through a sync.
 *
 * | Field type     | Domain                                                    | Client SQLite / IndexedDB | Server SQLite | Server Postgres          | Wire (JSON / protobuf) |
 * |----------------|-----------------------------------------------------------|---------------------------|---------------|--------------------------|------------------------|
 * | `string`       | any string (U+0000 and lone surrogates included)          | TEXT / string             | TEXT          | TEXT, lossless text codec (RT-65) | JSON string (escaped) |
 * | `enum`         | one of the declared values                                | TEXT / string             | TEXT + CHECK  | TEXT + CHECK             | JSON string            |
 * | `secret`       | string (stored hashed or encrypted)                       | TEXT                      | TEXT          | TEXT                     | JSON string            |
 * | `number`       | finite double; `-0` is `0`                                | REAL / number             | REAL          | DOUBLE PRECISION         | JSON number            |
 * | `boolean`      | `true` / `false`                                          | INTEGER 0/1 / boolean     | INTEGER       | INTEGER                  | JSON boolean           |
 * | `timestamp`    | integer milliseconds in [-8.64e15, 8.64e15] (the `Date` range; a safe integer). Fractions are refused, not rounded | INTEGER / number | INTEGER | BIGINT | JSON number |
 * | `array`        | dense array of the item kind's domain, nesting <= {@link MAX_VALUE_DEPTH} | TEXT (JSON) / array | TEXT (JSON) | JSONB (text codec) | JSON array |
 * | `object`       | plain object; declared keys in their kind's domain        | TEXT (JSON) / object      | TEXT (JSON)   | JSONB                    | JSON object            |
 * | `json`         | any JSON value: finite numbers, no `__proto__` key, nesting <= {@link MAX_VALUE_DEPTH}, not exactly `{ __kora_bytes__ }` (the wire's binary form) | TEXT (JSON) / value | TEXT (JSON) | JSONB | JSON |
 * | `blob`         | a `BlobRef`                                               | TEXT (JSON)               | TEXT          | TEXT                     | JSON object            |
 * | `richtext`     | Yjs update bytes (`Uint8Array` / `ArrayBuffer`) or a string | BLOB / bytes            | BLOB          | BYTEA                    | `{ $koraBytes }` / bytes |
 * | any operation  | serialized size <= `maxOperationBytes` (default {@link DEFAULT_MAX_OPERATION_BYTES}) | | | | |
 *
 * Every value additionally has a canonical JSON form (core canonical-body): no `NaN`,
 * `±Infinity`, `BigInt`, `Map`, `Set`, class instances or cycles.
 */

/** Smallest `t.timestamp()` value: the earliest instant a JavaScript `Date` can hold. */
export const TIMESTAMP_MIN_MS = -8_640_000_000_000_000

/** Largest `t.timestamp()` value: the latest instant a JavaScript `Date` can hold. */
export const TIMESTAMP_MAX_MS = 8_640_000_000_000_000

/**
 * Deepest nesting of arrays and objects inside one field value. Postgres parses JSONB
 * recursively with a stack limit, and every replica folds values recursively; 64 levels
 * is far beyond any real document.
 */
export const MAX_VALUE_DEPTH = 64

/** Default largest serialized operation, shared by the local write path and the server. */
export const DEFAULT_MAX_OPERATION_BYTES = 256 * 1024

/**
 * Why `value` is not a valid `t.timestamp()` value, or null when it is.
 *
 * @param value - The value
 */
export function timestampDomainViolation(value: unknown): string | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return `must be a timestamp (integer milliseconds), got ${describe(value)}`
	}
	if (!Number.isInteger(value)) {
		return `must be a timestamp in whole milliseconds, got ${String(value)}. Round it (Math.round) or use Date.getTime()`
	}
	if (value < TIMESTAMP_MIN_MS || value > TIMESTAMP_MAX_MS) {
		return `must be a timestamp between ${TIMESTAMP_MIN_MS} and ${TIMESTAMP_MAX_MS} (the range of a JavaScript Date), got ${String(value)}`
	}
	return null
}

/**
 * The path of the first container nested deeper than `maxDepth`, or null.
 *
 * @param value - Any value
 * @param maxDepth - The deepest allowed nesting of arrays and objects
 */
export function valueDepthViolation(
	value: unknown,
	maxDepth: number = MAX_VALUE_DEPTH,
): string | null {
	const walk = (current: unknown, depth: number, path: string): string | null => {
		if (current === null || typeof current !== 'object') return null
		if (depth > maxDepth) return path
		if (current instanceof Uint8Array || current instanceof ArrayBuffer) return null
		const entries = Array.isArray(current)
			? current.map((item, index) => [`[${index}]`, item] as const)
			: Object.entries(current as Record<string, unknown>).map(
					([key, item]) => [`.${key}`, item] as const,
				)
		for (const [suffix, item] of entries) {
			const found = walk(item, depth + 1, `${path}${suffix}`)
			if (found !== null) return found
		}
		return null
	}
	return walk(value, 1, '')
}

/**
 * The path of the first own `__proto__` key in a value, or null. JSON can carry such a
 * key, but most JavaScript code (including object spreads into a fresh `{}` with
 * assignment) turns it into a prototype and loses it, so it is refused everywhere.
 *
 * @param value - Any value
 */
export function protoKeyViolation(value: unknown): string | null {
	const walk = (current: unknown, path: string): string | null => {
		if (current === null || typeof current !== 'object') return null
		if (current instanceof Uint8Array || current instanceof ArrayBuffer) return null
		if (Array.isArray(current)) {
			for (let index = 0; index < current.length; index++) {
				const found = walk(current[index], `${path}[${index}]`)
				if (found !== null) return found
			}
			return null
		}
		if (Object.prototype.hasOwnProperty.call(current, '__proto__')) return `${path}.__proto__`
		for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
			const found = walk(item, `${path}.${key}`)
			if (found !== null) return found
		}
		return null
	}
	return walk(value, '')
}

/**
 * Why a field value, as an OPERATION carries it (op-data form: richtext as
 * `{ $koraBytes }` or a string, secrets in their at-rest string form), is outside the
 * field's domain, or null when it is inside. The server checks every uploaded and
 * route-written operation's data with it, so every server store and every peer holds
 * the same values (RT-86, RT-87). `null` is always accepted (a cleared field).
 *
 * @param descriptor - The field's descriptor in the schema that reads the operation
 * @param value - The value from `data`
 */
export function operationValueViolation(
	descriptor: FieldDescriptor,
	value: unknown,
): string | null {
	if (value === null || value === undefined) return null
	switch (descriptor.kind) {
		case 'string':
		case 'secret':
			return typeof value === 'string' ? null : `must be a string, got ${describe(value)}`
		case 'enum':
			if (typeof value !== 'string') return `must be a string (enum), got ${describe(value)}`
			if (descriptor.enumValues && !descriptor.enumValues.includes(value)) {
				return `must be one of: ${descriptor.enumValues.join(', ')}. Got "${value}"`
			}
			return null
		case 'number':
			return typeof value === 'number' && Number.isFinite(value)
				? null
				: `must be a finite number, got ${describe(value)}`
		case 'boolean':
			return typeof value === 'boolean' ? null : `must be a boolean, got ${describe(value)}`
		case 'timestamp':
			return timestampDomainViolation(value)
		case 'richtext':
			return typeof value === 'string' || isKoraBytesValue(value) || value instanceof Uint8Array
				? null
				: `must be richtext (Yjs bytes or a string), got ${describe(value)}`
		case 'blob':
			return isBlobRef(value) ? null : `must be a BlobRef, got ${describe(value)}`
		case 'array': {
			if (!Array.isArray(value)) return `must be an array, got ${describe(value)}`
			const item = descriptor.itemKind
			for (let index = 0; index < value.length; index++) {
				const element = value[index]
				if (item === 'timestamp') {
					const violation = timestampDomainViolation(element)
					if (violation) return `[${index}] ${violation}`
				} else if (
					item === 'number' &&
					(typeof element !== 'number' || !Number.isFinite(element))
				) {
					return `[${index}] must be a finite number, got ${describe(element)}`
				} else if ((item === 'string' || item === 'enum') && typeof element !== 'string') {
					return `[${index}] must be a string, got ${describe(element)}`
				} else if (item === 'boolean' && typeof element !== 'boolean') {
					return `[${index}] must be a boolean, got ${describe(element)}`
				}
			}
			return structureViolation(value)
		}
		case 'object': {
			if (typeof value !== 'object' || Array.isArray(value)) {
				return `must be a plain object, got ${describe(value)}`
			}
			for (const [name, nested] of Object.entries(descriptor.nestedFields ?? {})) {
				const violation = operationValueViolation(nested, (value as Record<string, unknown>)[name])
				if (violation) return `.${name} ${violation}`
			}
			return structureViolation(value)
		}
		case 'json':
			return structureViolation(value)
	}
}

/**
 * The sync wire's binary form of a top-level value (`{ __kora_bytes__: <base64> }`, what
 * beta.13 sends a `Uint8Array` as). A json or object field value of exactly that shape
 * would be read back as bytes, so it is refused.
 */
export const WIRE_BYTES_KEY = '__kora_bytes__'

/**
 * Why a json or object field value is reserved by the wire, or null: an object whose
 * only member is `__kora_bytes__`.
 *
 * @param value - A field value
 */
export function reservedWireShapeViolation(value: unknown): string | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
	const keys = Object.keys(value)
	return keys.length === 1 && keys[0] === WIRE_BYTES_KEY
		? `is an object whose only key is "${WIRE_BYTES_KEY}", which the sync wire reserves for binary values; add another key or rename it`
		: null
}

/** Depth, `__proto__` keys and non-finite numbers inside a structured value. */
function structureViolation(value: unknown): string | null {
	const reserved = reservedWireShapeViolation(value)
	if (reserved !== null) return reserved
	const deep = valueDepthViolation(value)
	if (deep !== null) return `nests deeper than ${MAX_VALUE_DEPTH} levels at "${deep}"`
	const proto = protoKeyViolation(value)
	if (proto !== null) return `holds a "__proto__" key at "${proto}", which is not supported`
	const walk = (current: unknown, path: string): string | null => {
		if (typeof current === 'number') {
			return Number.isFinite(current) ? null : `holds ${String(current)} at "${path}"`
		}
		if (current === null || typeof current !== 'object') return null
		const entries = Array.isArray(current)
			? current.map((item, index) => [`${path}[${index}]`, item] as const)
			: Object.entries(current as Record<string, unknown>).map(
					([key, item]) => [`${path}.${key}`, item] as const,
				)
		for (const [next, item] of entries) {
			const found = walk(item, next)
			if (found !== null) return found
		}
		return null
	}
	return walk(value, '')
}

/**
 * Serialized size of an operation in bytes (UTF-8 of its JSON), the measure the server
 * enforces `maxOperationBytes` with and the local write path checks before a write is
 * accepted (RT-86).
 *
 * @param op - The operation
 */
export function measureOperationBytes(op: Operation): number {
	return utf8Length(JSON.stringify(op))
}

function utf8Length(text: string): number {
	let bytes = 0
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		if (code < 0x80) bytes += 1
		else if (code < 0x800) bytes += 2
		else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
			const next = text.charCodeAt(i + 1)
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4
				i++
			} else bytes += 3
		} else bytes += 3
	}
	return bytes
}

function describe(value: unknown): string {
	if (value === null) return 'null'
	if (Array.isArray(value)) return 'array'
	if (typeof value === 'number') return Number.isFinite(value) ? 'number' : String(value)
	if (value instanceof Date) return 'Date'
	return typeof value
}
