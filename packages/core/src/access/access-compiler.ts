import {
	ACCESS_COMPILER_SLOT,
	type AccessCompileArgs,
	type AccessCompilerSlot,
} from './access-slot-key'
import { buildAccessDefinition } from './define-access'
import type { AccessDefinition } from './define-access'

/**
 * Validates and compiles a schema's access declarations. Lives in its own entry file so a
 * production bundle of the lite entry, which never calls it, does not include it.
 *
 * @param args - The declarations captured by `defineSchema`
 * @returns The compiled definition, or undefined when there is nothing to compile
 */
export function compileAccess(args: AccessCompileArgs): AccessDefinition | undefined {
	return buildAccessDefinition(args.config, args.collectionAccess, args.collections, args.relations)
}

/**
 * Makes the access compiler available to every schema defined with the lite entry. The
 * full `@korajs/core` entry and the Kora runtime call this when they load; a schema whose
 * access rules were not compiled at definition time compiles them on its first read of
 * `access` (see `attachAccess`).
 */
export function registerAccessCompiler(): void {
	;(globalThis as AccessCompilerSlot)[ACCESS_COMPILER_SLOT] = compileAccess
}
