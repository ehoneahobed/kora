import { SchemaValidationError } from '../errors/errors'
import type { MigrationDefinition } from '../migrations/migration-builder'
import { normalizeSyncRuleWhere } from '../scopes/sync-scope-bindings'
import { validateStateMachineDefinition } from '../state-machine/state-machine'
import type {
	CollectionDefinition,
	Constraint,
	CustomResolver,
	FieldDescriptor,
	RelationDefinition,
	SchemaDefinition,
	StateMachineDefinition,
	SyncRuleDefinition,
} from '../types'
import type { FieldBuilder } from './types'

/** Valid collection name pattern: lowercase, alphanumeric + underscore, starting with letter */
const COLLECTION_NAME_RE = /^[a-z][a-z0-9_]*$/

/** Valid field name pattern: camelCase allowed (e.g. createdAt, dueDate) */
const FIELD_NAME_RE = /^[a-z][a-zA-Z0-9_]*$/

/** Reserved field names that cannot be used in schemas */
const RESERVED_FIELDS = new Set(['id', '_created_at', '_updated_at', '_version', '_deleted'])

/**
 * Input shape for defineSchema() — what the developer writes.
 */
export interface SchemaInput {
	version: number
	collections: Record<string, CollectionInput>
	relations?: Record<string, RelationInput>
	/** Schema migrations keyed by target version number. */
	migrations?: Record<number, MigrationDefinition>
	/**
	 * Declarative partial-sync rules.
	 *
	 * @example
	 * ```typescript
	 * sync: {
	 *   todos: { where: { userId: true, orgId: true } },
	 *   projects: { where: { orgId: true } },
	 * }
	 * ```
	 */
	sync?: Record<string, SyncRuleInput>
}

/**
 * Developer input for a collection sync rule.
 */
export interface SyncRuleInput {
	/**
	 * Field filters bound to scope values.
	 * Use `true` to bind a field to a scope value with the same name.
	 * Use a string to bind to a different scope value key.
	 */
	where: Record<string, boolean | string>
}

export interface StateMachineInput {
	/** The enum field this state machine controls */
	field: string
	/** Map of state to allowed next states */
	transitions: Record<string, string[]>
	/** What to do when an invalid transition is attempted */
	onInvalidTransition: 'reject' | 'last-valid-state'
}

export interface CollectionInput {
	// biome-ignore lint/suspicious/noExplicitAny: Required for TypeScript conditional type inference
	fields: Record<string, FieldBuilder<any, any, any>>
	indexes?: string[]
	constraints?: ConstraintInput[]
	resolve?: Record<string, CustomResolver>
	/** Scope fields for sync filtering. Only records matching the client's scope values are synced. */
	scope?: string[]
	/** State machine definition constraining transitions on an enum field */
	stateMachine?: StateMachineInput
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

	const migrations: Record<number, MigrationDefinition> = {}
	if (input.migrations) {
		for (const [versionStr, migration] of Object.entries(input.migrations)) {
			const version = Number(versionStr)
			if (!Number.isInteger(version) || version < 2) {
				throw new SchemaValidationError(
					`Migration key "${versionStr}" is invalid. Must be an integer >= 2 (version 1 is the initial schema).`,
					{ version: versionStr },
				)
			}
			if (version > input.version) {
				throw new SchemaValidationError(
					`Migration version ${version} exceeds schema version ${input.version}. Migrations must target versions <= schema version.`,
					{ migrationVersion: version, schemaVersion: input.version },
				)
			}
			if (!migration.steps || migration.steps.length === 0) {
				throw new SchemaValidationError(
					`Migration for version ${version} has no steps. Use migrate() to define at least one step.`,
					{ version },
				)
			}
			migrations[version] = migration
		}
	}

	const sync = buildSyncRules(input.sync, collections)
	applySyncRulesToCollectionScope(collections, sync)

	return {
		version: input.version,
		collections,
		relations,
		migrations,
		...(sync ? { sync } : {}),
	} as TypedSchemaDefinition<T>
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

	const scope: string[] = []
	if (input.scope) {
		for (const scopeField of input.scope) {
			if (!(scopeField in fields)) {
				throw new SchemaValidationError(
					`Scope field "${scopeField}" does not exist in collection "${name}". Available fields: ${Object.keys(fields).join(', ')}`,
					{ collection: name, field: scopeField },
				)
			}
			scope.push(scopeField)
		}
	}

	let stateMachine: StateMachineDefinition | undefined
	if (input.stateMachine) {
		validateStateMachineDefinition(name, input.stateMachine, fields)
		stateMachine = { ...input.stateMachine }
	}

	return { fields, indexes, constraints, resolvers, scope, stateMachine }
}

function buildSyncRules(
	syncInput: SchemaInput['sync'],
	collections: Record<string, CollectionDefinition>,
): Record<string, SyncRuleDefinition> | undefined {
	if (!syncInput) {
		return undefined
	}

	const sync: Record<string, SyncRuleDefinition> = {}

	for (const [collectionName, ruleInput] of Object.entries(syncInput)) {
		if (!(collectionName in collections)) {
			throw new SchemaValidationError(
				`Sync rule references collection "${collectionName}" which does not exist. Available collections: ${Object.keys(collections).join(', ')}`,
				{ collection: collectionName },
			)
		}

		if (!ruleInput.where || Object.keys(ruleInput.where).length === 0) {
			throw new SchemaValidationError(
				`Sync rule for collection "${collectionName}" must declare at least one where binding`,
				{ collection: collectionName },
			)
		}

		const collection = collections[collectionName]
		if (!collection) {
			continue
		}

		for (const fieldName of Object.keys(ruleInput.where)) {
			if (!(fieldName in collection.fields)) {
				throw new SchemaValidationError(
					`Sync rule where field "${fieldName}" does not exist in collection "${collectionName}". Available fields: ${Object.keys(collection.fields).join(', ')}`,
					{ collection: collectionName, field: fieldName },
				)
			}
		}

		try {
			sync[collectionName] = { where: normalizeSyncRuleWhere(collectionName, ruleInput.where) }
		} catch (error) {
			throw new SchemaValidationError(
				error instanceof Error ? error.message : 'Invalid sync rule',
				{ collection: collectionName },
			)
		}
	}

	return sync
}

function applySyncRulesToCollectionScope(
	collections: Record<string, CollectionDefinition>,
	sync: Record<string, SyncRuleDefinition> | undefined,
): void {
	if (!sync) {
		return
	}

	for (const [collectionName, rule] of Object.entries(sync)) {
		const collection = collections[collectionName]
		if (!collection) {
			continue
		}

		for (const fieldName of Object.keys(rule.where)) {
			if (!collection.scope.includes(fieldName)) {
				collection.scope.push(fieldName)
			}
		}
	}
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
