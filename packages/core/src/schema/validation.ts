import { isBlobRef } from '../blob/blob-ref'
import { SchemaValidationError } from '../errors/errors'
import { isAtomicOp } from '../operations/atomic-ops'
import type { CollectionDefinition, FieldDescriptor, OperationType } from '../types'

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
					result[fieldName] = value
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
		result[fieldName] = value
	}

	return result
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
			if (typeof value !== 'number' || Number.isNaN(value)) {
				throw new SchemaValidationError(
					`Field "${fieldName}" in collection "${collection}" must be a number, got ${typeof value}`,
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
			if (typeof value !== 'number' || !Number.isFinite(value)) {
				throw new SchemaValidationError(
					`Field "${fieldName}" in collection "${collection}" must be a timestamp (number), got ${typeof value}`,
					{
						collection,
						field: fieldName,
						expectedType: 'timestamp',
						receivedType: typeof value,
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
			break
		}

		case 'json': {
			// Dynamic-key JSON: accept any JSON-serializable value (object, array,
			// scalar, or null). Reject only values that cannot round-trip through
			// JSON, since the store persists them via JSON.stringify.
			if (!isJsonSerializable(value)) {
				throw new SchemaValidationError(
					`Field "${fieldName}" in collection "${collection}" must be JSON-serializable, got ${describeType(value)}`,
					{ collection, field: fieldName, expectedType: 'json', receivedType: describeType(value) },
				)
			}
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

/** True for plain data objects only (not arrays, null, or class instances). */
function isPlainObject(value: unknown): boolean {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false
	}
	const proto = Object.getPrototypeOf(value)
	return proto === null || proto === Object.prototype
}

/** True when the value can round-trip through JSON (no functions/symbols/undefined). */
function isJsonSerializable(value: unknown): boolean {
	if (value === null) {
		return true
	}
	const type = typeof value
	if (type === 'string' || type === 'number' || type === 'boolean') {
		return Number.isFinite(value as number) || type !== 'number'
	}
	if (Array.isArray(value)) {
		return value.every(isJsonSerializable)
	}
	if (type === 'object') {
		return Object.values(value as Record<string, unknown>).every(isJsonSerializable)
	}
	return false
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
