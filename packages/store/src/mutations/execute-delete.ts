import type { Operation } from '@korajs/core'
import { currentWriteObserver } from '@korajs/core/internal'
import { activePhaseTimers } from '../instrumentation/phase-timers'
import {
	type WriteTracker,
	activeWriteOverlay,
	readBaseIfNeeded,
	trackDelete,
} from '../overlay/write-overlay'
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
	activePhaseTimers()?.begin('delete')
	// Captured before the first await: the observer is only current synchronously.
	const observer = currentWriteObserver()
	// Off by default; see executeInsert.
	const overlay = activeWriteOverlay()
	let tracker: WriteTracker | null = null
	if (overlay) {
		const read = readBaseIfNeeded(ctx, overlay, ctx.collection, id)
		tracker = trackDelete(ctx, overlay, id, read instanceof Promise ? await read : read)
	}
	try {
		const result = await runLocalWrite(
			ctx,
			(scope) =>
				writeDeleteInTx(ctx, scope, ctx.collection, id, {
					skipReferentialEnforcement: options?.skipReferentialEnforcement ?? false,
					extraCausalDeps: ctx.extraCausalDeps ?? [],
				}),
			{ observer, ...(tracker ? { onCommitted: (results) => tracker.committed(results) } : {}) },
		)
		return result.operation ? [result.operation, ...result.sideEffects] : result.sideEffects
	} catch (error) {
		tracker?.failed()
		throw error
	}
}
