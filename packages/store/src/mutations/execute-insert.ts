import { generateUUIDv7 } from '@korajs/core'
import { currentWriteObserver } from '@korajs/core/internal'
import { activePhaseTimers } from '../instrumentation/phase-timers'
import { trackInsert, trackInsertMany } from '../overlay/write-overlay'
import type { CollectionRecord, WriteOptions } from '../types'
import { runLocalWrite } from './run-local-write'
import type { LocalMutationContext } from './types'
import { type PreparedInsert, prepareInsert, writeInsertInTx } from './write-ops'

/**
 * Insert a record and persist its operation, atomically, through the single
 * local write path (sequence reserved and operation built inside the write
 * transaction).
 *
 * @param options - `durable: true` shows the record only once it has committed (no
 *   instant-updates prediction for this write)
 */
export async function executeInsert(
	ctx: LocalMutationContext,
	data: Record<string, unknown>,
	options?: WriteOptions,
): Promise<CollectionRecord> {
	// Captured before the first await: the observer is only current synchronously.
	const observer = currentWriteObserver()
	const timers = activePhaseTimers()
	timers?.begin('insert')
	const preparedAt = timers ? performance.now() : 0
	const prepared = await prepareInsert(ctx, ctx.collection, data)
	timers?.add('prepare', performance.now() - preparedAt)
	// Off unless the store was built with `instantUpdates`. The SAME prepared object is
	// predicted here and written below (I4); the write path itself never reads the
	// overlay (I1).
	const tracker = ctx.overlay ? trackInsert(ctx, ctx.overlay, prepared, options) : null
	try {
		const result = await runLocalWrite(
			ctx,
			(scope) => writeInsertInTx(ctx, scope, prepared, ctx.extraCausalDeps ?? []),
			{
				observer,
				...(tracker
					? {
							onCommitted: (results) => tracker.committed(results),
							onCommitUnknown: (lookup, _error, results) => {
								if (lookup.outcome === 'committed') tracker.committed(results)
								else if (lookup.outcome === 'unknown') tracker.unknown(lookup.operationId)
							},
						}
					: {}),
			},
		)
		return result.record
	} catch (error) {
		tracker?.failed(error)
		throw error
	}
}

/**
 * Insert several records of one collection in ONE storage transaction: all of them
 * or none.
 *
 * Every row is validated (and its secret fields transformed) before the
 * transaction starts, so an invalid row refuses the whole call without writing
 * anything. Each row then becomes its own insert operation through the single
 * local write path, in input order: consecutive sequence numbers from the
 * transaction's block, increasing HLC timestamps, each operation causally after
 * the previous one, and one shared `transactionId`, exactly like the same inserts
 * made in `store.transaction`. Subscriptions and `operation:created` see the
 * operations only after the commit, in that order.
 *
 * With instant updates on, a batch within the per-write record cap is shown at once as
 * one entry per record (all together or none); a larger batch waits for the commit.
 *
 * @returns The inserted records, in input order
 */
export async function executeInsertMany(
	ctx: LocalMutationContext,
	rows: readonly Record<string, unknown>[],
	options?: WriteOptions,
): Promise<CollectionRecord[]> {
	if (rows.length === 0) return []
	// Captured before the first await: the observer is only current synchronously.
	const observer = currentWriteObserver()
	const prepared: PreparedInsert[] = []
	for (const data of rows) {
		prepared.push(await prepareInsert(ctx, ctx.collection, data))
	}
	const env = { ...ctx, transactionId: ctx.transactionId ?? generateUUIDv7() }
	const tracker = ctx.overlay ? trackInsertMany(ctx, ctx.overlay, prepared, options) : null
	try {
		const results = await runLocalWrite(
			env,
			async (scope) => {
				const written = []
				for (const insert of prepared) {
					written.push(await writeInsertInTx(env, scope, insert, ctx.extraCausalDeps ?? []))
				}
				return written
			},
			{
				chainOperations: true,
				observer,
				...(tracker
					? {
							onCommitted: (written) => tracker.committed(written),
							onCommitUnknown: (lookup, _error, written) => {
								if (lookup.outcome === 'committed') tracker.committed(written)
								else if (lookup.outcome === 'unknown') tracker.unknown(lookup.operationId)
							},
						}
					: {}),
			},
		)
		return results.map((result) => result.record)
	} catch (error) {
		tracker?.failed(error)
		throw error
	}
}
