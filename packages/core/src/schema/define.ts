import { SchemaValidationError } from '../errors/errors'
import type {
	CollectionDefinition,
	Constraint,
	CustomResolver,
	FieldDescriptor,
	RelationDefinition,
	SchemaDefinition,
} from '../types'
import type { FieldBuilder } from './types'

/** Valid collection name pattern: lowercase, alphanumeric + underscore, starting with letter */
const COLLECTION_NAME_RE = /^[a-z][a-z0-9_]*$/

/** Valid field name pattern: camelCase allowed (e.g. createdAt, dueDate) */
const FIELD_NAME_RE = /^[a-z][a-zA-Z0-9_]*$/

/** Reserved field names that cannot be used in schemas */
const RESERVED_FIELDS = new Set(['id', '_created_at', '_updated_at', '_deleted'])

/**
 * Input shape for defineSchema() — what the developer writes.
 */
export interface SchemaInput {
	version: number
	collections: Record<string, CollectionInput>
	relations?: Record<string, RelationInput>
}

export interface CollectionInput {
	fields: Record<string, FieldBuilder<any, any, any>>
	indexes?: string[]
	constraints?: ConstraintInput[]
	resolve?: Record<string, CustomResolver>
}

export interface ConstraintInput {
	type: 'unique' | 'capacity' | 'referential'
	fields: string[]
	where?: Record<string, unknown>
	onConflict:
		| 'first-write-wins'
		| 'last-write-wins'
		| 'priority-field'
		| 'server-decides'
		| 'custom'
	priorityField?: string
	resolve?: (local: unknown, remote: unknown, base: unknown) => unknown
}

export interface RelationInput {
	from: string
	to: string
	type: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many'
	field: string
	onDelete: 'cascade' | 'set-null' | 'restrict' | 'no-action'
}

/**
 * Validates and builds a SchemaDefinition from developer input.
 * This is the primary developer-facing function for defining a schema.
 *
 * @param input - The schema definition using type builders
 * @returns A validated SchemaDefinition ready for use by the framework
 * @throws {SchemaValidationError} If the schema is invalid
 *
 * @example
 * ```typescript
 * import { defineSchema, t } from '@korajs/core'
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
 * ```
 */
/**
 * Schema definition with a phantom type brand preserving the original input shape.
 * The `__input` property exists only at the type level for inference — no runtime cost.
 */
export type TypedSchemaDefinition<T extends SchemaInput = SchemaInput> = SchemaDefinition & {
	readonly __input: T
}

export function defineSchema<const T extends SchemaInput>(input: T): TypedSchemaDefinition<T> {
	validateVersion(input.version)

	const collections: Record<string, CollectionDefinition> = {}

	for (const [name, collectionInput] of Object.entries(input.collections)) {
		validateCollectionName(name)
		collections[name] = buildCollection(name, collectionInput)
	}

	if (Object.keys(collections).length === 0) {
		throw new SchemaValidationError('Schema must define at least one collection')
	}

	const relations: Record<string, RelationDefinition> = {}
	if (input.relations) {
		for (const [name, relationInput] of Object.entries(input.relations)) {
			validateRelation(name, relationInput, collections)
			relations[name] = { ...relationInput }
		}
	}

	return { version: input.version, collections, relations } as TypedSchemaDefinition<T>
}

function validateVersion(version: number): void {
	if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
		throw new SchemaValidationError('Schema version must be a positive integer', {
			received: version,
		})
	}
}

function validateCollectionName(name: string): void {
	if (!COLLECTION_NAME_RE.test(name)) {
		throw new SchemaValidationError(
			`Collection name "${name}" is invalid. Must be lowercase, start with a letter, and contain only letters, numbers, and underscores.`,
			{ collection: name },
		)
	}
}

