import { validateRecord } from '@korajs/core'
import { currentWriteObserver } from '@korajs/core/internal'
import { activePhaseTimers } from '../instrumentation/phase-timers'
import { updateNeedsFoldState } from '../overlay/predict'
import {
	type WriteTracker,
	readBaseIfNeeded,
	recordKey,
	trackUpdate,
} from '../overlay/write-overlay'
import type { CollectionRecord, WriteOptions } from '../types'
import { runLocalWrite } from './run-local-write'
import type { LocalMutationContext } from './types'
import { writeUpdateInTx } from './write-ops'

/**
 * Update a record and persist its operation, atomically. The row read, the
 * state-machine check and atomic-op resolution all happen inside the write
 * transaction, so concurrent increments compose (STORE-9).
 *
 * @param options - `durable: true` shows the change only once it has committed (no
 *   instant-updates prediction for this write)
 */
export async function executeUpdate(
	ctx: LocalMutationContext,
	id: string,
	data: Record<string, unknown>,
	options?: WriteOptions,
): Promise<CollectionRecord> {
	const observer = currentWriteObserver()
	const timers = activePhaseTimers()
	timers?.begin('update')
	const preparedAt = timers ? performance.now() : 0
	const validated = validateRecord(ctx.collection, ctx.definition, data, 'update')
	timers?.add('prepare', performance.now() - preparedAt)
	// Off unless the store was built with `instantUpdates`; see executeInsert.
	const overlay = ctx.overlay
	let tracker: WriteTracker | null = null
	// Held while this write reads before it can be predicted: updates, deletes and
	// transactions called meanwhile wait, so writes start in call order (see write-order.ts).
	const turn = overlay ? overlay.registry.order.enter([recordKey(ctx.collection, id)]) : null
	try {
		if (overlay) {
			if (turn?.wait) await turn.wait
			// Registration and the write below happen in one synchronous step unless the base
			// record has to be read first, so overlapping writes register in transaction order.
			// A `durable` write needs no base: it is not predicted at all.
			const read =
				options?.durable === true
					? ({ status: 'skipped' } as const)
					: readBaseIfNeeded(
							ctx,
							overlay,
							ctx.collection,
							id,
							updateNeedsFoldState(ctx, ctx.collection, validated),
						)
			if (read instanceof Promise) turn?.hold()
			tracker = trackUpdate(
				ctx,
				overlay,
				id,
				validated,
				read instanceof Promise ? await read : read,
				options,
			)
		}
		const started = runLocalWrite(
			ctx,
			(scope) =>
				writeUpdateInTx(ctx, scope, ctx.collection, id, validated, ctx.extraCausalDeps ?? []),
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
		// The storage transaction is queued: later writes of this record may now start.
		turn?.release()
		const result = await started
		return result.record
	} catch (error) {
		tracker?.failed(error)
		throw error
	} finally {
		turn?.release()
	}
}
