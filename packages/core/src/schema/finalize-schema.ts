import { attachAccess } from '../access/access-slot'
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
import type {
	CollectionInput,
	ConstraintInput,
	RelationInput,
	SchemaInput,
	StateMachineInput,
} from './define'
import { PENDING_SCHEMA, PENDING_SCHEMAS_SLOT, type PendingSchemaSlot } from './schema-slot-key'

/**
 * Valid collection name pattern: starts with a letter, then letters, numbers,
 * and underscores. Case is preserved, so camelCase (`formResponses`) and
 * PascalCase (`UserProfiles`) are allowed — generated SQL quotes every
 * identifier (see `quoteIdent`), so mixed case and even reserved words like
 * `order` round-trip safely. The leading-letter rule keeps names clear of the
 * framework's own `_`-prefixed tables.
 */
const COLLECTION_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/

/** Valid field name pattern: camelCase allowed (e.g. createdAt, dueDate) */
const FIELD_NAME_RE = /^[a-z][a-zA-Z0-9_]*$/

/** Reserved field names that cannot be used in schemas */
const RESERVED_FIELDS = new Set(['id', '_created_at', '_updated_at', '_version', '_deleted'])

/**
 * Validates a schema built by the lite `defineSchema` and completes it in place: collection
 * names, indexes, constraints, resolvers, scopes, state machines, relations, migrations, sync
 * rules and access rules. Safe to call again (a finalized schema is left alone).
 *
 * `defineSchema` returns the first-paint descriptor synchronously; this is the rest of what it
 * used to do, loaded with the runtime (or at once in development builds, servers and tests).
 *
 * @param schema - A schema returned by `defineSchema`
 * @throws {SchemaValidationError} If the schema is invalid
 */
export function finalizeSchema(schema: SchemaDefinition): void {
	const slot = schema as unknown as { [PENDING_SCHEMA]?: SchemaInput }
	const input = slot[PENDING_SCHEMA]
	if (input === undefined) return

	validateVersion(input.version)

	const collections = schema.collections
	for (const [name, collectionInput] of Object.entries(input.collections)) {
		validateCollectionName(name)
		const built = buildCollection(name, collectionInput)
		const existing = collections[name]
		if (existing) Object.assign(existing, built)
		else collections[name] = built
	}

	if (Object.keys(collections).length === 0) {
		throw new SchemaValidationError('Schema must define at least one collection')
	}

	if (input.relations) {
		for (const [name, relationInput] of Object.entries(input.relations)) {
			validateRelation(name, relationInput, collections)
			schema.relations[name] = { ...relationInput }
		}
	}

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
			schema.migrations[version] = migration as MigrationDefinition
		}
	}

	const sync = buildSyncRules(input.sync, collections)
	applySyncRulesToCollectionScope(collections, sync)
	if (sync) schema.sync = sync

	// The lite descriptor hid `access` behind a getter; the compiled value replaces it. When the
	// rules are invalid the getter must stay: a schema that failed to finalize must keep throwing
	// when `access` is read, never answer "no rules" (undefined) and run unprotected.
	const hidden = Object.getOwnPropertyDescriptor(schema, 'access')
	Reflect.deleteProperty(schema, 'access')
	try {
		attachAccess(schema, {
			config: input.access,
			collectionAccess: Object.fromEntries(
				Object.entries(input.collections).map(([name, collection]) => [name, collection.access]),
			),
			collections,
			relations: schema.relations,
		})
	} catch (error) {
		if (hidden) Object.defineProperty(schema, 'access', hidden)
		throw error
	}

	// Finalized: done only after everything passed, so a failure is reported again on the next call.
	delete slot[PENDING_SCHEMA]
	Reflect.deleteProperty(schema, 'toJSON')
	const pending = (globalThis as PendingSchemaSlot)[PENDING_SCHEMAS_SLOT]
	if (pending) {
		const index = pending.indexOf(schema)
		if (index >= 0) pending.splice(index, 1)
	}
}

/**
 * Finalizes every schema defined before the finalizer was available (a schema module that was
 * evaluated before the runtime loaded). A schema that fails stays pending and reports its error
 * when something finalizes it explicitly.
 */
export function finalizePendingSchemas(): void {
	const pending = (globalThis as PendingSchemaSlot)[PENDING_SCHEMAS_SLOT]
	if (!pending) return
	for (const schema of [...pending]) {
		try {
			finalizeSchema(schema)
		} catch {
			// Reported by the explicit finalize (the runtime, a Store, a server).
		}
	}
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
			`Collection name "${name}" is invalid. Must start with a letter and contain only letters, numbers, and underscores.`,
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

	// Field-level `t.enum(...).transitions({...})` (NEW-STORE-3) is the documented
	// shorthand for a state machine on that field, with the default 'reject' mode.
	// With exactly one such field and no collection-level definition, it becomes
	// the collection's state machine, so every layer that reads `stateMachine`
	// (local writes, transactions, merge) sees it. Local writes also enforce every
	// field-level transition map directly, so a collection may declare several.
	if (!stateMachine) {
		const transitionFields = Object.entries(fields).filter(
			([, descriptor]) => descriptor.kind === 'enum' && descriptor.transitions,
		)
		const only = transitionFields.length === 1 ? transitionFields[0] : undefined
		if (only?.[1].transitions) {
			const derived: StateMachineInput = {
				field: only[0],
				transitions: { ...only[1].transitions },
				onInvalidTransition: 'reject',
			}
			validateStateMachineDefinition(name, derived, fields)
			stateMachine = derived
		}
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

	// A unique or capacity constraint's `where` selects the records it applies to by
	// plain equality. An operator object (`{ $ne: 'draft' }`) or a field that does not
	// exist would match no record, silently disabling the constraint (F2), so both are
	// refused here. A referential constraint's `where` holds metadata (`collection`).
	if (constraint.where !== undefined && constraint.type !== 'referential') {
		for (const [key, value] of Object.entries(constraint.where)) {
			if (key !== 'id' && !(key in fields)) {
				throw new SchemaValidationError(
					`Constraint where references field "${key}" which does not exist in collection "${collection}". Available fields: ${Object.keys(fields).join(', ')}`,
					{ collection, field: key },
				)
			}
			if (value !== null && typeof value === 'object') {
				throw new SchemaValidationError(
					`Constraint where on "${collection}.${key}" uses ${Array.isArray(value) ? 'an array' : `the operator object ${JSON.stringify(value)}`}, but constraint where matches by plain equality only, so the constraint would never apply. Use an equality value (for example { ${key}: 'published' }), or enforce the rule in validateOperation or a server route.`,
					{ collection, field: key },
				)
			}
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
