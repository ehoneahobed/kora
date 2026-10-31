import type { SchemaDefinition } from '../types'

/** Completes a schema built by `defineSchema` (see `finalizeSchema`). */
export type SchemaFinalizer = (schema: SchemaDefinition) => void

// One slot per JavaScript realm, like the access compiler's: the lite entry defines the schema
// and the full entry holds the finalizer, which may be different copies of this module.
export const SCHEMA_FINALIZER_SLOT = Symbol.for('@korajs/core:schema-finalizer')
export const PENDING_SCHEMAS_SLOT = Symbol.for('@korajs/core:pending-schemas')

/** Where `defineSchema` keeps the input a schema is finalized from. */
export const PENDING_SCHEMA = Symbol.for('@korajs/core:pending-schema')

/** The globalThis shape that holds the registered finalizer. */
export interface SchemaFinalizerSlot {
	[SCHEMA_FINALIZER_SLOT]?: SchemaFinalizer
}

/** The globalThis shape that lists the schemas still waiting to be finalized. */
export interface PendingSchemaSlot {
	[PENDING_SCHEMAS_SLOT]?: SchemaDefinition[]
}
