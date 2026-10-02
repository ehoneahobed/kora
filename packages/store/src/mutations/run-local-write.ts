import type { Operation } from '@korajs/core'
import { KoraError } from '@korajs/core'
import type { LocalMutationContext } from './types'
import { CausalScope, type WriteScope, withWriteScope } from './write-context'
import type { WriteResult } from './write-ops'

/**
 * Run one local write in its own storage transaction, then publish it.
 *
 * Post-commit work (causal heads, in-memory version vector, subscriptions,
 * `operation:created`) runs only after the transaction commits, so nothing
 * observable ever points at an operation that was rolled back (STORE-15).
 */
export async function runLocalWrite(
	ctx: LocalMutationContext,
	write: (scope: WriteScope) => Promise<WriteResult>,
): Promise<WriteResult> {
	const causal = new CausalScope(ctx.causalTracker, false)
	let result: WriteResult | undefined
	try {
		await ctx.adapter.transaction(async (tx) => {
			result = await withWriteScope(tx, ctx.nodeId, causal, write)
		})
	} catch (error) {
		ctx.onStorageError?.(error)
		throw error
	}
	if (!result) {
		throw new KoraError('Local write transaction completed without a result', 'WRITE_INCOMPLETE', {
			collection: ctx.collection,
		})
	}
	causal.publish()
	publishOperations(ctx, result)
	return result
}

/** Notify the store about every operation of a committed write, in creation order. */
function publishOperations(ctx: LocalMutationContext, result: WriteResult): void {
	const ops: Operation[] = []
	if (result.operation) ops.push(result.operation)
	ops.push(...result.sideEffects)
	for (const op of ops) {
		ctx.onMutation(op.collection, op)
	}
}
