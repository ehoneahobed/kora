import { isBlobRef } from '../blob/blob-ref'
import { SchemaValidationError } from '../errors/errors'
import { isAtomicOp } from '../operations/atomic-ops'
import { NonCanonicalValueError, canonicalValue } from '../operations/canonical-body'
import type { CollectionDefinition, FieldDescriptor, OperationType } from '../types'
import {
	MAX_VALUE_DEPTH,
	protoKeyViolation,
	reservedWireShapeViolation,
	timestampDomainViolation,
	valueDepthViolation,
} from './value-domain'

/**
 * Validates a record's data against a collection's field definitions.
 * Applies defaults, rejects auto fields, and type-checks each value.
 *
 * @param collection - The collection name (for error messages)
 * @param collectionDef - The collection definition from the schema
 * @param data - The record data to validate
 * @param operationType - The operation type ('insert', 'update', 'delete')
 * @returns The validated and normalized data (with defaults applied)
 * @throws {SchemaValidationError} If validation fails
 */
export function validateRecord(
	collection: string,
	collectionDef: CollectionDefinition,
	data: Record<string, unknown>,
	operationType: OperationType,
): Record<string, unknown> {
	if (operationType === 'delete') {
		return {}
	}

	const result: Record<string, unknown> = {}
	const fieldNames = Object.keys(collectionDef.fields)

	// Check for extra fields not in the schema
	for (const key of Object.keys(data)) {
		if (!(key in collectionDef.fields)) {
			throw new SchemaValidationError(
				`Unknown field "${key}" in collection "${collection}". Available fields: ${fieldNames.join(', ')}`,
				{ collection, field: key },
			)
		}
	}

	for (const [fieldName, descriptor] of Object.entries(collectionDef.fields)) {
		const value = data[fieldName]
		const hasValue = fieldName in data

		// Auto fields cannot be set by the developer
		if (descriptor.auto && hasValue) {
			throw new SchemaValidationError(
				`Field "${fieldName}" in collection "${collection}" is auto-populated and cannot be set manually`,
				{ collection, field: fieldName },
			)
		}

		// For updates, only validate fields that are present (partial updates)
		if (operationType === 'update') {
			if (hasValue) {
				// Atomic op sentinels pass through validation — they are resolved
				// to concrete values by Collection.update() before the Operation is created.
				if (isAtomicOp(value)) {
					result[fieldName] = value
				} else if (value !== undefined && value !== null) {
					validateFieldValue(collection, fieldName, descriptor, value)
					result[fieldName] = canonicalFieldValue(collection, fieldName, descriptor, value)
				} else {
					result[fieldName] = value
				}
			}
			continue
		}

		// For inserts, apply defaults and check required fields
		if (descriptor.auto) {
			// Skip auto fields — they are populated by the framework
			continue
		}

		if (!hasValue || value === undefined) {
			if (descriptor.defaultValue !== undefined) {
				// Deep-copy default arrays/objects to prevent shared mutations
				result[fieldName] =
					typeof descriptor.defaultValue === 'object' && descriptor.defaultValue !== null
						? JSON.parse(JSON.stringify(descriptor.defaultValue))
						: descriptor.defaultValue
				continue
			}

			if (descriptor.required) {
				throw new SchemaValidationError(
					`Required field "${fieldName}" is missing in collection "${collection}"`,
					{ collection, field: fieldName },
				)
			}

			// Optional field with no default — omit from result
			continue
		}

		validateFieldValue(collection, fieldName, descriptor, value)
		result[fieldName] = canonicalFieldValue(collection, fieldName, descriptor, value)
	}

	return result
}

/**
 * The value in the canonical form an operation carries (core canonical-body.ts): an
 * `undefined` member of an object value is absent, a `Date` inside a json/object value is
 * its ISO string, `-0` is `0`; a value with no JSON form (Map, Set, class instance,
 * BigInt, ...) is refused here, naming the field, instead of being silently changed on
 * the way to the log (RT-72, RT-79). The record therefore holds exactly what peers will
 * see. Richtext values (Yjs bytes) are encoded by the store, not here.
 */
