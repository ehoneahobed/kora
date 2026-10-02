import { validateRecord } from '@korajs/core'
import type { CollectionRecord } from '../types'
import { runLocalWrite } from './run-local-write'
import type { LocalMutationContext } from './types'
import { writeUpdateInTx } from './write-ops'

/**
 * Update a record and persist its operation, atomically. The row read, the
 * state-machine check and atomic-op resolution all happen inside the write
 * transaction, so concurrent increments compose (STORE-9).
 */
export async function executeUpdate(
	ctx: LocalMutationContext,
	id: string,
	data: Record<string, unknown>,
): Promise<CollectionRecord> {
	const validated = validateRecord(ctx.collection, ctx.definition, data, 'update')
	const result = await runLocalWrite(ctx, (scope) =>
		writeUpdateInTx(ctx, scope, ctx.collection, id, validated, ctx.extraCausalDeps ?? []),
	)
	return result.record
}
