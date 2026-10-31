import { AccessNotLoadedError, declaresAccess } from '../access/access-slot'
import type { AccessConfigInput, CollectionAccessInput } from '../access/define-access'
import type { MigrationDefinition } from '../migrations/migration-builder'
import type {
	CollectionDefinition,
	CustomResolver,
	FieldDescriptor,
	SchemaDefinition,
} from '../types'
import {
	PENDING_SCHEMA,
	PENDING_SCHEMAS_SLOT,
	type PendingSchemaSlot,
	SCHEMA_FINALIZER_SLOT,
	type SchemaFinalizerSlot,
} from './schema-slot-key'
import type { FieldBuilder } from './types'

/**
 * Input shape for defineSchema() — what the developer writes.
 */
export interface SchemaInput {
	version: number
	collections: Record<string, CollectionInput>
	/**
	 * Membership-based access rules: the memberships collection, the ordered roles and
	 * the group collections whose creator becomes a member. Each collection declares its
	 * own rules in its `access` block.
	 */
	access?: AccessConfigInput
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
	fields: Record<string, FieldBuilder>
	indexes?: string[]
	constraints?: ConstraintInput[]
	resolve?: Record<string, CustomResolver>
	/** Scope fields for sync filtering. Only records matching the client's scope values are synced. */
	scope?: string[]
	/** State machine definition constraining transitions on an enum field */
	stateMachine?: StateMachineInput
	/**
	 * Who may read and write this collection's records (`read`, `create`, `update`,
	 * `delete`, `write` and per-field `fields` rules). Collections without it keep the
	 * grant the auth provider returns.
	 */
	access?: CollectionAccessInput
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
 * Schema definition with a phantom type brand preserving the original input shape.
 * The `__input` property exists only at the type level for inference — no runtime cost.
 */
export type TypedSchemaDefinition<T extends SchemaInput = SchemaInput> = SchemaDefinition & {
	readonly __input: T
}

/**
 * Builds the first-paint descriptor of a schema: its collections and their fields, which is
 * what hooks, the write journal and the first screen read. Everything else a schema declares
 * (names, indexes, constraints, resolvers, scopes, state machines, relations, migrations, sync
 * rules, access rules) is validated and completed by `finalizeSchema`, which loads with the
 * runtime: a schema error then rejects `app.ready`. Development builds, servers and tests
 * register the finalizer first, so there the error is thrown here, at `defineSchema`.
 *
 * @param input - The schema definition using type builders
 * @returns The schema, usable at once; completed in place when it is finalized
 * @throws {SchemaValidationError} If a field builder is invalid, or (finalizer loaded) the schema is
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
export function defineSchema<const T extends SchemaInput>(input: T): TypedSchemaDefinition<T> {
	const collections: Record<string, CollectionDefinition> = {}
	for (const [name, collection] of Object.entries(input.collections ?? {})) {
		const fields: Record<string, FieldDescriptor> = {}
		for (const [fieldName, builder] of Object.entries(collection.fields ?? {})) {
			fields[fieldName] = builder._build()
		}
		collections[name] = {
			fields,
			indexes: collection.indexes ?? [],
			constraints: [],
			resolvers: {},
			scope: [],
			stateMachine: undefined,
		}
	}
	const schema: SchemaDefinition = {
		version: input.version,
		collections,
		relations: {},
		migrations: {},
	}
	Object.defineProperty(schema, PENDING_SCHEMA, {
		value: input,
		configurable: true,
		enumerable: false,
		writable: true,
	})
	const realm = globalThis as PendingSchemaSlot & SchemaFinalizerSlot
	const pending = realm[PENDING_SCHEMAS_SLOT] ?? []
	realm[PENDING_SCHEMAS_SLOT] = pending
	pending.push(schema)
	// Not enumerable: spreading or serializing the schema before the runtime loaded must not throw.
	if (
		declaresAccess(
			input.access,
			Object.fromEntries(Object.entries(input.collections ?? {}).map(([n, c]) => [n, c.access])),
			collections,
		)
	) {
		Object.defineProperty(schema, 'access', {
			enumerable: false,
			configurable: true,
			get() {
				const finalize = realm[SCHEMA_FINALIZER_SLOT]
				if (!finalize) throw new AccessNotLoadedError()
				finalize(schema)
				return schema.access
			},
			set(value) {
				Object.defineProperty(schema, 'access', {
					value,
					enumerable: true,
					configurable: true,
					writable: true,
				})
			},
		})
	}
	realm[SCHEMA_FINALIZER_SLOT]?.(schema)
	return schema as TypedSchemaDefinition<T>
}