function canonicalFieldValue(
	collection: string,
	fieldName: string,
	descriptor: FieldDescriptor,
	value: unknown,
): unknown {
	if (descriptor.kind === 'richtext') return value
	try {
		return canonicalValue(value, `${collection}.${fieldName}`)
	} catch (error) {
		if (error instanceof NonCanonicalValueError) {
			throw new SchemaValidationError(
				`Field "${fieldName}" in collection "${collection}": ${error.message}`,
				{
					collection,
					field: fieldName,
					path: error.path,
					receivedType: error.receivedType,
				},
			)
		}
		throw error
	}
}

function validateFieldValue(
	collection: string,
	fieldName: string,
	descriptor: FieldDescriptor,
	value: unknown,
): void {
	switch (descriptor.kind) {
		case 'string': {
			if (typeof value !== 'string') {
				throw new SchemaValidationError(
					`Field "${fieldName}" in collection "${collection}" must be a string, got ${typeof value}`,
					{ collection, field: fieldName, expectedType: 'string', receivedType: typeof value },
				)
			}
			break
		}

		case 'number': {
			// The value domain (value-domain.ts): a finite double. Infinity has no JSON form
			// and no store column holds it.
			if (typeof value !== 'number' || !Number.isFinite(value)) {
				throw new SchemaValidationError(
					`Field "${fieldName}" in collection "${collection}" must be a finite number, got ${typeof value === 'number' ? String(value) : typeof value}`,
					{ collection, field: fieldName, expectedType: 'number', receivedType: typeof value },
				)
			}
			break
		}

		case 'boolean': {
			if (typeof value !== 'boolean') {
				throw new SchemaValidationError(
					`Field "${fieldName}" in collection "${collection}" must be a boolean, got ${typeof value}`,
					{ collection, field: fieldName, expectedType: 'boolean', receivedType: typeof value },
				)
			}
			break
		}

		case 'timestamp': {
			// The value domain (value-domain.ts, RT-87): whole milliseconds within the range
			// of a JavaScript Date, which every store holds (Postgres BIGINT included).
			const violation = timestampDomainViolation(value)
			if (violation !== null) {
				throw new SchemaValidationError(
					`Field "${fieldName}" in collection "${collection}" ${violation}`,
					{
						collection,
						field: fieldName,
						expectedType: 'timestamp',
						receivedType: typeof value,
						received: value,
					},
				)
			}
			break
		}

		case 'enum': {
			if (typeof value !== 'string') {
				throw new SchemaValidationError(
					`Field "${fieldName}" in collection "${collection}" must be a string (enum), got ${typeof value}`,
					{ collection, field: fieldName, expectedType: 'enum', receivedType: typeof value },
				)
			}
			if (descriptor.enumValues && !descriptor.enumValues.includes(value)) {
				throw new SchemaValidationError(
					`Field "${fieldName}" in collection "${collection}" must be one of: ${descriptor.enumValues.join(', ')}. Got "${value}"`,
					{
						collection,
						field: fieldName,
						allowedValues: [...descriptor.enumValues],
						received: value,
					},
				)
			}
			break
		}

		case 'array': {
			if (!Array.isArray(value)) {
				throw new SchemaValidationError(
					`Field "${fieldName}" in collection "${collection}" must be an array, got ${typeof value}`,
					{ collection, field: fieldName, expectedType: 'array', receivedType: typeof value },
				)
			}
			if (descriptor.itemKind) {
				const expectedType = jsTypeForKind(descriptor.itemKind)
				for (let i = 0; i < value.length; i++) {
					const item = value[i]
					if (
						(descriptor.itemKind === 'timestamp' || descriptor.itemKind === 'number') &&
						item !== null &&
						item !== undefined
					) {
						validateFieldValue(
							collection,
							`${fieldName}[${i}]`,
							{ ...descriptor, kind: descriptor.itemKind, itemKind: null },
							item,
						)
					}
					if (!matchesJsType(item, expectedType)) {
						throw new SchemaValidationError(
							`Field "${fieldName}[${i}]" in collection "${collection}" must be a ${descriptor.itemKind}, got ${typeof item}`,
							{
								collection,
								field: `${fieldName}[${i}]`,
								expectedType: descriptor.itemKind,
								receivedType: typeof item,
							},
						)
					}
				}
			}
			assertStructureInDomain(collection, fieldName, value)
			break
		}

		case 'richtext': {
			// Richtext fields accept Uint8Array/ArrayBuffer (Yjs state) or string
			// (plain text initial value) — matching what the richtext serializer
			// encodes, so no accepted input can be silently lost downstream.
			if (
				!(value instanceof Uint8Array) &&
				!(value instanceof ArrayBuffer) &&
				typeof value !== 'string'
			) {
				throw new SchemaValidationError(
					`Field "${fieldName}" in collection "${collection}" must be a Uint8Array, ArrayBuffer, or string for richtext, got ${typeof value}`,
					{
						collection,
						field: fieldName,
						expectedType: 'richtext',
						receivedType: typeof value,
					},
				)
			}
			break
		}

		case 'object': {
			if (!isPlainObject(value)) {
				throw new SchemaValidationError(
					`Field "${fieldName}" in collection "${collection}" must be a plain object, got ${describeType(value)}`,
					{
						collection,
						field: fieldName,
						expectedType: 'object',
						receivedType: describeType(value),
					},
				)
			}
			// Validate declared nested keys by their own kind. Undeclared keys are
			// allowed (forward-compatible), but a present declared key must type-check.
			if (descriptor.nestedFields) {
				for (const [nestedName, nestedDescriptor] of Object.entries(descriptor.nestedFields)) {
					const nestedValue = (value as Record<string, unknown>)[nestedName]
					if (nestedValue !== undefined && nestedValue !== null) {
						validateFieldValue(
							collection,
							`${fieldName}.${nestedName}`,
							nestedDescriptor,
							nestedValue,
						)
					}
				}
			}
			assertStructureInDomain(collection, fieldName, value)
			break
		}

		case 'json': {
			// Dynamic-key JSON: accept any JSON-serializable value (object, array,
			// scalar, or null). Reject only values that cannot round-trip through
			// JSON, since the store persists them via JSON.stringify.
			const nonJson = findNonJsonSerializable(value, fieldName)
			if (nonJson) {
				throw new SchemaValidationError(
					`Field "${fieldName}" in collection "${collection}" must be JSON-serializable; found ${nonJson.receivedType} at "${nonJson.path}"`,
					{
						collection,
						field: fieldName,
						expectedType: 'json',
						receivedType: nonJson.receivedType,
						path: nonJson.path,
					},
				)
			}
			assertStructureInDomain(collection, fieldName, value)
			break
		}

		case 'blob': {
			// A blob field carries a content-addressed reference, not raw bytes.
			// Developers upload bytes to the blob store (which returns a BlobRef)
			// and assign that reference here.
			if (!isBlobRef(value)) {
				throw new SchemaValidationError(
					`Field "${fieldName}" in collection "${collection}" must be a BlobRef (from the blob store), got ${describeType(value)}`,
					{ collection, field: fieldName, expectedType: 'blob', receivedType: describeType(value) },
				)
			}
			break
		}

		case 'secret': {
			// A secret field takes plaintext as a string on input; the framework
			// applies the at-rest transform (hash or encrypt). Its value is never
			// exposed in traces (redacted in the merge engine).
			if (typeof value !== 'string') {
				throw new SchemaValidationError(
					`Field "${fieldName}" in collection "${collection}" must be a string, got ${describeType(value)}`,
					{
						collection,
						field: fieldName,
						expectedType: 'secret',
						receivedType: describeType(value),
					},
				)
			}
			break
		}
	}
}

