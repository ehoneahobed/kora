import { quoteIdent } from '@korajs/core'
import type { StorageAdapter } from '../types'
import type { WriteResult } from './write-ops'

/*
 * M2, for local writes (docs/design/instant-ui-updates.md 7; plan item M2): when a write
 * transaction rejects AFTER its body finished, the answer to COMMIT was lost (a leader
 * change cut the reply, a bridge died) and the commit may have landed. Operation ids are
 * content-addressed, so the write's own primary operation id is a witness: the
 * transaction is atomic, so if that operation is in the log, everything else landed too.
 */

/** What the lookup found. */
export type CommitLookup =
	/** The operation is in the log: the commit landed. */
	| { readonly outcome: 'committed' }
	/** The log was read and the operation is not in it: nothing was committed. */
	| { readonly outcome: 'absent' }
	/**
	 * The log could not be read (the adapter is still unavailable), or the write has no
	 * operation to look for. `operationId` is the witness to try again later, when known.
	 */
	| {
			readonly outcome: 'unknown'
			readonly operationId: string | null
			readonly collection: string | null
	  }

/** The operation whose presence in the log proves the write landed. */
export function witnessOperation(
	results: readonly WriteResult[],
): { readonly id: string; readonly collection: string } | null {
	for (const result of results) {
		const operation = result.operation ?? result.sideEffects[0]
		if (operation) return { id: operation.id, collection: operation.collection }
	}
	return null
}

/**
 * Ask the operation log whether a write whose commit answer was lost landed. Never
 * throws: a failed read is `unknown`, not a guess either way.
 *
 * @param adapter - The store's adapter
 * @param results - The write's results, as built inside the (rejected) transaction
 */
export async function lookupCommit(
	adapter: StorageAdapter,
	results: readonly WriteResult[],
): Promise<CommitLookup> {
	const witness = witnessOperation(results)
	if (!witness) return { outcome: 'unknown', operationId: null, collection: null }
	return lookupOperation(adapter, witness.collection, witness.id)
}

/** {@link lookupCommit} for a witness already known (a later retry). */
export async function lookupOperation(
	adapter: StorageAdapter,
	collection: string,
	operationId: string,
): Promise<CommitLookup> {
	try {
		const rows = await adapter.query<{ id: string }>(
			`SELECT id FROM ${quoteIdent(`_kora_ops_${collection}`)} WHERE id = ? LIMIT 1`,
			[operationId],
		)
		return rows.length > 0 ? { outcome: 'committed' } : { outcome: 'absent' }
	} catch {
		return { outcome: 'unknown', operationId, collection }
	}
}
