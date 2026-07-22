import type { CollectionDefinition, FieldDescriptor, FieldKind, SchemaDefinition } from '../types'

/**
 * Output of the proto definition generator.
 * Contains the .proto file text, a type mapping, and a JSON descriptor
 * compatible with protobufjs's `Root.fromJSON()`.
 */
export interface ProtoOutput {
	/** The generated .proto file content as a string */
	proto: string
	/** TypeScript type map: field name -> protobuf type */
	typeMap: Map<string, string>
	/** JSON descriptor for dynamic protobufjs usage (no .proto file needed) */
	jsonDescriptor: Record<string, unknown>
}

/**
 * Maps a Kora FieldKind to its protobuf scalar type string.
 * Array and enum kinds are handled separately because they
 * produce composite types (repeated, generated enum).
 */
const SCALAR_TYPE_MAP: Record<Exclude<FieldKind, 'array' | 'enum'>, string> = {
	string: 'string',
	number: 'double',
	boolean: 'bool',
	timestamp: 'int64',
	richtext: 'bytes',
	// object/json values travel as JSON-serialized strings on the proto wire.
	object: 'string',
	json: 'string',
	// A blob field carries a JSON-serialized content-addressed reference, not bytes.
	blob: 'string',
	// A secret field's stored value is a JSON string (ciphertext or hash).
	secret: 'string',
}

/**
 * Maps a Kora FieldKind (when used as an array item) to its protobuf scalar type.
 * Only scalar kinds can be array items.
 */
const ARRAY_ITEM_TYPE_MAP: Record<string, string> = {
	string: 'string',
	number: 'double',
	boolean: 'bool',
	timestamp: 'int64',
}

/**
 * Converts a collection name (snake_case) to PascalCase for protobuf message names.
 * E.g., "todo_items" becomes "TodoItems", "todos" becomes "Todos".
 */
function toPascalCase(name: string): string {
	return name
		.split('_')
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join('')
}

/**
 * Converts a camelCase field name to snake_case for protobuf field names.
 * E.g., "dueDate" becomes "due_date", "createdAt" becomes "created_at".
 */
