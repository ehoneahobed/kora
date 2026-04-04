import { SchemaValidationError } from '../errors/errors'
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
				if (value !== undefined && value !== null) {
					validateFieldValue(collection, fieldName, descriptor, value)
				}
				result[fieldName] = value
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
			// Richtext fields accept Uint8Array (Yjs state) or string (plain text initial value)
			if (!(value instanceof Uint8Array) && typeof value !== 'string') {
				throw new SchemaValidationError(
					`Field "${fieldName}" in collection "${collection}" must be a Uint8Array or string for richtext, got ${typeof value}`,
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
	}
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
