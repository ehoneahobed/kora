import { generateUUIDv7 } from '@korajs/core'
import { currentWriteObserver } from '@korajs/core/internal'
import { activePhaseTimers } from '../instrumentation/phase-timers'
import { activeWriteOverlay, trackInsert } from '../overlay/write-overlay'
import type { CollectionRecord } from '../types'
import { runLocalWrite } from './run-local-write'
import type { LocalMutationContext } from './types'
import { type PreparedInsert, prepareInsert, writeInsertInTx } from './write-ops'

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
	const timers = activePhaseTimers()
	timers?.begin('insert')
	const preparedAt = timers ? performance.now() : 0
	const prepared = await prepareInsert(ctx, ctx.collection, data)
	timers?.add('prepare', performance.now() - preparedAt)
	// Off by default. When an overlay is installed, the SAME prepared object is predicted
	// here and written below (I4); the write path itself never reads the overlay (I1).
	const overlay = activeWriteOverlay()
	const tracker = overlay ? trackInsert(ctx, overlay, prepared) : null
	try {
		const result = await runLocalWrite(
			ctx,
			(scope) => writeInsertInTx(ctx, scope, prepared, ctx.extraCausalDeps ?? []),
			{ observer, ...(tracker ? { onCommitted: (results) => tracker.committed(results) } : {}) },
		)
		return result.record
	} catch (error) {
		tracker?.failed()
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
 * @returns The inserted records, in input order
 */
export async function executeInsertMany(
	ctx: LocalMutationContext,
	rows: readonly Record<string, unknown>[],
): Promise<CollectionRecord[]> {
	if (rows.length === 0) return []
	// Captured before the first await: the observer is only current synchronously.
	const observer = currentWriteObserver()
	const prepared: PreparedInsert[] = []
	for (const data of rows) {
		prepared.push(await prepareInsert(ctx, ctx.collection, data))
	}
	const env = { ...ctx, transactionId: ctx.transactionId ?? generateUUIDv7() }
	const results = await runLocalWrite(
		env,
		async (scope) => {
			const written = []
			for (const insert of prepared) {
				written.push(await writeInsertInTx(env, scope, insert, ctx.extraCausalDeps ?? []))
			}
			return written
		},
		{ chainOperations: true, observer },
	)
	return results.map((result) => result.record)
}
