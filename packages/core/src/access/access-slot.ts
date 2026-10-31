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
 * Attaches `access` to a schema being defined.
 *
 * - When the access compiler is already loaded (a server, a development build of `korajs`, the
 *   runtime), the rules are validated and compiled now, so a bad rule fails at `defineSchema`.
 * - When it is not (a production browser build, where the validation code is not in the
 *   first-paint bundle), `access` becomes a getter that compiles on first read. The runtime
 *   reads it as the first thing it loads, so the same `SchemaValidationError` rejects `app.ready`.
 *
 * @param schema - The schema object being built
 * @param args - The declarations to compile
 */
export function attachAccess(schema: SchemaDefinition, args: AccessCompileArgs): void {
	if (!declaresAccess(args.config, args.collectionAccess, args.collections)) return
	const loaded = (globalThis as AccessCompilerSlot)[ACCESS_COMPILER_SLOT]
	if (loaded) {
		const access = loaded(args)
		if (access) schema.access = access
		return
	}
	let compiled: { value: AccessDefinition | undefined } | null = null
	Object.defineProperty(schema, 'access', {
		enumerable: true,
		configurable: true,
		get(): AccessDefinition | undefined {
			if (compiled) return compiled.value
			const compiler = (globalThis as AccessCompilerSlot)[ACCESS_COMPILER_SLOT]
			if (!compiler) throw new AccessNotLoadedError()
			compiled = { value: compiler(args) }
			return compiled.value
		},
		set(value: AccessDefinition | undefined) {
			compiled = { value }
		},
	})
}