/**
 * The value domain of structured values (value-domain.ts): nesting depth and no own
 * `__proto__` key (JSON can carry one, but JavaScript object handling turns it into a
 * prototype and silently drops it, so it is refused everywhere instead).
 */
function assertStructureInDomain(collection: string, fieldName: string, value: unknown): void {
	const reserved = reservedWireShapeViolation(value)
	if (reserved !== null) {
		throw new SchemaValidationError(
			`Field "${fieldName}" in collection "${collection}" ${reserved}.`,
			{ collection, field: fieldName },
		)
	}
	const deep = valueDepthViolation(value)
	if (deep !== null) {
		throw new SchemaValidationError(
			`Field "${fieldName}" in collection "${collection}" nests deeper than ${MAX_VALUE_DEPTH} levels (at "${fieldName}${deep}"). Flatten the value.`,
			{ collection, field: fieldName, path: `${fieldName}${deep}`, maxDepth: MAX_VALUE_DEPTH },
		)
	}
	const proto = protoKeyViolation(value)
	if (proto !== null) {
		throw new SchemaValidationError(
			`Field "${fieldName}" in collection "${collection}" holds a "__proto__" key (at "${fieldName}${proto}"), which cannot be stored and synced unchanged. Rename the key.`,
			{ collection, field: fieldName, path: `${fieldName}${proto}` },
		)
	}
}

