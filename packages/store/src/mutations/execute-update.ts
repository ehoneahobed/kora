import { validateRecord } from '@korajs/core'
import { currentWriteObserver } from '@korajs/core/internal'
import { activePhaseTimers } from '../instrumentation/phase-timers'
import {
	type WriteTracker,
	activeWriteOverlay,
	readBaseIfNeeded,
	trackUpdate,
} from '../overlay/write-overlay'
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
	const observer = currentWriteObserver()
	const timers = activePhaseTimers()
	timers?.begin('update')
	const preparedAt = timers ? performance.now() : 0
	const validated = validateRecord(ctx.collection, ctx.definition, data, 'update')
	timers?.add('prepare', performance.now() - preparedAt)
	// Off by default; see executeInsert.
	const overlay = activeWriteOverlay()
	let tracker: WriteTracker | null = null
	if (overlay) {
		// Registration and the write below happen in one synchronous step unless the base
		// record has to be read first, so overlapping writes register in transaction order.
		const read = readBaseIfNeeded(ctx, overlay, ctx.collection, id)
		tracker = trackUpdate(ctx, overlay, id, validated, read instanceof Promise ? await read : read)
	}
	try {
		const result = await runLocalWrite(
			ctx,
			(scope) =>
				writeUpdateInTx(ctx, scope, ctx.collection, id, validated, ctx.extraCausalDeps ?? []),
			{ observer, ...(tracker ? { onCommitted: (results) => tracker.committed(results) } : {}) },
		)
		return result.record
	} catch (error) {
		tracker?.failed()
		throw error
	}
}
