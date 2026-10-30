import type { Operation } from '@korajs/core'
import { currentWriteObserver } from '@korajs/core/internal'
import { activePhaseTimers } from '../instrumentation/phase-timers'
import { type WriteTracker, readBaseIfNeeded, trackDelete } from '../overlay/write-overlay'
import type { WriteOptions } from '../types'
import { runLocalWrite } from './run-local-write'
import type { LocalMutationContext } from './types'
import { writeDeleteInTx } from './write-ops'

export interface ExecuteDeleteOptions extends WriteOptions {
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
	// Off unless the store was built with `instantUpdates`; see executeInsert. A delete
	// that skips referential enforcement is a system write (a cascade the caller already
	// decided), never predicted.
	const overlay = ctx.overlay
	let tracker: WriteTracker | null = null
	// See executeUpdate: a write that reads before it is predicted holds a turn.
	const turn = overlay ? overlay.registry.order.enter() : null
	try {
		if (overlay && options?.skipReferentialEnforcement !== true) {
			if (turn?.wait) await turn.wait
			const read =
				options?.durable === true
					? ({ status: 'skipped' } as const)
					: readBaseIfNeeded(ctx, overlay, ctx.collection, id)
			if (read instanceof Promise) turn?.hold()
			tracker = trackDelete(ctx, overlay, id, read instanceof Promise ? await read : read, options)
		} else if (turn?.wait) {
			await turn.wait
		}
		const started = runLocalWrite(
			ctx,
			(scope) =>
				writeDeleteInTx(ctx, scope, ctx.collection, id, {
					skipReferentialEnforcement: options?.skipReferentialEnforcement ?? false,
					extraCausalDeps: ctx.extraCausalDeps ?? [],
				}),
			{
				observer,
				...(tracker
					? {
							onCommitted: (results) => tracker?.committed(results),
							onCommitUnknown: (lookup, _error, results) => {
								if (lookup.outcome === 'committed') tracker?.committed(results)
								else if (lookup.outcome === 'unknown') tracker?.unknown(lookup.operationId)
							},
						}
					: {}),
			},
		)
		turn?.release()
		const result = await started
		return result.operation ? [result.operation, ...result.sideEffects] : result.sideEffects
	} catch (error) {
		tracker?.failed(error)
		throw error
	} finally {
		turn?.release()
	}
}