function toSnakeCase(name: string): string {
	return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

/**
 * Resolves the protobuf type for a single field descriptor.
 *
 * @param fieldName - The field name (used for enum type naming)
 * @param descriptor - The Kora field descriptor
 * @param messageName - Parent message name (used for scoping enum type names)
 * @returns The protobuf type string
 */
function resolveProtoType(
	fieldName: string,
	descriptor: FieldDescriptor,
	messageName: string,
): string {
	if (descriptor.kind === 'enum') {
		return `${messageName}${toPascalCase(fieldName)}`
	}
	if (descriptor.kind === 'array') {
		const itemType = descriptor.itemKind
			? (ARRAY_ITEM_TYPE_MAP[descriptor.itemKind] ?? 'string')
			: 'string'
		return itemType
	}
	return SCALAR_TYPE_MAP[descriptor.kind as Exclude<FieldKind, 'array' | 'enum'>]
}

/**
 * Generates a protobuf enum definition for a Kora enum field.
 * Protobuf enums require the first value to be 0, so we add
 * an UNSPECIFIED sentinel as field 0.
 */
function generateEnumBlock(
	enumTypeName: string,
	enumValues: readonly string[],
	indent: string,
): string {
	const lines: string[] = []
	lines.push(`${indent}enum ${enumTypeName} {`)
	// Proto3 requires field number 0 as a default/unspecified value
	lines.push(`${indent}\t${enumTypeName.toUpperCase()}_UNSPECIFIED = 0;`)
	for (let i = 0; i < enumValues.length; i++) {
		const value = enumValues[i]
		if (value === undefined) continue
		lines.push(`${indent}\t${enumTypeName.toUpperCase()}_${value.toUpperCase()} = ${i + 1};`)
	}
	lines.push(`${indent}}`)
	return lines.join('\n')
}

/**
 * Generates a protobuf message definition for a single Kora collection.
 * Includes nested enum types for any enum fields.
 *
 * @param collectionName - The collection name from the schema
 * @param collection - The collection definition
 * @param typeMap - Accumulator map for field->type mappings
 * @returns The proto message block as a string
 */
function generateCollectionMessage(
	collectionName: string,
	collection: CollectionDefinition,
	typeMap: Map<string, string>,
): string {
	const messageName = `${toPascalCase(collectionName)}Record`
	const lines: string[] = []
	const nestedEnums: string[] = []

	lines.push(`message ${messageName} {`)

	// Field 1 is always "id"
	lines.push('\tstring id = 1;')
	typeMap.set(`${collectionName}.id`, 'string')

	let fieldNumber = 2
	const entries = Object.entries(collection.fields)

	for (const [fieldName, descriptor] of entries) {
		const protoFieldName = toSnakeCase(fieldName)
		const protoType = resolveProtoType(fieldName, descriptor, messageName)
		const mapKey = `${collectionName}.${fieldName}`

		if (descriptor.kind === 'enum' && descriptor.enumValues) {
			const enumTypeName = `${messageName}${toPascalCase(fieldName)}`
			nestedEnums.push(generateEnumBlock(enumTypeName, descriptor.enumValues, '\t'))
			typeMap.set(mapKey, enumTypeName)
			lines.push(`\t${enumTypeName} ${protoFieldName} = ${fieldNumber};`)
		} else if (descriptor.kind === 'array') {
			typeMap.set(mapKey, `repeated ${protoType}`)
			lines.push(`\trepeated ${protoType} ${protoFieldName} = ${fieldNumber};`)
		} else {
			typeMap.set(mapKey, protoType)
			lines.push(`\t${protoType} ${protoFieldName} = ${fieldNumber};`)
		}

		fieldNumber++
	}

	// Insert nested enums before the closing brace
	if (nestedEnums.length > 0) {
		// Place enum definitions after the last field
		lines.push('')
		for (const enumBlock of nestedEnums) {
			lines.push(enumBlock)
		}
	}

	lines.push('}')
	return lines.join('\n')
}

/**
 * The KoraOperation message — the wire format for individual operations.
 * Field assignments match the sync protocol specification from CLAUDE.md.
 */
const KORA_OPERATION_MESSAGE = `message KoraOperation {
\tstring id = 1;
\tstring node_id = 2;
\tstring type = 3;
\tstring collection = 4;
\tstring record_id = 5;
\tbytes data = 6;
\tbytes previous_data = 7;
\tint64 wall_time = 8;
\tint32 logical = 9;
\tstring timestamp_node_id = 10;
\tint64 sequence_number = 11;
\trepeated string causal_deps = 12;
\tint32 schema_version = 13;
}`

/**
 * The OperationBatch message — batches operations for sync transfer.
 */
const OPERATION_BATCH_MESSAGE = `message OperationBatch {
\trepeated KoraOperation operations = 1;
\tbool is_final = 2;
}`

/**
 * The HandshakeMessage — initiates a sync session with version vector exchange.
 */
const HANDSHAKE_MESSAGE = `message HandshakeMessage {
\tmap<string, int64> version_vector = 1;
\tint32 schema_version = 2;
\tstring node_id = 3;
}`

/**
 * The HandshakeResponse — server acknowledges and returns its version vector.
 */
const HANDSHAKE_RESPONSE_MESSAGE = `message HandshakeResponse {
\tmap<string, int64> version_vector = 1;
\tint32 schema_version = 2;
}`

/**
 * The Acknowledgment message — confirms receipt of an operation batch.
 */
const ACKNOWLEDGMENT_MESSAGE = `message Acknowledgment {
\tint64 sequence_number = 1;
\tstring node_id = 2;
}`

/**
 * Builds a JSON descriptor object compatible with protobufjs Root.fromJSON().
 * This allows runtime usage of the proto definitions without parsing .proto text.
 */
function buildJsonDescriptor(schema: SchemaDefinition): Record<string, unknown> {
	const nested: Record<string, unknown> = {}

	// Per-collection record messages
	for (const [collectionName, collection] of Object.entries(schema.collections)) {
		const messageName = `${toPascalCase(collectionName)}Record`
		const fields: Record<string, unknown> = {
			id: { type: 'string', id: 1 },
		}
		const nestedTypes: Record<string, unknown> = {}

		let fieldNumber = 2
		for (const [fieldName, descriptor] of Object.entries(collection.fields)) {
			const protoFieldName = toSnakeCase(fieldName)
			const fieldDef: Record<string, unknown> = { id: fieldNumber }

			if (descriptor.kind === 'enum' && descriptor.enumValues) {
				const enumTypeName = `${messageName}${toPascalCase(fieldName)}`
				fieldDef.type = enumTypeName

				// Build enum values object for protobufjs
				const enumValuesObj: Record<string, number> = {
					[`${enumTypeName.toUpperCase()}_UNSPECIFIED`]: 0,
				}
				for (let i = 0; i < descriptor.enumValues.length; i++) {
					const val = descriptor.enumValues[i]
					if (val === undefined) continue
					enumValuesObj[`${enumTypeName.toUpperCase()}_${val.toUpperCase()}`] = i + 1
				}
				nestedTypes[enumTypeName] = { values: enumValuesObj }
			} else if (descriptor.kind === 'array') {
				const itemType = descriptor.itemKind
					? (ARRAY_ITEM_TYPE_MAP[descriptor.itemKind] ?? 'string')
					: 'string'
				fieldDef.type = itemType
				fieldDef.rule = 'repeated'
			} else {
				fieldDef.type = SCALAR_TYPE_MAP[descriptor.kind as Exclude<FieldKind, 'array' | 'enum'>]
			}

			fields[protoFieldName] = fieldDef
			fieldNumber++
		}

		const messageDescriptor: Record<string, unknown> = { fields }
		if (Object.keys(nestedTypes).length > 0) {
			messageDescriptor.nested = nestedTypes
		}
		nested[messageName] = messageDescriptor
	}

	// KoraOperation
	nested.KoraOperation = {
		fields: {
			id: { type: 'string', id: 1 },
			node_id: { type: 'string', id: 2 },
			type: { type: 'string', id: 3 },
			collection: { type: 'string', id: 4 },
			record_id: { type: 'string', id: 5 },
			data: { type: 'bytes', id: 6 },
			previous_data: { type: 'bytes', id: 7 },
			wall_time: { type: 'int64', id: 8 },
			logical: { type: 'int32', id: 9 },
			timestamp_node_id: { type: 'string', id: 10 },
			sequence_number: { type: 'int64', id: 11 },
			causal_deps: { type: 'string', id: 12, rule: 'repeated' },
			schema_version: { type: 'int32', id: 13 },
		},
	}

	// OperationBatch
	nested.OperationBatch = {
		fields: {
			operations: { type: 'KoraOperation', id: 1, rule: 'repeated' },
			is_final: { type: 'bool', id: 2 },
		},
	}

	// HandshakeMessage
	nested.HandshakeMessage = {
		fields: {
			version_vector: { keyType: 'string', type: 'int64', id: 1 },
			schema_version: { type: 'int32', id: 2 },
			node_id: { type: 'string', id: 3 },
		},
	}

	// HandshakeResponse
	nested.HandshakeResponse = {
		fields: {
			version_vector: { keyType: 'string', type: 'int64', id: 1 },
			schema_version: { type: 'int32', id: 2 },
		},
	}

	// Acknowledgment
	nested.Acknowledgment = {
		fields: {
			sequence_number: { type: 'int64', id: 1 },
			node_id: { type: 'string', id: 2 },
		},
	}

	return {
		nested: {
			kora: { nested },
		},
	}
}

/**
 * Generates Protocol Buffer definitions from a Kora schema.
 *
 * Produces three outputs:
 * 1. A `.proto` file string conforming to proto3 syntax
 * 2. A type map linking Kora field paths to protobuf types
 * 3. A JSON descriptor for runtime protobufjs usage via `Root.fromJSON()`
 *
 * The generated definitions include:
 * - Per-collection record messages with proper type mappings
 * - Nested enum types for enum fields
 * - `KoraOperation` wrapper for the sync wire format
 * - `OperationBatch` for batched sync transfers
 * - `HandshakeMessage` / `HandshakeResponse` for sync session initiation
 * - `Acknowledgment` for delivery confirmation
 *
 * @param schema - A validated SchemaDefinition from defineSchema()
 * @returns ProtoOutput with proto text, type map, and JSON descriptor
 *
 * @example
 * ```typescript
 * import { defineSchema, t, generateProtoDefinitions } from '@korajs/core'
 *
 * const schema = defineSchema({
 *   version: 1,
 *   collections: {
 *     todos: {
 *       fields: {
 *         title: t.string(),
 *         completed: t.boolean().default(false),
 *       }
 *     }
 *   }
 * })
 *
 * const { proto, typeMap, jsonDescriptor } = generateProtoDefinitions(schema)
 * // proto is a valid .proto file string
 * // typeMap maps "todos.title" -> "string", "todos.completed" -> "bool"
 * // jsonDescriptor can be loaded with protobuf.Root.fromJSON()
 * ```
 */
export function generateProtoDefinitions(schema: SchemaDefinition): ProtoOutput {
	const typeMap = new Map<string, string>()
	const sections: string[] = []

	// Proto3 header
	sections.push('syntax = "proto3";')
	sections.push('')
	sections.push('package kora;')

	// Per-collection messages
	const collectionEntries = Object.entries(schema.collections)
	if (collectionEntries.length > 0) {
		sections.push('')
		sections.push('// Collection record messages')
		for (const [collectionName, collection] of collectionEntries) {
			sections.push('')
			sections.push(generateCollectionMessage(collectionName, collection, typeMap))
		}
	}

	// Sync protocol messages
	sections.push('')
	sections.push('// Sync protocol messages')
	sections.push('')
	sections.push(KORA_OPERATION_MESSAGE)
	sections.push('')
	sections.push(OPERATION_BATCH_MESSAGE)
	sections.push('')
	sections.push(HANDSHAKE_MESSAGE)
	sections.push('')
	sections.push(HANDSHAKE_RESPONSE_MESSAGE)
	sections.push('')
	sections.push(ACKNOWLEDGMENT_MESSAGE)

	const proto = `${sections.join('\n')}\n`
	const jsonDescriptor = buildJsonDescriptor(schema)

	return { proto, typeMap, jsonDescriptor }
}
