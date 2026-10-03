import { deriveSideEffectOpId } from '@korajs/core'
import type { ServerStore } from '../store/server-store'

/**
 * Id of a server-derived operation (cascade, set-null, constraint correction). The
 * built-in stores key it with the deployment's persisted secret (RT-64): every instance
 * derives the same id for the same effect, and no client can predict it, so no client
 * operation can occupy it first and make the store drop the server's as a duplicate.
 * A third-party store without `deriveServerOperationId` gets the unkeyed derivation.
 */
export async function deriveServerOpId(
	store: ServerStore,
	parentOpId: string,
	ruleId: string,
	targetRecordId: string,
): Promise<string> {
	if (store.deriveServerOperationId) {
		return store.deriveServerOperationId(parentOpId, ruleId, targetRecordId)
	}
	return deriveSideEffectOpId(parentOpId, ruleId, targetRecordId)
}
