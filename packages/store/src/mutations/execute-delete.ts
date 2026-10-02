import type { Operation } from '@korajs/core'
import { runLocalWrite } from './run-local-write'
import type { LocalMutationContext } from './types'
import { writeDeleteInTx } from './write-ops'

export interface ExecuteDeleteOptions {
	/** When true, skip referential checks and cascades (caller already enforced them). */
	skipReferentialEnforcement?: boolean
}

/**
 * Soft-delete a record and persist the operation log entry atomically, together
 * with any referential side effects (cascades / set-null), in one transaction.
 * Returns the primary delete operation followed by the side-effect operations.
 */
export async function executeDelete(
	ctx: LocalMutationContext,
	id: string,
	options?: ExecuteDeleteOptions,
): Promise<Operation[]> {
	const result = await runLocalWrite(ctx, (scope) =>
		writeDeleteInTx(ctx, scope, ctx.collection, id, {
			skipReferentialEnforcement: options?.skipReferentialEnforcement ?? false,
			extraCausalDeps: ctx.extraCausalDeps ?? [],
		}),
	)
	return result.operation ? [result.operation, ...result.sideEffects] : result.sideEffects
}
