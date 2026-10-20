import { currentWriteObserver } from '@korajs/core/internal'
import type { CollectionRecord } from '../types'
import { runLocalWrite } from './run-local-write'
import type { LocalMutationContext } from './types'
import { prepareInsert, writeInsertInTx } from './write-ops'

/**
 * Insert a record and persist its operation, atomically, through the single
 * local write path (sequence reserved and operation built inside the write
 * transaction).
 */
export async function executeInsert(
	ctx: LocalMutationContext,
	data: Record<string, unknown>,
): Promise<CollectionRecord> {
	// Captured before the first await: the observer is only current synchronously.
	const observer = currentWriteObserver()
	const prepared = await prepareInsert(ctx, ctx.collection, data)
	const result = await runLocalWrite(
		ctx,
		(scope) => writeInsertInTx(ctx, scope, prepared, ctx.extraCausalDeps ?? []),
		observer,
	)
	return result.record
}
