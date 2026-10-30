import type { Operation } from '@korajs/core'
import { KoraError } from '@korajs/core'
import { type WriteObserver, notifyWriteObserver } from '@korajs/core/internal'
import { activePhaseTimers } from '../instrumentation/phase-timers'
import type { LocalMutationContext } from './types'
import { CausalScope, type WriteScope, withWriteScope } from './write-context'
import type { WriteResult } from './write-ops'

/** Options for {@link runLocalWrite}. */
export interface RunLocalWriteOptions {
	/**
	 * Every operation of the write also depends on the previous one (as in
	 * `store.transaction`). Used by multi-record writes such as `insertMany`.
	 */
	readonly chainOperations?: boolean
	/**
	 * The binding that started this write (captured synchronously by the caller). It
	 * learns the write's operation ids after the commit and before they reach sync.
	 */
	readonly observer?: WriteObserver | null
}

/**
 * Run one local write in its own storage transaction, then publish it.
 *
 * Post-commit work (causal heads, in-memory version vector, subscriptions,
 * `operation:created`) runs only after the transaction commits, so nothing
 * observable ever points at an operation that was rolled back (STORE-15).
 *
 * `write` may return one result or several (a multi-record write); the
 * operations of every result are published in order.
 */
export async function runLocalWrite<R extends WriteResult | readonly WriteResult[]>(
	ctx: LocalMutationContext,
	write: (scope: WriteScope) => Promise<R>,
	options: RunLocalWriteOptions = {},
): Promise<R> {
	const causal = new CausalScope(ctx.causalTracker, options.chainOperations === true)
	let result: R | undefined
	const timers = activePhaseTimers()
	const txCalledAt = timers ? performance.now() : 0
	let bodyStartedAt = 0
	let bodyEndedAt = 0
	try {
		await ctx.adapter.transaction(async (tx) => {
			bodyStartedAt = timers ? performance.now() : 0
			result = await withWriteScope(tx, ctx.nodeId, causal, write)
			bodyEndedAt = timers ? performance.now() : 0
		})
	} catch (error) {
		ctx.onStorageError?.(error)
		throw error
	}
	if (!result) {
		throw new KoraError('Local write transaction completed without a result', 'WRITE_INCOMPLETE', {
			collection: ctx.collection,
		})
	}
	const committedAt = timers ? performance.now() : 0
	if (timers) {
		timers.add('txOpen', bodyStartedAt - txCalledAt)
		timers.add('body', bodyEndedAt - bodyStartedAt)
		timers.add('commit', committedAt - bodyEndedAt)
	}
	causal.publish()
	const results: readonly WriteResult[] = isResultList(result) ? result : [result]
	// The observer (the binding that started this write) learns every operation id of the
	// write before they reach sync, so a refusal can never arrive before the write is tracked.
	notifyWriteObserver(
		options.observer ?? null,
		results.flatMap((one) => [...(one.operation ? [one.operation] : []), ...one.sideEffects]),
	)
	for (const one of results) publishOperations(ctx, one)
	if (timers) {
		const publishedAt = performance.now()
		timers.add('publish', publishedAt - committedAt)
		timers.notePublished(publishedAt)
	}

	// IndexedDB fallback commits first to the live in-memory SQLite database and
	// persists a snapshot asynchronously. A resolved write promise is a durability
	// promise, so wait for the adapter's group-commit barrier after publishing the
	// committed operations. Native and OPFS adapters have no barrier and pay nothing.
	if (ctx.adapter.ensureDurable) {
		const operationIds = results.flatMap((one) => [
			...(one.operation ? [one.operation.id] : []),
			...one.sideEffects.map((operation) => operation.id),
		])
		try {
			await ctx.adapter.ensureDurable()
			ctx.onWriteDurable?.()
		} catch (error) {
			ctx.onStorageError?.(error)
			throw ctx.onWriteDurabilityError?.(error, operationIds) ?? error
		}
	}
	return result
}

function isResultList(
	value: WriteResult | readonly WriteResult[],
): value is readonly WriteResult[] {
	return Array.isArray(value)
}

/** Notify the store about every operation of a committed write, in creation order. */
function publishOperations(ctx: LocalMutationContext, result: WriteResult): void {
	const ops: Operation[] = []
	if (result.operation) ops.push(result.operation)
	ops.push(...result.sideEffects)
	for (const op of ops) {
		ctx.onMutation(op.collection, op)
	}
}