function buildCollection(name: string, input: CollectionInput): CollectionDefinition {
	const fields: Record<string, FieldDescriptor> = {}

	if (!input.fields || Object.keys(input.fields).length === 0) {
		throw new SchemaValidationError(`Collection "${name}" must define at least one field`, {
			collection: name,
		})
	}

	for (const [fieldName, builder] of Object.entries(input.fields)) {
		validateFieldName(name, fieldName)
		fields[fieldName] = builder._build()
	}

	const indexes = input.indexes ?? []
	for (const indexField of indexes) {
		if (!(indexField in fields)) {
			throw new SchemaValidationError(
				`Index field "${indexField}" does not exist in collection "${name}". Available fields: ${Object.keys(fields).join(', ')}`,
				{ collection: name, field: indexField },
			)
		}
	}

	const constraints: Constraint[] = []
	if (input.constraints) {
		for (const constraintInput of input.constraints) {
			validateConstraint(name, constraintInput, fields)
			constraints.push({ ...constraintInput })
		}
	}

	const resolvers: Record<string, CustomResolver> = {}
	if (input.resolve) {
		for (const [fieldName, resolver] of Object.entries(input.resolve)) {
			if (!(fieldName in fields)) {
				throw new SchemaValidationError(
					`Resolver for field "${fieldName}" does not exist in collection "${name}". Available fields: ${Object.keys(fields).join(', ')}`,
					{ collection: name, field: fieldName },
				)
			}
			if (typeof resolver !== 'function') {
				throw new SchemaValidationError(
					`Resolver for field "${fieldName}" in collection "${name}" must be a function`,
					{ collection: name, field: fieldName },
				)
			}
			resolvers[fieldName] = resolver
		}
	}

	return { fields, indexes, constraints, resolvers }
}

function validateFieldName(collection: string, fieldName: string): void {
	if (RESERVED_FIELDS.has(fieldName)) {
		throw new SchemaValidationError(
			`Field name "${fieldName}" is reserved in collection "${collection}". Reserved fields: ${[...RESERVED_FIELDS].join(', ')}`,
			{ collection, field: fieldName },
		)
	}
	if (!FIELD_NAME_RE.test(fieldName)) {
		throw new SchemaValidationError(
			`Field name "${fieldName}" in collection "${collection}" is invalid. Must start with a lowercase letter and contain only letters, numbers, and underscores.`,
			{ collection, field: fieldName },
		)
	}
}

function validateConstraint(
	collection: string,
	constraint: ConstraintInput,
	fields: Record<string, FieldDescriptor>,
): void {
	for (const field of constraint.fields) {
		if (!(field in fields)) {
			throw new SchemaValidationError(
				`Constraint references field "${field}" which does not exist in collection "${collection}". Available fields: ${Object.keys(fields).join(', ')}`,
				{ collection, field },
			)
		}
	}

	if (constraint.onConflict === 'priority-field' && !constraint.priorityField) {
		throw new SchemaValidationError(
			`Constraint with "priority-field" onConflict strategy in collection "${collection}" requires a priorityField`,
			{ collection },
		)
	}

	if (constraint.onConflict === 'priority-field' && constraint.priorityField) {
		if (!(constraint.priorityField in fields)) {
			throw new SchemaValidationError(
				`Constraint priorityField "${constraint.priorityField}" does not exist in collection "${collection}"`,
				{ collection, field: constraint.priorityField },
			)
		}
	}

	if (constraint.onConflict === 'custom' && typeof constraint.resolve !== 'function') {
		throw new SchemaValidationError(
			`Constraint with "custom" onConflict strategy in collection "${collection}" requires a resolve function`,
			{ collection },
		)
	}
}

function validateRelation(
	name: string,
	relation: RelationInput,
	collections: Record<string, CollectionDefinition>,
): void {
	if (!(relation.from in collections)) {
		throw new SchemaValidationError(
			`Relation "${name}" references source collection "${relation.from}" which does not exist. Available collections: ${Object.keys(collections).join(', ')}`,
			{ relation: name, collection: relation.from },
		)
	}

	if (!(relation.to in collections)) {
		throw new SchemaValidationError(
			`Relation "${name}" references target collection "${relation.to}" which does not exist. Available collections: ${Object.keys(collections).join(', ')}`,
			{ relation: name, collection: relation.to },
		)
	}

	const fromCollection = collections[relation.from]
	if (fromCollection && !(relation.field in fromCollection.fields)) {
		throw new SchemaValidationError(
			`Relation "${name}" references field "${relation.field}" which does not exist in collection "${relation.from}". Available fields: ${Object.keys(fromCollection.fields).join(', ')}`,
			{ relation: name, collection: relation.from, field: relation.field },
		)
	}
}
