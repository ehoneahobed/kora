import { KoraError } from '../errors/errors'
import type { CollectionDefinition, RelationDefinition, SchemaDefinition } from '../types'
import {
	ACCESS_COMPILER_SLOT,
	type AccessCompileArgs,
	type AccessCompilerSlot,
} from './access-slot-key'
import type { AccessConfigInput, AccessDefinition, CollectionAccessInput } from './define-access'

/**
 * Thrown when `schema.access` is read before anything that can compile it has loaded.
 * Access rules are validated and compiled by code that production browser builds load with
 * the runtime, after the first paint, to keep it out of the first-paint bundle.
 */
export class AccessNotLoadedError extends KoraError {
	constructor() {
		super(
			'schema.access was read before the Kora runtime loaded. In production browser builds the access rules of a schema are validated and compiled when the runtime loads (await app.ready); in development builds they are validated when defineSchema runs.',
			'ACCESS_NOT_LOADED',
			{
				fix: 'Await app.ready before reading schema.access, or import @korajs/core where you read it.',
			},
		)
		this.name = 'AccessNotLoadedError'
	}
}

/**
 * Whether the schema input declares anything `buildAccessDefinition` has to look at: an
 * `access` block, a collection `access`, or a `stamp()` field (which is an error without rules).
 */
export function declaresAccess(
	config: AccessConfigInput | undefined,
	collectionAccess: Readonly<Record<string, CollectionAccessInput | undefined>>,
	collections: Readonly<Record<string, CollectionDefinition>>,
): boolean {
	if (config !== undefined) return true
	if (Object.values(collectionAccess).some((entry) => entry !== undefined)) return true
	return Object.values(collections).some((collection) =>
		Object.values(collection.fields).some((field) => field.stamp),
	)
}

/**
 * Attaches the compiled `access` to a schema being finalized. Finalizing only happens once the
 * access compiler is registered (`registerAccessCompiler` registers both), so the rules are
 * validated and compiled here and a bad rule throws `SchemaValidationError`.
 *
 * @param schema - The schema object being finalized
 * @param args - The declarations to compile
 * @throws {AccessNotLoadedError} If the compiler is not registered (a caller bypassed `finalizeSchema`)
 */
export function attachAccess(schema: SchemaDefinition, args: AccessCompileArgs): void {
	if (!declaresAccess(args.config, args.collectionAccess, args.collections)) return
	const loaded = (globalThis as AccessCompilerSlot)[ACCESS_COMPILER_SLOT]
	if (!loaded) throw new AccessNotLoadedError()
	const access = loaded(args)
	if (access) schema.access = access
}