/**
 * The domain check of one resolved field value (value-domain.ts), for values produced
 * after validation: an atomic op's resolved result (`op.increment(0.5)` on a timestamp,
 * an increment past the largest finite number).
 *
 * @param collection - The collection (for the message)
 * @param fieldName - The field
 * @param descriptor - The field's descriptor
 * @param value - The resolved value
 * @throws {SchemaValidationError} When the value is outside the field's domain
 */
export function assertResolvedFieldValue(
	collection: string,
	fieldName: string,
	descriptor: FieldDescriptor,
	value: unknown,
): void {
	if (value === null || value === undefined || descriptor.kind === 'richtext') return
	validateFieldValue(collection, fieldName, descriptor, value)
}

/** True for plain data objects only (not arrays, null, or class instances). */
function isPlainObject(value: unknown): boolean {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false
	}
	const proto = Object.getPrototypeOf(value)
	return proto === null || proto === Object.prototype
}

interface NonJsonSerializableValue {
	path: string
	receivedType: string
}

/** Find the first value that cannot safely round-trip through JSON. */
function findNonJsonSerializable(
	value: unknown,
	path: string,
	seen = new WeakSet<object>(),
	nested = false,
): NonJsonSerializableValue | null {
	if (value === null) {
		return null
	}
	// Inside a value, `undefined` has a JSON form, exactly as JSON.stringify and the
	// canonical operation body write it: an object member is absent, an array element
	// is null (F12). The server stores it that way, so refusing it here only made a
	// fire-and-forget write fail on the device while the same value synced fine.
	if (value === undefined && nested) {
		return null
	}
	const type = typeof value
	if (type === 'string' || type === 'number' || type === 'boolean') {
		if (type === 'number' && !Number.isFinite(value as number)) {
			return { path, receivedType: describeType(value) }
		}
		return null
	}
	if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') {
		return { path, receivedType: describeType(value) }
	}
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			const invalid = findNonJsonSerializable(value[index], `${path}[${index}]`, seen, true)
			if (invalid) return invalid
		}
		return null
	}
	if (type === 'object') {
		const objectValue = value as Record<string, unknown>
		if (seen.has(objectValue)) {
			return { path, receivedType: 'circular object' }
		}
		seen.add(objectValue)
		for (const [key, nestedValue] of Object.entries(objectValue)) {
			const invalid = findNonJsonSerializable(nestedValue, `${path}.${key}`, seen, true)
			if (invalid) return invalid
		}
		seen.delete(objectValue)
		return null
	}
	return { path, receivedType: describeType(value) }
}

/** A readable type label for error messages (distinguishes array/null from object). */
function describeType(value: unknown): string {
	if (value === null) {
		return 'null'
	}
	if (Array.isArray(value)) {
		return 'array'
	}
	return typeof value
}

function jsTypeForKind(kind: string): string {
	switch (kind) {
		case 'string':
		case 'enum':
			return 'string'
		case 'number':
		case 'timestamp':
			return 'number'
		case 'boolean':
			return 'boolean'
		default:
			return 'object'
	}
}

function matchesJsType(value: unknown, expected: string): boolean {
	// Using explicit comparisons to satisfy Biome's useValidTypeof rule,
	// which requires typeof to be compared against string literals.
	switch (expected) {
		case 'string':
			return typeof value === 'string'
		case 'number':
			return typeof value === 'number'
		case 'boolean':
			return typeof value === 'boolean'
		case 'object':
			return typeof value === 'object'
		default:
			return false
	}
}
