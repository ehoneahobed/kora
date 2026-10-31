import type { CollectionDefinition, RelationDefinition } from '../types'
import type { AccessConfigInput, AccessDefinition, CollectionAccessInput } from './define-access'

/** Everything `buildAccessDefinition` reads, captured when the schema is defined. */
export interface AccessCompileArgs {
	config: AccessConfigInput | undefined
	collectionAccess: Readonly<Record<string, CollectionAccessInput | undefined>>
	collections: Readonly<Record<string, CollectionDefinition>>
	relations: Readonly<Record<string, RelationDefinition>>
}

/** Validates and compiles a schema's access declarations. */
export type AccessCompiler = (args: AccessCompileArgs) => AccessDefinition | undefined

// One slot per JavaScript realm: the lite entry (which defines the schema) and the full
// entry (which holds the compiler) may be different copies of this module in one bundle.
export const ACCESS_COMPILER_SLOT = Symbol.for('@korajs/core:access-compiler')

/** The globalThis shape that holds the registered compiler. */
export interface AccessCompilerSlot {
	[ACCESS_COMPILER_SLOT]?: AccessCompiler
}
